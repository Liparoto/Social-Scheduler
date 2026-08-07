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
    """An interval cadence, or None when it could never fire.

    The window and day list WIDEN when absent (no window = all day, no `days` key = all week)
    because the unrestricted 24/7 drift is a real choice someone might want. An explicitly
    empty day list is different: the owner unchecked all seven, and a cadence that can never
    fire must read as invalid rather than silently doing nothing forever.
    """
    try:
        every_minutes = int(cfg.get("every_minutes"))
    except (TypeError, ValueError):
        return None
    if every_minutes <= 0:
        return None

    window_cfg = cfg.get("window")
    start = end = None
    if isinstance(window_cfg, dict):
        start = _parse_hhmm(window_cfg.get("from"))
        end = _parse_hhmm(window_cfg.get("to"))
    window = (start or (0, 0), end or (23, 59))

    if "days" in cfg:
        days = _weekday_ints(cfg.get("days"))
        if not days:
            return None
    else:
        days = set(WEEKDAYS.values())

    return Cadence(
        mode="interval",
        every_minutes=every_minutes,
        window=window,
        days=frozenset(days),
    )


def parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 UTC string (handles both '...Z' and '+00:00')."""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


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


def iter_slots(cadence: Cadence, tz_name: str, after: datetime, horizon_days: int = 366):
    """Yield (utc_dt, (hour, minute)) chronologically, strictly after `after`.

    The local (hour, minute) rides along because the caller needs it to derive the slot's band,
    and recovering it from the UTC instant would mean a second timezone conversion per slot.

    A GENERATOR on purpose: auto-fill cannot know how many slots it needs until it knows how
    many it can fill, because a slot no remaining candidate's band fits is SKIPPED rather than
    consumed. Returning a fixed-length list would force the caller to guess.
    """
    if cadence.mode == "interval":
        yield from _iter_interval_slots(cadence, tz_name, after, horizon_days)
    else:
        yield from _iter_time_slots(cadence, tz_name, after, horizon_days)


def _iter_time_slots(cadence: Cadence, tz_name: str, after: datetime, horizon_days: int):
    tz = ZoneInfo(tz_name)
    cursor = after.astimezone(tz).date()
    for _ in range(horizon_days):
        # cadence.slots is sorted by time, so a day's slots come out in clock order.
        for hour, minute, weekdays in cadence.slots:
            if cursor.weekday() not in weekdays:
                continue
            utc_dt = datetime.combine(cursor, dtime(hour, minute), tz).astimezone(UTC)
            if utc_dt > after:
                yield utc_dt, (hour, minute)
        cursor += timedelta(days=1)


def _iter_interval_slots(cadence: Cadence, tz_name: str, after: datetime, horizon_days: int):
    """Advance by `every_minutes` from `after`, yielding only steps that land inside the
    window on an active weekday.

    The cursor advances from where a SKIPPED step WOULD have been, never from the last yielded
    slot. That is the whole feature: a non-round interval drifts, so over a few weeks the
    account posts at every hour and the metrics can say which ones worked. Reset the phase on
    a skip and every overnight gap drops the next send back onto the window's opening minute,
    which is the "nudge it into the window" behaviour that was explicitly rejected.

    The horizon is expressed as a STEP count so a small interval cannot outrun it: a cadence
    whose window can never be satisfied ends after `steps` iterations instead of spinning.
    """
    tz = ZoneInfo(tz_name)
    step = timedelta(minutes=cadence.every_minutes)
    steps = math.ceil(horizon_days * 1440 / cadence.every_minutes)
    cursor = after
    for _ in range(steps):
        cursor += step
        local = cursor.astimezone(tz)
        if local.weekday() not in cadence.days:
            continue
        if not _in_window(local.hour, local.minute, cadence.window):
            continue
        yield cursor.astimezone(UTC), (local.hour, local.minute)
