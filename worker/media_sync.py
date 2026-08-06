"""Media sync — mirror each account's own post list into remote_media.

This is what makes the Insights hub account-wide rather than scheduler-wide. post_metrics
can only describe posts this tool published; remote_media describes every post that exists
on the account, including ones made from the phone and ones predating this install.

Read-only against the API, so it runs even under DRY_RUN — a fresh clone gets a populated
hub before it ever posts for real.

Two things worth knowing about the shape of this job:

**Listing is cheap; insights are not.** 988 posts is ~10 listing calls but ~988 insight
calls. So this job does NOT persist a pagination cursor to resume a partial crawl — it
simply re-walks from the newest page each cycle, which costs a handful of calls and is
self-healing (it picks up edited captions and deletions for free). The expensive per-post
insight fetching is a separate job with its own budget.

**Upserts, not inserts.** remote_media is unique on (channel_id, remote_post_id), so
re-walking the same pages is idempotent by construction rather than by careful bookkeeping.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from .clients import SUPPORTED_PLATFORMS


class CallBudget:
    """Per-cycle spending limit for API calls, plus Meta's own throttle signal.

    A backfill cannot finish in one cycle, and pushing into a throttle would also block
    PUBLISHING — which matters far more than metrics being a few hours stale. So the job
    stops early and resumes next cycle rather than spending to the limit.
    """

    def __init__(self, max_calls: int, usage_ceiling_pct: int) -> None:
        self.remaining = max_calls
        self.usage_ceiling_pct = usage_ceiling_pct
        self.stopped_reason: str | None = None

    def spend(self) -> None:
        self.remaining -= 1

    def exhausted(self, client) -> bool:
        if self.remaining <= 0:
            self.stopped_reason = "per-cycle call budget reached"
            return True
        # None means the header was absent — "unknown", which must NOT be read as
        # "plenty left", but also cannot justify refusing to work. Proceed and let the
        # call budget be the bound.
        usage = getattr(client, "last_usage_pct", None)
        if usage is not None and usage >= self.usage_ceiling_pct:
            self.stopped_reason = f"Meta reports {usage}% of rate limit used"
            return True
        if getattr(client, "retry_after_seconds", 0) > 0:
            self.stopped_reason = "Meta is currently throttling this app"
            return True
        return False


def parse_meta_timestamp(raw: str | None) -> str | None:
    """Meta returns '2026-08-06T01:00:24+0000' — ISO-8601 with a colon-less offset.

    Normalised to UTC ISO with a colon so it string-compares correctly against the
    published_at values already stored elsewhere in this database. Sorting and range
    filtering are done as string comparisons in SQL, so a mixed format would silently
    produce wrong windows rather than an error.
    """
    if not raw:
        return None
    text = str(raw).strip()
    try:
        # '+0000' -> '+00:00' (fromisoformat is strict about this before 3.11)
        if len(text) >= 5 and text[-5] in "+-" and ":" not in text[-5:]:
            text = f"{text[:-2]}:{text[-2:]}"
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _map_instagram(item: dict) -> dict:
    return {
        "remote_post_id": item.get("id"),
        "media_type": item.get("media_type"),
        "media_product_type": item.get("media_product_type"),
        "permalink": item.get("permalink"),
        "caption": item.get("caption"),
        "thumbnail_url": item.get("thumbnail_url") or item.get("media_url"),
        "published_at": parse_meta_timestamp(item.get("timestamp")),
    }


def _map_threads(item: dict) -> dict:
    # Threads calls the caption `text` and has no media_product_type. Mapping it to None
    # rather than inventing 'FEED' keeps "this platform has no such concept" honest.
    return {
        "remote_post_id": item.get("id"),
        "media_type": item.get("media_type"),
        "media_product_type": None,
        "permalink": item.get("permalink"),
        "caption": item.get("text"),
        "thumbnail_url": item.get("thumbnail_url"),
        "published_at": parse_meta_timestamp(item.get("timestamp")),
    }


def _list_instagram(client, channel, page_size, next_url):
    return client.get_user_media(
        channel["remote_account_id"], channel["access_token"],
        limit=page_size, next_url=next_url,
    )


def _list_threads(client, channel, page_size, next_url):
    return client.get_threads_user_media(
        channel["remote_account_id"], channel["access_token"],
        limit=page_size, next_url=next_url,
    )


# One (list, map) pair per platform. None means "this platform has no media-list edge" —
# the same explicit-None convention metrics._FETCHERS uses, so a platform that is simply
# missing from the dict is a registration bug rather than an intentional gap.
_ADAPTERS = {
    "instagram": (_list_instagram, _map_instagram),
    "threads": (_list_threads, _map_threads),
    "facebook": None,   # Page feed sync lands in phase 5
    "discord": None,
    "telegram": None,
}

assert set(_ADAPTERS) == set(SUPPORTED_PLATFORMS), (
    "media_sync._ADAPTERS and clients.SUPPORTED_PLATFORMS disagree"
)


def _upsert_media(conn, channel_id: int, fields: dict, raw: dict, now_iso: str) -> None:
    """Insert or refresh one post.

    The UPDATE deliberately does NOT touch publication_id or first_seen_at: the first is
    owned by the linking step below, the second records when WE first saw the post and
    would be meaningless if it moved. is_deleted is reset because seeing a post again
    means it is back (or was never gone).
    """
    conn.execute(
        """
        INSERT INTO remote_media
            (channel_id, remote_post_id, media_type, media_product_type, permalink,
             caption, thumbnail_url, published_at, raw_json, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (channel_id, remote_post_id) DO UPDATE SET
            media_type         = excluded.media_type,
            media_product_type = excluded.media_product_type,
            permalink          = excluded.permalink,
            caption            = excluded.caption,
            thumbnail_url      = excluded.thumbnail_url,
            published_at       = excluded.published_at,
            raw_json           = excluded.raw_json,
            last_synced_at     = excluded.last_synced_at,
            is_deleted         = 0
        """,
        (
            channel_id, fields["remote_post_id"], fields["media_type"],
            fields["media_product_type"], fields["permalink"], fields["caption"],
            fields["thumbnail_url"], fields["published_at"], json.dumps(raw), now_iso,
        ),
    )


def _link_publications(conn, channel_id: int) -> int:
    """Point remote_media rows at the publication that created them, where one exists.

    Matched on remote_post_id, which is the only identifier both sides share. Dry-run
    publications are excluded explicitly: they all carry the literal 'DRYRUN' as their
    remote id, so without this guard every dry-run row on a channel would collide onto
    one remote post.
    """
    return conn.execute(
        """
        UPDATE remote_media SET publication_id = (
            SELECT p.id FROM publications p
            WHERE p.channel_id     = remote_media.channel_id
              AND p.remote_post_id = remote_media.remote_post_id
              AND p.is_dry_run     = 0
              AND p.remote_post_id != 'DRYRUN'
            ORDER BY p.id LIMIT 1
        )
        WHERE channel_id = ? AND publication_id IS NULL
          AND EXISTS (
            SELECT 1 FROM publications p
            WHERE p.channel_id     = remote_media.channel_id
              AND p.remote_post_id = remote_media.remote_post_id
              AND p.is_dry_run     = 0
              AND p.remote_post_id != 'DRYRUN'
          )
        """,
        (channel_id,),
    ).rowcount


def sync_channel_media(conn, config, client, channel, now, budget, logger=None) -> dict:
    """Walk one channel's media list and upsert what it finds.

    Returns a summary dict. Never raises for API failures — a channel whose token expired
    must not stop the other channels from syncing.
    """
    adapter = _ADAPTERS.get(channel["platform"])
    if adapter is None:
        return {"skipped": "platform has no media list"}
    list_page, map_item = adapter

    now_iso = now.isoformat()
    age_cutoff = (now - timedelta(days=config.media_sync_max_age_days)).isoformat()

    # How far to walk. The first run crawls history; afterwards it re-walks a bounded
    # REFRESH WINDOW off the top rather than stopping at the newest post already held.
    #
    # Stopping at the newest known post is the obvious optimisation and it is wrong: it
    # means no existing row is ever revisited, so an edited caption never propagates and
    # a deleted post is never noticed. The hub would drift from reality permanently and
    # silently. Re-walking a page or two costs a couple of calls and buys correctness.
    post_cap = (
        config.media_sync_refresh_posts
        if channel["media_backfill_complete"]
        else config.media_sync_max_posts
    )

    seen_ids: list[str] = []
    next_url = None
    pages = 0
    completed_naturally = False
    oldest_walked: str | None = None
    # The oldest point this walk can vouch for having SEARCHED — which depends on why it
    # stopped, not on what it happened to find. Deriving it from the oldest post found
    # is subtly wrong: when a post is deleted, the walk's oldest find moves UP past it,
    # placing the very post we should flag outside the window. None means "searched all
    # the way down" (the pages ran out), which is the only case where absence anywhere
    # is real evidence of deletion.
    search_floor: str | None = None
    # Counted by row total rather than by sqlite3's total_changes: an ON CONFLICT DO
    # UPDATE also bumps total_changes, so that would report every re-synced post as new.
    count_before = conn.execute(
        "SELECT COUNT(*) AS c FROM remote_media WHERE channel_id = ?", (channel["id"],)
    ).fetchone()["c"]

    while True:
        if budget.exhausted(client):
            break
        budget.spend()
        items, next_url = list_page(client, channel, config.media_sync_page_size, next_url)
        pages += 1

        stop = False
        for item in items:
            fields = map_item(item)
            if not fields["remote_post_id"]:
                continue
            published = fields["published_at"]

            # Both bounds are checked against the ITEM, not the page: /media returns
            # newest-first, so the first out-of-range item means every later one is too.
            if published and published < age_cutoff:
                # Everything at or above the cutoff was searched; below it, nothing was.
                stop = completed_naturally = True
                search_floor = age_cutoff
                break

            _upsert_media(conn, channel["id"], fields, item, now_iso)
            seen_ids.append(fields["remote_post_id"])
            if published and (oldest_walked is None or published < oldest_walked):
                oldest_walked = published

            if len(seen_ids) >= post_cap:
                # We deliberately stopped mid-history: nothing older than the last post
                # taken was looked at, so that post is the floor.
                stop = completed_naturally = True
                search_floor = oldest_walked
                break

        if stop or not next_url:
            completed_naturally = completed_naturally or not next_url
            break

    conn.commit()
    new_rows = conn.execute(
        "SELECT COUNT(*) AS c FROM remote_media WHERE channel_id = ?", (channel["id"],)
    ).fetchone()["c"] - count_before
    linked = _link_publications(conn, channel["id"])
    deleted = 0
    if completed_naturally and seen_ids:
        deleted = _mark_missing_as_deleted(conn, channel["id"], seen_ids, search_floor)

    conn.execute(
        "UPDATE channels SET media_synced_at = ?, media_backfill_complete = ?, "
        "insights_error = NULL WHERE id = ?",
        (now_iso, 1 if completed_naturally else channel["media_backfill_complete"],
         channel["id"]),
    )
    conn.commit()

    summary = {
        "pages": pages, "seen": len(seen_ids), "new": new_rows,
        "linked": linked, "marked_deleted": deleted,
        "complete": completed_naturally,
    }
    if logger:
        logger.info(
            "[media_sync ch %s] %d page(s), %d post(s), %d new, %d linked, %d gone%s",
            channel["id"], pages, len(seen_ids), new_rows, linked, deleted,
            "" if completed_naturally else f" (paused: {budget.stopped_reason})",
        )
    return summary


def _mark_missing_as_deleted(conn, channel_id: int, seen_ids: list[str],
                             search_floor: str | None) -> int:
    """Flag posts we hold that the account no longer lists.

    Flagged, never deleted: their metrics history is still true for the period they were
    live, and hard-deleting would silently rewrite past charts.

    Absence is only evidence WITHIN the range actually searched. `search_floor` is the
    oldest point this walk can vouch for; below it nothing was looked at, so a missing
    post there proves nothing. None means the pages ran out — the whole account was seen,
    so anything missing really is gone.
    """
    if not seen_ids:
        return 0
    placeholders = ",".join("?" for _ in seen_ids)
    floor_clause = "AND published_at >= ?" if search_floor else ""
    params = [channel_id]
    if search_floor:
        params.append(search_floor)
    params.extend(seen_ids)
    return conn.execute(
        f"""
        UPDATE remote_media SET is_deleted = 1
        WHERE channel_id = ?
          AND is_deleted = 0
          AND published_at IS NOT NULL
          {floor_clause}
          AND remote_post_id NOT IN ({placeholders})
        """,
        params,
    ).rowcount


def run_media_sync(conn, config, client=None, now=None, logger=None, client_for=None) -> int:
    """Sync every active channel that has a media-list adapter. Returns channels synced.

    Signature mirrors run_metrics: `client_for` resolves the right Graph host per
    platform, falling back to a single shared client when a caller has only one.
    """
    pick_client = client_for or (lambda _platform: client)
    budget = CallBudget(config.insights_max_calls_per_cycle, config.insights_usage_pct_ceiling)
    rows = conn.execute("SELECT * FROM channels WHERE is_active = 1").fetchall()
    synced = 0
    for channel in rows:
        if _ADAPTERS.get(channel["platform"]) is None:
            continue
        if not channel["access_token"] or not channel["remote_account_id"]:
            continue
        due = _is_due(channel, now, config)
        if not due:
            continue
        try:
            client_obj = pick_client(channel["platform"])
            sync_channel_media(conn, config, client_obj, channel, now, budget, logger=logger)
            synced += 1
        except Exception as exc:  # noqa: BLE001 — one bad channel must not stop the rest
            from .redact import redact

            message = redact(str(exc))
            conn.execute(
                "UPDATE channels SET insights_error = ? WHERE id = ?",
                (message[:500], channel["id"]),
            )
            conn.commit()
            if logger:
                logger.info("[media_sync ch %s] failed: %s", channel["id"], message)
        if budget.exhausted(pick_client(channel["platform"])):
            if logger:
                logger.info("[media_sync] stopping early — %s", budget.stopped_reason)
            break
    return synced


def _is_due(channel, now, config) -> bool:
    """Never synced, an unfinished backfill, a manual request, or past the interval."""
    if channel["insights_refresh_requested"]:
        return True
    if not channel["media_backfill_complete"]:
        return True
    last = channel["media_synced_at"]
    if not last:
        return True
    cutoff = (now - timedelta(hours=config.insights_sync_interval_hours)).isoformat()
    return last <= cutoff
