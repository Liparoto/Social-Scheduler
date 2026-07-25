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
from .clients import PLATFORM_CAPS
from .config import Config
from .periods import in_season, local_date, period_from_row
from .scheduling import parse_iso, parse_weekly_cadence, weekly_date_slots
from .time_of_day import band_times, post_bands, resolve_slot_time

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


def select_candidates(conn, channel_id: int, now):
    """SQL-gated, ordered candidate posts for a channel. Cooldown/one-time/period gates
    are applied afterward in `eligible_candidates` (Python — clearer for date math).

    Gates here: status ready, targets this channel, supported type for this channel's
    platform, not already queued. Ordered: never-posted first, then performance desc,
    then stalest, then oldest.

    Type eligibility is capability-driven, not a hardcoded type list: a single/carousel
    post is eligible if it has at least one asset (unchanged); a text post is eligible
    only if the channel's platform declares supports_text in PLATFORM_CAPS. A platform
    PLATFORM_CAPS doesn't recognize excludes text posts (the safe direction) rather than
    guessing.
    """
    platform_row = conn.execute(
        "SELECT platform FROM channels WHERE id = ?", (channel_id,)
    ).fetchone()
    platform = platform_row["platform"] if platform_row else None
    caps = PLATFORM_CAPS.get(platform)
    supports_text = 1 if caps is not None and caps.supports_text else 0

    rows = conn.execute(
        f"""
        SELECT
          p.id AS post_id,
          p.content_kind AS content_kind,
          p.cooldown_days AS cooldown_days,
          (SELECT MAX(pub.published_at) FROM publications pub
             WHERE pub.post_id = p.id AND pub.channel_id = :cid AND pub.status = 'posted'
               AND pub.is_dry_run = 0
          ) AS last_posted,
          (SELECT COALESCE(MAX(IFNULL(pm.reach,0) + IFNULL(pm.saves,0)), 0)
             FROM post_metrics pm
             JOIN publications p3 ON p3.id = pm.publication_id
             WHERE p3.post_id = p.id AND p3.channel_id = :cid
          ) AS perf
        FROM posts p
        WHERE p.content_status = 'ready'
          AND (
            (p.post_type IN ('single','carousel')
               AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id))
            OR (p.post_type = 'text' AND :supports_text = 1)
          )
          AND EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.channel_id = :cid)
          AND NOT EXISTS (
             SELECT 1 FROM publications q
             WHERE q.post_id = p.id AND q.channel_id = :cid
               AND q.status IN ({",".join("'" + s + "'" for s in ACTIVE_QUEUE_STATUSES)})
          )
        ORDER BY
          CASE WHEN last_posted IS NULL THEN 0 ELSE 1 END ASC,
          perf DESC,
          last_posted ASC,
          p.created_at ASC
        """,
        {"cid": channel_id, "supports_text": supports_text},
    ).fetchall()
    return rows


def _post_periods(conn, post_id: int):
    """Return (green_periods, blackout_periods) for a post."""
    green, blackout = [], []
    for row in conn.execute(
        """SELECT pp.mode AS mode, pe.*
             FROM post_periods pp JOIN periods pe ON pe.id = pp.period_id
            WHERE pp.post_id = ?""",
        (post_id,),
    ).fetchall():
        (green if row["mode"] == "green" else blackout).append(period_from_row(row))
    return green, blackout


def eligible_candidates(conn, channel, now, limit: int):
    """Apply cooldown, one-time, and period gates to the SQL candidates; return <= limit."""
    reuse_default = channel["reuse_min_age_days"]
    today_local = local_date(now, channel["timezone"])
    out = []
    for r in select_candidates(conn, channel["id"], now):
        last = r["last_posted"]
        if r["content_kind"] == "one_time":
            if last is not None:
                continue  # one-time: only if this channel hasn't posted it
        elif last is not None:
            cooldown = r["cooldown_days"] if r["cooldown_days"] is not None else reuse_default
            if parse_iso(last) > now - timedelta(days=cooldown):
                continue  # still within cooldown
        green, blackout = _post_periods(conn, r["post_id"])
        if not in_season(green, blackout, today_local):
            continue
        out.append(r)
        if len(out) >= limit:
            break
    return out


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

        candidates = eligible_candidates(conn, ch, now, need)
        if not candidates:
            if logger:
                logger.info(
                    "[autofill %s] queue low (%d/%d) but no eligible content",
                    ch["account_name"], ahead, ch["min_queue_depth"],
                )
            continue

        weekdays, hour, minute = cadence
        cadence_hm = (hour, minute)
        bt_map = band_times(config)
        last_future = latest_future_scheduled(conn, ch["id"], now_iso)
        after = parse_iso(last_future) if last_future else now
        # Each candidate's slot TIME comes from its time_of_day tag; the cadence
        # still supplies which DAYS (one auto-post per active day).
        per_candidate_times = [
            resolve_slot_time(post_bands(conn, cand["post_id"]), bt_map, cadence_hm)
            for cand in candidates
        ]
        slots = weekly_date_slots(weekdays, ch["timezone"], after, per_candidate_times)

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
