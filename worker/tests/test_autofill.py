"""Tests for auto-fill: queue-depth math, the tiered selection rules, and top-up."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker.autofill import (
    eligible_candidates,
    run_autofill,
    scheduled_ahead_count,
    select_candidates,
)

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


def picks(conn, channel_id, limit):
    from worker import db
    ch = db.get_channel(conn, channel_id)
    return [r["post_id"] for r in eligible_candidates(conn, ch, NOW, limit)]


# ---- seed helpers ---------------------------------------------------------------
def make_channel(conn, *, autofill=1, min_depth=3, target=5, cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
                 tz="America/New_York", approval=0, platform="instagram"):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, requires_approval,
              remote_account_id, access_token)
           VALUES (?,'Chan',?,?,?,?,?,180,?, 'acct1','tok')""",
        (platform, tz, autofill, cadence, min_depth, target, approval),
    ).lastrowid


def make_post(conn, channel_id=None, created_at="2026-01-01T00:00:00+00:00",
              content_kind="evergreen"):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at) "
        "VALUES ('x','single','draft','ready',?,?)",
        (content_kind, created_at),
    ).lastrowid
    aid = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, public_url) VALUES (?,?,?,?)",
        (f"h{pid}", "image", f"{pid}.jpg", "https://a.test/x.jpg"),
    ).lastrowid
    conn.execute("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)", (pid, aid))
    if channel_id is not None:
        conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, channel_id))
    conn.commit()
    return pid


def make_reel_post(conn, channel_id=None, created_at="2026-01-01T00:00:00+00:00",
                    content_kind="evergreen"):
    """A reel: post_type='reel' with exactly one video asset (mirrors what the Reels
    validator from Task 3 requires to publish)."""
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at) "
        "VALUES ('reel caption','reel','draft','ready',?,?)",
        (content_kind, created_at),
    ).lastrowid
    aid = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, public_url, duration_ms) "
        "VALUES (?,?,?,?,?)",
        (f"h{pid}", "video", f"{pid}.mp4", "https://a.test/x.mp4", 15000),
    ).lastrowid
    conn.execute("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)", (pid, aid))
    if channel_id is not None:
        conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, channel_id))
    conn.commit()
    return pid


def make_text_post(conn, channel_id=None, created_at="2026-01-01T00:00:00+00:00",
                    content_kind="evergreen"):
    """A text post: caption only, deliberately NO row in post_assets."""
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at) "
        "VALUES ('hello world','text','draft','ready',?,?)",
        (content_kind, created_at),
    ).lastrowid
    if channel_id is not None:
        conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, channel_id))
    conn.commit()
    return pid


def target(conn, post_id, channel_id):
    conn.execute("INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?,?)",
                 (post_id, channel_id))
    conn.commit()


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
    never = make_post(conn, ch)
    recyc = make_post(conn, ch)
    mark_posted(conn, recyc, ch, (NOW - timedelta(days=200)).isoformat())
    assert picks(conn, ch, 1) == [never]


def test_recently_posted_is_excluded(conn):
    ch = make_channel(conn)
    recent = make_post(conn, ch)
    old = make_post(conn, ch)
    mark_posted(conn, recent, ch, (NOW - timedelta(days=10)).isoformat())
    mark_posted(conn, old, ch, (NOW - timedelta(days=200)).isoformat())
    got = picks(conn, ch, 10)
    assert recent not in got
    assert old in got


def test_top_performer_preferred_among_recyclable(conn):
    ch = make_channel(conn)
    low = make_post(conn, ch)
    high = make_post(conn, ch)
    mark_posted(conn, low, ch, (NOW - timedelta(days=200)).isoformat(), reach=10, saves=1)
    mark_posted(conn, high, ch, (NOW - timedelta(days=200)).isoformat(), reach=500, saves=90)
    assert picks(conn, ch, 1) == [high]


def test_performance_is_per_channel(conn):
    a = make_channel(conn)
    b = make_channel(conn)
    plain = make_post(conn, a)
    star_on_b = make_post(conn, a)
    mark_posted(conn, plain, a, (NOW - timedelta(days=200)).isoformat(), reach=5, saves=0)
    mark_posted(conn, star_on_b, a, (NOW - timedelta(days=200)).isoformat(), reach=5, saves=0)
    mark_posted(conn, star_on_b, b, (NOW - timedelta(days=200)).isoformat(), reach=9999, saves=9999)
    assert set(picks(conn, a, 2)) == {plain, star_on_b}


def test_already_queued_not_reselected(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch)
    queue_future(conn, p, ch, "2026-08-01T22:00:00+00:00")
    assert p not in picks(conn, ch, 10)


# ---- full top-up ----------------------------------------------------------------
def test_run_autofill_tops_up_to_target(conn, config):
    ch = make_channel(conn, min_depth=3, target=5)
    for _ in range(10):
        make_post(conn, ch)  # plenty of never-posted, targeted content

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
    p1, p2 = make_post(conn, ch), make_post(conn, ch)
    queue_future(conn, p1, ch, "2026-08-01T22:00:00+00:00")
    queue_future(conn, p2, ch, "2026-08-03T22:00:00+00:00")  # ahead == 2 == min_depth
    for _ in range(5):
        make_post(conn, ch)
    assert run_autofill(conn, config, NOW) == 0  # healthy, nothing added


def test_run_autofill_respects_approval(conn, config):
    ch = make_channel(conn, min_depth=1, target=2, approval=1)
    make_post(conn, ch)
    make_post(conn, ch)
    run_autofill(conn, config, NOW)
    statuses = [r["status"] for r in conn.execute(
        "SELECT status FROM publications WHERE channel_id=?", (ch,)
    ).fetchall()]
    assert statuses and all(s == "pending_approval" for s in statuses)


# ---- content-model eligibility gates --------------------------------------------
def _add_period(conn, name, sm, sd, em, ed):
    return conn.execute(
        "INSERT INTO periods (name, recurs_yearly, start_month, start_day, end_month, end_day) "
        "VALUES (?,1,?,?,?,?)", (name, sm, sd, em, ed),
    ).lastrowid


def test_draft_status_excluded(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch)
    conn.execute("UPDATE posts SET content_status='draft' WHERE id=?", (p,))
    conn.commit()
    assert p not in picks(conn, ch, 10)


def test_untargeted_post_excluded(conn):
    ch = make_channel(conn)
    p = make_post(conn)  # no channel target
    assert p not in picks(conn, ch, 10)


def test_one_time_only_until_posted_once(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch, content_kind="one_time")
    assert p in picks(conn, ch, 10)                       # eligible before posting
    mark_posted(conn, p, ch, (NOW - timedelta(days=999)).isoformat())
    assert p not in picks(conn, ch, 10)                   # never again, even long after


def test_dry_run_publication_not_counted_as_posted(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch, content_kind="one_time")
    # A dry-run 'posted' publication to this channel must NOT count as "already posted".
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at, "
        "is_dry_run, remote_post_id) VALUES (?,?,?,'posted',?,1,'DRYRUN')",
        (p, ch, (NOW - timedelta(days=1)).isoformat(), (NOW - timedelta(days=1)).isoformat()),
    )
    conn.commit()
    assert p in picks(conn, ch, 10)


def test_per_post_cooldown_override(conn):
    ch = make_channel(conn)  # channel reuse default = 180 days
    p = make_post(conn, ch)
    conn.execute("UPDATE posts SET cooldown_days=7 WHERE id=?", (p,))
    conn.commit()
    mark_posted(conn, p, ch, (NOW - timedelta(days=10)).isoformat())  # 10 > 7 -> eligible
    assert p in picks(conn, ch, 10)


def test_green_period_gates_by_season(conn):
    ch = make_channel(conn)  # tz America/New_York
    winter = make_post(conn, ch)
    per = _add_period(conn, "Winter", 12, 1, 2, 28)
    conn.execute("INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?, 'green')",
                 (winter, per))
    conn.commit()
    # NOW is July -> out of the Winter window -> excluded.
    assert winter not in picks(conn, ch, 10)


def test_text_post_selected_for_threads_channel(conn):
    """Threads declares supports_text=True in PLATFORM_CAPS, so a Ready text post
    (no assets at all) must be selectable for a Threads channel."""
    ch = make_channel(conn, platform="threads")
    p = make_text_post(conn, ch)
    assert p in picks(conn, ch, 10)


def test_text_post_not_selected_for_instagram_channel(conn):
    """Instagram declares supports_text=False, so the same Ready text post targeted at
    an Instagram channel must never be auto-scheduled there — widening only the
    post_type gate without the platform-capability gate would let this happen."""
    ch = make_channel(conn, platform="instagram")
    p = make_text_post(conn, ch)
    assert p not in picks(conn, ch, 10)


def test_reels_are_eligible_for_autofill(conn):
    """Recycling evergreen demo videos is a primary goal. Left out of the candidate
    query, a reel is publishable but never auto-queued — it just silently never
    appears, with no error anywhere."""
    ch = make_channel(conn)
    p = make_reel_post(conn, ch)
    rows = select_candidates(conn, ch, NOW)
    assert [r["post_type"] for r in rows] == ["reel"]
    assert p in picks(conn, ch, 10)


def test_caption_over_telegram_limit_skipped_but_selected_for_instagram(conn):
    """A caption fine for Instagram (no enforced limit) but over Telegram's 1024-char
    single-image limit must never be auto-queued to the Telegram channel — queuing it
    would fail terminally at publish every time, and being evergreen it would keep
    getting re-selected forever. The same post must still be selectable for Instagram,
    which has no caption_chars entry for 'single' (so nothing to enforce there)."""
    tg = make_channel(conn, platform="telegram")
    ig = make_channel(conn, platform="instagram")
    p = make_post(conn)  # single image, no channel target yet
    conn.execute("UPDATE posts SET caption=? WHERE id=?", ("x" * 1400, p))
    target(conn, p, tg)
    target(conn, p, ig)
    conn.commit()
    assert p not in picks(conn, tg, 10)
    assert p in picks(conn, ig, 10)


def test_caption_within_telegram_limit_is_selected(conn):
    """The gate must not over-trigger: a caption within Telegram's limit is still
    selectable there."""
    tg = make_channel(conn, platform="telegram")
    p = make_post(conn)
    conn.execute("UPDATE posts SET caption=? WHERE id=?", ("short caption", p))
    target(conn, p, tg)
    conn.commit()
    assert p in picks(conn, tg, 10)


def test_blackout_overrides_eligibility(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch)
    per = _add_period(conn, "NoSummer", 6, 1, 8, 31)     # NOW (July) is inside
    conn.execute("INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?, 'blackout')",
                 (p, per))
    conn.commit()
    assert p not in picks(conn, ch, 10)


# ---- time_of_day tag integration -----------------------------------------------
from zoneinfo import ZoneInfo


def _tag(conn, post_id, band):
    conn.execute(
        "INSERT INTO post_tags (post_id, tag_id) "
        "SELECT ?, id FROM tags WHERE name = ? AND kind='time_of_day'",
        (post_id, band),
    )
    conn.commit()


def test_autofill_uses_time_of_day_for_slot_time(conn, config):
    # Channel posts Mon/Wed/Fri; cadence time 17:00 is the anytime fallback.
    tz = "America/New_York"
    ch = make_channel(conn, min_depth=3, target=3,
                      cadence='{"days":["mon","wed","fri"],"time":"17:00"}', tz=tz)
    # created_at ordering makes selection deterministic (oldest first among never-posted).
    p_even = make_post(conn, ch, created_at="2026-01-01T00:00:00+00:00")
    p_morn = make_post(conn, ch, created_at="2026-01-02T00:00:00+00:00")
    p_any = make_post(conn, ch, created_at="2026-01-03T00:00:00+00:00")
    _tag(conn, p_even, "evening")
    _tag(conn, p_morn, "morning")
    # p_any: no time_of_day tag -> cadence time.

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)  # a Sunday
    made = run_autofill(conn, config, now)
    assert made == 3

    rows = conn.execute(
        "SELECT post_id, scheduled_at FROM publications WHERE channel_id=? "
        "ORDER BY scheduled_at ASC", (ch,)
    ).fetchall()
    times = {r["post_id"]: datetime.fromisoformat(r["scheduled_at"]).astimezone(ZoneInfo(tz))
             for r in rows}
    assert (times[p_even].hour, times[p_even].minute) == (18, 0)
    assert (times[p_morn].hour, times[p_morn].minute) == (9, 0)
    assert (times[p_any].hour, times[p_any].minute) == (17, 0)  # cadence fallback
