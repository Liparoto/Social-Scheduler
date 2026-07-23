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
