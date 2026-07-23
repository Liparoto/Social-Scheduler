"""Per-channel auto-fill: keep each channel's queue topped up.

When a channel's scheduled-ahead depth drops below its min_queue_depth, refill it to
target_queue_depth by selecting content with these ordered rules (per channel):

  1. Never posted to this channel yet.
  2. Not posted to this channel within reuse_min_age_days (recyclable by age).
     — content posted MORE recently than that is excluded entirely.
  3. Among the recyclable pool, prefer top performers on THIS channel (reach + saves).

Realized as one ranking: tier gate (0 = never, 1 = recyclable) then performance desc,
then staleness, then age of the content. This captures all three rules coherently and
is testable tier-by-tier.
"""

from __future__ import annotations

import json
from datetime import timedelta

from . import db
from .config import Config
from .scheduling import parse_iso, parse_weekly_cadence, weekly_slots

ACTIVE_QUEUE_STATUSES = ("scheduled", "pending_approval", "publishing")


def scheduled_ahead_count(conn, channel_id: int, now_iso: str) -> int:
    """How many publications are queued ahead (future, not yet posted) for a channel."""
    row = conn.execute(
        f"""
        SELECT COUNT(*) FROM publications
        WHERE channel_id = ?
          AND status IN ({",".join("?" * len(ACTIVE_QUEUE_STATUSES))})
          AND scheduled_at > ?
        """,
        (channel_id, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]


def latest_future_scheduled(conn, channel_id: int, now_iso: str) -> str | None:
    row = conn.execute(
        f"""
        SELECT MAX(scheduled_at) FROM publications
        WHERE channel_id = ?
          AND status IN ({",".join("?" * len(ACTIVE_QUEUE_STATUSES))})
          AND scheduled_at > ?
        """,
        (channel_id, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]


def select_candidates(conn, channel_id: int, reuse_min_age_days: int, now, limit: int):
    """Return up to `limit` post ids to enqueue, in selection-rule order."""
    cutoff = (now - timedelta(days=reuse_min_age_days)).isoformat()
    rows = conn.execute(
        f"""
        SELECT
          p.id AS post_id,
          (SELECT MAX(pub.published_at) FROM publications pub
             WHERE pub.post_id = p.id AND pub.channel_id = :cid AND pub.status = 'posted'
          ) AS last_posted,
          (SELECT COALESCE(MAX(IFNULL(pm.reach,0) + IFNULL(pm.saves,0)), 0)
             FROM post_metrics pm
             JOIN publications p3 ON p3.id = pm.publication_id
             WHERE p3.post_id = p.id AND p3.channel_id = :cid
          ) AS perf
        FROM posts p
        WHERE p.post_type IN ('single','carousel')
          AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id)
          AND NOT EXISTS (
             SELECT 1 FROM publications q
             WHERE q.post_id = p.id AND q.channel_id = :cid
               AND q.status IN ({",".join("'" + s + "'" for s in ACTIVE_QUEUE_STATUSES)})
          )
          AND (
             (SELECT MAX(pub.published_at) FROM publications pub
                WHERE pub.post_id = p.id AND pub.channel_id = :cid AND pub.status = 'posted'
             ) IS NULL
             OR
             (SELECT MAX(pub.published_at) FROM publications pub
                WHERE pub.post_id = p.id AND pub.channel_id = :cid AND pub.status = 'posted'
             ) <= :cutoff
          )
        ORDER BY
          CASE WHEN last_posted IS NULL THEN 0 ELSE 1 END ASC,  -- never-posted first
          perf DESC,                                            -- then top performers
          last_posted ASC,                                      -- then stalest
          p.created_at ASC
        LIMIT :limit
        """,
        {"cid": channel_id, "cutoff": cutoff, "limit": limit},
    ).fetchall()
    return rows


def run_autofill(conn, config: Config, now, logger=None) -> int:
    """Top up every autofill-enabled channel. Returns total publications created."""
    now_iso = now.isoformat()
    channels = conn.execute(
        "SELECT * FROM channels WHERE is_active = 1 AND autofill_enabled = 1"
    ).fetchall()

    created_total = 0
    for ch in channels:
        cadence = parse_weekly_cadence(ch["cadence_config"])
        if cadence is None:
            if logger:
                logger.info("[autofill %s] no valid cadence — skipping", ch["account_name"])
            continue

        ahead = scheduled_ahead_count(conn, ch["id"], now_iso)
        if ahead >= ch["min_queue_depth"]:
            continue  # queue is healthy
        need = ch["target_queue_depth"] - ahead
        if need <= 0:
            continue

        candidates = select_candidates(conn, ch["id"], ch["reuse_min_age_days"], now, need)
        if not candidates:
            if logger:
                logger.info(
                    "[autofill %s] queue low (%d/%d) but no eligible content",
                    ch["account_name"], ahead, ch["min_queue_depth"],
                )
            continue

        weekdays, hour, minute = cadence
        last_future = latest_future_scheduled(conn, ch["id"], now_iso)
        after = parse_iso(last_future) if last_future else now
        slots = weekly_slots(weekdays, hour, minute, ch["timezone"], after, len(candidates))

        status = "pending_approval" if ch["requires_approval"] else "scheduled"
        made = 0
        for cand, slot in zip(candidates, slots):
            conn.execute(
                """INSERT INTO publications
                     (post_id, channel_id, scheduled_at, status, created_by)
                   VALUES (?, ?, ?, ?, 'autofill')""",
                (cand["post_id"], ch["id"], slot.isoformat(), status),
            )
            made += 1
        conn.commit()
        created_total += made
        if logger and made:
            logger.info(
                "[autofill %s] queue %d/%d -> added %d (target %d)",
                ch["account_name"], ahead, ch["min_queue_depth"], made,
                ch["target_queue_depth"],
            )
    return created_total
