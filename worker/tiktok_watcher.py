"""Did the creator ever publish the video we delivered?

The worker hands a video to TikTok's inbox and the creator finishes the post themselves,
so nothing in the publish path can know whether it went live. This loop asks, on a slow
cadence, until TikTok answers or the window closes.

**Two facts, not one.** A real delivery (spec R1, answered 2026-08-23) showed these arrive
independently:

  * `PUBLISH_COMPLETE` — the creator published it. Immediate, and unaffected by who can
    see it.
  * `publicaly_available_post_id` — a METRICS key. TikTok returns it only for a video that
    is PUBLIC and through moderation.

Promoting on the post id, as this was first designed to do, would leave a video published
to Friends Only stuck reading "waiting in your inbox" forever — it is live, it simply has
no public id and never will. So publication is decided by the status, and the post id is
recorded separately when it shows up, which may be later or never.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from . import db

# Cadence: often at first (most creators publish soon after the notification), then rarely.
FAST_INTERVAL = timedelta(minutes=15)
FAST_WINDOW = timedelta(hours=6)
SLOW_INTERVAL = timedelta(hours=1)

# After a week, stop asking. 'gave_up' means "we do not know", which is the truth — not
# that it failed, and not that it published.
GIVE_UP_AFTER = timedelta(days=7)


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def _due(pub, now) -> bool:
    published = _parse(pub["published_at"])
    checked = _parse(pub["delivery_checked_at"])
    if checked is None:
        return True
    age = now - published if published else timedelta(0)
    interval = FAST_INTERVAL if age <= FAST_WINDOW else SLOW_INTERVAL
    return now - checked >= interval


def run_tiktok_watcher(conn, config, client, now, logger=None, client_for=None) -> int:
    """Check delivered TikTok sends for publication. Returns how many were asked about.

    Read-only against TikTok, so it runs in dry-run mode too — but dry-run PUBLICATIONS are
    skipped, since nothing was ever delivered for them.
    """
    rows = conn.execute(
        """
        SELECT pub.* FROM publications pub
        JOIN channels ch ON ch.id = pub.channel_id
        WHERE ch.platform = 'tiktok'
          AND pub.status = 'posted'
          AND pub.is_dry_run = 0
          AND pub.remote_container_id IS NOT NULL
          AND (
                pub.delivery_state = 'inbox'
                -- Still watched after promotion: a creator can publish privately and make
                -- it public later, and the post id only appears at that point. Dropping
                -- the row at 'published' would lose its metrics permanently.
             OR (pub.delivery_state = 'published' AND pub.remote_post_id IS NULL)
          )
        ORDER BY pub.id
        """
    ).fetchall()

    checked = 0
    for pub in rows:
        if not _due(pub, now):
            continue

        channel = db.get_channel(conn, pub["channel_id"])
        pub_client = client_for("tiktok") if client_for else client
        try:
            from .tiktok_tokens import refresh_channel_token

            channel = refresh_channel_token(
                conn, config, pub_client, channel, now, logger=logger
            )
            data = pub_client.fetch_publish_status(
                channel["access_token"], pub["remote_container_id"]
            )
        except Exception as exc:  # noqa: BLE001 — a failed check is evidence of nothing
            if logger:
                logger.warning("[tiktok watcher] pub %s check failed: %s", pub["id"], exc)
            # Deliberately no state change and no delivery_checked_at stamp: a network
            # blip must not push the next attempt an hour away.
            continue
        checked += 1

        fields: dict = {"delivery_checked_at": now.isoformat(), "updated_at": now.isoformat()}
        status = data.get("status")
        post_ids = data.get("publicaly_available_post_id") or []

        if status == "PUBLISH_COMPLETE" and pub["delivery_state"] != "published":
            fields["delivery_state"] = "published"
            if logger:
                logger.info("[tiktok watcher] pub %s is live on TikTok", pub["id"])
        if post_ids and not pub["remote_post_id"]:
            # The metrics due-query gates on this column, so writing it is what admits the
            # row to the metrics loop — nothing else needs to know TikTok exists.
            fields["remote_post_id"] = str(post_ids[0])
            if logger:
                logger.info("[tiktok watcher] pub %s public post id %s",
                            pub["id"], post_ids[0])

        published = _parse(pub["published_at"])
        if (
            "delivery_state" not in fields
            and pub["delivery_state"] == "inbox"
            and published is not None
            and now - published >= GIVE_UP_AFTER
        ):
            fields["delivery_state"] = "gave_up"
            if logger:
                logger.info("[tiktok watcher] pub %s unconfirmed after %s; giving up",
                            pub["id"], GIVE_UP_AFTER)

        db.update_publication(conn, pub["id"], **fields)
    return checked
