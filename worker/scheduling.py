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
        hh, mm = (int(x) for x in cfg["time"].split(":"))
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
