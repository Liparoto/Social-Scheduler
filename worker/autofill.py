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
from .bpp import bpp_slot_indices
from .clients import PLATFORM_CAPS
from .config import Config
from .periods import in_season, local_date, period_from_row
from .publisher import _select_caption
from .scheduling import iter_slots, parse_cadence, parse_iso
from .time_of_day import BAND_ORDER, band_times, post_allows_band, post_bands
from .time_of_day import derive_band

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
          -- surface='feed': auto-fill queues ordinary posts only. A post targeted SOLELY
          -- at an Instagram Story must never be auto-queued as a feed post — matching on
          -- channel_id alone would send it to the wrong destination silently. Story
          -- recycling is a deliberate v1 scope cut (docs/design-instagram-stories.md §4),
          -- not an oversight.
          AND EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.channel_id = :cid
                        AND pt.surface = 'feed')
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
                        reuse_default=None, timezone_name=None, skip_cooldown=False):
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


def group_eligible_candidates(conn, group, members, now, limit: int | None, *,
                              skip_cooldown=False):
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
                conn, m, now, None, reuse_default=reuse_default, timezone_name=tz_name,
                skip_cooldown=skip_cooldown,
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


def bpp_pool(conn, channel, now, *, reuse_default=None, timezone_name=None) -> list:
    """The owner's marked posts that could go out on this channel, whose turn first.

    Ordered by when each last went out, oldest first, so the pool ROTATES: every marked
    post is used before any repeats. That is the behaviour being reproduced — a set of
    keepers cycled through, not a favourite replayed.

    `skip_cooldown=True` is the one rule a BPP is allowed past, and only because the owner
    chose both the marks and the frequency: a pool of four on a monthly cadence means each
    post returns every four months, which a 90-day reuse window would silently veto,
    leaving the feature looking broken rather than declining. One-time content is still
    excluded — "never repost this" outranks "repost my best".
    """
    marked = {
        row["id"]
        for row in conn.execute("SELECT id FROM posts WHERE is_bpp = 1").fetchall()
    }
    if not marked:
        return []
    rows = eligible_candidates(
        conn, channel, now, None, reuse_default=reuse_default,
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
        f"SELECT MAX(scheduled_at) AS d FROM publications "
        f"WHERE channel_id IN ({placeholders}) AND is_recycled = 1",
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
        pool = _group_bpp_pool(conn, settings, unit.members, now)
    else:
        channel = unit.members[0]
        pool = [(r, [channel]) for r in bpp_pool(conn, channel, now)]

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


def _group_bpp_pool(conn, group, members, now) -> list:
    """The group's BPP pool as (row, recipients) pairs.

    Reuses group_eligible_candidates for the recipient logic — which members can take a
    post, and whether a rule blocks the whole group — so a BPP is delivered on exactly the
    same terms as any other pick and cannot land on a subset of the group.
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
            conn, group, members, now, None, skip_cooldown=True
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
    because it isn't a BPP.
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
    for slot, hhmm in slots:
        if len(out) >= need:
            break
        band = band_of(hhmm)
        item = take(remaining_pool, band) if len(out) in due else None
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


def _fill_unit(conn, unit: AutofillUnit, config: Config, now, now_iso: str, logger) -> int:
    """Top up one unit. Returns the number of publications created."""
    if unit.is_group and not unit.members:
        if logger:
            logger.info("[autofill %s] group has no active members — skipping", unit.label)
        return 0

    settings = unit.settings
    cadence = parse_cadence(settings["cadence_config"])
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

    # Uncapped on purpose. Under band matching, a `need`-sized fetch is a bug: if the top-ranked
    # few all sit in a band this cadence has no slot for, auto-fill would place nothing while
    # hundreds of usable posts sat further down the ranking. The SLOTS do the limiting instead —
    # which is already how the group and BPP paths have always worked.
    if unit.is_group:
        candidates = group_eligible_candidates(conn, settings, unit.members, now, None)
    else:
        ch = unit.members[0]
        candidates = [(r, [ch]) for r in eligible_candidates(conn, ch, now, None)]

    if not candidates:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but no eligible content",
                unit.label, ahead, settings["min_queue_depth"],
            )
        return 0

    bt_map = band_times(config)

    def band_of(hhmm):
        return derive_band(hhmm[0], hhmm[1], bt_map)

    covered = {band_of(hm) for hm in cadence.candidate_local_times()}
    bands_by_post = {row["post_id"]: post_bands(conn, row["post_id"]) for row, _ in candidates}

    after = parse_iso(last_future) if last_future else now
    placed = _assign(
        iter_slots(cadence, settings["timezone"], after),
        candidates, bands_by_post, band_of, need, covered,
    )

    # BPP: give some slots to posts the OWNER marked as worth reposting, on their own cadence
    # in days. Nothing here judges content — the mark is the judgement, made by a person
    # looking at the stats (see worker/bpp.py for why an algorithm cannot).
    every_days = _setting(settings, "bpp_every_days")
    if every_days > 0 and placed:
        placed = _apply_bpp(conn, unit, settings, now, placed, candidates, bands_by_post,
                            band_of, covered, every_days, logger)

    stranded = _stranded_by_band(candidates, bands_by_post, covered)
    if stranded and logger:
        detail = ", ".join(f"{count} tagged {band}" for band, count in sorted(stranded.items()))
        logger.info(
            "[autofill %s] %s held back — this cadence has no slot in that band. Add a time "
            "in the dashboard, or retag the posts.", unit.label, detail,
        )

    if not placed:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but nothing could be placed",
                unit.label, ahead, settings["min_queue_depth"],
            )
        return 0

    made = 0
    try:
        for (row, recipients), slot, _hhmm, is_bpp in placed:
            for member in recipients:
                status = "pending_approval" if member["requires_approval"] else "scheduled"
                conn.execute(
                    """INSERT INTO publications
                         (post_id, channel_id, scheduled_at, status, created_by,
                          is_recycled)
                       VALUES (?, ?, ?, ?, 'autofill', ?)""",
                    (row["post_id"], member["id"], slot.isoformat(), status,
                     1 if is_bpp else 0),
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
