"""Period window math for content eligibility. Pure + stdlib only.

A period is either yearly (by month/day, wrap-around allowed) or a one-off date range.
Windows are evaluated against a LOCAL date (the channel's timezone) so season boundaries
land on the local calendar day. See docs/design-content-model.md.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo


@dataclass
class Period:
    id: int
    name: str
    recurs_yearly: bool
    start_month: int | None
    start_day: int | None
    end_month: int | None
    end_day: int | None
    start_date: str | None
    end_date: str | None


def period_from_row(row) -> Period:
    return Period(
        id=row["id"], name=row["name"], recurs_yearly=bool(row["recurs_yearly"]),
        start_month=row["start_month"], start_day=row["start_day"],
        end_month=row["end_month"], end_day=row["end_day"],
        start_date=row["start_date"], end_date=row["end_date"],
    )


def _md(month: int, day: int) -> int:
    """A comparable month-day key, e.g. Dec 15 -> 1215."""
    return month * 100 + day


def period_contains(period: Period, local: date) -> bool:
    if period.recurs_yearly:
        start = _md(period.start_month, period.start_day)
        end = _md(period.end_month, period.end_day)
        cur = _md(local.month, local.day)
        if start <= end:
            return start <= cur <= end
        # wrap-around across the New Year (e.g. Dec 15 -> Jan 5)
        return cur >= start or cur <= end
    start = date.fromisoformat(period.start_date)
    end = date.fromisoformat(period.end_date)
    return start <= local <= end


def local_date(now_utc: datetime, tz_name: str) -> date:
    return now_utc.astimezone(ZoneInfo(tz_name)).date()


def in_season(green: list[Period], blackout: list[Period], local: date) -> bool:
    """Blackout wins; then, if any green periods exist, one must contain `local`."""
    if any(period_contains(b, local) for b in blackout):
        return False
    if green and not any(period_contains(g, local) for g in green):
        return False
    return True
