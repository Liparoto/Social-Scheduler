"""Period window math: yearly (incl. wrap-around), one-off, timezone-local date."""
from __future__ import annotations

from datetime import date, datetime, timezone

from worker.periods import Period, in_season, local_date, period_contains


def yearly(sm, sd, em, ed):
    return Period(id=1, name="p", recurs_yearly=True, start_month=sm, start_day=sd,
                  end_month=em, end_day=ed, start_date=None, end_date=None)


def oneoff(s, e):
    return Period(id=2, name="o", recurs_yearly=False, start_month=None, start_day=None,
                  end_month=None, end_day=None, start_date=s, end_date=e)


def test_yearly_simple_window():
    summer = yearly(6, 1, 8, 31)
    assert period_contains(summer, date(2026, 7, 15)) is True
    assert period_contains(summer, date(2026, 1, 15)) is False


def test_yearly_wraps_new_year():
    holidays = yearly(12, 15, 1, 5)   # Dec 15 -> Jan 5
    assert period_contains(holidays, date(2026, 12, 20)) is True
    assert period_contains(holidays, date(2026, 1, 3)) is True
    assert period_contains(holidays, date(2026, 7, 4)) is False


def test_oneoff_dates():
    p = oneoff("2026-07-01", "2026-07-07")
    assert period_contains(p, date(2026, 7, 4)) is True
    assert period_contains(p, date(2026, 7, 8)) is False


def test_local_date_uses_channel_timezone():
    # 01:30 UTC is still the previous evening in New York.
    now = datetime(2026, 1, 2, 1, 30, tzinfo=timezone.utc)
    assert local_date(now, "America/New_York") == date(2026, 1, 1)


def test_in_season_rules():
    winter = yearly(12, 1, 2, 28)
    beach_blackout = yearly(12, 1, 12, 31)
    # green with no match -> out of season
    assert in_season([winter], [], date(2026, 7, 1)) is False
    # green match -> in season
    assert in_season([winter], [], date(2026, 1, 15)) is True
    # blackout overrides green
    assert in_season([winter], [beach_blackout], date(2026, 12, 10)) is False
    # no green periods -> always in season (unless blackout)
    assert in_season([], [], date(2026, 7, 1)) is True
    assert in_season([], [beach_blackout], date(2026, 12, 10)) is False
