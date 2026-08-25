"""Timestamp FORMAT must never change what auto-fill thinks the queue holds.

Two writers put UTC instants into publications.scheduled_at: the Python worker
(`datetime.isoformat()` -> "…+00:00") and the Next.js dashboard (JS
`toISOString()` -> "….000Z"). Both are the same instant; only the text differs.

A group writes one row per member at a single instant and counts SLOTS, so any
count that compares the raw text sees one slot as two — reporting the queue as
fuller than it is and refusing to top up. That is a silent stall: no error, no
failed publication, just nothing scheduled.
"""

from __future__ import annotations

from datetime import datetime, timezone

from worker.autofill import (
    group_latest_future_scheduled,
    group_scheduled_ahead_count,
    run_autofill,
)
from worker.tests.test_autofill_groups import make_channel, make_group, make_post

NOW = datetime(2026, 8, 18, 17, 0, tzinfo=timezone.utc)
NOW_ISO = NOW.isoformat()

# The same instant, written by each of the two writers.
PY_FMT = "2026-08-18T19:30:00+00:00"
JS_FMT = "2026-08-18T19:30:00.000Z"


def _pub(conn, post_id, channel_id, scheduled_at, status="scheduled"):
    return conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?,?,?,?)",
        (post_id, channel_id, scheduled_at, status),
    ).lastrowid


def _group_of_two(conn, **group_kw):
    gid = make_group(conn, name="Liparoto Meta", **group_kw)
    ig = make_channel(conn, platform="instagram", name="Liparoto", group_id=gid)
    th = make_channel(conn, platform="threads", name="Liparoto", group_id=gid)
    conn.commit()
    return gid, ig, th


def test_one_slot_written_in_both_formats_counts_as_one(conn):
    """The regression: one slot, two members, two text formats -> ONE slot."""
    _gid, ig, th = _group_of_two(conn)
    pid = make_post(conn, targets=(ig, th))
    _pub(conn, pid, ig, PY_FMT)
    _pub(conn, pid, th, JS_FMT)
    conn.commit()

    assert group_scheduled_ahead_count(conn, [ig, th], NOW_ISO, "feed") == 1


def test_matching_formats_still_count_as_one(conn):
    """The already-working case must keep working."""
    _gid, ig, th = _group_of_two(conn)
    pid = make_post(conn, targets=(ig, th))
    _pub(conn, pid, ig, PY_FMT)
    _pub(conn, pid, th, PY_FMT)
    conn.commit()

    assert group_scheduled_ahead_count(conn, [ig, th], NOW_ISO, "feed") == 1


def test_genuinely_distinct_slots_are_not_collapsed(conn):
    """Two real slots stay two, whatever format each is in."""
    _gid, ig, th = _group_of_two(conn)
    pid = make_post(conn, targets=(ig, th))
    _pub(conn, pid, ig, PY_FMT)
    _pub(conn, pid, th, JS_FMT)
    _pub(conn, pid, ig, "2026-08-19T19:30:00+00:00")
    _pub(conn, pid, th, "2026-08-19T19:30:00.000Z")
    conn.commit()

    assert group_scheduled_ahead_count(conn, [ig, th], NOW_ISO, "feed") == 2


def test_latest_future_scheduled_is_the_latest_INSTANT(conn):
    """Picking the queue's tail by text lets a format decide the answer."""
    _gid, ig, th = _group_of_two(conn)
    pid = make_post(conn, targets=(ig, th))
    _pub(conn, pid, ig, "2026-08-20T19:30:00.000Z")   # latest instant, JS format
    _pub(conn, pid, th, "2026-08-19T19:30:00+00:00")
    conn.commit()

    latest = group_latest_future_scheduled(conn, [ig, th], NOW_ISO, "feed")
    assert latest is not None
    assert latest.startswith("2026-08-20T19:30:00")


def test_autofill_tops_up_a_group_whose_slot_is_split_across_formats(conn, config):
    """End to end: the stalled queue must actually refill.

    min_queue_depth=2 with ONE slot queued is a queue that needs topping up. Counting
    that slot twice makes it look healthy and auto-fill does nothing at all.
    """
    _gid, ig, th = _group_of_two(
        conn,
        min_depth=2,
        target=5,
        cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}',
        tz="America/Los_Angeles",
    )
    queued = make_post(conn, targets=(ig, th))
    _pub(conn, queued, ig, PY_FMT)
    _pub(conn, queued, th, JS_FMT)
    for _ in range(6):
        make_post(conn, targets=(ig, th))
    conn.commit()

    made = run_autofill(conn, config, NOW)
    assert made > 0, "auto-fill saw a one-slot queue as full and scheduled nothing"
