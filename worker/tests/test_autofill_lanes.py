"""Per-surface auto-fill lanes — docs/design-autofill-lanes.md.

A lane is an owner plus a surface. A group with a feed lane and a story lane is topped
up twice per cycle, independently: separate queue depths, separate candidate pools,
separate slot walks.
"""

from __future__ import annotations

import pytest

from worker.autofill import _autofill_lanes, run_autofill

CADENCE = '{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}'


def make_channel(conn, *, platform="instagram", name="Chan", group_id=None,
                 tz="America/New_York", approval=0, active=1):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, group_id, requires_approval, is_active,
              remote_account_id, access_token)
           VALUES (?,?,?,?,?,?, 'acct1','tok')""",
        (platform, name, tz, group_id, approval, active),
    ).lastrowid


def make_group(conn, *, name="Personal", tz="America/New_York", active=1):
    return conn.execute(
        "INSERT INTO channel_groups (name, timezone, is_active) VALUES (?,?,?)",
        (name, tz, active),
    ).lastrowid


def make_lane(conn, *, channel_id=None, group_id=None, surface="feed", enabled=1,
              cadence=CADENCE, min_depth=3, target=5, reuse=180):
    return conn.execute(
        """INSERT INTO autofill_lanes
             (channel_id, group_id, surface, enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES (?,?,?,?,?,?,?,?)""",
        (channel_id, group_id, surface, enabled, cadence, min_depth, target, reuse),
    ).lastrowid


def make_post(conn, *, targets=(), post_type="single", caption="x",
              content_kind="evergreen", media_kind="image",
              created_at="2026-01-01T00:00:00+00:00", slides=1):
    """`targets` is [(channel_id, surface), ...]. `slides` controls how many assets the
    post carries, which is what makes a story fan out."""
    pid = conn.execute(
        """INSERT INTO posts (caption, post_type, content_kind, content_status, created_at)
           VALUES (?,?,?,'ready',?)""",
        (caption, post_type, content_kind, created_at),
    ).lastrowid
    for i in range(slides):
        aid = conn.execute(
            """INSERT INTO assets (content_hash, media_kind, storage_path)
               VALUES (?,?,?)""",
            (f"hash-{pid}-{i}", media_kind, f"/tmp/a{pid}_{i}.jpg"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,?)",
            (pid, aid, i),
        )
    for channel_id, surface in targets:
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,?)",
            (pid, channel_id, surface),
        )
    conn.commit()
    return pid


def test_a_group_with_two_lanes_yields_two_lanes(conn):
    gid = make_group(conn)
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    make_lane(conn, group_id=gid, surface="story")
    conn.commit()

    lanes = _autofill_lanes(conn)
    assert {lane.surface for lane in lanes} == {"feed", "story"}
    assert all(lane.is_group for lane in lanes)
    assert all(len(lane.members) == 1 for lane in lanes)


def test_a_disabled_lane_is_not_returned(conn):
    gid = make_group(conn)
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed", enabled=1)
    make_lane(conn, group_id=gid, surface="story", enabled=0)
    conn.commit()

    assert [lane.surface for lane in _autofill_lanes(conn)] == ["feed"]


def test_settings_carries_the_owners_timezone_and_bpp_dials(conn):
    """_fill_unit reads settings["timezone"], and _setting(settings, "bpp_every_days")
    swallows a missing column and returns 0 — which would silently mean "BPP off" with
    nothing logged. Both must come through on the merged settings."""
    gid = make_group(conn, tz="America/Los_Angeles")
    conn.execute("UPDATE channel_groups SET bpp_every_days = 14 WHERE id = ?", (gid,))
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    conn.commit()

    lane = _autofill_lanes(conn)[0]
    assert lane.settings["timezone"] == "America/Los_Angeles"
    assert lane.settings["bpp_every_days"] == 14
    assert lane.settings["cadence_config"] == CADENCE


def test_a_grouped_channels_own_lane_is_ignored(conn):
    """A channel in a group fills through the group. If someone hand-inserts a lane on
    the member, it must not produce a second, competing unit of work."""
    gid = make_group(conn)
    cid = make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    make_lane(conn, channel_id=cid, surface="feed")
    conn.commit()

    lanes = _autofill_lanes(conn)
    assert len(lanes) == 1
    assert lanes[0].is_group


def test_an_inactive_owner_produces_no_lanes(conn):
    gid = make_group(conn, active=0)
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    conn.commit()

    assert _autofill_lanes(conn) == []


def queue(conn, post_id, channel_id, when, *, surface="feed", asset_id=None):
    conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, surface, asset_id)
           VALUES (?,?,?, 'scheduled', ?, ?)""",
        (post_id, channel_id, when, surface, asset_id),
    )
    conn.commit()


def test_a_full_story_queue_does_not_stall_the_feed_lane(conn):
    """The single most important assertion in this feature. scheduled_ahead_count was
    surface-blind, so story sends would satisfy the feed lane's min_queue_depth check
    and the feed would silently stop filling."""
    from worker.autofill import scheduled_ahead_count

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "story")])
    for day in range(10):
        queue(conn, pid, cid, f"2099-01-{day + 1:02d}T18:00:00+00:00", surface="story")

    assert scheduled_ahead_count(conn, cid, "2026-01-01T00:00:00+00:00", "story") == 10
    assert scheduled_ahead_count(conn, cid, "2026-01-01T00:00:00+00:00", "feed") == 0


def test_story_queue_depth_counts_slots_not_slides(conn):
    """One slot fans out into one publication per slide. Counting rows would read a
    four-slide Story as four posts of queue depth and stall the lane after two picks."""
    from worker.autofill import scheduled_ahead_count

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "story")], slides=4)
    for slide in range(4):
        queue(conn, pid, cid, "2099-01-01T18:00:00+00:00", surface="story",
              asset_id=slide + 1)

    assert scheduled_ahead_count(conn, cid, "2026-01-01T00:00:00+00:00", "story") == 1


def test_latest_future_scheduled_is_per_surface(conn):
    """The slot walk starts AFTER the last queued send. A story queued far into the
    future must not push the feed lane's next slot out with it."""
    from worker.autofill import latest_future_scheduled

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "feed"), (cid, "story")])
    queue(conn, pid, cid, "2099-12-31T18:00:00+00:00", surface="story")
    queue(conn, pid, cid, "2026-09-01T18:00:00+00:00", surface="feed")

    now = "2026-01-01T00:00:00+00:00"
    assert latest_future_scheduled(conn, cid, now, "feed").startswith("2026-09-01")
    assert latest_future_scheduled(conn, cid, now, "story").startswith("2099-12-31")
