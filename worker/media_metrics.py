"""Per-post insights for every post on the account, ours or not.

Feeds the Insights hub's content leaderboard. The sibling job worker/metrics.py does the
same thing for publications and feeds autofill's ranking; the two are kept separate
because they answer to different owners — that one may only ever see posts we sent, while
this one must cover the whole account.

They do NOT double-spend the API. Where a remote post is one we published and
worker/metrics.py already holds a fresh snapshot, the value is copied across instead of
refetched. On this install that is a small overlap (9 of 146 posts), but on an install
that has been running for years it is most of them.

Which posts are due, and why the rule is shaped this way:

  * a post with NO metrics at all is always due — that is what populates the leaderboard
    on a fresh install, across the entire backfilled history;
  * a post inside metrics_max_age_days refreshes on the normal interval, because its
    numbers are still moving;
  * an older post is left alone once it has a reading. Its metrics are effectively static,
    and refreshing 146 posts of history every six hours would spend the whole call budget
    re-reading numbers that do not change.

Read-only, so it runs under DRY_RUN like the other sync jobs.
"""

from __future__ import annotations

import json
from datetime import timedelta

from .clients import SUPPORTED_PLATFORMS
from .media_sync import CallBudget  # noqa: F401  (re-exported for callers)
from .metrics import COLUMN_MAP, REQUESTED_METRICS
from .redact import redact

# Columns media_metrics stores, in the order _record writes them.
METRIC_COLUMNS = (
    "reach", "impressions", "likes", "comments", "saves", "shares", "video_views",
)


def media_needing_metrics(conn, channel_id: int, now, max_age_days: int,
                          min_interval_hours: int, limit: int):
    """Posts due a reading, newest first.

    Newest first matters: when the budget runs out mid-backfill, the posts a person is
    most likely to look at are the ones already covered.
    """
    age_cutoff = (now - timedelta(days=max_age_days)).isoformat()
    interval_cutoff = (now - timedelta(hours=min_interval_hours)).isoformat()
    return conn.execute(
        """
        SELECT rm.* FROM remote_media rm
        WHERE rm.channel_id = ?
          AND rm.is_deleted = 0
          AND rm.published_at IS NOT NULL
          AND (
            NOT EXISTS (SELECT 1 FROM media_metrics mm WHERE mm.remote_media_id = rm.id)
            OR (
              rm.published_at >= ?
              AND NOT EXISTS (
                SELECT 1 FROM media_metrics mm
                WHERE mm.remote_media_id = rm.id AND mm.fetched_at > ?
              )
            )
          )
        ORDER BY rm.published_at DESC
        LIMIT ?
        """,
        (channel_id, age_cutoff, interval_cutoff, limit),
    ).fetchall()


def _fresh_publication_snapshot(conn, publication_id: int | None, interval_cutoff: str):
    """A post_metrics row recent enough to reuse, or None.

    This is the whole no-double-spend mechanism: worker/metrics.py already paid for this
    reading, and asking Meta for the same numbers again costs quota that the account-wide
    backfill needs.
    """
    if not publication_id:
        return None
    return conn.execute(
        """
        SELECT * FROM post_metrics
        WHERE publication_id = ? AND fetched_at > ?
        ORDER BY fetched_at DESC LIMIT 1
        """,
        (publication_id, interval_cutoff),
    ).fetchone()


def _record(conn, remote_media_id: int, fetched_at: str, values: dict, raw: dict) -> None:
    conn.execute(
        f"""INSERT INTO media_metrics
              (remote_media_id, fetched_at, {', '.join(METRIC_COLUMNS)}, raw_json)
            VALUES (?, ?, {', '.join('?' for _ in METRIC_COLUMNS)}, ?)""",
        (remote_media_id, fetched_at,
         *(values.get(column) for column in METRIC_COLUMNS), json.dumps(raw)),
    )


def _to_columns(insights: dict) -> dict:
    """Map platform metric names onto our columns, first mapped value winning.

    Shares COLUMN_MAP with worker/metrics.py deliberately: the same metric must mean the
    same column in both tables, or the copy-across path above would silently translate.
    """
    out: dict = {}
    for name, value in insights.items():
        column = COLUMN_MAP.get(name)
        if column and value is not None and out.get(column) is None:
            out[column] = value
    return out


# Per-media-type extras, on top of metrics.REQUESTED_METRICS. Verified one name at a time
# against real media on the live account, 2026-08-05.
#
# These CANNOT be folded into the shared base list: Instagram 400s the entire call when
# one metric is invalid for the media type, so asking an image for a Reels metric would
# lose every metric for that post, not just the one that does not apply.
REELS_EXTRA_METRICS = ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"]
# Rejected by Reels, accepted by feed images and carousels — the split runs both ways.
FEED_EXTRA_METRICS = ["profile_visits", "follows"]


def instagram_metrics_for(media) -> list[str]:
    """The metric list valid for this specific post.

    Keyed on media_product_type first because that is what separates a Reel from a feed
    post; media_type ('VIDEO') does not, since a feed video is not a Reel.
    """
    extras = (
        REELS_EXTRA_METRICS
        if (media["media_product_type"] or "").upper() == "REELS"
        else FEED_EXTRA_METRICS
    )
    return [*REQUESTED_METRICS, *extras]


def _fetch_instagram(client, media, channel, config):
    return client.get_media_insights(
        media["remote_post_id"], channel["access_token"], instagram_metrics_for(media)
    )


def _fetch_threads(client, media, channel, config):
    metrics = [m.strip() for m in config.threads_insight_metrics.split(",") if m.strip()]
    return client.get_threads_insights(media["remote_post_id"], channel["access_token"], metrics)


_FETCHERS = {
    "instagram": _fetch_instagram,
    "threads": _fetch_threads,
    "facebook": None,   # phase 5
    "discord": None,
    "telegram": None,
    # No remote_media mirror exists for TikTok (media_sync has no adapter for it), so
    # there is nothing here to attach per-media metrics to.
    "tiktok": None,
}

assert set(_FETCHERS) == set(SUPPORTED_PLATFORMS), (
    "media_metrics._FETCHERS and clients.SUPPORTED_PLATFORMS disagree"
)


def sync_channel_media_metrics(conn, config, client, channel, now, budget,
                               logger=None) -> dict:
    fetch = _FETCHERS.get(channel["platform"])
    if fetch is None:
        return {"fetched": 0, "reused": 0}

    now_iso = now.isoformat()
    interval_cutoff = (now - timedelta(hours=config.metrics_min_interval_hours)).isoformat()
    # The selection cap is a MEMORY bound, not a spend bound, and deliberately not
    # derived from budget.remaining: a reused row costs no API call, so sizing the query
    # to the call budget would silently stop copying free readings once the budget was
    # small — starving exactly the path that exists to conserve it.
    due = media_needing_metrics(
        conn, channel["id"], now, config.metrics_max_age_days,
        config.metrics_min_interval_hours, config.media_sync_max_posts,
    )

    fetched = reused = failed = 0
    for media in due:
        snapshot = _fresh_publication_snapshot(conn, media["publication_id"], interval_cutoff)
        if snapshot is not None:
            _record(
                conn, media["id"], snapshot["fetched_at"],
                {column: snapshot[column] for column in METRIC_COLUMNS},
                {"copied_from_post_metrics": snapshot["id"]},
            )
            reused += 1
            continue

        # The budget gate sits HERE rather than at the top of the loop, so an exhausted
        # budget stops paid fetches while free copy-across work keeps going.
        if budget.exhausted(client):
            break
        budget.spend()
        try:
            insights = fetch(client, media, channel, config)
        except Exception as exc:  # noqa: BLE001 — one dead post must not stop the rest
            # Expected in normal operation: Meta rejects insights on some older media and
            # on posts whose type has no insight set. Logged at debug so a backfill over
            # hundreds of posts does not bury the real messages.
            failed += 1
            if logger:
                logger.debug(
                    "[media_metrics %s] %s: %s",
                    channel["id"], media["remote_post_id"], redact(str(exc)),
                )
            continue
        _record(conn, media["id"], now_iso, _to_columns(insights), insights)
        fetched += 1

    conn.commit()
    if logger and (fetched or reused or failed):
        logger.info(
            "[media_metrics ch %s] %d fetched, %d reused from publications, %d unavailable",
            channel["id"], fetched, reused, failed,
        )
    return {"fetched": fetched, "reused": reused, "failed": failed}


def run_media_metrics(conn, config, client=None, now=None, logger=None,
                      client_for=None) -> int:
    """Refresh per-post metrics for every channel. Returns posts recorded."""
    pick_client = client_for or (lambda _platform: client)
    budget = CallBudget(config.insights_max_calls_per_cycle, config.insights_usage_pct_ceiling)
    rows = conn.execute("SELECT * FROM channels WHERE is_active = 1").fetchall()
    total = 0

    for channel in rows:
        if _FETCHERS.get(channel["platform"]) is None:
            continue
        if not channel["access_token"]:
            continue
        client_obj = pick_client(channel["platform"])
        try:
            result = sync_channel_media_metrics(
                conn, config, client_obj, channel, now, budget, logger=logger
            )
            total += result["fetched"] + result["reused"]
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            if logger:
                logger.info("[media_metrics ch %s] failed: %s", channel["id"], redact(str(exc)))
        if budget.exhausted(client_obj):
            if logger:
                logger.info("[media_metrics] stopping early — %s", budget.stopped_reason)
            break
    return total
