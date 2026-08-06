"""Cadence + slot generation for auto-fill.

A cadence is stored as JSON in channels.cadence_config (or channel_groups.cadence_config) and
comes in two modes:

    {"mode": "times", "slots": [{"time": "12:30", "days": ["mon", ..., "sun"]},
                                {"time": "18:00", "days": ["sat", "sun"]}]}

    {"mode": "interval", "every_minutes": 585,
     "window": {"from": "08:00", "to": "21:00"}, "days": ["mon", ...]}

Two older shapes are still read — {"days": [...], "time": "18:00"} and
{"days": [...], "times": [...]} — because a stored config is never rewritten until the owner
saves the form.

This module is deliberately free of any time-of-day BAND concept: it answers "when could a
send happen", and worker/time_of_day.py answers "what band is that". worker/autofill.py joins
the two. (Bulk scheduling in the dashboard uses a simpler interval and lives in TypeScript;
see dashboard/lib/scheduling.ts.)
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
UTC = ZoneInfo("UTC")


@dataclass(frozen=True)
class Cadence:
    """A parsed auto-fill cadence, in either mode.

    ONE type for both modes so `_fill_unit` keeps exactly one validity gate: a `None` from
    `parse_cadence` means "no valid cadence, skip this unit", and there is no second way for a
    cadence to be half-usable.

    times mode:    `slots` is [(hour, minute, weekdays), ...] sorted by time.
    interval mode: `every_minutes`, `window` (local from/to, inclusive, may wrap midnight),
                   and `days`.
    """

    mode: str
    slots: tuple[tuple[int, int, frozenset[int]], ...] = ()
    every_minutes: int = 0
    window: tuple[tuple[int, int], tuple[int, int]] = ((0, 0), (23, 59))
    days: frozenset[int] = frozenset()

    def candidate_local_times(self):
        """Every local (hour, minute) a slot from this cadence could land on.

        In times mode that is simply its times. In interval mode the send time DRIFTS, so any
        minute inside the window is reachable. Auto-fill maps these through `derive_band` to
        learn which bands the cadence covers — the one question both modes must answer the
        same way, and the reason this module can stay entirely free of band concepts.
        """
        if self.mode == "interval":
            for minutes in _window_minutes(self.window):
                yield divmod(minutes, 60)
        else:
            for hour, minute, _ in self.slots:
                yield hour, minute


def _parse_hhmm(value) -> tuple[int, int] | None:
    """(hour, minute) from 'HH:MM', or None if it isn't one. Never raises: every caller here
    treats an unparseable time as a slot to drop, not as an error to propagate."""
    try:
        hour, minute = (int(x) for x in str(value).split(":"))
    except (ValueError, TypeError, AttributeError):
        return None
    if 0 <= hour < 24 and 0 <= minute < 60:
        return hour, minute
    return None


def _weekday_ints(days) -> set[int]:
    """Weekday names to Python weekday ints, silently skipping anything unrecognized."""
    out: set[int] = set()
    for day in days or []:
        key = str(day).lower()
        if key in WEEKDAYS:
            out.add(WEEKDAYS[key])
    return out


def _window_minutes(window):
    """Every minute-of-day inside `window`, inclusive of both ends, wrapping midnight when
    `from` is later than `to`."""
    (from_hour, from_minute), (to_hour, to_minute) = window
    start, end = from_hour * 60 + from_minute, to_hour * 60 + to_minute
    if start <= end:
        return range(start, end + 1)
    return [*range(start, 1440), *range(0, end + 1)]


def _in_window(hour: int, minute: int, window) -> bool:
    """Is this local time inside the window? Wraps midnight when `from` > `to`."""
    (from_hour, from_minute), (to_hour, to_minute) = window
    start, end = from_hour * 60 + from_minute, to_hour * 60 + to_minute
    at = hour * 60 + minute
    if start <= end:
        return start <= at <= end
    return at >= start or at <= end


def parse_cadence(cadence_config: str | None) -> Cadence | None:
    """The stored JSON as one Cadence, or None when there is nothing usable in it.

    `mode` defaults to "times" when absent, which is what makes every config written before
    this existed keep working untouched.
    """
    if not cadence_config:
        return None
    try:
        cfg = json.loads(cadence_config)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(cfg, dict):
        return None
    if cfg.get("mode") == "interval":
        return _parse_interval(cfg)
    return _parse_times(cfg)


def _parse_times(cfg) -> Cadence | None:
    raw_slots = cfg.get("slots")
    if isinstance(raw_slots, list):
        pairs = [
            (slot.get("time"), _weekday_ints(slot.get("days")))
            for slot in raw_slots
            if isinstance(slot, dict)
        ]
    else:
        # The two shapes that predate per-time days: every time shares one day list.
        shared = _weekday_ints(cfg.get("days"))
        times = cfg.get("times")
        if not isinstance(times, list) or not times:
            single = cfg.get("time")
            times = [single] if single else []
        pairs = [(t, set(shared)) for t in times]

    merged: dict[tuple[int, int], set[int]] = {}
    for raw_time, days in pairs:
        hhmm = _parse_hhmm(raw_time)
        if hhmm is None or not days:
            continue
        merged.setdefault(hhmm, set()).update(days)
    if not merged:
        return None
    slots = tuple(
        (hour, minute, frozenset(days)) for (hour, minute), days in sorted(merged.items())
    )
    return Cadence(mode="times", slots=slots)


def _parse_interval(cfg) -> Cadence | None:
    return None  # Task 3


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
