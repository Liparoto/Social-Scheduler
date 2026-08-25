"""BPP: a curated pool of the owner's best posts, rotated on a cadence.

The earlier version of this feature scored posts automatically and got it wrong in an
instructive way — engagement rate ranked a 59-reach post above one with 1,462 reach and
151 interactions, because a small denominator inflates a rate. The owner already curates
by hand and better. So nothing here decides what is good; it surfaces candidates and
schedules the ones a person marked.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from worker.autofill import bpp_pool, run_autofill
from worker.bpp import (
    MIN_DISCRIMINATING_CUTOFF, Standout, bpp_slot_indices, find_standouts,
    percentile_cutoff, pool_is_thin, rotation_period_days,
)

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


# ---- which metrics can discriminate -------------------------------------------------

def test_a_metric_everyone_scores_zero_or_one_on_is_not_a_signal():
    """Live example: this account's saves have a median of 0 and a top-10% cutoff of 1,
    so "top 10% for saves" would mean "got one save" — true, useless, and it would badge a
    third of the library."""
    saves = [0] * 90 + [1] * 8 + [2] * 2
    assert percentile_cutoff(saves, 0.10) is None


def test_saves_DO_count_on_an_account_whose_audience_saves():
    """The exclusion above is per-account and recomputed every time — it is not a list of
    metrics that count. On an account where people actually save, saves rank like anything
    else."""
    saves = list(range(0, 200, 2))  # a real spread, plenty above the floor
    cutoff = percentile_cutoff(saves, 0.10)
    assert cutoff is not None and cutoff >= MIN_DISCRIMINATING_CUTOFF

    posts = [{"id": i, "saves": v} for i, v in enumerate(saves)]
    standouts = {s.post_id: s for s in find_standouts(posts)}
    top = max(posts, key=lambda p: p["saves"])
    assert "saves" in standouts[top["id"]].broad


def test_too_few_posts_to_rank_yields_no_signal():
    """A brand-new account gets no standouts rather than badging noise."""
    assert percentile_cutoff([100, 50, 10], 0.10) is None


def test_a_metric_nobody_reports_is_skipped():
    """Threads reports no reach at all — every value is None."""
    assert percentile_cutoff([None] * 50, 0.10) is None


# ---- surfacing candidates -----------------------------------------------------------

def _spread(metric, values):
    # Dated so peer windows are deterministic — standouts are ranked against
    # contemporaries, so undated fixtures would sort arbitrarily.
    return [
        {"id": i, metric: v, "published_at": f"2026-01-01T00:00:{i:02d}"}
        for i, v in enumerate(values)
    ]


def test_a_post_far_above_average_on_one_metric_is_a_candidate():
    """'Way above average likes' on its own is a reason the owner marks a post."""
    posts = _spread("likes", [5] * 95 + [200, 190, 180, 170, 160])
    standouts = {s.post_id: s for s in find_standouts(posts)}
    best = standouts[95]
    assert "likes" in best.strong
    assert best.is_candidate


def test_an_ordinary_post_is_not_a_candidate():
    posts = _spread("likes", [5] * 95 + [200, 190, 180, 170, 160])
    standouts = {s.post_id: s for s in find_standouts(posts)}
    assert standouts[0].is_candidate is False


def test_good_across_several_metrics_is_a_candidate_without_leading_any():
    """'Multiple metrics were well above average' — the other reason given, and it must
    qualify even when no single metric is outstanding."""
    posts = []
    for i in range(100):
        posts.append({"id": i, "likes": i, "reach": i * 10, "views": i * 20,
                      "published_at": f"2026-01-01T00:00:{i:02d}"})
    # id 91 sits in the top decile of all three, top 5% of none.
    standouts = {s.post_id: s for s in find_standouts(posts)}
    # Within its own peer window this post is good across the board without topping any
    # single metric — the "several things were up together" case.
    broad_only = [s for s in standouts.values() if not s.strong and len(s.broad) >= 2]
    assert broad_only, "some post must qualify on breadth alone"
    assert all(s.is_candidate for s in broad_only)


def test_the_reason_names_the_metrics_not_a_score():
    """'This was saved far more than usual' is actionable; '0.42' is not."""
    assert Standout(1, ("likes",), ()).reason() == "top 5% · likes"
    assert Standout(1, (), ("likes", "reach")).reason() == "top 10% · likes, reach"
    assert Standout(1, (), ("likes",)).reason() == ""


def test_standouts_are_relative_to_the_account_being_looked_at():
    """No absolute thresholds anywhere: an account averaging 11 likes and one averaging
    11,000 both get a useful answer."""
    small = find_standouts(_spread("likes", [5] * 95 + [60, 55, 50, 45, 40]))
    large = find_standouts(_spread("likes", [5000] * 95 + [60000, 55000, 50000, 45000, 40000]))
    assert sum(s.is_candidate for s in small) == sum(s.is_candidate for s in large)


def test_no_posts_is_not_a_crash():
    assert find_standouts([]) == []


# ---- the pool, stated plainly -------------------------------------------------------

def test_the_rotation_period_is_pool_size_times_cadence():
    """The number the owner actually needs. Two posts every 14 days is not 'every 14
    days' — it is each post reappearing monthly."""
    assert rotation_period_days(2, 14) == 28
    assert rotation_period_days(12, 30) == 360


def test_no_rotation_period_when_off_or_empty():
    assert rotation_period_days(0, 14) is None
    assert rotation_period_days(5, 0) is None


def test_a_thin_pool_is_flagged():
    assert pool_is_thin(2, 14) is True      # each post back every 28 days
    assert pool_is_thin(12, 30) is False    # each post back yearly


# ---- when a BPP is due --------------------------------------------------------------

def _days(*offsets):
    return [date(2026, 8, 1) + timedelta(days=o) for o in offsets]


def test_nothing_is_due_when_the_cadence_is_off():
    assert bpp_slot_indices(_days(0, 1, 2), None, 0) == set()


def test_the_first_slot_takes_one_when_none_has_ever_gone_out():
    """Turning the feature on should do something visible, not wait a month."""
    assert bpp_slot_indices(_days(0, 1, 2), None, 30) == {0}


def test_slots_are_spaced_by_the_cadence():
    chosen = bpp_slot_indices(_days(0, 7, 14, 21, 28), None, 14)
    assert chosen == {0, 2, 4}


def test_the_gap_counts_from_the_last_one_that_went_out():
    last = date(2026, 7, 30)
    assert bpp_slot_indices(_days(0, 1, 2), last, 14) == set()  # Aug 1-3: 2-4 days, too soon
    # Aug 12 is 13 days after — still short. Aug 13 is exactly 14, so that slot is the one.
    assert bpp_slot_indices(_days(11, 12, 13), last, 14) == {1}


def test_planned_slots_count_toward_the_gap_not_just_sent_ones():
    """Filling a week of queue at once must not stack a BPP into every slot that clears
    the gap against a now-stale date."""
    chosen = bpp_slot_indices(_days(0, 1, 2, 3, 4, 5, 6), None, 30)
    assert chosen == {0}


# ---- integration --------------------------------------------------------------------

_CADENCE = '{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}'


def _channel(conn, *, bpp_days=0, target=4, min_depth=3, reuse=30):
    cid = conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, remote_account_id,
              access_token, bpp_every_days)
           VALUES ('instagram','Chan','UTC',1,?,?,?,?,'acct1','tok',?)""",
        (_CADENCE, min_depth, target, reuse, bpp_days),
    ).lastrowid
    conn.execute(
        """INSERT INTO autofill_lanes
             (channel_id, surface, enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES (?, 'feed', 1, ?, ?, ?, ?)""",
        (cid, _CADENCE, min_depth, target, reuse),
    )
    return cid


def _post(conn, channel_id, *, is_bpp=0, kind="evergreen"):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind,"
        " is_bpp, created_at) VALUES ('x','single','draft','ready',?,?, '2026-01-01T00:00:00+00:00')",
        (kind, is_bpp),
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


def _posted(conn, post_id, channel_id, *, days_ago):
    when = (NOW - timedelta(days=days_ago)).isoformat()
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status,"
        " published_at, remote_post_id) VALUES (?,?,?,'posted',?,?)",
        (post_id, channel_id, when, when, f"r{post_id}-{days_ago}"),
    )
    conn.commit()


def _config(conn):
    from worker.config import Config

    return Config(
        database_path=":memory:", asset_storage_dir="/tmp", public_asset_base_url="",
        meta_app_id="", meta_app_secret="", graph_version="v25.0",
        graph_base="https://graph.facebook.com", default_timezone="UTC", poll_interval=1,
    )


def test_with_the_cadence_off_nothing_is_recycled(conn):
    """The default. Auto-fill behaves exactly as it did before this feature."""
    cid = _channel(conn, bpp_days=0)
    marked = _post(conn, cid, is_bpp=1)
    _posted(conn, marked, cid, days_ago=200)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE is_recycled=1"
    ).fetchone()["c"] == 0


def test_a_marked_post_takes_a_due_slot(conn):
    cid = _channel(conn, bpp_days=30)
    marked = _post(conn, cid, is_bpp=1)
    _posted(conn, marked, cid, days_ago=200)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    rows = conn.execute(
        "SELECT post_id FROM publications WHERE is_recycled=1"
    ).fetchall()
    assert [r["post_id"] for r in rows] == [marked]


def test_an_unmarked_post_is_never_treated_as_a_bpp(conn):
    """Only the owner's mark makes something a BPP — no metric, no heuristic."""
    cid = _channel(conn, bpp_days=30)
    great = _post(conn, cid, is_bpp=0)
    _posted(conn, great, cid, days_ago=200)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE is_recycled=1"
    ).fetchone()["c"] == 0


def test_an_empty_pool_leaves_autofill_completely_normal(conn):
    cid = _channel(conn, bpp_days=30)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    made = run_autofill(conn, _config(conn), NOW)

    assert made > 0, "the queue must still fill"
    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE is_recycled=1"
    ).fetchone()["c"] == 0


def test_the_pool_rotates_oldest_first(conn):
    """A set of keepers cycled through, not a favourite replayed."""
    cid = _channel(conn, bpp_days=30)
    recent = _post(conn, cid, is_bpp=1)
    ancient = _post(conn, cid, is_bpp=1)
    _posted(conn, recent, cid, days_ago=100)
    _posted(conn, ancient, cid, days_ago=300)
    conn.commit()

    from worker import db as dbmod

    pool = bpp_pool(conn, dbmod.get_channel(conn, cid), NOW, surface="feed")
    assert [r["post_id"] for r in pool] == [ancient, recent]


def test_a_bpp_may_ignore_the_reuse_window(conn):
    """A pool of four on a monthly cadence returns each post every four months, which a
    90-day reuse window would silently veto — the feature would look broken rather than
    decline. The owner set both the marks and the frequency."""
    cid = _channel(conn, bpp_days=30, reuse=365)
    marked = _post(conn, cid, is_bpp=1)
    _posted(conn, marked, cid, days_ago=40)          # well inside the 365-day window
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE post_id=? AND is_recycled=1", (marked,)
    ).fetchone()["c"] == 1


def test_one_time_content_is_never_reposted_even_if_marked(conn):
    """'Never repost this' outranks 'repost my best'."""
    cid = _channel(conn, bpp_days=30)
    once = _post(conn, cid, is_bpp=1, kind="one_time")
    _posted(conn, once, cid, days_ago=300)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE post_id=? AND status='scheduled'", (once,)
    ).fetchone()["c"] == 0


def test_a_bpp_is_not_also_queued_as_an_ordinary_pick(conn):
    cid = _channel(conn, bpp_days=1)     # every slot due
    marked = _post(conn, cid, is_bpp=1)
    _posted(conn, marked, cid, days_ago=200)
    for _ in range(4):
        _post(conn, cid)
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    dupes = conn.execute(
        "SELECT post_id FROM publications WHERE status='scheduled'"
        " GROUP BY post_id HAVING COUNT(*) > 1"
    ).fetchall()
    assert dupes == []


# ---- groups -------------------------------------------------------------------------

def _group(conn, *, bpp_days=0, target=4, min_depth=3):
    gid = conn.execute(
        """INSERT INTO channel_groups
             (name, timezone, autofill_enabled, cadence_config, min_queue_depth,
              target_queue_depth, reuse_min_age_days, bpp_every_days)
           VALUES ('G','UTC',1,?,?,?,30,?)""",
        (_CADENCE, min_depth, target, bpp_days),
    ).lastrowid
    conn.execute(
        """INSERT INTO autofill_lanes
             (group_id, surface, enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES (?, 'feed', 1, ?, ?, ?, 30)""",
        (gid, _CADENCE, min_depth, target),
    )
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


def test_a_group_sends_a_bpp_to_every_member_at_one_time(conn):
    """A group fills as one unit. A BPP must not break that or the accounts drift apart."""
    gid, members = _group(conn, bpp_days=30)
    marked = _post(conn, members[0], is_bpp=1)
    conn.execute("INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?,?)",
                 (marked, members[1]))
    _posted(conn, marked, members[0], days_ago=200)
    for _ in range(4):
        pid = _post(conn, members[0])
        conn.execute("INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?,?)",
                     (pid, members[1]))
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    rows = conn.execute(
        "SELECT channel_id, scheduled_at FROM publications"
        " WHERE post_id=? AND is_recycled=1", (marked,),
    ).fetchall()
    assert {r["channel_id"] for r in rows} == set(members)
    assert len({r["scheduled_at"] for r in rows}) == 1


def test_a_group_with_the_cadence_off_recycles_nothing(conn):
    gid, members = _group(conn, bpp_days=0)
    marked = _post(conn, members[0], is_bpp=1)
    _posted(conn, marked, members[0], days_ago=200)
    for _ in range(4):
        _post(conn, members[0])
    conn.commit()

    run_autofill(conn, _config(conn), NOW)

    assert conn.execute(
        "SELECT COUNT(*) c FROM publications WHERE is_recycled=1"
    ).fetchone()["c"] == 0


# ---- the tolerance is the owner's, not ours ----------------------------------------
#
# The 5%/10% defaults came from ONE account. A large back catalogue may want the strictest
# 2%; a small library building a rotation may want half of it; and the right answer moves
# as an account grows. Nothing may be hardcoded.

def test_a_stricter_tolerance_suggests_fewer_posts():
    posts = _spread("likes", list(range(100)))
    strict = sum(s.is_candidate for s in find_standouts(posts, 0.02, 0.05))
    loose = sum(s.is_candidate for s in find_standouts(posts, 0.40, 0.50))
    assert strict < loose


def test_a_very_loose_tolerance_suggests_about_half_the_library():
    """Someone may genuinely want 51% — building a rotation from a small library, say."""
    # Real engagement is noisy, not a perfect ramp; a strictly linear series is a
    # degenerate case where every post is exactly its own window's median.
    import random

    random.seed(7)
    posts = _spread("likes", [random.randint(1, 200) for _ in range(100)])
    matched = sum(s.is_candidate for s in find_standouts(posts, 0.51, 0.51))
    assert 25 <= matched <= 75, f"expected a loose setting to catch many, got {matched}"


def test_the_badge_quotes_the_owners_own_threshold():
    """A post flagged under a 25% setting must not read as if it cleared 5%."""
    posts = _spread("likes", [5] * 90 + list(range(100, 110)))
    reasons = [s.reason() for s in find_standouts(posts, 0.25, 0.40) if s.is_candidate]
    assert reasons and reasons[0].startswith("top 25% ·")


def test_the_defaults_reproduce_the_previous_behaviour():
    """Existing installs must see no change until somebody touches the setting."""
    posts = _spread("likes", [5] * 95 + [200, 190, 180, 170, 160])
    assert [s.reason() for s in find_standouts(posts) if s.is_candidate][0] == "top 5% · likes"


# ---- a keeper stays a keeper as the account grows -----------------------------------

def test_a_great_post_from_when_the_account_was_small_still_stands_out():
    """The correction that prompted peer ranking. At 1,000 followers a strong post might
    take 40 likes; at 100,000 an ordinary one takes 400. Pooled against all time the early
    post is buried forever — but it performed at a high level for the audience available TO
    IT, and is still worth reposting."""
    posts = []
    # Year one: small account, one clear winner at 40 likes among peers around 5.
    for i in range(60):
        posts.append({"id": i, "published_at": f"2025-01-{i % 28 + 1:02d}", "likes": 5})
    posts[30] = {"id": 30, "published_at": "2025-01-15", "likes": 40}
    # Year two: same account, ten times the audience — every post beats the old winner.
    for i in range(60, 120):
        posts.append({"id": i, "published_at": f"2026-01-{i % 28 + 1:02d}", "likes": 400})

    standouts = {s.post_id: s for s in find_standouts(posts)}
    assert standouts[30].is_candidate, (
        "the early winner must still be flagged — it was exceptional for its era"
    )


def test_an_ordinary_post_from_a_big_era_is_not_flagged_just_for_being_recent():
    """The other direction: scale alone must not qualify anything."""
    posts = []
    for i in range(60):
        posts.append({"id": i, "published_at": f"2025-01-{i % 28 + 1:02d}", "likes": 5})
    for i in range(60, 120):
        posts.append({"id": i, "published_at": f"2026-01-{i % 28 + 1:02d}", "likes": 400})

    standouts = {s.post_id: s for s in find_standouts(posts)}
    assert not standouts[100].is_candidate
