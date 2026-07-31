"""Auto-fill: keep each unit's queue topped up.

A UNIT is either a single ungrouped channel or a channel_group with its active members.
A group fills as one thing — one cadence, one selection decision, one slot, one
publication per member — so channels representing the same account never drift apart.

Selection rules (evaluated against the unit's settings):

  1. Never posted to this unit yet.
  2. Not posted within reuse_min_age_days (recyclable by age).
     - content posted MORE recently than that is excluded entirely.
  3. Among the recyclable pool, prefer top performers (reach + saves).

Realized as one ranking: tier gate (0 = never, 1 = recyclable) then performance desc,
then staleness, then age of the content. This captures all three rules coherently and
is testable tier-by-tier.

For a GROUP, performance is the MAX across members and "never posted" means never on any
member. Two kinds of rejection are distinguished: a platform CAPABILITY miss (media type,
caption length) lets that member sit the slot out, while a RULE miss (targeting, cooldown,
one-time, periods, already queued) holds the whole group back. See
group_eligible_candidates.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
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


def group_scheduled_ahead_count(conn, member_ids: list[int], now_iso: str) -> int:
    """How many future SLOTS a group has queued — distinct scheduled_at values across
    its members, not a row count.

    A group writes one row per member at a single timestamp, so counting rows would
    report a two-member group as twice as full as it is and stop refilling at half the
    target. Solo channels keep using scheduled_ahead_count (a plain row count) so their
    behaviour is byte-identical to before groups existed.
    """
    if not member_ids:
        return 0
    mq = ",".join("?" * len(member_ids))
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT COUNT(DISTINCT scheduled_at) FROM publications
        WHERE channel_id IN ({mq})
          AND status IN ({sq})
          AND scheduled_at > ?
        """,
        (*member_ids, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]


def group_latest_future_scheduled(conn, member_ids: list[int], now_iso: str) -> str | None:
    if not member_ids:
        return None
    mq = ",".join("?" * len(member_ids))
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT MAX(scheduled_at) FROM publications
        WHERE channel_id IN ({mq})
          AND status IN ({sq})
          AND scheduled_at > ?
        """,
        (*member_ids, *ACTIVE_QUEUE_STATUSES, now_iso),
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

    "Capable" is the platform question (media type, caption length, and content_status —
    it is enforced inside capable_post_ids, so a post that isn't 'ready' is a CAPABILITY
    miss, not a rule miss; it filters out identically for every member, so the label
    never changes the outcome); "allowed" is the rules question (targeting, cooldown,
    one-time, periods, already queued). The asymmetry is the whole design: a member that
    physically cannot take the content sits the slot out, but a member held back by a
    RULE stops everyone, so the accounts never drift apart on content they could both
    have had.

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


@dataclass
class AutofillUnit:
    """One thing auto-fill tops up. A channel_group with its active members, or a single
    ungrouped channel standing alone. `settings` carries cadence_config, timezone,
    min/target_queue_depth and reuse_min_age_days — the group and the channel share those
    column names precisely so this stays one code path."""

    label: str
    settings: object
    members: list
    is_group: bool


def _autofill_units(conn) -> list[AutofillUnit]:
    """Groups first, then ungrouped channels. A channel with group_id set is NEVER also
    returned as a solo unit, so it can't be topped up twice in one cycle."""
    units: list[AutofillUnit] = []
    for g in conn.execute(
        "SELECT * FROM channel_groups WHERE is_active = 1 AND autofill_enabled = 1"
    ).fetchall():
        members = conn.execute(
            "SELECT * FROM channels WHERE group_id = ? AND is_active = 1 ORDER BY id",
            (g["id"],),
        ).fetchall()
        units.append(AutofillUnit(g["name"], g, list(members), True))
    for ch in conn.execute(
        """SELECT * FROM channels
            WHERE is_active = 1 AND autofill_enabled = 1 AND group_id IS NULL"""
    ).fetchall():
        units.append(AutofillUnit(ch["account_name"], ch, [ch], False))
    return units


def _fill_unit(conn, unit: AutofillUnit, config: Config, now, now_iso: str, logger) -> int:
    """Top up one unit. Returns the number of publications created."""
    if unit.is_group and not unit.members:
        if logger:
            logger.info("[autofill %s] group has no active members — skipping", unit.label)
        return 0

    settings = unit.settings
    cadence = parse_weekly_cadence(settings["cadence_config"])
    if cadence is None:
        if logger:
            logger.info("[autofill %s] no valid cadence — skipping", unit.label)
        return 0

    member_ids = [m["id"] for m in unit.members]
    if unit.is_group:
        ahead = group_scheduled_ahead_count(conn, member_ids, now_iso)
        last_future = group_latest_future_scheduled(conn, member_ids, now_iso)
    else:
        ahead = scheduled_ahead_count(conn, member_ids[0], now_iso)
        last_future = latest_future_scheduled(conn, member_ids[0], now_iso)

    if ahead >= settings["min_queue_depth"]:
        return 0  # queue is healthy
    need = settings["target_queue_depth"] - ahead
    if need <= 0:
        return 0

    if unit.is_group:
        candidates = group_eligible_candidates(conn, settings, unit.members, now, need)
    else:
        ch = unit.members[0]
        candidates = [(r, [ch]) for r in eligible_candidates(conn, ch, now, need)]

    if not candidates:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but no eligible content",
                unit.label, ahead, settings["min_queue_depth"],
            )
        return 0

    weekdays, hour, minute = cadence
    cadence_hm = (hour, minute)
    bt_map = band_times(config)
    after = parse_iso(last_future) if last_future else now
    # Each candidate's slot TIME comes from its time_of_day tag; the cadence still
    # supplies which DAYS (one auto-post per active day).
    per_candidate_times = [
        resolve_slot_time(post_bands(conn, row["post_id"]), bt_map, cadence_hm)
        for row, _ in candidates
    ]
    slots = weekly_date_slots(weekdays, settings["timezone"], after, per_candidate_times)

    # All-or-nothing. sqlite3's default isolation means these inserts sit in an implicit
    # transaction, and run.py catches errors and REUSES this connection — so without the
    # rollback a failure mid-group (e.g. a member channel deleted in the dashboard since
    # _autofill_units read it; foreign keys are ON) would be silently committed by the
    # next cycle's heartbeat, leaving one member scheduled and the other not: exactly the
    # drift groups exist to prevent. The open transaction would also hold SQLite's writer
    # lock for a full poll interval, blocking the dashboard.
    made = 0
    try:
        for (row, recipients), slot in zip(candidates, slots):
            for member in recipients:
                # requires_approval stays a CHANNEL property — it describes the account,
                # not the schedule, so one member of a group may need approval and
                # another not.
                status = "pending_approval" if member["requires_approval"] else "scheduled"
                conn.execute(
                    """INSERT INTO publications
                         (post_id, channel_id, scheduled_at, status, created_by)
                       VALUES (?, ?, ?, ?, 'autofill')""",
                    (row["post_id"], member["id"], slot.isoformat(), status),
                )
                made += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    if logger and made:
        logger.info(
            "[autofill %s] queue %d/%d -> added %d publication(s) across %d channel(s) "
            "(target %d)",
            unit.label, ahead, settings["min_queue_depth"], made, len(unit.members),
            settings["target_queue_depth"],
        )
    return made


def run_autofill(conn, config: Config, now, logger=None) -> int:
    """Top up every auto-fill-enabled unit. Returns total publications created."""
    now_iso = now.isoformat()
    return sum(
        _fill_unit(conn, unit, config, now, now_iso, logger)
        for unit in _autofill_units(conn)
    )
