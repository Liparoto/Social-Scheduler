"""Channel groups: capability-vs-rules split, group selection, and group top-up."""

from __future__ import annotations

from datetime import datetime, timezone

from worker.autofill import capable_post_ids, eligible_candidates

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


# The value written to the SUPERSEDED reuse_min_age_days columns on channels and
# channel_groups. Since migration 0028 nothing writes them and nothing may read them, so
# they hold a window long enough that any code still reading one drops every recyclable
# post and fails its test loudly. Writing the SAME number to the column and the lane —
# which this file used to do — is what let a solo lane's reuse setting stay write-only
# with a green suite.
COLUMN_REUSE_SENTINEL = 9999


# ---- seed helpers ---------------------------------------------------------------
def make_channel(conn, *, platform="instagram", name="Chan", group_id=None,
                 autofill=0, tz="America/New_York", approval=0,
                 cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
                 min_depth=3, target=5, reuse=180, active=1,
                 column_reuse=COLUMN_REUSE_SENTINEL):
    channel_id = conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, requires_approval,
              remote_account_id, access_token, group_id, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,'acct1','tok',?,?)""",
        (platform, name, tz, autofill, cadence, min_depth, target, column_reuse, approval,
         group_id, active),
    ).lastrowid
    if group_id is None:
        # A grouped channel fills through its group's lane — giving it one of its own
        # here would create a stray row the loader must (and does, per
        # test_a_grouped_channels_own_lane_is_ignored) ignore, so only the ungrouped
        # case needs one to keep this suite's assertions meaningful.
        conn.execute(
            """INSERT INTO autofill_lanes
                 (channel_id, surface, enabled, cadence_config,
                  min_queue_depth, target_queue_depth, reuse_min_age_days)
               VALUES (?, 'feed', ?, ?, ?, ?, ?)""",
            (channel_id, autofill, cadence, min_depth, target, reuse),
        )
    return channel_id


def make_group(conn, *, name="Personal", autofill=1, tz="America/New_York",
               cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
               min_depth=3, target=5, reuse=180, active=1,
               column_reuse=COLUMN_REUSE_SENTINEL):
    group_id = conn.execute(
        """INSERT INTO channel_groups
             (name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, is_active)
           VALUES (?,?,?,?,?,?,?,?)""",
        (name, tz, autofill, cadence, min_depth, target, column_reuse, active),
    ).lastrowid
    conn.execute(
        """INSERT INTO autofill_lanes
             (group_id, surface, enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES (?, 'feed', ?, ?, ?, ?, ?)""",
        (group_id, autofill, cadence, min_depth, target, reuse),
    )
    return group_id


def make_post(conn, *, post_type="single", caption="x", targets=(),
              created_at="2026-01-01T00:00:00+00:00", content_kind="evergreen",
              media_kind="image"):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at) "
        "VALUES (?,?,'draft','ready',?,?)",
        (caption, post_type, content_kind, created_at),
    ).lastrowid
    if post_type != "text":
        aid = conn.execute(
            "INSERT INTO assets (content_hash, media_kind, storage_path, public_url) "
            "VALUES (?,?,?,?)",
            (f"h{pid}", media_kind, f"{pid}.bin", "https://a.test/x"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
            (pid, aid),
        )
    for cid in targets:
        conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, cid))
    conn.commit()
    return pid


def ch(conn, channel_id):
    return conn.execute("SELECT * FROM channels WHERE id=?", (channel_id,)).fetchone()


# ---- Task 2: capability vs rules ------------------------------------------------
def test_capable_post_ids_ignores_targeting_and_cooldown(conn):
    """Capability is about the PLATFORM, not the rules. A post nobody targets is still
    'capable' — that is what lets the group logic tell a capability miss apart from a
    rule miss."""
    ig = make_channel(conn, platform="instagram")
    untargeted = make_post(conn, targets=())
    assert untargeted in capable_post_ids(conn, ch(conn, ig))
    assert [r["post_id"] for r in
            eligible_candidates(conn, ch(conn, ig), NOW, None, surface="feed")] == []


def test_video_post_is_capable_for_instagram_but_not_threads(conn):
    ig = make_channel(conn, platform="instagram", name="IG")
    th = make_channel(conn, platform="threads", name="TH")
    video_post = make_post(conn, post_type="video", media_kind="video", targets=(ig, th))
    assert video_post in capable_post_ids(conn, ch(conn, ig))
    assert video_post not in capable_post_ids(conn, ch(conn, th))


def test_long_caption_is_capable_for_instagram_but_not_threads(conn):
    """Threads caps captions at 500 chars; Instagram at 2200."""
    ig = make_channel(conn, platform="instagram", name="IG")
    th = make_channel(conn, platform="threads", name="TH")
    long_post = make_post(conn, caption="c" * 600, targets=(ig, th))
    assert long_post in capable_post_ids(conn, ch(conn, ig))
    assert long_post not in capable_post_ids(conn, ch(conn, th))


def test_eligible_candidates_accepts_policy_overrides(conn):
    """A group supplies its own reuse_min_age_days and timezone; the member channel's
    values must not be consulted when overrides are passed."""
    ig = make_channel(conn, platform="instagram", column_reuse=180)
    p = make_post(conn, targets=(ig,))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (p, ig, "2026-07-01T18:00:00+00:00", "2026-07-01T18:00:00+00:00"),
    )
    conn.commit()

    # 21 days ago. Channel default (180) excludes it; a group override of 7 admits it.
    assert [r["post_id"] for r in
            eligible_candidates(conn, ch(conn, ig), NOW, None, surface="feed")] == []
    got = eligible_candidates(conn, ch(conn, ig), NOW, None, surface="feed", reuse_default=7)
    assert [r["post_id"] for r in got] == [p]


def test_eligible_candidates_limit_none_means_unlimited(conn):
    ig = make_channel(conn, platform="instagram")
    ids = {make_post(conn, targets=(ig,)) for _ in range(5)}
    got = eligible_candidates(conn, ch(conn, ig), NOW, None, surface="feed")
    assert {r["post_id"] for r in got} == ids


# ---- Task 3: group selection ----------------------------------------------------
from worker.autofill import group_eligible_candidates  # noqa: E402


def grp(conn, group_id, surface="feed"):
    """The lane SETTINGS _fill_unit would hand group_eligible_candidates — the lane row
    merged with the owner's timezone and bpp dials — not the raw channel_groups row.

    Handing over the raw group row would read `channel_groups.reuse_min_age_days`, a
    column frozen and unwritten since migration 0028, and every assertion below would be
    about a number the worker never consults.
    """
    from worker.autofill import _lane_settings
    group = conn.execute(
        "SELECT * FROM channel_groups WHERE id=?", (group_id,)
    ).fetchone()
    lane = conn.execute(
        "SELECT * FROM autofill_lanes WHERE group_id=? AND surface=?",
        (group_id, surface),
    ).fetchone()
    return _lane_settings(lane, group)


def members(conn, group_id):
    return conn.execute(
        "SELECT * FROM channels WHERE group_id=? AND is_active=1 ORDER BY id", (group_id,)
    ).fetchall()


def pair(conn, **kw):
    """A group with an Instagram and a Threads member. Returns (gid, ig_id, th_id)."""
    gid = make_group(conn, **kw)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid)
    return gid, ig, th


def picked(conn, gid, limit=10):
    got = group_eligible_candidates(
        conn, grp(conn, gid), members(conn, gid), NOW, limit, surface="feed"
    )
    return [(r["post_id"], sorted(m["id"] for m in ms)) for r, ms in got]


def test_image_targeted_at_both_goes_to_both(conn):
    gid, ig, th = pair(conn)
    p = make_post(conn, targets=(ig, th))
    assert picked(conn, gid) == [(p, sorted([ig, th]))]


def test_video_post_goes_to_instagram_only_capability_is_an_exception(conn):
    """Threads declares supports_video=False. The video post must still queue to
    Instagram — this is the rule that keeps evergreen video recycling alive."""
    gid, ig, th = pair(conn)
    video_post = make_post(conn, post_type="video", media_kind="video", targets=(ig, th))
    assert picked(conn, gid) == [(video_post, [ig])]


def test_long_caption_goes_to_instagram_only(conn):
    gid, ig, th = pair(conn)
    long_post = make_post(conn, caption="c" * 600, targets=(ig, th))
    assert picked(conn, gid) == [(long_post, [ig])]


def test_cooldown_on_one_member_blocks_the_whole_group(conn):
    """A RULE miss, unlike a capability miss, holds every member back so the accounts
    never drift apart."""
    gid, ig, th = pair(conn, reuse=180)
    p = make_post(conn, targets=(ig, th))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (p, th, "2026-07-01T18:00:00+00:00", "2026-07-01T18:00:00+00:00"),
    )
    conn.commit()
    assert picked(conn, gid) == []


def test_post_targeted_at_only_one_member_is_never_selected(conn):
    gid, ig, th = pair(conn)
    only_ig = make_post(conn, targets=(ig,))
    assert picked(conn, gid) == []


def test_already_queued_on_one_member_blocks_the_group(conn):
    gid, ig, th = pair(conn)
    p = make_post(conn, targets=(ig, th))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status) "
        "VALUES (?,?,?,'scheduled')",
        (p, ig, "2026-08-01T18:00:00+00:00"),
    )
    conn.commit()
    assert picked(conn, gid) == []


def test_blackout_on_the_group_timezone_blocks_the_group(conn):
    gid, ig, th = pair(conn)
    p = make_post(conn, targets=(ig, th))
    # NOTE: the column is recurs_yearly (1/0), not `kind` — see migrations/0002.
    period_id = conn.execute(
        "INSERT INTO periods (name, recurs_yearly, start_month, start_day, end_month, end_day) "
        "VALUES ('Summer',1,7,1,8,31)"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?,'blackout')",
        (p, period_id),
    )
    conn.commit()
    assert picked(conn, gid) == []


def test_group_reuse_override_governs_over_member_reuse(conn):
    """The group LANE's reuse_min_age_days must win over the members' own column. Each
    member's column holds COLUMN_REUSE_SENTINEL; the group's lane here is 7. A publish 21
    days ago is recyclable under the lane's policy and in cooldown under any column."""
    gid, ig, th = pair(conn, reuse=7)
    p = make_post(conn, targets=(ig, th))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (p, ig, "2026-07-01T18:00:00+00:00", "2026-07-01T18:00:00+00:00"),
    )
    conn.commit()
    assert picked(conn, gid) == [(p, sorted([ig, th]))]


def test_group_timezone_override_governs_over_member_timezone(conn):
    """The group's timezone must win over the members' own column. NOW
    (2026-07-22T18:00 UTC) is 2026-07-22 in America/Los_Angeles but 2026-07-23 in
    Asia/Tokyo. A one-day blackout on July 23 only blocks the post if the GROUP's
    tz (Tokyo) is what's consulted -- both members' own tz (LA) would not."""
    gid = make_group(conn, tz="Asia/Tokyo")
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid, tz="America/Los_Angeles")
    th = make_channel(conn, platform="threads", name="TH", group_id=gid, tz="America/Los_Angeles")
    p = make_post(conn, targets=(ig, th))
    period_id = conn.execute(
        "INSERT INTO periods (name, recurs_yearly, start_month, start_day, end_month, end_day) "
        "VALUES ('OneDay',1,7,23,7,23)"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?,'blackout')",
        (p, period_id),
    )
    conn.commit()
    assert picked(conn, gid) == []


def test_group_ranking_prefers_never_posted_then_best_member_not_the_sum(conn):
    """perf is the MAX across members, never the sum: Threads reports no reach/saves,
    so summing would halve every score and scramble Instagram's real ordering."""
    gid, ig, th = pair(conn)
    weak = make_post(conn, targets=(ig, th), created_at="2026-01-01T00:00:00+00:00")
    strong = make_post(conn, targets=(ig, th), created_at="2026-01-02T00:00:00+00:00")
    for pid, reach in ((weak, 10), (strong, 900)):
        pub = conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
            "VALUES (?,?,?,'posted',?)",
            (pid, ig, "2026-01-10T18:00:00+00:00", "2026-01-10T18:00:00+00:00"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_metrics (publication_id, fetched_at, reach, saves) VALUES (?,?,?,0)",
            (pub, "2026-01-10T18:00:00+00:00", reach),
        )
    fresh = make_post(conn, targets=(ig, th), created_at="2026-01-03T00:00:00+00:00")
    conn.commit()

    order = [pid for pid, _ in picked(conn, gid)]
    assert order[0] == fresh, "never-posted-on-any-member ranks first"
    assert order[1:] == [strong, weak], "then best member's performance, descending"


def test_group_ranking_uses_max_not_sum_when_metrics_split_across_members(conn):
    """Discriminates MAX from SUM directly: post A has reach 100 on EACH member (MAX=100,
    SUM=200); post B has reach 150 on only one member (MAX=150, SUM=150). MAX ranks
    [B, A] because B's best member beat A's best member. SUM would rank [A, B] because
    A's total (200) beats B's total (150)."""
    gid, ig, th = pair(conn)
    a = make_post(conn, targets=(ig, th), created_at="2026-01-01T00:00:00+00:00")
    b = make_post(conn, targets=(ig, th), created_at="2026-01-02T00:00:00+00:00")
    for cid, reach in ((ig, 100), (th, 100)):
        pub = conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
            "VALUES (?,?,?,'posted',?)",
            (a, cid, "2026-01-10T18:00:00+00:00", "2026-01-10T18:00:00+00:00"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_metrics (publication_id, fetched_at, reach, saves) VALUES (?,?,?,0)",
            (pub, "2026-01-10T18:00:00+00:00", reach),
        )
    pub = conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (b, ig, "2026-01-10T18:00:00+00:00", "2026-01-10T18:00:00+00:00"),
    ).lastrowid
    conn.execute(
        "INSERT INTO post_metrics (publication_id, fetched_at, reach, saves) VALUES (?,?,?,0)",
        (pub, "2026-01-10T18:00:00+00:00", 150),
    )
    conn.commit()

    order = [pid for pid, _ in picked(conn, gid)]
    assert order == [b, a], "MAX(150,150 vs 100,100) ranks B first; SUM(150 vs 200) would rank A first"


def test_group_selection_respects_limit(conn):
    gid, ig, th = pair(conn)
    for _ in range(5):
        make_post(conn, targets=(ig, th))
    assert len(picked(conn, gid, limit=2)) == 2


def test_group_with_no_active_members_selects_nothing(conn):
    gid = make_group(conn)
    assert group_eligible_candidates(
        conn, grp(conn, gid), [], NOW, 5, surface="feed"
    ) == []


# ---- Task 4: group top-up -------------------------------------------------------
from worker.autofill import run_autofill  # noqa: E402


def pubs(conn, channel_id):
    return conn.execute(
        "SELECT * FROM publications WHERE channel_id=? ORDER BY scheduled_at", (channel_id,)
    ).fetchall()


def test_group_queues_both_members_at_the_identical_timestamp(conn, config):
    gid, ig, th = pair(conn, min_depth=2, target=2)
    for _ in range(3):
        make_post(conn, targets=(ig, th))

    made = run_autofill(conn, config, NOW)

    ig_rows, th_rows = pubs(conn, ig), pubs(conn, th)
    assert len(ig_rows) == 2 and len(th_rows) == 2
    assert made == 4, "two slots x two members"
    assert [r["scheduled_at"] for r in ig_rows] == [r["scheduled_at"] for r in th_rows]
    assert [r["post_id"] for r in ig_rows] == [r["post_id"] for r in th_rows]
    assert all(r["created_by"] == "autofill" for r in ig_rows + th_rows)


def test_group_queue_depth_counts_slots_not_rows(conn, config):
    """A 2-member group writes 2 rows per slot. Counting rows would report the queue as
    twice as full as it is and stop refilling at half the target.

    The asymmetry only bites once the queue is non-empty, so this seeds two existing
    slots directly (4 rows across both members) before calling run_autofill: read as
    DISTINCT scheduled_at, ahead=2 (< min_depth=3, needs 1 more); read as a plain row
    count, ahead=4 (>= min_depth=3, would skip and add nothing)."""
    gid, ig, th = pair(conn, min_depth=3, target=3)
    for i in range(2):
        pid = make_post(conn, targets=(ig, th))
        slot = f"2026-07-2{3 + i}T18:00:00+00:00"
        for member in (ig, th):
            conn.execute(
                "INSERT INTO publications (post_id, channel_id, scheduled_at, status, created_by) "
                "VALUES (?,?,?,'scheduled','autofill')",
                (pid, member, slot),
            )
    conn.commit()
    fresh = make_post(conn, targets=(ig, th))

    run_autofill(conn, config, NOW)

    ig_rows = pubs(conn, ig)
    assert len(ig_rows) == 3, "2 existing slots + 1 top-up slot, not stalled at 2"
    assert len({r["scheduled_at"] for r in ig_rows}) == 3
    assert ig_rows[-1]["post_id"] == fresh


def test_group_reel_queues_instagram_only_and_does_not_stall_the_slot(conn, config):
    gid, ig, th = pair(conn, min_depth=1, target=1)
    reel = make_post(conn, post_type="video", media_kind="video", targets=(ig, th))

    run_autofill(conn, config, NOW)

    assert [r["post_id"] for r in pubs(conn, ig)] == [reel]
    assert pubs(conn, th) == []


def test_group_honours_each_members_own_requires_approval(conn, config):
    gid = make_group(conn, min_depth=1, target=1)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid, approval=0)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid, approval=1)
    make_post(conn, targets=(ig, th))

    run_autofill(conn, config, NOW)

    assert pubs(conn, ig)[0]["status"] == "scheduled"
    assert pubs(conn, th)[0]["status"] == "pending_approval"


def test_inactive_member_is_excluded_from_the_group(conn, config):
    gid = make_group(conn, min_depth=1, target=1)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid, active=0)
    p = make_post(conn, targets=(ig,))  # targeted at the ACTIVE member only

    run_autofill(conn, config, NOW)

    assert [r["post_id"] for r in pubs(conn, ig)] == [p]
    assert pubs(conn, th) == []


def test_grouped_channel_is_not_also_filled_as_a_solo_unit(conn, config):
    """A grouped channel's own autofill_enabled must go unread — otherwise it would be
    topped up twice per cycle, once by the group and once by itself.

    Seeds 6 spare posts (group only needs 1) so a second, solo pass over `ig` — were the
    group_id IS NULL guard ever dropped — would have plenty of untargeted-by-the-group
    content left to grab under ig's own (higher) target_queue_depth=5 default."""
    gid = make_group(conn, min_depth=1, target=1)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid, autofill=1)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid, autofill=1)
    for _ in range(6):
        make_post(conn, targets=(ig, th))

    run_autofill(conn, config, NOW)

    assert len(pubs(conn, ig)) == 1


def test_disabled_group_fills_nothing(conn, config):
    gid, ig, th = pair(conn, autofill=0)
    make_post(conn, targets=(ig, th))
    assert run_autofill(conn, config, NOW) == 0


def test_ungrouped_channel_still_fills_on_its_own_settings(conn, config):
    """Regression guard: solo behaviour must be untouched by the unit refactor."""
    solo = make_channel(conn, platform="instagram", name="Solo", autofill=1,
                        min_depth=2, target=2)
    for _ in range(3):
        make_post(conn, targets=(solo,))

    assert run_autofill(conn, config, NOW) == 2
    assert len(pubs(conn, solo)) == 2


# ---- transaction safety ---------------------------------------------------------
import sqlite3  # noqa: E402

import pytest  # noqa: E402


def test_failed_group_insert_persists_nothing_and_leaves_no_open_transaction(conn, config):
    """A mid-group insert failure must leave the queue exactly as it was.

    worker/db.py connects with sqlite3's default isolation, so the inserts sit in an
    implicit transaction, and run.py catches the error and REUSES the connection — the
    next cycle's heartbeat commit would otherwise persist a half-queued group (Instagram
    scheduled, Threads not), which is precisely the drift groups exist to prevent. It
    would also hold the writer lock for a whole poll interval, blocking the dashboard.

    The failure is simulated with a trigger that aborts the second member's insert. The
    real-world trigger is a channel deleted in the dashboard between _autofill_lanes
    reading its members and _fill_unit inserting (foreign keys are ON).
    """
    gid, ig, th = pair(conn, min_depth=1, target=1)
    make_post(conn, targets=(ig, th))
    # SQLite forbids bound parameters inside a trigger body, so the member id is
    # interpolated — it is a locally created integer, not input.
    conn.execute(
        f"""CREATE TRIGGER fail_second_member BEFORE INSERT ON publications
              WHEN NEW.channel_id = {int(th)}
              BEGIN SELECT RAISE(ABORT, 'simulated mid-group insert failure'); END"""
    )
    conn.commit()

    with pytest.raises(sqlite3.Error):
        run_autofill(conn, config, NOW)

    assert conn.in_transaction is False, "leaked write txn holds SQLite's writer lock"
    conn.commit()  # what run.py's next-cycle write_heartbeat would do
    assert conn.execute("SELECT COUNT(*) FROM publications").fetchone()[0] == 0
