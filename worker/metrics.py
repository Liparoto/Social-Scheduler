"""Metrics fetch job (Instagram media insights + Facebook Page-post counts).

For each real (non-dry-run) published publication, periodically fetch its insights
from the Graph API and append a time-series row to post_metrics. Those rows feed the
per-channel performance ranking that auto-fill uses (see autofill.select_candidates).

Throttling: only publications published within metrics_max_age_days are refreshed, and
each is refreshed at most once per metrics_min_interval_hours.
"""

from __future__ import annotations

import json
from datetime import timedelta

from .clients import SUPPORTED_PLATFORMS
from .config import Config

# Metrics requested from the IG media insights endpoint. We store whatever comes back;
# missing ones are simply null.
#
# This list is the SAFE BASE: every name here was verified on 2026-08-05 against a real
# Reel, image and carousel on the live account, and works on all three. That matters more
# than it sounds — Instagram rejects the WHOLE call with HTTP 400 if any single metric is
# invalid for that media type, so one Reels-only name in this list would wipe out metrics
# for every image post. Per-media-type extras therefore live in media_metrics.py, which
# knows the media type; this list must stay universally valid.
#
# `views` replaced `video_views`/`plays`, both of which now 400 on every media type
# including Reels. It maps to the impressions column via COLUMN_MAP. Adding it does not
# disturb auto-fill, which ranks on reach + saves only (see autofill.select_candidates).
REQUESTED_METRICS = ["reach", "likes", "comments", "saved", "shares", "views"]

# Story media supports a DIFFERENT set, and rejects the feed list outright (HTTP 400,
# not partial results) — asking for likes/comments/saved/impressions on a story fails
# the whole call. Established by probing a real published Story against the live API
# on 2026-08-04, not from docs: the names that read as obvious (taps_forward,
# taps_back, exits) are all REJECTED; `navigation` is their modern replacement, and
# `views` replaces `impressions`. See reference.md, "first real Story".
#
# Only reach/views/replies/shares map to columns (via COLUMN_MAP); navigation,
# profile_visits, follows and total_interactions have no column and live in raw_json,
# which is what it exists for. They cost nothing extra — it is all one request.
REQUESTED_STORY_METRICS = [
    "reach", "views", "replies", "shares",
    "navigation", "profile_visits", "follows", "total_interactions",
]

# A Story is gone 24h after publishing, so there is nothing left to refresh.
STORY_LIFETIME_HOURS = 24

# Map insight names -> our post_metrics columns.
COLUMN_MAP = {
    # Instagram media insights
    "reach": "reach",
    "impressions": "impressions",
    "likes": "likes",
    "comments": "comments",
    "saved": "saves",
    "shares": "shares",
    "video_views": "video_views",
    "plays": "video_views",
    # Facebook Page posts: stable edge summaries...
    "fb_reactions": "likes",
    "fb_comments": "comments",
    "fb_shares": "shares",
    # ...plus best-effort insight names for reach/views (see Config.fb_post_insight_metrics).
    "post_total_media_view_unique": "reach",
    "post_impressions_unique": "reach",
    "post_impressions": "impressions",
    # Threads insights. "quotes" is deliberately unmapped — it has no column, and folding
    # it into shares would silently inflate that number; it stays in raw_json.
    "views": "impressions",
    "replies": "comments",
    "reposts": "shares",
}


# Consecutive gone-shaped failures before a publication stops being asked about.
#
# Not 1, deliberately. Meta returns error 100/33 both for an object that has been DELETED
# and for one it will not load "due to missing permissions" — the same code for a permanent
# fact and a temporary one. An expired or downgraded token returns it for every post on the
# account at once, so marking on the first failure could freeze an entire account's metrics
# on a problem that fixes itself. Three in a row, with any success resetting the count, is
# cheap insurance; a genuinely deleted post reaches it within a couple of minutes anyway.
METRICS_FAILURE_LIMIT = 3


def publications_needing_metrics(conn, now, max_age_days: int, min_interval_hours: int):
    max_age_cutoff = (now - timedelta(days=max_age_days)).isoformat()
    interval_cutoff = (now - timedelta(hours=min_interval_hours)).isoformat()
    story_cutoff = (now - timedelta(hours=STORY_LIFETIME_HOURS)).isoformat()
    # Platforms _FETCHERS registers as None have no metrics endpoint at all (Discord,
    # Telegram) — excluding them here means they are never reselected, cycle after
    # cycle, only for run_metrics to skip them again every time.
    no_metrics_platforms = [platform for platform, fetch in _FETCHERS.items() if fetch is None]
    exclude_clause = ""
    if no_metrics_platforms:
        placeholders = ",".join("?" for _ in no_metrics_platforms)
        exclude_clause = f"ch.platform NOT IN ({placeholders}) AND "
    return conn.execute(
        f"""
        SELECT pub.* FROM publications pub
        JOIN channels ch ON ch.id = pub.channel_id
        WHERE pub.status = 'posted'
          AND pub.is_dry_run = 0
          AND pub.remote_post_id IS NOT NULL
          AND pub.remote_post_id != 'DRYRUN'
          AND pub.published_at IS NOT NULL
          AND (
            -- Automatic refresh: within the age window, past the interval gate, AND on
            -- a platform that actually has a metrics endpoint (excluding Discord/
            -- Telegram here, rather than in the WHERE clause overall, keeps a
            -- manually-flagged row on those platforms selectable below — it must still
            -- be picked up once so run_metrics' finally block can clear the flag).
            (
              {exclude_clause}pub.published_at >= ?
              -- A Story is gone 24h after publishing. Refreshing it past that only
              -- produces a 400 every cycle, forever. This sits INSIDE the automatic
              -- branch, beside the platform exclusion above and for the same reason: a
              -- manually-flagged row must still be selectable once below, or
              -- run_metrics' finally block never clears metrics_refresh_requested_at.
              AND (pub.surface != 'story' OR pub.published_at >= ?)
              -- The platform has told us this post is not there. Same shape as the Story
              -- rule above and for the same reason: asking again only produces another
              -- error, forever. INSIDE the automatic branch, so an explicit refresh below
              -- still overrides it — error 100/33 also covers a permissions problem, and a
              -- post frozen by one must stay one click from being retried.
              AND pub.remote_missing_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM post_metrics pm
                WHERE pm.publication_id = pub.id AND pm.fetched_at > ?
              )
            )
            -- Manual refresh: user-initiated + one-shot, so it overrides BOTH the age
            -- window and the interval gate (else the flag would never clear) AND the
            -- platform exclusion above (else a Discord/Telegram flag would never clear
            -- either).
            OR pub.metrics_refresh_requested_at IS NOT NULL
          )
        """,
        (*no_metrics_platforms, max_age_cutoff, story_cutoff, interval_cutoff),
    ).fetchall()


def _note_failure(conn, pub, exc, now_iso: str, logger) -> None:
    """Record one failed fetch, and stop asking once the platform has said "gone" enough.

    Only a MISSING-OBJECT error counts toward the streak. An ordinary failure — a timeout, a
    connection reset, a 500 — says nothing about whether the post still exists, so it must
    never accumulate toward giving up on it.
    """
    if not getattr(exc, "is_missing_object", False):
        if logger:
            logger.info("[metrics pub %s] fetch failed: %s", pub["id"], exc)
        return

    streak = (pub["metrics_failure_streak"] or 0) + 1
    if streak < METRICS_FAILURE_LIMIT:
        conn.execute(
            "UPDATE publications SET metrics_failure_streak = ? WHERE id = ?",
            (streak, pub["id"]),
        )
        conn.commit()
        if logger:
            logger.info(
                "[metrics pub %s] the platform says this post is not there (%d/%d)",
                pub["id"], streak, METRICS_FAILURE_LIMIT,
            )
        return

    # Stored, not the raw response: this string is shown in the dashboard, and an API body
    # can carry material that has no business being persisted.
    reason = "The platform reports this post is no longer there (it was probably deleted)."
    conn.execute(
        """UPDATE publications
              SET metrics_failure_streak = ?, remote_missing_at = ?, remote_missing_reason = ?
            WHERE id = ?""",
        (streak, now_iso, reason, pub["id"]),
    )
    conn.commit()
    if logger:
        # ONCE, and then silence. The noise this replaces was the actual complaint: the same
        # line 703 times in one log file, which is where a real failure would have hidden.
        logger.info(
            "[metrics pub %s] giving up: %s No further metrics will be requested for it "
            "unless you refresh it by hand.",
            pub["id"], reason,
        )


def _clear_failures(conn, pub) -> None:
    """A publication that answered is not missing, whatever it did before.

    Clears the mark as well as the streak, so an explicit refresh that succeeds genuinely
    un-freezes the row rather than leaving it flagged with fresh numbers beside it.
    """
    if not (pub["metrics_failure_streak"] or pub["remote_missing_at"]):
        return
    conn.execute(
        """UPDATE publications
              SET metrics_failure_streak = 0, remote_missing_at = NULL,
                  remote_missing_reason = NULL
            WHERE id = ?""",
        (pub["id"],),
    )
    conn.commit()


def _record(conn, publication_id: int, fetched_at: str, insights: dict) -> None:
    cols = {
        "reach": None, "impressions": None, "likes": None, "comments": None,
        "saves": None, "shares": None, "video_views": None,
    }
    # Several Meta metric names intentionally map to the same column (e.g. both
    # post_total_media_view_unique and post_impressions_unique -> reach), so an operator
    # may reasonably configure more than one. The FIRST mapped value wins per column —
    # relying on `insights` iteration order to reflect the operator's configured
    # preference (see _fetch_facebook) — rather than the last one Meta happened to
    # return. `0` is a legitimate value, so only skip when the column is still unset.
    for name, value in insights.items():
        col = COLUMN_MAP.get(name)
        if col and cols[col] is None and value is not None:
            cols[col] = value
    conn.execute(
        """INSERT INTO post_metrics
             (publication_id, fetched_at, reach, impressions, likes, comments,
              saves, shares, video_views, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            publication_id, fetched_at, cols["reach"], cols["impressions"],
            cols["likes"], cols["comments"], cols["saves"], cols["shares"],
            cols["video_views"], json.dumps(insights),
        ),
    )
    conn.commit()


def _fetch_instagram(client, remote_post_id: str, token: str, config, logger, pub_id,
                     surface: str = "feed") -> dict:
    metrics = REQUESTED_STORY_METRICS if surface == "story" else REQUESTED_METRICS
    return client.get_media_insights(remote_post_id, token, metrics)


def _fetch_facebook(client, remote_post_id: str, token: str, config, logger, pub_id,
                    surface: str = "feed") -> dict:
    # surface is accepted and ignored: Facebook Page Stories have no adapter yet, and a
    # uniform signature keeps _FETCHERS callable without special-casing one platform.
    """Stable counts first, then reach/views as best-effort.

    Reactions/comments/shares are plain edge summaries and are required — if they fail,
    the caller skips this snapshot. The insights call is the fragile one (Meta keeps
    retiring metric names), so a failure there only costs us reach: we log it and record
    the counts we did get.
    """
    summary = client.get_page_post_summary(remote_post_id, token)
    metrics = [m.strip() for m in config.fb_post_insight_metrics.split(",") if m.strip()]
    insights: dict = {}
    if metrics:
        try:
            fetched = client.get_page_post_insights(remote_post_id, token, metrics)
        except Exception as exc:  # noqa: BLE001 — best-effort by design
            fetched = {}
            if logger:
                logger.info(
                    "[metrics pub %s] Facebook insight metrics unavailable (%s): %s",
                    pub_id, ",".join(metrics), exc,
                )
        # Order the returned insights by the operator's configured preference, so that
        # when multiple configured names map to the same post_metrics column (see
        # COLUMN_MAP / _record), the first one the operator listed wins deterministically
        # rather than whatever order Meta's response happened to use. Any names Meta
        # returned that weren't configured are appended after, so raw_json stays complete.
        for name in metrics:
            if name in fetched:
                insights[name] = fetched[name]
        for name, value in fetched.items():
            if name not in insights:
                insights[name] = value
    return {**summary, **insights}


def _fetch_threads(client, remote_post_id: str, token: str, config, logger, pub_id,
                   surface: str = "feed") -> dict:
    # surface accepted and ignored — Threads has no Stories surface. See _fetch_facebook.
    """Unlike Facebook, Threads has no stable summary endpoint to fall back on — the
    insights call IS the only source. If it fails, let it raise: run_metrics' caller
    logs it and skips this snapshot rather than recording an all-null row."""
    metrics = [m.strip() for m in config.threads_insight_metrics.split(",") if m.strip()]
    return client.get_threads_insights(remote_post_id, token, metrics)


_FETCHERS = {
    "instagram": _fetch_instagram,
    "facebook": _fetch_facebook,
    "threads": _fetch_threads,
    # None means "this platform has no metrics" (a webhook / bot API has no insights
    # endpoint at all) — distinct from a platform simply missing from this dict, which
    # would mean someone forgot to register it.
    "discord": None,
    "telegram": None,
}

assert set(_FETCHERS) == set(SUPPORTED_PLATFORMS), (
    "metrics._FETCHERS and clients.SUPPORTED_PLATFORMS disagree"
)


def run_metrics(conn, config: Config, client, now, logger=None, client_for=None) -> int:
    """Fetch + store metrics for all due publications. Returns count fetched."""
    now_iso = now.isoformat()
    pick_client = client_for or (lambda _platform: client)
    due = publications_needing_metrics(
        conn, now, config.metrics_max_age_days, config.metrics_min_interval_hours
    )
    fetched = 0
    for pub in due:
        was_flagged = pub["metrics_refresh_requested_at"] is not None
        try:
            channel = conn.execute(
                "SELECT access_token, platform FROM channels WHERE id = ?",
                (pub["channel_id"],),
            ).fetchone()
            token = channel["access_token"] if channel else None
            if not token:
                continue
            platform = channel["platform"]
            if platform not in _FETCHERS:
                # Missing entirely from the registry — someone forgot to register this
                # platform. That's worth a log line every time it happens.
                if logger:
                    logger.info(
                        "[metrics pub %s] no metrics adapter for platform '%s'",
                        pub["id"], platform,
                    )
                continue
            fetch = _FETCHERS[platform]
            if fetch is None:
                # Registered as having no metrics endpoint at all (Discord, Telegram) —
                # expected, not a problem, so no per-cycle warning noise.
                if logger:
                    logger.debug(
                        "[metrics pub %s] platform '%s' has no metrics", pub["id"], platform,
                    )
                continue
            try:
                insights = fetch(
                    pick_client(platform), pub["remote_post_id"], token,
                    config, logger, pub["id"],
                    pub["surface"] if "surface" in pub.keys() else "feed",
                )
            except Exception as exc:  # noqa: BLE001 — a metrics fetch failure is non-fatal
                _note_failure(conn, pub, exc, now_iso, logger)
                continue
            _record(conn, pub["id"], now_iso, insights)
            _clear_failures(conn, pub)
            fetched += 1
        finally:
            if was_flagged:
                conn.execute(
                    "UPDATE publications SET metrics_refresh_requested_at = NULL WHERE id = ?",
                    (pub["id"],),
                )
                conn.commit()
    if logger and fetched:
        logger.info("[metrics] fetched %d snapshot(s)", fetched)
    return fetched
