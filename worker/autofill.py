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
from .publisher import _select_caption
from .scheduling import parse_iso, parse_weekly_cadence, weekly_date_slots
from .time_of_day import band_times, post_bands, resolve_slot_time

ACTIVE_QUEUE_STATUSES = ("scheduled", "pending_approval", "publishing")

# The media-type capability test, shared by select_candidates (which also applies the
# rules) and capable_post_ids (which applies capability ONLY). Kept in one place so the
# two can never drift: if they did, a group would mistake a capability miss for a rule
# miss and block every member instead of letting one sit the slot out.
# Binds :supports_text and :supports_video; references the `posts p` alias.
_TYPE_CAPABILITY_SQL = """
          (
            (p.post_type IN ('single','carousel')
               AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id))
            OR (p.post_type = 'reel' AND :supports_video = 1
               AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id))
            OR (p.post_type = 'text' AND :supports_text = 1)
          )
"""


def _platform_capability_params(platform: str | None) -> dict:
    """The :supports_text/:supports_video bindings for a platform. A platform
    PLATFORM_CAPS does not recognize supports neither — the safe direction."""
    caps = PLATFORM_CAPS.get(platform)
    return {
        "supports_text": 1 if caps is not None and caps.supports_text else 0,
        "supports_video": 1 if caps is not None and caps.supports_video else 0,
    }


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
    only if the channel's platform declares supports_text in PLATFORM_CAPS, and a reel
    only if it declares supports_video — a platform PLATFORM_CAPS doesn't recognize
    excludes both (the safe direction) rather than guessing. Reels are asset-gated the
    same as single/carousel here — the stricter "exactly one video asset" rule is the
    publisher's job (worker/publisher.py), not autofill's; autofill only needs to know a
    reel is a candidate at all. Without the supports_video gate, a reel targeted at a
    platform with no publish path for it (everything but Instagram today) would get
    selected, queued, and fail terminally every autofill cycle forever — 'failed' isn't
    in ACTIVE_QUEUE_STATUSES, so the "already queued" guard below never excludes it.
    """
    platform_row = conn.execute(
        "SELECT platform FROM channels WHERE id = ?", (channel_id,)
    ).fetchone()
    platform = platform_row["platform"] if platform_row else None
    cap_params = _platform_capability_params(platform)

    rows = conn.execute(
        f"""
        SELECT
          p.id AS post_id,
          p.post_type AS post_type,
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
          AND {_TYPE_CAPABILITY_SQL}
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
        {"cid": channel_id, **cap_params},
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


def _caption_too_long_for_channel(conn, channel, post_id: int, post_type: str) -> bool:
    """True when the caption this candidate would actually publish with on `channel`
    exceeds that channel's platform's caption limit for this post_type.

    Uses the SAME caption resolution the publisher uses at publish time
    (publisher._select_caption: platform-specific variant, else generic, else the
    post's base caption — rotated by how many times this post/channel pair has already
    posted) so this gate can't drift from what would actually be selected and sent.
    Mirroring instead of approximating matters here: a candidate that looks fine under a
    naive "just check post.caption" reading can still be the over-limit variant once
    rotation picks it.

    An evergreen post over a channel's limit must never be queued in the first place —
    once queued, the worker fails it terminally every retry, and evergreen content keeps
    getting re-selected, so it fails forever with nothing in the UI having warned.
    """
    caps = PLATFORM_CAPS.get(channel["platform"])
    if caps is None:
        return False
    limit = caps.caption_limit(post_type)
    if limit is None:
        return False
    used_count = conn.execute(
        "SELECT COUNT(*) FROM publications WHERE post_id=? AND channel_id=? AND status='posted'",
        (post_id, channel["id"]),
    ).fetchone()[0]
    caption = _select_caption(conn, post_id, channel["platform"], used_count)
    return caption is not None and len(caption) > limit


def capable_post_ids(conn, channel) -> set[int]:
    """Post ids this channel's platform can PHYSICALLY accept — media type and caption
    length only. Deliberately ignores every rule (targeting, cooldown, one-time,
    periods, already-queued).

    This exists so channel-group selection can tell the two kinds of rejection apart.
    A capability miss means that member sits the slot out (a Reel still goes to
    Instagram when a Threads member cannot take video); a RULE miss means the group is
    held back so its members never drift apart. Collapsing the two would silently end
    evergreen video recycling for any group containing Threads.
    """
    cap_params = _platform_capability_params(channel["platform"])
    rows = conn.execute(
        f"""
        SELECT p.id AS post_id, p.post_type AS post_type
        FROM posts p
        WHERE p.content_status = 'ready'
          AND {_TYPE_CAPABILITY_SQL}
        """,
        cap_params,
    ).fetchall()
    return {
        r["post_id"]
        for r in rows
        if not _caption_too_long_for_channel(conn, channel, r["post_id"], r["post_type"])
    }


def eligible_candidates(conn, channel, now, limit: int | None, *,
                        reuse_default=None, timezone_name=None):
    """Apply cooldown, one-time, period, and caption-length gates to the SQL candidates;
    return <= limit (or all of them when limit is None).

    reuse_default/timezone_name override the channel's own values. A grouped channel
    takes both from its group, so the group's cadence and cooldown policy govern every
    member; omit them and the channel's own columns are used exactly as before.
    """
    if reuse_default is None:
        reuse_default = channel["reuse_min_age_days"]
    if timezone_name is None:
        timezone_name = channel["timezone"]
    today_local = local_date(now, timezone_name)
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
        if _caption_too_long_for_channel(conn, channel, r["post_id"], r["post_type"]):
            # Over this channel's limit: never queue it here to fail terminally later.
            # Other channels (e.g. Instagram, no caption limit) still get to select it.
            continue
        out.append(r)
        if limit is not None and len(out) >= limit:
            break
    return out


def group_rank(conn, member_ids: list[int], post_ids) -> list:
    """Order `post_ids` by the group's tiering: never posted on ANY member first, then
    the BEST member's performance descending, then stalest, then oldest content.

    perf is MAX across members rather than SUM on purpose. Threads reports neither reach
    nor saves, so its contribution is always 0; summing would halve every score the
    moment a Threads member joined a group and scramble an ordering that is driven
    entirely by Instagram's real numbers. MAX means "how well did this do on its best
    member", which is the question the ranking is actually asking.
    """
    post_ids = list(post_ids)
    if not post_ids or not member_ids:
        return []
    mq = ",".join("?" * len(member_ids))
    pq = ",".join("?" * len(post_ids))
    return conn.execute(
        f"""
        SELECT
          p.id AS post_id,
          p.post_type AS post_type,
          (SELECT MAX(pub.published_at) FROM publications pub
             WHERE pub.post_id = p.id AND pub.channel_id IN ({mq})
               AND pub.status = 'posted' AND pub.is_dry_run = 0
          ) AS last_posted,
          (SELECT COALESCE(MAX(IFNULL(pm.reach,0) + IFNULL(pm.saves,0)), 0)
             FROM post_metrics pm
             JOIN publications p3 ON p3.id = pm.publication_id
             WHERE p3.post_id = p.id AND p3.channel_id IN ({mq})
          ) AS perf
        FROM posts p
        WHERE p.id IN ({pq})
        ORDER BY
          CASE WHEN last_posted IS NULL THEN 0 ELSE 1 END ASC,
          perf DESC,
          last_posted ASC,
          p.created_at ASC
        """,
        (*member_ids, *member_ids, *post_ids),
    ).fetchall()


def group_eligible_candidates(conn, group, members, now, limit: int | None):
    """Ranked (candidate_row, [member channels to receive it]) for a channel group.

    A post P is group-eligible when BOTH hold:
      1. at least one member is capable AND allowed, and
      2. every member that is CAPABLE is also ALLOWED.

    "Capable" is the platform question (media type, caption length); "allowed" is the
    rules question (targeting, content_status, cooldown, one-time, periods, already
    queued). The asymmetry is the whole design: a member that physically cannot take
    the content sits the slot out, but a member held back by a RULE stops everyone, so
    the accounts never drift apart on content they could both have had.

    Every member is evaluated under the GROUP's reuse_min_age_days and timezone, not
    its own — the group owns the cadence policy.
    """
    if not members:
        return []

    reuse_default = group["reuse_min_age_days"]
    tz_name = group["timezone"]

    capable: dict[int, set[int]] = {}
    allowed: dict[int, set[int]] = {}
    for m in members:
        capable[m["id"]] = capable_post_ids(conn, m)
        allowed[m["id"]] = {
            r["post_id"]
            for r in eligible_candidates(
                conn, m, now, None, reuse_default=reuse_default, timezone_name=tz_name
            )
        }

    # A post that is capable for a member but NOT allowed for it failed a rule — the
    # capability sets are what make that inference sound.
    recipients: dict[int, list] = {}
    for pid in set().union(*capable.values()):
        capable_members = [m for m in members if pid in capable[m["id"]]]
        if not capable_members:
            continue
        if all(pid in allowed[m["id"]] for m in capable_members):
            recipients[pid] = capable_members

    ranked = group_rank(conn, [m["id"] for m in members], recipients.keys())
    out = [(row, recipients[row["post_id"]]) for row in ranked]
    return out if limit is None else out[:limit]


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
