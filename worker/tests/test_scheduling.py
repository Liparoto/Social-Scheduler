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
    # after is Monday 12:00 local; a morning (09:00) first candidate can't fit today.
    tz = "America/New_York"
    after = datetime(2026, 7, 20, 12, 0, tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)
    slots = weekly_date_slots({0, 2, 4}, tz, after, [(9, 0)])
    assert len(slots) == 1
    # Must be strictly after `after`; 09:00 Monday already passed -> lands Wednesday.
    assert slots[0] > after
    assert _local_hm(slots[0], tz) == (9, 0)


# ---- several posts a day ------------------------------------------------------------
#
# weekly_date_slots advances a whole day after each placement by design — it exists to
# spread a queue out — so it can never produce two sends on one date however it is called.
# An account posting 2-4 times a day needs its own path.

from worker.scheduling import daily_slots, parse_cadence_times  # noqa: E402


def test_a_single_time_cadence_still_parses():
    """Most installs hold the original shape and must keep working untouched."""
    assert parse_cadence_times('{"days":["mon"],"time":"18:00"}') == [(18, 0)]


def test_several_times_parse_in_order():
    cfg = '{"days":["mon"],"times":["18:00","09:00","13:00"]}'
    assert parse_cadence_times(cfg) == [(9, 0), (13, 0), (18, 0)]


def test_duplicate_times_collapse():
    """Two posts booked for the same minute would collide on one slot."""
    assert parse_cadence_times('{"days":["mon"],"times":["09:00","09:00"]}') == [(9, 0)]


def test_a_nonsense_time_is_dropped_not_fatal():
    cfg = '{"days":["mon"],"times":["09:00","banana","25:00","13:70"]}'
    assert parse_cadence_times(cfg) == [(9, 0)]


def test_missing_or_broken_config_yields_nothing():
    assert parse_cadence_times(None) == []
    assert parse_cadence_times("not json") == []
    assert parse_cadence_times('{"days":["mon"]}') == []


def test_slots_fill_each_day_before_moving_on():
    """Morning-then-afternoon-then-evening, not every morning first — which is what
    'three times a day' is understood to mean."""
    after = datetime(2026, 8, 6, 7, 0, tzinfo=timezone.utc)
    slots = daily_slots({0, 1, 2, 3, 4, 5, 6}, "UTC", after, [(9, 0), (13, 0), (18, 0)], 5)
    assert [s.isoformat() for s in slots] == [
        "2026-08-06T09:00:00+00:00",
        "2026-08-06T13:00:00+00:00",
        "2026-08-06T18:00:00+00:00",
        "2026-08-07T09:00:00+00:00",
        "2026-08-07T13:00:00+00:00",
    ]


def test_a_time_already_past_today_is_skipped_not_booked_in_the_past():
    after = datetime(2026, 8, 6, 14, 0, tzinfo=timezone.utc)
    slots = daily_slots({0, 1, 2, 3, 4, 5, 6}, "UTC", after, [(9, 0), (18, 0)], 2)
    assert slots[0].isoformat() == "2026-08-06T18:00:00+00:00"
    assert slots[1].isoformat() == "2026-08-07T09:00:00+00:00"


def test_inactive_weekdays_are_skipped_entirely():
    after = datetime(2026, 8, 6, 0, 0, tzinfo=timezone.utc)   # Thursday
    slots = daily_slots({0}, "UTC", after, [(9, 0), (18, 0)], 3)   # Mondays only
    assert [s.date().isoformat() for s in slots] == [
        "2026-08-10", "2026-08-10", "2026-08-17",
    ]


def test_no_times_or_no_days_produces_nothing():
    after = datetime(2026, 8, 6, 0, 0, tzinfo=timezone.utc)
    assert daily_slots(set(), "UTC", after, [(9, 0)], 3) == []
    assert daily_slots({0}, "UTC", after, [], 3) == []
    assert daily_slots({0}, "UTC", after, [(9, 0)], 0) == []


from worker.scheduling import Cadence, parse_cadence  # noqa: E402


def test_parse_cadence_reads_the_original_single_time_shape():
    # The shape this install's live row is stored in.
    c = parse_cadence('{"days":["mon","wed"],"time":"18:00"}')
    assert c.mode == "times"
    assert c.slots == ((18, 0, frozenset({0, 2})),)


def test_parse_cadence_reads_the_multi_time_shape():
    c = parse_cadence('{"days":["sat"],"times":["18:00","09:00"]}')
    assert c.slots == ((9, 0, frozenset({5})), (18, 0, frozenset({5})))  # sorted by time


def test_parse_cadence_reads_per_time_days():
    c = parse_cadence(
        '{"mode":"times","slots":['
        '{"time":"18:00","days":["sat","sun"]},'
        '{"time":"12:30","days":["mon"]}]}'
    )
    assert c.slots == ((12, 30, frozenset({0})), (18, 0, frozenset({5, 6})))


def test_parse_cadence_merges_slots_sharing_a_time():
    # Two sends booked for the same minute would collide on one slot.
    c = parse_cadence(
        '{"mode":"times","slots":['
        '{"time":"18:00","days":["sat"]},{"time":"18:00","days":["sun"]}]}'
    )
    assert c.slots == ((18, 0, frozenset({5, 6})),)


def test_parse_cadence_drops_an_unusable_slot_but_keeps_the_rest():
    c = parse_cadence(
        '{"mode":"times","slots":['
        '{"time":"25:00","days":["mon"]},'      # impossible time
        '{"time":"09:00","days":[]},'           # no days
        '{"time":"18:00","days":["mon"]}]}'
    )
    assert c.slots == ((18, 0, frozenset({0})),)


def test_parse_cadence_returns_none_when_nothing_is_usable():
    assert parse_cadence(None) is None
    assert parse_cadence("") is None
    assert parse_cadence("not json") is None
    assert parse_cadence('["a list, not an object"]') is None
    assert parse_cadence('{"days":[],"time":"18:00"}') is None       # no days
    assert parse_cadence('{"days":["mon"],"time":"25:00"}') is None  # no valid time
    assert parse_cadence('{"days":["mon"]}') is None                 # no time at all


def test_candidate_local_times_in_times_mode_is_just_its_times():
    c = parse_cadence('{"days":["mon"],"times":["09:00","18:00"]}')
    assert sorted(c.candidate_local_times()) == [(9, 0), (18, 0)]
