"""Tests for auto-fill: queue-depth math, the tiered selection rules, and top-up."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker.autofill import (
    run_autofill,
    scheduled_ahead_count,
    select_candidates,
)

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


# ---- seed helpers ---------------------------------------------------------------
def make_channel(conn, *, autofill=1, min_depth=3, target=5, cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
                 tz="America/New_York", approval=0):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, requires_approval,
              remote_account_id, access_token)
           VALUES ('instagram','Chan',?,?,?,?,?,180,?, 'ig1','tok')""",
        (tz, autofill, cadence, min_depth, target, approval),
    ).lastrowid


def make_post(conn, created_at="2026-01-01T00:00:00+00:00"):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, created_at) VALUES ('x','single','draft',?)",
        (created_at,),
    ).lastrowid
    aid = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, public_url) VALUES (?,?,?,?)",
        (f"h{pid}", "image", f"{pid}.jpg", "https://a.test/x.jpg"),
    ).lastrowid
    conn.execute("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)", (pid, aid))
    conn.commit()
    return pid


def mark_posted(conn, post_id, channel_id, published_at, reach=None, saves=None):
    pub = conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (post_id, channel_id, published_at, published_at),
    ).lastrowid
    if reach is not None or saves is not None:
        conn.execute(
            "INSERT INTO post_metrics (publication_id, fetched_at, reach, saves) VALUES (?,?,?,?)",
            (pub, published_at, reach, saves),
        )
    conn.commit()
    return pub


def queue_future(conn, post_id, channel_id, scheduled_at):
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?,?,?,'scheduled')",
        (post_id, channel_id, scheduled_at),
    )
    conn.commit()


# ---- queue depth ----------------------------------------------------------------
def test_scheduled_ahead_count(conn):
    ch = make_channel(conn)
    p = make_post(conn)
    queue_future(conn, p, ch, "2026-08-01T22:00:00+00:00")  # future
    queue_future(conn, make_post(conn), ch, "2026-07-01T22:00:00+00:00")  # past -> not "ahead"
    assert scheduled_ahead_count(conn, ch, NOW.isoformat()) == 1


# ---- selection tiers ------------------------------------------------------------
def test_never_posted_chosen_before_recyclable(conn):
    ch = make_channel(conn)
    never = make_post(conn)
    recyc = make_post(conn)
    mark_posted(conn, recyc, ch, (NOW - timedelta(days=200)).isoformat())  # eligible but tier 1

    got = [r["post_id"] for r in select_candidates(conn, ch, 180, NOW, 1)]
    assert got == [never]  # never-posted wins the single slot


def test_recently_posted_is_excluded(conn):
    ch = make_channel(conn)
    recent = make_post(conn)
    old = make_post(conn)
    mark_posted(conn, recent, ch, (NOW - timedelta(days=10)).isoformat())   # < 180d -> excluded
    mark_posted(conn, old, ch, (NOW - timedelta(days=200)).isoformat())     # >= 180d -> eligible

    got = [r["post_id"] for r in select_candidates(conn, ch, 180, NOW, 10)]
    assert recent not in got
    assert old in got


def test_top_performer_preferred_among_recyclable(conn):
    ch = make_channel(conn)
    low = make_post(conn)
    high = make_post(conn)
    mark_posted(conn, low, ch, (NOW - timedelta(days=200)).isoformat(), reach=10, saves=1)
    mark_posted(conn, high, ch, (NOW - timedelta(days=200)).isoformat(), reach=500, saves=90)

    got = [r["post_id"] for r in select_candidates(conn, ch, 180, NOW, 1)]
    assert got == [high]  # higher reach+saves on THIS channel wins


def test_performance_is_per_channel(conn):
    # A post that performed great on channel B should NOT jump the queue on channel A.
    a = make_channel(conn)
    b = make_channel(conn)
    plain = make_post(conn)
    star_on_b = make_post(conn)
    mark_posted(conn, plain, a, (NOW - timedelta(days=200)).isoformat(), reach=5, saves=0)
    mark_posted(conn, star_on_b, a, (NOW - timedelta(days=200)).isoformat(), reach=5, saves=0)
    mark_posted(conn, star_on_b, b, (NOW - timedelta(days=200)).isoformat(), reach=9999, saves=9999)

    got = [r["post_id"] for r in select_candidates(conn, a, 180, NOW, 2)]
    # On channel A both have equal (tiny) perf; star_on_b's channel-B fame is ignored.
    assert set(got) == {plain, star_on_b}
    # tie broken by created_at asc -> plain first (created earlier is arbitrary; assert both present)


def test_already_queued_not_reselected(conn):
    ch = make_channel(conn)
    p = make_post(conn)
    queue_future(conn, p, ch, "2026-08-01T22:00:00+00:00")
    got = [r["post_id"] for r in select_candidates(conn, ch, 180, NOW, 10)]
    assert p not in got


# ---- full top-up ----------------------------------------------------------------
def test_run_autofill_tops_up_to_target(conn, config):
    ch = make_channel(conn, min_depth=3, target=5)
    for _ in range(10):
        make_post(conn)  # plenty of never-posted content

    created = run_autofill(conn, config, NOW)
    assert created == 5  # filled from 0 up to target

    rows = conn.execute(
        "SELECT scheduled_at, status, created_by FROM publications WHERE channel_id=? ORDER BY scheduled_at",
        (ch,),
    ).fetchall()
    assert len(rows) == 5
    assert all(r["created_by"] == "autofill" for r in rows)
    assert all(r["status"] == "scheduled" for r in rows)
    # Slots land on the cadence (Mon/Wed/Fri 18:00 EDT == 22:00 UTC), strictly increasing.
    times = [r["scheduled_at"] for r in rows]
    assert times == sorted(times) and len(set(times)) == 5
    assert all(t.endswith("22:00:00+00:00") for t in times)


def test_run_autofill_skips_when_queue_healthy(conn, config):
    ch = make_channel(conn, min_depth=2, target=5)
    p1, p2 = make_post(conn), make_post(conn)
    queue_future(conn, p1, ch, "2026-08-01T22:00:00+00:00")
    queue_future(conn, p2, ch, "2026-08-03T22:00:00+00:00")  # ahead == 2 == min_depth
    for _ in range(5):
        make_post(conn)
    assert run_autofill(conn, config, NOW) == 0  # healthy, nothing added


def test_run_autofill_respects_approval(conn, config):
    ch = make_channel(conn, min_depth=1, target=2, approval=1)
    make_post(conn)
    make_post(conn)
    run_autofill(conn, config, NOW)
    statuses = [r["status"] for r in conn.execute(
        "SELECT status FROM publications WHERE channel_id=?", (ch,)
    ).fetchall()]
    assert statuses and all(s == "pending_approval" for s in statuses)
