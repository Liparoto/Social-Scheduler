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
import math
from dataclasses import dataclass
from datetime import timedelta
from itertools import islice

from . import db
from .bpp import bpp_slot_indices
from .caption_length import caption_length
from .clients import PLATFORM_CAPS
from .config import Config
from .periods import in_season, local_date, period_from_row
from .publisher import _select_caption
from .scheduling import iter_slots, parse_cadence, parse_iso
from .time_of_day import BAND_ORDER, band_times, post_allows_band, post_bands
from .time_of_day import derive_band

ACTIVE_QUEUE_STATUSES = ("scheduled", "pending_approval", "publishing")

# scheduled_at holds a UTC instant, but not one canonical SPELLING of it: the worker
# writes datetime.isoformat() ("...+00:00") and the dashboard has written JS
# toISOString() ("....000Z"). Same moment, different text.
#
# That matters because a group writes one row per member at a single instant and counts
# SLOTS by distinctness. Compared as text, one slot written half by each writer counts as
# two — the queue reads as fuller than it is, and auto-fill quietly stops topping it up.
# No error, no failed publication, just nothing scheduled.
#
# So: compare INSTANTS, never text. SQLite parses both spellings to the same epoch.
# (strftime returns NULL on anything it cannot parse, which COUNT ignores and DESC sorts
# last — an unreadable timestamp can never inflate the count or win "latest".)
_INSTANT = "strftime('%s', scheduled_at)"

# The media-type capability test, shared by select_candidates (which also applies the
# rules) and capable_post_ids (which applies capability ONLY). Kept in one place so the
# two can never drift: if they did, a group would mistake a capability miss for a rule
# miss and block every member instead of letting one sit the slot out.
# Binds :supports_text and :supports_video; references the `posts p` alias.
_TYPE_CAPABILITY_SQL = """
          (
            (p.post_type IN ('single','carousel')
               AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id))
            OR (p.post_type = 'video' AND :supports_video = 1
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


def scheduled_ahead_count(conn, channel_id: int, now_iso: str, surface: str) -> int:
    """How many future SLOTS this channel has queued ON THIS SURFACE — distinct INSTANTS,
    not a row count and not distinct text (see _INSTANT).

    Two things make the surface filter load-bearing. Without it a healthy Story queue
    satisfies the FEED lane's `ahead >= min_queue_depth` check and the feed silently
    stops filling. And counting distinct instants rather than rows is what makes a
    four-slide Story — one slot, four publications — read as one post of queue depth
    instead of four. For a feed lane the two counts are identical, because a solo feed
    slot produces exactly one publication; the change is a no-op there and a correctness
    fix here.
    """
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT COUNT(DISTINCT {_INSTANT}) FROM publications
        WHERE channel_id = ?
          AND surface = ?
          AND status IN ({sq})
          AND scheduled_at > ?
        """,
        (channel_id, surface, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]


def latest_future_scheduled(conn, channel_id: int, now_iso: str, surface: str) -> str | None:
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT scheduled_at FROM publications
        WHERE channel_id = ?
          AND surface = ?
          AND status IN ({sq})
          AND scheduled_at > ?
        ORDER BY {_INSTANT} DESC, scheduled_at DESC
        LIMIT 1
        """,
        (channel_id, surface, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0] if row else None


def group_scheduled_ahead_count(conn, member_ids: list[int], now_iso: str, surface: str) -> int:
    """How many future SLOTS a group has queued ON THIS SURFACE — distinct INSTANTS across
    its members, not a row count and not distinct text (see _INSTANT).

    A group writes one row per member at a single timestamp, so counting rows would
    report a two-member group as twice as full as it is and stop refilling at half the
    target.
    """
    if not member_ids:
        return 0
    mq = ",".join("?" * len(member_ids))
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT COUNT(DISTINCT {_INSTANT}) FROM publications
        WHERE channel_id IN ({mq})
          AND surface = ?
          AND status IN ({sq})
          AND scheduled_at > ?
        """,
        (*member_ids, surface, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]


def group_latest_future_scheduled(conn, member_ids: list[int], now_iso: str, surface: str) -> str | None:
    if not member_ids:
        return None
    mq = ",".join("?" * len(member_ids))
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT scheduled_at FROM publications
        WHERE channel_id IN ({mq})
          AND surface = ?
          AND status IN ({sq})
          AND scheduled_at > ?
        ORDER BY {_INSTANT} DESC, scheduled_at DESC
        LIMIT 1
        """,
        (*member_ids, surface, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0] if row else None


def select_candidates(conn, channel_id: int, now, surface: str):
    """SQL-gated, ordered candidate posts for a channel. Cooldown/one-time/period gates
    are applied afterward in `eligible_candidates` (Python — clearer for date math).

    Gates here: status ready, targets this channel, supported type for this channel's
    platform, not already queued. Ordered: never-posted first, then performance desc,
    then stalest, then oldest.

    Type eligibility is capability-driven, not a hardcoded type list: a single/carousel
    post is eligible if it has at least one asset (unchanged); a text post is eligible
    only if the channel's platform declares supports_text in PLATFORM_CAPS, and a video
    post only if it declares supports_video — a platform PLATFORM_CAPS doesn't recognize
    excludes both (the safe direction) rather than guessing. Video posts are asset-gated
    the same as single/carousel here — the stricter "exactly one video asset" rule is the
    publisher's job (worker/publisher.py), not autofill's; autofill only needs to know a
    video post is a candidate at all. Without the supports_video gate, a video post
    targeted at a platform with no publish path for it (everything but Instagram today)
    would get selected, queued, and fail terminally every autofill cycle forever —
    'failed' isn't in ACTIVE_QUEUE_STATUSES, so the "already queued" guard below never
    excludes it.
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
          -- Auto-fill queues only posts explicitly targeted at THIS lane's surface.
          -- Matching on channel_id alone would send a Story-only post to the feed
          -- silently. A story lane is the exact mirror: nothing lands on a Story
          -- because auto-fill inferred it could.
          AND EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.channel_id = :cid
                        AND pt.surface = :surface)
          -- Surface-BLIND on purpose: a post already queued as a Story is also held out
          -- of the feed lane (and vice versa). This is the shared-cooldown principle
          -- applied to pending work, and it is what stops the same photo appearing on
          -- the feed and in Stories the same day. Do not add a surface predicate here.
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
        {"cid": channel_id, "surface": surface, **cap_params},
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
    # Must agree with publisher.py's gate — this decides whether autofill even offers the
    # post to this channel, and disagreeing would queue a send the publisher then refuses.
    return caption is not None and caption_length(caption) > limit


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


def eligible_candidates(conn, channel, now, limit: int | None, *, surface: str,
                        reuse_default=None, timezone_name=None, skip_cooldown=False):
    """Apply cooldown, one-time, period, and caption-length gates to the SQL candidates;
    return <= limit (or all of them when limit is None).

    reuse_default/timezone_name are the LANE's policy: a grouped channel takes both from
    its group and an ungrouped one from its own lane row, so the cadence and cooldown
    policy that governs is the one the dashboard actually writes.

    Omitting them falls back to the channel's own columns. That fallback exists only for
    direct callers (tests, one-off scripts) — `channels.reuse_min_age_days` has been
    frozen and unwritten since migration 0028, so every production call site MUST pass
    reuse_default. _fill_unit once did not, and the owner's setting was write-only.
    """
    if reuse_default is None:
        reuse_default = channel["reuse_min_age_days"]
    if timezone_name is None:
        timezone_name = channel["timezone"]
    today_local = local_date(now, timezone_name)
    out = []
    for r in select_candidates(conn, channel["id"], now, surface):
        last = r["last_posted"]
        if r["content_kind"] == "one_time":
            if last is not None:
                continue  # one-time: only if this channel hasn't posted it
        elif last is not None and skip_cooldown:
            # A BPP pool ignores the reuse window — the owner marked the post AND set the
            # frequency, so the cadence is the decision. One-time content is still
            # excluded above: "never repost this" outranks "repost my best".
            pass
        elif last is not None:
            cooldown = r["cooldown_days"] if r["cooldown_days"] is not None else reuse_default
            if parse_iso(last) > now - timedelta(days=cooldown):
                continue  # still within cooldown
        green, blackout = _post_periods(conn, r["post_id"])
        if not in_season(green, blackout, today_local):
            continue
        if surface == "feed" and _caption_too_long_for_channel(
            conn, channel, r["post_id"], r["post_type"]
        ):
            # Over this channel's limit: never queue it here to fail terminally later.
            # Other channels (e.g. Instagram, no caption limit) still get to select it.
            #
            # Feed only. A Story sends NO caption — worker/publisher.py suppresses it
            # unconditionally and _validate runs no caption check on the story branch —
            # so applying the limit here would silently exclude every long-caption post
            # from the Story rotation over a rule that will never be applied to it.
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


def group_eligible_candidates(conn, group, members, now, limit: int | None, *,
                              surface: str, skip_cooldown=False):
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
                conn, m, now, None, surface=surface, reuse_default=reuse_default,
                timezone_name=tz_name, skip_cooldown=skip_cooldown,
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
class AutofillLane:
    """One thing auto-fill tops up: an owner (a channel_group with its active members, or
    an ungrouped channel standing alone) PLUS a surface.

    A group with a feed lane and a story lane is two lanes, topped up independently —
    separate queue-depth maths, separate candidate pools, separate slot walks. That
    independence is the whole feature: see docs/design-autofill-lanes.md.

    `settings` is the lane row merged with the owner's `timezone` and `bpp_*` dials, which
    stay stored on the owner. The merge is not cosmetic: `_setting` swallows a missing
    column and returns its default, so a `settings` that dropped `bpp_every_days` would
    not raise — the BPP step would read 0, conclude "off", and silently stop recycling
    with nothing logged.
    """

    label: str
    surface: str
    settings: dict
    members: list
    is_group: bool


# Owner columns that travel with every lane, because the file already reads them off
# `settings` and they describe the ACCOUNT rather than the schedule.
_OWNER_SETTINGS = ("timezone", "bpp_every_days", "bpp_strong_pct", "bpp_broad_pct")


def _lane_settings(lane_row, owner_row) -> dict:
    """The lane's own columns, plus the owner settings listed above.

    Tolerant of an owner that lacks a column: channel_groups never got bpp_strong_pct /
    bpp_broad_pct (0022 added them to channels only), and a clone may be mid-migration.
    A missing dial is simply absent, which `_setting` already handles.
    """
    out = {key: lane_row[key] for key in lane_row.keys()}
    for key in _OWNER_SETTINGS:
        try:
            out[key] = owner_row[key]
        except (IndexError, KeyError):
            pass
    return out


def _autofill_lanes(conn) -> list[AutofillLane]:
    """Every enabled lane whose owner is active. Groups first, then ungrouped channels.

    A channel with group_id set is NEVER also returned as a solo lane — it fills through
    its group — so it cannot be topped up twice in one cycle even if a stray lane row
    exists on it.
    """
    lanes: list[AutofillLane] = []
    for lane_row in conn.execute(
        """SELECT l.*, g.name AS owner_label
             FROM autofill_lanes l
             JOIN channel_groups g ON g.id = l.group_id
            WHERE l.enabled = 1 AND g.is_active = 1
            ORDER BY g.id, l.surface"""
    ).fetchall():
        group = conn.execute(
            "SELECT * FROM channel_groups WHERE id = ?", (lane_row["group_id"],)
        ).fetchone()
        members = conn.execute(
            "SELECT * FROM channels WHERE group_id = ? AND is_active = 1 ORDER BY id",
            (lane_row["group_id"],),
        ).fetchall()
        lanes.append(AutofillLane(
            lane_row["owner_label"], lane_row["surface"],
            _lane_settings(lane_row, group), list(members), True,
        ))
    for lane_row in conn.execute(
        """SELECT l.*, c.account_name AS owner_label
             FROM autofill_lanes l
             JOIN channels c ON c.id = l.channel_id
            WHERE l.enabled = 1 AND c.is_active = 1 AND c.group_id IS NULL
            ORDER BY c.id, l.surface"""
    ).fetchall():
        channel = conn.execute(
            "SELECT * FROM channels WHERE id = ?", (lane_row["channel_id"],)
        ).fetchone()
        lanes.append(AutofillLane(
            lane_row["owner_label"], lane_row["surface"],
            _lane_settings(lane_row, channel), [channel], False,
        ))
    return lanes


def _setting(settings, name: str, default=0):
    """Read a unit setting that may predate the row's schema.

    sqlite3.Row raises IndexError for an unknown column rather than returning None, and a
    group row and a channel row are not guaranteed to have been migrated in lockstep in
    someone else's clone. A missing BPP column must mean "off", never a crash on the
    publish path.
    """
    try:
        value = settings[name]
    except (IndexError, KeyError):
        return default
    return default if value is None else value


def bpp_pool(conn, channel, now, *, surface: str, reuse_default=None,
            timezone_name=None) -> list:
    """The owner's marked posts that could go out on this channel, whose turn first.

    Ordered by when each last went out, oldest first, so the pool ROTATES: every marked
    post is used before any repeats. That is the behaviour being reproduced — a set of
    keepers cycled through, not a favourite replayed.

    `skip_cooldown=True` is the one rule a BPP is allowed past, and only because the owner
    chose both the marks and the frequency: a pool of four on a monthly cadence means each
    post returns every four months, which a 90-day reuse window would silently veto,
    leaving the feature looking broken rather than declining. One-time content is still
    excluded — "never repost this" outranks "repost my best".

    `surface` is the LANE's surface, same as everywhere else — a BPP pick is still a pick,
    and must be targeted at the surface the lane is topping up.
    """
    marked = {
        row["id"]
        for row in conn.execute("SELECT id FROM posts WHERE is_bpp = 1").fetchall()
    }
    if not marked:
        return []
    rows = eligible_candidates(
        conn, channel, now, None, surface=surface, reuse_default=reuse_default,
        timezone_name=timezone_name, skip_cooldown=True,
    )
    pool = [r for r in rows if r["post_id"] in marked]
    # None sorts first: a marked post never sent on THIS channel is the stalest of all.
    pool.sort(key=lambda r: (r["last_posted"] is not None, r["last_posted"] or ""))
    return pool


def _last_bpp_date(conn, member_ids: list[int]):
    """The date the unit last had a BPP scheduled, or None if never.

    Reads scheduled_at, not published_at, and counts queued rows as well as sent ones —
    otherwise every cycle would re-measure the gap against the last SENT one and stack
    several BPPs into a queue that already had one waiting.
    """
    if not member_ids:
        return None
    placeholders = ",".join("?" * len(member_ids))
    row = conn.execute(
        f"SELECT scheduled_at AS d FROM publications "
        f"WHERE channel_id IN ({placeholders}) AND is_recycled = 1 "
        f"ORDER BY {_INSTANT} DESC, scheduled_at DESC LIMIT 1",
        member_ids,
    ).fetchone()
    if not row or not row["d"]:
        return None
    return parse_iso(row["d"]).date()


def _apply_bpp(conn, unit, settings, now, placed, candidates, bands_by_post, band_of,
               covered, every_days, logger):
    """Re-fill the slots pass 1 chose, giving the due ones to the owner's marked posts.

    Two passes, because the two facts depend on each other in opposite directions: a BPP's
    due-ness depends on the slot DATES, while which post lands in a slot depends on band
    matching. So pass 1 (already done, in `placed`) fixes the dates, and this re-runs the same
    slots with the pool available at the due positions.

    A due slot whose band no pool post fits falls through to normal selection and is not
    flagged — the same behaviour as a due slot with an empty pool.
    """
    slots = [(slot, hhmm) for _, slot, hhmm, _ in placed]
    due = bpp_slot_indices(
        [slot.date() for slot, _ in slots],
        _last_bpp_date(conn, [m["id"] for m in unit.members]),
        every_days,
    )
    if not due:
        return placed

    if unit.is_group:
        pool = _group_bpp_pool(conn, settings, unit.members, now, unit.surface)
    else:
        channel = unit.members[0]
        # Same lane-over-column rule as the selection arm above. The reuse window is inert
        # here (a BPP pool runs skip_cooldown=True), but passing it keeps the two solo call
        # sites identical so neither can quietly go back to reading a frozen column.
        pool = [(r, [channel]) for r in bpp_pool(
            conn, channel, now, surface=unit.surface,
            reuse_default=_setting(settings, "reuse_min_age_days", None),
            timezone_name=settings["timezone"],
        )]

    if not pool:
        if logger:
            logger.info(
                "[autofill %s] a BPP slot came due but the pool is empty — mark some posts "
                "in the dashboard, or this stays ordinary auto-fill", unit.label,
            )
        return placed

    for row, _ in pool:
        bands_by_post.setdefault(row["post_id"], post_bands(conn, row["post_id"]))

    refilled = _assign(slots, candidates, bands_by_post, band_of, len(slots), covered,
                       pool=pool, due=due)
    if logger and any(flag for _, _, _, flag in refilled):
        chosen = [item[0]["post_id"] for item, _, _, flag in refilled if flag]
        logger.info(
            "[autofill %s] BPP: %d slot(s) from a pool of %d — post(s) %s",
            unit.label, len(chosen), len(pool), ", ".join(str(p) for p in chosen),
        )
    return refilled


def _covered_bands(cadence, tz_name: str, after, band_of) -> set[str]:
    """Which bands this cadence can actually put a slot in.

    In TIMES mode the answer is static — the bands of its slot times — and exact.

    In INTERVAL mode it is emphatically NOT the whole window. Stepping by `every_minutes` can
    only land on the residues of that interval modulo a day: exactly 1440/gcd(every_minutes,
    1440) clock times, spaced gcd minutes apart. "Every 24h between 08:00 and 21:00" reaches
    ONE clock time, not 1440 of them, and which one depends on the phase — i.e. on `after`.
    Claiming the window would mark every band covered, leaving `_stranded_by_band` nothing to
    report and silencing the held-back log line that is the strict band rule's only safety net
    (design §7).

    So the interval branch PEEKS the real walk, which the worker can do precisely because it
    has `after`. Seven times the residue count is enough: the (clock time, weekday) pair
    repeats within 7 * distinct STEPS, and each yielded slot consumes at least one step, so
    that many yields has seen every reachable clock time — including one a day filter only
    lets through on some weekdays.

    What it cannot see is a DST shift further out than the peek reaches, which could move a
    residue into a neighbouring band. That direction costs at most an unused slot, never a
    send at the wrong hour.
    """
    if cadence.mode != "interval":
        return {band_of(hm) for hm in cadence.candidate_local_times()}
    distinct = 1440 // math.gcd(cadence.every_minutes, 1440)
    return {
        band_of(hhmm)
        for _, hhmm in islice(iter_slots(cadence, tz_name, after), 7 * distinct)
    }


def _stranded_by_band(candidates, bands_by_post, covered) -> dict[str, int]:
    """How many eligible candidates carry a band the cadence has no slot for.

    This is the number behind the held-back log line. It counts over the FULL eligible list
    (the fetch is uncapped for exactly this reason), so it reports the real size of the
    problem rather than however many happened to fit in one cycle's need.
    """
    counts: dict[str, int] = {}
    for row, _ in candidates:
        bands = bands_by_post.get(row["post_id"], set()) & set(BAND_ORDER)
        if bands and not (bands & covered):
            for band in sorted(bands):
                counts[band] = counts.get(band, 0) + 1
    return counts


def _group_bpp_pool(conn, group, members, now, surface: str) -> list:
    """The group's BPP pool as (row, recipients) pairs.

    Reuses group_eligible_candidates for the recipient logic — which members can take a
    post, and whether a rule blocks the whole group — so a BPP is delivered on exactly the
    same terms as any other pick and cannot land on a subset of the group.

    `surface` is the LANE's surface — a BPP pick is still a pick, targeted at whichever
    surface the lane is topping up.
    """
    marked = {
        row["id"]
        for row in conn.execute("SELECT id FROM posts WHERE is_bpp = 1").fetchall()
    }
    if not marked:
        return []
    pairs = [
        (row, recipients)
        for row, recipients in group_eligible_candidates(
            conn, group, members, now, None, surface=surface, skip_cooldown=True
        )
        if row["post_id"] in marked
    ]
    pairs.sort(key=lambda rm: (rm[0]["last_posted"] is not None, rm[0]["last_posted"] or ""))
    return pairs


def _unit_publication_count(conn, member_ids: list[int]) -> int:
    """How many publications this unit has ever had — the sequence recycle slots count on.

    Every publication counts, including posted and failed ones: the point is a stable,
    ever-advancing position so the 1-in-N ratio holds across cycles. Counting only the
    live queue would reset as things published and cluster the recycles.
    """
    if not member_ids:
        return 0
    placeholders = ",".join("?" * len(member_ids))
    row = conn.execute(
        f"SELECT COUNT(*) FROM publications WHERE channel_id IN ({placeholders})",
        member_ids,
    ).fetchone()
    return row[0] or 0


def _assign(slots, items, bands_by_post, band_of, need, covered, *, pool=None,
            due=frozenset()):
    """Place items into slots, honouring each item's time_of_day bands.

    `slots` is an iterable of (utc_dt, (hour, minute)) — a lazy generator on the first pass and
    a fixed list on the BPP re-fill, which is why this takes an iterable rather than a list.
    Returns [(item, utc_dt, (hour, minute), is_bpp)].

    A slot nothing fits is SKIPPED, not consumed: holding a post back must cost an unused slot,
    never queue depth. Conversely the walk stops the moment nothing remaining can fit any band
    the cadence covers, so an impossible cadence ends in a few steps instead of grinding
    through a year of slots that provably cannot be filled.

    `pool`/`due` carry BPP: at a due POSITION the stalest pool post that fits the slot's band
    wins, and if none fits the slot falls through to normal selection and is NOT flagged —
    because it isn't a BPP. A due position is an index into `slots`, NOT a count of what has
    been placed: pass 2 can skip a slot pass 1 filled (design §9), and measuring by output
    length would shift every later position and hand the BPP to the wrong date.
    """
    remaining = list(items)
    remaining_pool = list(pool or [])
    used: set[int] = set()
    out: list = []

    def fits(item, band):
        return post_allows_band(bands_by_post.get(item[0]["post_id"], set()), band)

    def take(seq, band):
        for index, item in enumerate(seq):
            # A post taken from the OTHER list stays in this one; `used` is what stops it
            # being placed twice, since the pool and the candidates share a library.
            if item[0]["post_id"] in used:
                continue
            if fits(item, band):
                return seq.pop(index)
        return None

    def anything_left():
        return any(
            fits(item, band)
            for item in remaining + remaining_pool
            for band in covered
        )

    if not anything_left():
        return out
    for position, (slot, hhmm) in enumerate(slots):
        if len(out) >= need:
            break
        band = band_of(hhmm)
        item = take(remaining_pool, band) if position in due else None
        is_bpp = item is not None
        if item is None:
            item = take(remaining, band)
        if item is None:
            continue  # nothing fits this slot — skip it, do not consume it
        used.add(item[0]["post_id"])
        out.append((item, slot, hhmm, is_bpp))
        if not anything_left():
            break
    return out


def _slide_asset_ids(conn, post_id: int, surface: str) -> list:
    """The asset_id values this post's publication rows should carry on `surface`.

    A FEED send is ONE row covering all of the post's assets, which `asset_id IS NULL`
    encodes (migration 0014). A STORY send is one row PER slide, because there is no such
    thing as a carousel Story in the API: a four-slide post becomes four consecutive
    Stories, each an independent publication that retries, fails and reports metrics on
    its own.

    This is the Python counterpart to dashboard/lib/story-fanout.ts's expandTarget, whose
    docstring has always claimed one existed here. It does now. The two runtimes share a
    database, not code (CLAUDE.md), so the rule is deliberately duplicated and tested on
    both sides — change one and you must change the other.
    """
    if surface != "story":
        return [None]
    return [
        r["asset_id"] for r in conn.execute(
            "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order ASC",
            (post_id,),
        ).fetchall()
    ]


def _fill_unit(conn, lane: AutofillLane, config: Config, now, now_iso: str, logger) -> int:
    """Top up one lane. Returns the number of publications created."""
    if lane.is_group and not lane.members:
        if logger:
            logger.info("[autofill %s] group has no active members — skipping", lane.label)
        return 0

    # A lane reaches only members whose platform HAS this surface: an Instagram + Facebook
    # group with a story lane creates Instagram sends and nothing for the Page.
    #
    # Here rather than inside group_eligible_candidates so the SOLO path is gated by the
    # same line. A story lane on a Telegram channel must be refused by the WORKER — the
    # dashboard hides the option, but the worker must never depend on the UI for
    # correctness.
    # .get(), matching _platform_capability_params: a platform PLATFORM_CAPS does not
    # recognize has no surfaces, which is the safe direction — that member sits the lane
    # out. A bare subscript would raise KeyError all the way out of run_autofill and stop
    # EVERY lane in the install, not just the unrecognized platform's.
    members = [
        m for m in lane.members
        if lane.surface in getattr(
            PLATFORM_CAPS.get(m["platform"]), "surfaces", frozenset()
        )
    ]
    if not members:
        if logger:
            logger.info("[autofill %s] no active member can take a %s — skipping",
                        lane.label, lane.surface)
        return 0
    lane.members = members

    settings = lane.settings
    cadence = parse_cadence(settings["cadence_config"])
    if cadence is None:
        if logger:
            logger.info("[autofill %s] no valid cadence — skipping", lane.label)
        return 0

    member_ids = [m["id"] for m in lane.members]
    if lane.is_group:
        ahead = group_scheduled_ahead_count(conn, member_ids, now_iso, lane.surface)
        last_future = group_latest_future_scheduled(conn, member_ids, now_iso, lane.surface)
    else:
        ahead = scheduled_ahead_count(conn, member_ids[0], now_iso, lane.surface)
        last_future = latest_future_scheduled(conn, member_ids[0], now_iso, lane.surface)

    if ahead >= settings["min_queue_depth"]:
        return 0  # queue is healthy
    need = settings["target_queue_depth"] - ahead
    if need <= 0:
        return 0

    # Uncapped on purpose. Under band matching, a `need`-sized fetch is a bug: if the top-ranked
    # few all sit in a band this cadence has no slot for, auto-fill would place nothing while
    # hundreds of usable posts sat further down the ranking. The SLOTS do the limiting instead —
    # which is already how the group and BPP paths have always worked.
    if lane.is_group:
        candidates = group_eligible_candidates(
            conn, settings, lane.members, now, None, surface=lane.surface
        )
    else:
        ch = lane.members[0]
        # reuse_default/timezone_name come from the LANE's settings, never from the
        # channel row — exactly as the group arm takes them from the group. Since
        # migration 0028 the dashboard writes autofill_lanes.reuse_min_age_days and
        # nothing writes channels.reuse_min_age_days, so omitting it here made the solo
        # channel's reuse window write-only: eligible_candidates would fall back to the
        # frozen column and both of the channel's lanes would silently share it.
        candidates = [
            (r, [ch]) for r in
            eligible_candidates(
                conn, ch, now, None, surface=lane.surface,
                reuse_default=settings["reuse_min_age_days"],
                timezone_name=settings["timezone"],
            )
        ]

    if not candidates:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but no eligible content",
                lane.label, ahead, settings["min_queue_depth"],
            )
        return 0

    bt_map = band_times(config)

    def band_of(hhmm):
        return derive_band(hhmm[0], hhmm[1], bt_map)

    # `after` first: in interval mode which clock times are reachable depends on the phase,
    # and the phase is `after`.
    after = parse_iso(last_future) if last_future else now
    covered = _covered_bands(cadence, settings["timezone"], after, band_of)
    bands_by_post = {row["post_id"]: post_bands(conn, row["post_id"]) for row, _ in candidates}

    placed = _assign(
        iter_slots(cadence, settings["timezone"], after),
        candidates, bands_by_post, band_of, need, covered,
    )

    # BPP: give some slots to posts the OWNER marked as worth reposting, on their own cadence
    # in days. Nothing here judges content — the mark is the judgement, made by a person
    # looking at the stats (see worker/bpp.py for why an algorithm cannot).
    # Feed only. Recycling a best-performing post as a Story is not a thing the owner
    # asked for, and _last_bpp_date / _unit_publication_count are both surface-blind — a
    # story recycle would silently move the FEED lane's next BPP due date.
    every_days = _setting(settings, "bpp_every_days") if lane.surface == "feed" else 0
    if every_days > 0 and placed:
        placed = _apply_bpp(conn, lane, settings, now, placed, candidates, bands_by_post,
                            band_of, covered, every_days, logger)

    stranded = _stranded_by_band(candidates, bands_by_post, covered)
    if stranded and logger:
        detail = ", ".join(f"{count} tagged {band}" for band, count in sorted(stranded.items()))
        logger.info(
            "[autofill %s] %s held back — this cadence has no slot in that band. Add a time "
            "in the dashboard, or retag the posts.", lane.label, detail,
        )

    if not placed:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but nothing could be placed",
                lane.label, ahead, settings["min_queue_depth"],
            )
        return 0

    # All-or-nothing. sqlite3's default isolation means these inserts sit in an implicit
    # transaction, and run.py catches errors and REUSES this connection — so without the
    # rollback a failure mid-group (e.g. a member channel deleted in the dashboard since
    # _autofill_lanes read it; foreign keys are ON) would be silently committed by the
    # next cycle's heartbeat, leaving one member scheduled and the other not: exactly the
    # drift groups exist to prevent. The open transaction would also hold SQLite's writer
    # lock for a full poll interval, blocking the dashboard.
    made = 0
    try:
        for (row, recipients), slot, _hhmm, is_bpp in placed:
            for member in recipients:
                # requires_approval stays a CHANNEL property — it describes the account,
                # not the schedule, so one member of a group may need approval and
                # another not.
                status = "pending_approval" if member["requires_approval"] else "scheduled"
                # One row for a feed send; one row PER SLIDE for a story send. They share
                # the slot's timestamp, so ascending publication id gives the publish
                # order worker/db.py's `ORDER BY scheduled_at, id` relies on.
                for asset_id in _slide_asset_ids(conn, row["post_id"], lane.surface):
                    conn.execute(
                        """INSERT INTO publications
                             (post_id, channel_id, scheduled_at, status, created_by,
                              is_recycled, surface, asset_id)
                           VALUES (?, ?, ?, ?, 'autofill', ?, ?, ?)""",
                        (row["post_id"], member["id"], slot.isoformat(), status,
                         1 if is_bpp else 0, lane.surface, asset_id),
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
            lane.label, ahead, settings["min_queue_depth"], made, len(lane.members),
            settings["target_queue_depth"],
        )
    return made


def run_autofill(conn, config: Config, now, logger=None) -> int:
    """Top up every enabled lane. Returns total publications created."""
    now_iso = now.isoformat()
    return sum(
        _fill_unit(conn, lane, config, now, now_iso, logger)
        for lane in _autofill_lanes(conn)
    )
