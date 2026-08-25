"""Per-surface auto-fill lanes — docs/design-autofill-lanes.md.

A lane is an owner plus a surface. A group with a feed lane and a story lane is topped
up twice per cycle, independently: separate queue depths, separate candidate pools,
separate slot walks.
"""

from __future__ import annotations

from datetime import datetime, timezone as _tz

import pytest

from worker.autofill import _autofill_lanes, run_autofill

CADENCE = '{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}'


def _now():
    """A fixed 'now' well after every fixture's created_at, so cooldown and season gates
    behave deterministically."""
    return datetime(2026, 6, 1, 12, 0, tzinfo=_tz.utc)


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


def test_a_story_lane_picks_only_story_targeted_posts(conn):
    from worker.autofill import eligible_candidates

    cid = make_channel(conn)
    feed_only = make_post(conn, targets=[(cid, "feed")], caption="feed only")
    story_ok = make_post(conn, targets=[(cid, "story")], caption="story ok")
    channel = conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()
    now = _now()

    story_ids = {r["post_id"] for r in
                 eligible_candidates(conn, channel, now, None, surface="story")}
    feed_ids = {r["post_id"] for r in
                eligible_candidates(conn, channel, now, None, surface="feed")}

    assert story_ids == {story_ok}
    assert feed_ids == {feed_only}


def test_a_long_caption_blocks_the_feed_lane_but_not_the_story_lane(conn):
    """A Story sends no caption at all (publisher.py suppresses it unconditionally), so
    gating a story candidate on caption length would silently empty the rotation over a
    limit that is never applied to it."""
    from worker.autofill import eligible_candidates

    cid = make_channel(conn, platform="threads")
    long_caption = "x" * 10_000
    pid = make_post(conn, targets=[(cid, "feed"), (cid, "story")], caption=long_caption)
    channel = conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()
    now = _now()

    feed = {r["post_id"] for r in
            eligible_candidates(conn, channel, now, None, surface="feed")}
    assert pid not in feed, "over the platform's caption limit — would fail forever"

    story = {r["post_id"] for r in
             eligible_candidates(conn, channel, now, None, surface="story")}
    assert pid in story, "a story sends no caption, so the limit does not apply"


def test_a_story_lane_on_a_mixed_group_reaches_only_story_capable_members(conn, config):
    """Drives run_autofill rather than the inner function, because the capability gate
    lives in _fill_unit — which is what makes it cover the SOLO path too, not just
    groups. Asserts on channel_id only: at this point in the build the insert does not
    yet write `surface` (Task 6 adds that), so filtering on it here would assert nothing."""
    gid = make_group(conn)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid)
    fb = make_channel(conn, platform="facebook", name="FB", group_id=gid)
    make_lane(conn, group_id=gid, surface="story", min_depth=3, target=2)
    make_post(conn, targets=[(ig, "story"), (fb, "story")])
    conn.commit()

    run_autofill(conn, config, _now())

    reached = {r["channel_id"] for r in conn.execute(
        "SELECT DISTINCT channel_id FROM publications WHERE created_by = 'autofill'"
    ).fetchall()}
    assert reached == {ig}, "Facebook has no Stories surface — it must get nothing"


def test_a_story_lane_on_a_story_incapable_solo_channel_fills_nothing(conn, config):
    """The reason the gate is in _fill_unit and not in group_eligible_candidates. A solo
    Telegram story lane must be refused by the WORKER; it must not depend on the
    dashboard never offering one."""
    cid = make_channel(conn, platform="telegram", name="TG")
    make_lane(conn, channel_id=cid, surface="story", min_depth=3, target=2)
    make_post(conn, targets=[(cid, "story")])
    conn.commit()

    assert run_autofill(conn, config, _now()) == 0


def test_a_feed_slot_makes_one_publication_covering_every_asset(conn):
    from worker.autofill import _slide_asset_ids

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "feed")], post_type="carousel", slides=3)
    assert _slide_asset_ids(conn, pid, "feed") == [None], \
        "a feed send means ALL assets in order, which is what asset_id NULL encodes"


def test_a_story_slot_makes_one_publication_per_slide_in_order(conn):
    from worker.autofill import _slide_asset_ids

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "story")], post_type="carousel", slides=4)
    expected = [r["asset_id"] for r in conn.execute(
        "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order", (pid,)
    ).fetchall()]
    assert _slide_asset_ids(conn, pid, "story") == expected
    assert len(expected) == 4


def test_run_autofill_writes_story_sends_with_surface_and_asset_id(conn, config):
    """End to end: a story lane queues a four-slide post as four Stories at ONE instant,
    ordered by ascending id — the order worker/db.py's `ORDER BY scheduled_at, id`
    relies on to send them out in sequence."""
    cid = make_channel(conn)
    make_lane(conn, channel_id=cid, surface="story", min_depth=3, target=3)
    pid = make_post(conn, targets=[(cid, "story")], post_type="carousel", slides=4)
    conn.commit()

    made = run_autofill(conn, config, _now())
    assert made > 0

    rows = conn.execute(
        """SELECT id, surface, asset_id, scheduled_at FROM publications
            WHERE post_id = ? ORDER BY id""",
        (pid,),
    ).fetchall()
    assert len(rows) == 4, "four slides, four independent Stories"
    assert {r["surface"] for r in rows} == {"story"}
    assert [r["asset_id"] for r in rows] == [r["asset_id"] for r in conn.execute(
        "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order", (pid,)
    ).fetchall()]
    assert len({r["scheduled_at"] for r in rows}) == 1, "one slot, one instant"


def test_a_feed_lane_still_writes_exactly_one_row_with_a_null_asset(conn, config):
    """The regression guard: feed behaviour must be byte-identical to before lanes."""
    cid = make_channel(conn)
    make_lane(conn, channel_id=cid, surface="feed", min_depth=3, target=1)
    pid = make_post(conn, targets=[(cid, "feed")], post_type="carousel", slides=3)
    conn.commit()

    run_autofill(conn, config, _now())

    rows = conn.execute(
        "SELECT surface, asset_id FROM publications WHERE post_id = ?", (pid,)
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["surface"] == "feed"
    assert rows[0]["asset_id"] is None


def test_a_story_lane_never_queues_a_bpp_recycle(conn, config):
    """BPP dials live on the OWNER, so a story lane inherits them through settings. It
    must skip the BPP step anyway: recycling a best-performing post as a Story was never
    asked for, and _last_bpp_date is surface-blind, so a story recycle would also move
    the feed lane's next BPP due date."""
    cid = make_channel(conn)
    conn.execute("UPDATE channels SET bpp_every_days = 1 WHERE id = ?", (cid,))
    make_lane(conn, channel_id=cid, surface="story", min_depth=3, target=3)
    pid = make_post(conn, targets=[(cid, "story")])
    conn.execute("UPDATE posts SET is_bpp = 1 WHERE id = ?", (pid,))
    conn.commit()

    run_autofill(conn, config, _now())

    recycled = conn.execute(
        "SELECT COUNT(*) FROM publications WHERE is_recycled = 1"
    ).fetchone()[0]
    assert recycled == 0, "BPP is a feed-only concept"
