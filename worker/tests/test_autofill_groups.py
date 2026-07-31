"""Channel groups: capability-vs-rules split, group selection, and group top-up."""

from __future__ import annotations

from datetime import datetime, timezone

from worker.autofill import capable_post_ids, eligible_candidates

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


# ---- seed helpers ---------------------------------------------------------------
def make_channel(conn, *, platform="instagram", name="Chan", group_id=None,
                 autofill=0, tz="America/New_York", approval=0,
                 cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
                 min_depth=3, target=5, reuse=180, active=1):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, requires_approval,
              remote_account_id, access_token, group_id, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,'acct1','tok',?,?)""",
        (platform, name, tz, autofill, cadence, min_depth, target, reuse, approval,
         group_id, active),
    ).lastrowid


def make_group(conn, *, name="Personal", autofill=1, tz="America/New_York",
               cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
               min_depth=3, target=5, reuse=180, active=1):
    return conn.execute(
        """INSERT INTO channel_groups
             (name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, is_active)
           VALUES (?,?,?,?,?,?,?,?)""",
        (name, tz, autofill, cadence, min_depth, target, reuse, active),
    ).lastrowid


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
    assert [r["post_id"] for r in eligible_candidates(conn, ch(conn, ig), NOW, None)] == []


def test_reel_is_capable_for_instagram_but_not_threads(conn):
    ig = make_channel(conn, platform="instagram", name="IG")
    th = make_channel(conn, platform="threads", name="TH")
    reel = make_post(conn, post_type="reel", media_kind="video", targets=(ig, th))
    assert reel in capable_post_ids(conn, ch(conn, ig))
    assert reel not in capable_post_ids(conn, ch(conn, th))


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
    ig = make_channel(conn, platform="instagram", reuse=180)
    p = make_post(conn, targets=(ig,))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (p, ig, "2026-07-01T18:00:00+00:00", "2026-07-01T18:00:00+00:00"),
    )
    conn.commit()

    # 21 days ago. Channel default (180) excludes it; a group override of 7 admits it.
    assert [r["post_id"] for r in eligible_candidates(conn, ch(conn, ig), NOW, None)] == []
    got = eligible_candidates(conn, ch(conn, ig), NOW, None, reuse_default=7)
    assert [r["post_id"] for r in got] == [p]


def test_eligible_candidates_limit_none_means_unlimited(conn):
    ig = make_channel(conn, platform="instagram")
    ids = {make_post(conn, targets=(ig,)) for _ in range(5)}
    got = eligible_candidates(conn, ch(conn, ig), NOW, None)
    assert {r["post_id"] for r in got} == ids


# ---- Task 3: group selection ----------------------------------------------------
from worker.autofill import group_eligible_candidates  # noqa: E402


def grp(conn, group_id):
    return conn.execute("SELECT * FROM channel_groups WHERE id=?", (group_id,)).fetchone()


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
    got = group_eligible_candidates(conn, grp(conn, gid), members(conn, gid), NOW, limit)
    return [(r["post_id"], sorted(m["id"] for m in ms)) for r, ms in got]


def test_image_targeted_at_both_goes_to_both(conn):
    gid, ig, th = pair(conn)
    p = make_post(conn, targets=(ig, th))
    assert picked(conn, gid) == [(p, sorted([ig, th]))]


def test_reel_goes_to_instagram_only_capability_is_an_exception(conn):
    """Threads declares supports_video=False. The Reel must still queue to Instagram —
    this is the rule that keeps evergreen video recycling alive."""
    gid, ig, th = pair(conn)
    reel = make_post(conn, post_type="reel", media_kind="video", targets=(ig, th))
    assert picked(conn, gid) == [(reel, [ig])]


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
    """The group's reuse_min_age_days must win over the members' own column. Members
    default to reuse=180; the group here is 7. A publish 21 days ago is recyclable
    under the group's policy but would still be in cooldown under either member's own."""
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
    assert group_eligible_candidates(conn, grp(conn, gid), [], NOW, 5) == []
