"""BPP recycling: the score, the slot arithmetic, and the autofill integration.

Auto-fill already preferred top performers, but the tier gate put every never-posted item
ahead of every proven one — 100 against 11 on the live install — so the performance term
could not touch a slot for roughly three months. These tests cover the slots that
deliberately bypass that gate, and the guarantees that make doing so safe.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker import db
from worker.autofill import eligible_candidates, rank_proven, run_autofill, select_candidates
from worker.bpp import (
    BPP_MIN_REACH, Candidate, Snapshot, engagement_rate, interactions, is_recycle_slot,
    merge_recycle_slots, rank_candidates, score_candidate,
)

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


# ---- the score (pure) --------------------------------------------------------------

def test_engagement_rate_is_interactions_per_person_reached():
    snap = Snapshot(reach=1000, likes=80, comments=15, saves=4, shares=1)
    assert engagement_rate(snap) == 0.1


def test_interactions_treat_an_unreported_field_as_zero():
    """A platform that does not report saves has not reported FEWER saves."""
    assert interactions(Snapshot(reach=100, likes=5, comments=None, saves=None, shares=2)) == 7


def test_a_post_below_the_reach_floor_has_no_score_rather_than_a_small_one():
    """Without a floor, 1 like on a reach of 3 scores 33% and outranks the whole account
    forever. Too little evidence is not the same as poor performance."""
    assert engagement_rate(Snapshot(reach=3, likes=1, comments=0, saves=0, shares=0)) is None


def test_a_measured_zero_is_a_real_score_not_a_missing_one():
    """0.0 means 'we measured, nobody engaged' and must rank LAST; None means 'we cannot
    tell' and must be left out. Collapsing them loses the distinction the ranking needs."""
    assert engagement_rate(Snapshot(reach=500, likes=0, comments=0, saves=0, shares=0)) == 0.0


def test_reach_exactly_at_the_floor_counts():
    snap = Snapshot(reach=BPP_MIN_REACH, likes=5, comments=0, saves=0, shares=0)
    assert engagement_rate(snap) is not None


def test_zero_reach_never_divides():
    assert engagement_rate(Snapshot(reach=0, likes=3, comments=0, saves=0, shares=0)) is None
    assert engagement_rate(Snapshot(reach=None, likes=3, comments=0, saves=0, shares=0)) is None


def test_a_posts_best_run_represents_it():
    """A post published twice is fairly judged by its better outing."""
    weak = Snapshot(reach=1000, likes=10, comments=0, saves=0, shares=0)     # 1%
    strong = Snapshot(reach=500, likes=50, comments=0, saves=0, shares=0)    # 10%
    assert score_candidate([weak, strong], post_id=7).rate == 0.1


def test_a_post_with_nothing_above_the_floor_scores_none(  ):
    below = Snapshot(reach=10, likes=5, comments=0, saves=0, shares=0)
    assert score_candidate([below], post_id=7).rate is None


def test_ranking_drops_unproven_posts_instead_of_sorting_them_last():
    """A recycle slot exists to run something PROVEN. Filling it from the unscored pile
    would make it an ordinary slot wearing a badge that says otherwise."""
    ranked = rank_candidates([
        Candidate(post_id=1, rate=0.05, reach=500),
        Candidate(post_id=2, rate=None, reach=900),
        Candidate(post_id=3, rate=0.11, reach=100),
    ])
    assert [c.post_id for c in ranked] == [3, 1]


def test_reach_breaks_a_tie_between_equally_engaging_posts():
    ranked = rank_candidates([
        Candidate(post_id=1, rate=0.08, reach=200),
        Candidate(post_id=2, rate=0.08, reach=900),
    ])
    assert [c.post_id for c in ranked] == [2, 1]


def test_rate_beats_raw_reach():
    """The reordering this feature exists for. Real numbers from the live account: 754
    reach at 2.7% versus 661 at 6.5% — the old reach-based score ranked them backwards."""
    ranked = rank_candidates([
        Candidate(post_id=1, rate=0.027, reach=754),
        Candidate(post_id=2, rate=0.065, reach=661),
    ])
    assert [c.post_id for c in ranked] == [2, 1]


# ---- slot arithmetic ---------------------------------------------------------------

def test_zero_means_off_and_never_divides():
    assert is_recycle_slot(0, 0) is False
    assert is_recycle_slot(7, 0) is False
    assert is_recycle_slot(3, -1) is False


def test_every_nth_slot_recycles():
    assert [i for i in range(8) if is_recycle_slot(i, 4)] == [0, 4]


def test_the_ratio_continues_across_cycles():
    """Sequence counts the unit's whole publication history, so the share holds instead of
    restarting — and clustering — with every batch."""
    assert is_recycle_slot(100, 4) is True
    assert is_recycle_slot(101, 4) is False


# ---- merging -----------------------------------------------------------------------

def _item(post_id):
    return {"post_id": post_id}


KEY = lambda item: item["post_id"]  # noqa: E731


def test_proven_picks_land_on_recycle_positions():
    merged = merge_recycle_slots(
        [_item(1), _item(2), _item(3)], [_item(9)], {1}, 3, KEY
    )
    assert [(i["post_id"], r) for i, r in merged] == [(1, False), (9, True), (2, False)]


def test_a_post_is_never_queued_twice_in_one_batch():
    """Both pools are drawn from the same library, so a proven post is usually in both.
    Without the guard the same post would be queued twice, minutes apart, to a live
    account."""
    merged = merge_recycle_slots(
        [_item(1), _item(9), _item(2)], [_item(9)], {0}, 3, KEY
    )
    ids = [i["post_id"] for i, _ in merged]
    assert ids == [9, 1, 2]
    assert len(ids) == len(set(ids))


def test_a_recycle_position_falls_back_to_normal_selection_when_nothing_is_proven():
    """Leaving the slot empty would shrink the queue to buy nothing — and the flag must
    report what actually happened, so a fallback is not badged as a recycle."""
    merged = merge_recycle_slots([_item(1), _item(2)], [], {0}, 2, KEY)
    assert [(i["post_id"], r) for i, r in merged] == [(1, False), (2, False)]


def test_the_batch_ends_early_when_both_pools_run_out():
    merged = merge_recycle_slots([_item(1)], [_item(9)], {0}, 5, KEY)
    assert len(merged) == 2


def test_exhausted_proven_pool_still_fills_later_recycle_positions_normally():
    merged = merge_recycle_slots(
        [_item(1), _item(2), _item(3)], [_item(9)], {0, 2}, 3, KEY
    )
    assert [(i["post_id"], r) for i, r in merged] == [(9, True), (1, False), (2, False)]


# ---- autofill integration ----------------------------------------------------------

def _channel(conn, *, bpp=0, target=4, min_depth=3):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, remote_account_id,
              access_token, bpp_every_n_slots)
           VALUES ('instagram','Chan','UTC',1,
                   '{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}',
                   ?,?,30,'acct1','tok',?)""",
        (min_depth, target, bpp),
    ).lastrowid


def _post(conn, channel_id, *, created_at="2026-01-01T00:00:00+00:00"):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind,"
        " created_at) VALUES ('x','single','draft','ready','evergreen',?)",
        (created_at,),
    ).lastrowid
    aid = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, public_url)"
        " VALUES (?,?,?,?)", (f"h{pid}", "image", f"{pid}.jpg", "https://a.test/x.jpg"),
    ).lastrowid
    conn.execute("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
                 (pid, aid))
    conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)",
                 (pid, channel_id))
    conn.commit()
    return pid


def _published_with_metrics(conn, post_id, channel_id, *, reach, likes, days_ago=200):
    """A completed run of `post_id` old enough to be recyclable."""
    when = (NOW - timedelta(days=days_ago)).isoformat()
    pub = conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status,"
        " published_at, remote_post_id) VALUES (?,?,?,'posted',?,?)",
        (post_id, channel_id, when, when, f"r{post_id}"),
    ).lastrowid
    conn.execute(
        "INSERT INTO post_metrics (publication_id, fetched_at, reach, likes, comments,"
        " saves, shares) VALUES (?,?,?,?,0,0,0)",
        (pub, when, reach, likes),
    )
    conn.commit()
    return pub


def test_the_score_reaches_selection_from_real_rows(conn):
    cid = _channel(conn)
    strong = _post(conn, cid)
    _published_with_metrics(conn, strong, cid, reach=500, likes=50)
    conn.commit()

    row = next(r for r in select_candidates(conn, cid, NOW) if r["post_id"] == strong)
    assert row["bpp_rate"] == 0.1
    assert row["bpp_reach"] == 500


def test_a_below_floor_run_leaves_the_score_null(conn):
    cid = _channel(conn)
    tiny = _post(conn, cid)
    _published_with_metrics(conn, tiny, cid, reach=10, likes=5)
    conn.commit()

    row = next(r for r in select_candidates(conn, cid, NOW) if r["post_id"] == tiny)
    assert row["bpp_rate"] is None


def test_rank_proven_orders_by_rate_and_drops_the_unproven(conn):
    cid = _channel(conn)
    weak = _post(conn, cid)
    strong = _post(conn, cid)
    _post(conn, cid)  # never posted, no score
    _published_with_metrics(conn, weak, cid, reach=1000, likes=20)     # 2%
    _published_with_metrics(conn, strong, cid, reach=200, likes=40)    # 20%
    conn.commit()

    ranked = rank_proven(select_candidates(conn, cid, NOW))
    assert [r["post_id"] for r in ranked] == [strong, weak]


def test_with_bpp_off_nothing_is_recycled(conn):
    """The default. Selection must stay byte-identical to before this feature existed."""
    cid = _channel(conn, bpp=0)
    proven = _post(conn, cid)
    _published_with_metrics(conn, proven, cid, reach=500, likes=50)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config_for(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE is_recycled = 1"
    ).fetchone()["c"] == 0


def test_with_bpp_on_a_proven_post_takes_a_slot(conn):
    cid = _channel(conn, bpp=2)
    proven = _post(conn, cid)
    _published_with_metrics(conn, proven, cid, reach=500, likes=50)
    for _ in range(5):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config_for(conn), NOW)

    recycled = conn.execute(
        "SELECT post_id FROM publications WHERE is_recycled = 1"
    ).fetchall()
    assert [r["post_id"] for r in recycled] == [proven]


def test_a_recycled_slot_is_recorded_so_the_choice_can_be_explained(conn):
    """Once the queue is full there is no way to reconstruct WHY something was picked,
    and 'why is this old post going out again?' is exactly what this feature prompts."""
    cid = _channel(conn, bpp=2)
    proven = _post(conn, cid)
    _published_with_metrics(conn, proven, cid, reach=500, likes=50)
    for _ in range(5):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config_for(conn), NOW)

    row = conn.execute(
        "SELECT is_recycled, created_by FROM publications WHERE post_id = ? "
        "AND status = 'scheduled'", (proven,),
    ).fetchone()
    assert row["is_recycled"] == 1 and row["created_by"] == "autofill"


def test_bpp_on_with_nothing_proven_changes_nothing(conn):
    cid = _channel(conn, bpp=2)
    for _ in range(5):
        _post(conn, cid)
    conn.commit()

    made = run_autofill(conn, _config_for(conn), NOW)

    assert made > 0, "the queue must still fill"
    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE is_recycled = 1"
    ).fetchone()["c"] == 0


def test_a_recycled_post_still_obeys_the_reuse_window(conn):
    """BPP changes WHICH eligible candidate is chosen, never WHETHER one is eligible. A
    post inside its cooldown must stay out even if it is the best performer on record."""
    cid = _channel(conn, bpp=1)          # every slot would recycle if allowed
    recent = _post(conn, cid)
    _published_with_metrics(conn, recent, cid, reach=900, likes=200, days_ago=2)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config_for(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE post_id = ? AND status = 'scheduled'",
        (recent,),
    ).fetchone()["c"] == 0


def test_a_recycled_post_is_not_also_queued_as_a_normal_pick(conn):
    cid = _channel(conn, bpp=1)
    proven = _post(conn, cid)
    _published_with_metrics(conn, proven, cid, reach=500, likes=50)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config_for(conn), NOW)

    rows = conn.execute(
        "SELECT post_id, COUNT(*) c FROM publications WHERE status='scheduled'"
        " GROUP BY post_id HAVING c > 1"
    ).fetchall()
    assert rows == [], "no post may be queued twice in one batch"


def _config_for(conn):
    from worker.config import Config

    return Config(
        database_path=":memory:", asset_storage_dir="/tmp", public_asset_base_url="",
        meta_app_id="", meta_app_secret="", graph_version="v25.0",
        graph_base="https://graph.facebook.com", default_timezone="UTC", poll_interval=1,
    )


# ---- groups ------------------------------------------------------------------------
#
# The solo path and the group path are DIFFERENT queries whose rows are read by the same
# code. A column present in one and missing from the other is not a wrong number — it is
# an IndexError on the publish path. That is exactly how the first version of this shipped
# and was caught only by running it against the owner's real (grouped) install, so the
# group path gets its own coverage here.

def _group(conn, *, bpp=0, target=4, min_depth=3):
    gid = conn.execute(
        """INSERT INTO channel_groups
             (name, timezone, autofill_enabled, cadence_config, min_queue_depth,
              target_queue_depth, reuse_min_age_days, bpp_every_n_slots)
           VALUES ('G','UTC',1,
                   '{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}',
                   ?,?,30,?)""",
        (min_depth, target, bpp),
    ).lastrowid
    members = [
        conn.execute(
            "INSERT INTO channels (platform, account_name, timezone, group_id,"
            " remote_account_id, access_token) VALUES (?,?, 'UTC', ?, 'a','t')",
            (platform, f"C{platform}", gid),
        ).lastrowid
        for platform in ("instagram", "threads")
    ]
    conn.commit()
    return gid, members


def _target_all(conn, post_id, member_ids):
    for cid in member_ids:
        conn.execute(
            "INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?,?)",
            (post_id, cid),
        )
    conn.commit()


def test_the_group_ranking_carries_the_score(conn):
    """The regression guard. group_rank is a separate query from select_candidates, and
    _apply_bpp reads bpp_rate off whichever it got."""
    gid, members = _group(conn)
    from worker.autofill import group_rank

    pid = _post(conn, members[0])
    _target_all(conn, pid, members)
    _published_with_metrics(conn, pid, members[0], reach=400, likes=40)
    conn.commit()

    rows = group_rank(conn, members, [pid])
    assert rows[0]["bpp_rate"] == 0.1
    assert rows[0]["bpp_reach"] == 400


def test_a_group_recycles_a_proven_post_to_every_member(conn):
    """A group fills as one unit — one slot, one publication per member. A recycle must
    not break that or the accounts drift apart, which is what groups exist to prevent."""
    gid, members = _group(conn, bpp=2)
    proven = _post(conn, members[0])
    _target_all(conn, proven, members)
    _published_with_metrics(conn, proven, members[0], reach=400, likes=40)
    for _ in range(5):
        pid = _post(conn, members[0])
        _target_all(conn, pid, members)
    conn.commit()

    run_autofill(conn, _config_for(conn), NOW)

    rows = conn.execute(
        "SELECT channel_id, scheduled_at FROM publications"
        " WHERE post_id = ? AND is_recycled = 1", (proven,),
    ).fetchall()
    assert {r["channel_id"] for r in rows} == set(members), "every member gets it"
    assert len({r["scheduled_at"] for r in rows}) == 1, "at one shared slot time"


def test_a_group_with_bpp_off_recycles_nothing(conn):
    gid, members = _group(conn, bpp=0)
    proven = _post(conn, members[0])
    _target_all(conn, proven, members)
    _published_with_metrics(conn, proven, members[0], reach=400, likes=40)
    for _ in range(4):
        pid = _post(conn, members[0])
        _target_all(conn, pid, members)
    conn.commit()

    run_autofill(conn, _config_for(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE is_recycled = 1"
    ).fetchone()["c"] == 0
