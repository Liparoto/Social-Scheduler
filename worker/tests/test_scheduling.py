"""Tests for cadence slot generation (weekly form)."""

from __future__ import annotations

from datetime import datetime, timezone

from worker.scheduling import parse_weekly_cadence, weekly_slots, WEEKDAYS


def test_parse_weekly_cadence_ok():
    assert parse_weekly_cadence('{"days":["tue","thu","sat"],"time":"18:00"}') == (
        {1, 3, 5},
        18,
        0,
    )


def test_parse_weekly_cadence_invalid():
    assert parse_weekly_cadence(None) is None
    assert parse_weekly_cadence("not json") is None
    assert parse_weekly_cadence('{"days":[],"time":"18:00"}') is None
    assert parse_weekly_cadence('{"days":["xxx"],"time":"18:00"}') is None


def test_weekly_slots_tue_thu_sat_at_6pm_eastern():
    # Start Sun 2026-07-19 00:00 UTC. Tue/Thu/Sat @ 18:00 America/New_York (EDT, -4).
    after = datetime(2026, 7, 19, 0, 0, tzinfo=timezone.utc)
    slots = weekly_slots({1, 3, 5}, 18, 0, "America/New_York", after, 3)
    got = [s.isoformat() for s in slots]
    # 18:00 EDT == 22:00 UTC. Next Tue=Jul21, Thu=Jul23, Sat=Jul25.
    assert got == [
        "2026-07-21T22:00:00+00:00",
        "2026-07-23T22:00:00+00:00",
        "2026-07-25T22:00:00+00:00",
    ]


def test_weekly_slots_strictly_after():
    # 'after' exactly on a slot instant -> that instant is excluded, next one returned.
    after = datetime(2026, 7, 21, 22, 0, tzinfo=timezone.utc)  # Tue 18:00 EDT
    slots = weekly_slots({1, 3, 5}, 18, 0, "America/New_York", after, 1)
    assert slots[0].isoformat() == "2026-07-23T22:00:00+00:00"  # skips to Thu


from worker.scheduling import weekly_date_slots
from zoneinfo import ZoneInfo


def _local_hm(dt, tz_name):
    local = dt.astimezone(ZoneInfo(tz_name))
    return (local.hour, local.minute)


def test_weekly_date_slots_uses_per_candidate_times():
    # Mon/Wed/Fri channel in New York; after = Sun 2026-07-19 12:00 UTC.
    after = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    weekdays = {0, 2, 4}  # mon, wed, fri
    # Three candidates: evening (18:00), morning (09:00), anytime->cadence (17:00).
    bands = [(18, 0), (9, 0), (17, 0)]
    slots = weekly_date_slots(weekdays, "America/New_York", after, bands)

    assert len(slots) == 3
    # Strictly increasing, one per successive matching day.
    assert slots[0] < slots[1] < slots[2]
    # Each carries its own local clock time.
    assert _local_hm(slots[0], "America/New_York") == (18, 0)  # Mon evening
    assert _local_hm(slots[1], "America/New_York") == (9, 0)   # Wed morning
    assert _local_hm(slots[2], "America/New_York") == (17, 0)  # Fri anytime
    # Distinct calendar days in local tz.
    days = {s.astimezone(ZoneInfo("America/New_York")).date() for s in slots}
    assert len(days) == 3


def test_weekly_date_slots_skips_past_time_on_first_day():
    # after is Monday 20:00 local; a morning (09:00) first candidate can't fit today.
    tz = "America/New_York"
    after = datetime(2026, 7, 20, 12, 0, tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)
    slots = weekly_date_slots({0, 2, 4}, tz, after, [(9, 0)])
    assert len(slots) == 1
    # Must be strictly after `after`; 09:00 Monday already passed -> lands Wednesday.
    assert slots[0] > after
    assert _local_hm(slots[0], tz) == (9, 0)
