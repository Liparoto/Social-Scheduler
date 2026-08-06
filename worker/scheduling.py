"""Cadence + slot generation for auto-fill.

Auto-fill cadence is the WEEKLY form: specific weekdays at a time, interpreted in the
channel's timezone. Example config stored in channels.cadence_config:

    {"days": ["tue", "thu", "sat"], "time": "18:00"}

(Bulk scheduling in the dashboard uses a simpler interval — every N days at a time —
and lives in TypeScript; see dashboard/lib/scheduling.ts.)
"""

from __future__ import annotations

import json
from datetime import datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
UTC = ZoneInfo("UTC")


def parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 UTC string (handles both '...Z' and '+00:00')."""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def parse_weekly_cadence(cadence_config: str | None) -> tuple[set[int], int, int] | None:
    """Return (weekday_ints, hour, minute) or None if the config is absent/invalid."""
    if not cadence_config:
        return None
    try:
        cfg = json.loads(cadence_config)
        days = cfg["days"]
        wanted = {WEEKDAYS[d.lower()] for d in days}
        # A multi-time cadence ({"times": [...]}) has no "time" key. Falling back to its
        # FIRST time keeps this function's contract — and, more importantly, keeps such a
        # config VALID: _fill_unit treats a None here as "no cadence" and skips the
        # channel entirely, so without this an account posting three times a day would
        # silently stop auto-filling altogether.
        raw_time = cfg.get("time")
        if raw_time is None:
            times = cfg.get("times") or []
            raw_time = times[0] if times else None
        if raw_time is None:
            return None
        hh, mm = (int(x) for x in str(raw_time).split(":"))
        if not wanted or not (0 <= hh < 24 and 0 <= mm < 60):
            return None
        return wanted, hh, mm
    except (json.JSONDecodeError, KeyError, ValueError, AttributeError):
        return None


def weekly_slots(
    weekdays: set[int],
    hour: int,
    minute: int,
    tz_name: str,
    after: datetime,
    count: int,
) -> list[datetime]:
    """The next `count` slots on matching weekdays at hour:minute in tz_name,
    strictly after `after` (a UTC datetime). Returned as UTC datetimes.
    """
    tz = ZoneInfo(tz_name)
    cursor = after.astimezone(tz).date()
    slots: list[datetime] = []
    # Safety horizon: enough days to satisfy `count` even for a once-weekly cadence.
    for _ in range(count * 8 + 366):
        if cursor.weekday() in weekdays:
            local_dt = datetime.combine(cursor, dtime(hour, minute), tz)
            utc_dt = local_dt.astimezone(UTC)
            if utc_dt > after:
                slots.append(utc_dt)
                if len(slots) >= count:
                    break
        cursor += timedelta(days=1)
    return slots


def weekly_date_slots(
    weekdays: set[int],
    tz_name: str,
    after: datetime,
    band_times: list[tuple[int, int]],
) -> list[datetime]:
    """One UTC slot per (hour, minute) in `band_times`, each on the next matching
    cadence day (one post per active day), strictly increasing and strictly after
    `after`. Unlike weekly_slots, each slot's time comes from its own band entry.
    """
    tz = ZoneInfo(tz_name)
    cursor = after.astimezone(tz).date()
    prev = after
    slots: list[datetime] = []
    i = 0
    horizon = len(band_times) * 8 + 366
    for _ in range(horizon):
        if i >= len(band_times):
            break
        if cursor.weekday() in weekdays:
            hh, mm = band_times[i]
            utc_dt = datetime.combine(cursor, dtime(hh, mm), tz).astimezone(UTC)
            if utc_dt > prev:
                slots.append(utc_dt)
                prev = utc_dt
                i += 1
                cursor += timedelta(days=1)  # one auto-post per active day
                continue
        cursor += timedelta(days=1)
    return slots


def parse_cadence_times(cadence_config: str | None) -> list[tuple[int, int]]:
    """Every posting time in a cadence, in order. [] when the config is absent/invalid.

    Two accepted shapes, because the single-time one predates this and is still what most
    installs hold:

        {"days": [...], "time":  "18:00"}                  -> [(18, 0)]
        {"days": [...], "times": ["09:00", "13:00"]}       -> [(9, 0), (13, 0)]

    `times` wins when both are present. Sorted and de-duplicated: two posts booked for the
    same minute would collide on one slot, and the order they were typed in is not
    something anybody means.
    """
    if not cadence_config:
        return []
    try:
        cfg = json.loads(cadence_config)
    except (json.JSONDecodeError, TypeError):
        return []
    raw = cfg.get("times")
    if not raw:
        single = cfg.get("time")
        raw = [single] if single else []
    out: set[tuple[int, int]] = set()
    for entry in raw:
        try:
            hh, mm = (int(x) for x in str(entry).split(":"))
        except (ValueError, AttributeError):
            continue
        if 0 <= hh < 24 and 0 <= mm < 60:
            out.add((hh, mm))
    return sorted(out)


def daily_slots(
    weekdays: set[int],
    tz_name: str,
    after: datetime,
    day_times: list[tuple[int, int]],
    count: int,
) -> list[datetime]:
    """`count` slots, filling each active day at every time in `day_times`.

    This is the multiple-posts-per-day path. weekly_date_slots deliberately advances a
    whole day after placing one post — it exists to spread a queue out — so it can never
    produce two sends on the same date however it is called.

    Times are taken in order within a day before moving to the next, so a queue fills
    morning-then-afternoon-then-evening rather than filling every morning first, which is
    what "three times a day" is understood to mean.
    """
    if not weekdays or not day_times or count <= 0:
        return []
    tz = ZoneInfo(tz_name)
    cursor = after.astimezone(tz).date()
    slots: list[datetime] = []
    # Enough days to satisfy `count` even if only one weekday is active, plus slack for a
    # partly-elapsed first day.
    for _ in range(count * 7 + 8):
        if len(slots) >= count:
            break
        if cursor.weekday() in weekdays:
            for hh, mm in day_times:
                if len(slots) >= count:
                    break
                utc_dt = datetime.combine(cursor, dtime(hh, mm), tz).astimezone(UTC)
                # Strictly after `after` so a cadence time already past today does not
                # book a send in the past on the first day.
                if utc_dt > after:
                    slots.append(utc_dt)
        cursor += timedelta(days=1)
    return slots
