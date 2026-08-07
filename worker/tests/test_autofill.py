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


def test_reels_not_selected_for_channel_with_no_video_publish_path(conn):
    """Mirrors test_text_post_not_selected_for_instagram_channel, but for the OTHER
    capability-gated post_type: a channel on a platform with no publish path for
    post_type='reel' (everything but Instagram — worker/publisher.py's
    _publish_instagram is the only adapter with a 'reel' branch) must never have a reel
    auto-queued to it. Without this gate the worker would fail it terminally every
    autofill cycle forever, since 'failed' isn't in ACTIVE_QUEUE_STATUSES."""
    ch = make_channel(conn, platform="facebook")
    p = make_reel_post(conn, ch)
    rows = select_candidates(conn, ch, NOW)
    assert [r["post_type"] for r in rows] == []
    assert p not in picks(conn, ch, 10)


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


def test_autofill_never_places_a_post_outside_its_band(conn, config):
    # Cadence is 12:30 only, which derives to AFTERNOON. The evening post must be held back
    # entirely rather than sent at 12:30; the untagged one fills as normal.
    tz = "America/New_York"
    ch = make_channel(conn, min_depth=3, target=3,
                      cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],'
                              '"time":"12:30"}', tz=tz)
    p_even = make_post(conn, ch, created_at="2026-01-01T00:00:00+00:00")
    p_plain = make_post(conn, ch, created_at="2026-01-02T00:00:00+00:00")
    _tag(conn, p_even, "evening")

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    run_autofill(conn, config, now)

    placed = [r["post_id"] for r in conn.execute(
        "SELECT post_id FROM publications WHERE channel_id=?", (ch,)).fetchall()]
    assert p_plain in placed
    assert p_even not in placed


def test_autofill_places_a_banded_post_once_its_band_has_a_time(conn, config):
    # Same library, but the cadence now books an evening slot too.
    tz = "America/New_York"
    ch = make_channel(conn, min_depth=3, target=3,
                      cadence='{"mode":"times","slots":['
                              '{"time":"12:30","days":["mon","tue","wed","thu","fri","sat","sun"]},'
                              '{"time":"18:00","days":["mon","tue","wed","thu","fri","sat","sun"]}]}',
                      tz=tz)
    p_even = make_post(conn, ch, created_at="2026-01-01T00:00:00+00:00")
    p_plain = make_post(conn, ch, created_at="2026-01-02T00:00:00+00:00")
    _tag(conn, p_even, "evening")

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    run_autofill(conn, config, now)

    rows = conn.execute(
        "SELECT post_id, scheduled_at FROM publications WHERE channel_id=?", (ch,)).fetchall()
    at = {r["post_id"]: datetime.fromisoformat(r["scheduled_at"]).astimezone(ZoneInfo(tz))
          for r in rows}
    assert (at[p_even].hour, at[p_even].minute) == (18, 0)
    assert p_plain in at


def test_autofill_looks_past_the_top_ranked_candidates_to_find_a_fitting_one(conn, config):
    # The bug the uncapped fetch fixes: the top `need` ranked posts are ALL evening-tagged
    # while the cadence covers only afternoon. Fetching just `need` would place nothing.
    tz = "UTC"
    ch = make_channel(conn, min_depth=2, target=2,
                      cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],'
                              '"time":"12:30"}', tz=tz)
    for i in range(5):  # oldest first -> these rank ahead of the plain ones
        _tag(conn, make_post(conn, ch, created_at=f"2026-01-0{i + 1}T00:00:00+00:00"), "evening")
    plain = [make_post(conn, ch, created_at="2026-02-01T00:00:00+00:00"),
             make_post(conn, ch, created_at="2026-02-02T00:00:00+00:00")]

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    made = run_autofill(conn, config, now)
    assert made == 2
    placed = {r["post_id"] for r in conn.execute(
        "SELECT post_id FROM publications WHERE channel_id=?", (ch,)).fetchall()}
    assert placed == set(plain)


def test_autofill_logs_which_posts_are_held_back(conn, config):
    class Recorder:
        def __init__(self):
            self.lines = []

        def info(self, msg, *args):
            self.lines.append(msg % args if args else msg)

    ch = make_channel(conn, min_depth=2, target=2,
                      cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],'
                              '"time":"12:30"}', tz="UTC")
    for i in range(3):
        _tag(conn, make_post(conn, ch, created_at=f"2026-01-0{i + 1}T00:00:00+00:00"), "evening")
    make_post(conn, ch, created_at="2026-02-01T00:00:00+00:00")

    log = Recorder()
    run_autofill(conn, config, datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc), log)
    held = [line for line in log.lines if "held back" in line]
    assert held, log.lines
    assert "3" in held[0] and "evening" in held[0]


def test_autofill_interval_cadence_drifts(conn, config):
    ch = make_channel(conn, min_depth=3, target=3, tz="UTC",
                      cadence='{"mode":"interval","every_minutes":585,'
                              '"window":{"from":"08:00","to":"21:00"}}')
    for i in range(3):
        make_post(conn, ch, created_at=f"2026-01-0{i + 1}T00:00:00+00:00")

    now = datetime(2026, 8, 3, 9, 0, tzinfo=timezone.utc)  # Monday 09:00
    assert run_autofill(conn, config, now) == 3
    at = [datetime.fromisoformat(r["scheduled_at"]) for r in conn.execute(
        "SELECT scheduled_at FROM publications WHERE channel_id=? ORDER BY scheduled_at",
        (ch,)).fetchall()]
    assert [(d.hour, d.minute) for d in at] == [(18, 45), (14, 15), (9, 45)]


def test_story_only_post_is_never_autofilled_into_the_feed(conn):
    """post_targets carries a surface now. Matching on channel_id alone would let a post
    meant ONLY for Stories be auto-queued as an ordinary feed post — a silent wrong
    destination, not a visible error. Auto-fill is deliberately feed-only for v1
    (docs/design-instagram-stories.md §4)."""
    ch = make_channel(conn)
    p = make_post(conn)
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
        (p, ch),
    )
    conn.commit()

    rows = select_candidates(conn, ch, NOW)
    assert p not in [r["post_id"] for r in rows]
    assert p not in picks(conn, ch, 10)


def test_a_post_targeted_at_both_surfaces_is_still_autofilled_for_the_feed(conn):
    """The feed target is real work; only the story-ONLY case is excluded."""
    ch = make_channel(conn)
    p = make_post(conn, ch)  # feed target
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
        (p, ch),
    )
    conn.commit()

    assert p in [r["post_id"] for r in select_candidates(conn, ch, NOW)]


# ---- several posts a day ------------------------------------------------------------

def test_autofill_can_queue_more_than_one_post_a_day(conn, config):
    """A channel posting three times a day must get three sends on one date. The
    single-time path advances a whole day after each placement, so this needs the
    multi-time cadence to take effect end to end — not just in the slot helper."""
    cid = conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, remote_account_id,
              access_token)
           VALUES ('instagram','Chan','UTC',1, ?, 3, 6, 30, 'acct1','tok')""",
        ('{"days":["mon","tue","wed","thu","fri","sat","sun"],'
         '"times":["09:00","13:00","18:00"]}',),
    ).lastrowid
    for _ in range(8):
        make_post(conn, cid)
    conn.commit()

    run_autofill(conn, config, NOW)

    dates = [
        r["scheduled_at"][:10]
        for r in conn.execute(
            "SELECT scheduled_at FROM publications WHERE channel_id=? ORDER BY scheduled_at",
            (cid,),
        ).fetchall()
    ]
    assert len(dates) == 6
    busiest = max(dates.count(d) for d in set(dates))
    assert busiest > 1, f"expected several sends on one day, got {dates}"


def test_a_single_time_cadence_still_posts_once_a_day(conn, config):
    """The existing behaviour must be untouched — spreading a queue out is the point of
    the original path."""
    cid = make_channel(conn, cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}',
                       min_depth=3, target=5, tz="UTC")
    for _ in range(6):
        make_post(conn, cid)
    conn.commit()

    run_autofill(conn, config, NOW)

    dates = [
        r["scheduled_at"][:10]
        for r in conn.execute(
            "SELECT scheduled_at FROM publications WHERE channel_id=?", (cid,)
        ).fetchall()
    ]
    assert len(dates) == len(set(dates)), "one post per day on the single-time cadence"


# ---- _assign: band-matching placement ------------------------------------------
from worker.autofill import _assign  # noqa: E402
from worker.time_of_day import derive_band  # noqa: E402

_BT = {"morning": (9, 0), "afternoon": (13, 0), "evening": (18, 0)}


def _band_of(hm):
    return derive_band(hm[0], hm[1], _BT)


def _item(post_id):
    """An (row, recipients) pair — _assign only ever reads row["post_id"]."""
    return ({"post_id": post_id}, [])


def _slot(day, hour, minute):
    return (datetime(2026, 8, day, hour, minute, tzinfo=timezone.utc), (hour, minute))


def test_assign_skips_a_slot_no_candidate_fits():
    # An evening post must not take the 09:00 slot; it waits for 18:00, and 09:00 goes unused.
    out = _assign(
        iter([_slot(3, 9, 0), _slot(3, 18, 0)]),
        [_item(1)], {1: {"evening"}}, _band_of, 2, {"morning", "evening"},
    )
    assert [(item[0]["post_id"], hm) for item, _, hm, _ in out] == [(1, (18, 0))]


def test_assign_takes_the_highest_ranked_candidate_that_fits():
    # 1 ranks first but is a morning post, so the evening slot goes to 2.
    out = _assign(
        iter([_slot(3, 18, 0)]),
        [_item(1), _item(2)], {1: {"morning"}, 2: set()}, _band_of, 1,
        {"morning", "evening"},
    )
    assert out[0][0][0]["post_id"] == 2


def test_assign_fills_to_need_even_when_most_slots_are_unusable():
    # Two slots a day, only the evening one usable, three evening posts -> three days out.
    def slots():
        for day in range(3, 13):
            yield _slot(day, 9, 0)
            yield _slot(day, 18, 0)

    out = _assign(
        slots(), [_item(1), _item(2), _item(3)],
        {1: {"evening"}, 2: {"evening"}, 3: {"evening"}}, _band_of, 3,
        {"morning", "evening"},
    )
    assert [item[0]["post_id"] for item, _, _, _ in out] == [1, 2, 3]
    assert [hm for _, _, hm, _ in out] == [(18, 0), (18, 0), (18, 0)]
    assert [dt.day for _, dt, _, _ in out] == [3, 4, 5]


def test_assign_stops_when_nothing_left_can_fit_any_covered_band():
    # The generator is capped only so a REGRESSION fails instead of hanging the suite.
    def nearly_endless():
        for day in range(1, 5000):
            yield _slot(3, 9, 0)

    out = _assign(nearly_endless(), [_item(1)], {1: {"evening"}}, _band_of, 5, {"morning"})
    assert out == []


def test_assign_uses_the_pool_at_a_due_position_when_the_band_fits():
    out = _assign(
        iter([_slot(3, 18, 0), _slot(4, 18, 0)]),
        [_item(1), _item(2)], {1: set(), 2: set(), 9: {"evening"}}, _band_of, 2,
        {"evening"}, pool=[_item(9)], due={0},
    )
    assert [(item[0]["post_id"], flag) for item, _, _, flag in out] == [(9, True), (1, False)]


def test_assign_falls_back_to_normal_selection_when_the_pool_does_not_fit():
    # Position 0 is due, but the only pool post is evening-tagged and slot 0 is morning. The
    # slot is filled normally and must NOT be flagged as recycled — it isn't one.
    out = _assign(
        iter([_slot(3, 9, 0), _slot(3, 18, 0)]),
        [_item(1), _item(2)], {1: set(), 2: set(), 9: {"evening"}}, _band_of, 2,
        {"morning", "evening"}, pool=[_item(9)], due={0},
    )
    assert [(item[0]["post_id"], flag) for item, _, _, flag in out] == [(1, False), (2, False)]


def test_assign_never_places_the_same_post_twice():
    # The pool and the normal list are drawn from the same library, so overlap is routine.
    out = _assign(
        iter([_slot(3, 18, 0), _slot(4, 18, 0)]),
        [_item(9)], {9: set()}, _band_of, 2, {"evening"}, pool=[_item(9)], due={0},
    )
    assert [item[0]["post_id"] for item, _, _, _ in out] == [9]


# ---- BPP x band interaction, end to end -----------------------------------------

def test_bpp_due_slot_with_no_fitting_marked_post_falls_through_and_is_not_recycled(conn, config):
    # Cadence covers only afternoon. The one marked (BPP) post is evening-tagged, so it can
    # never land in the due slot; that slot must fall through to ordinary selection and the
    # resulting publication must NOT be flagged as recycled.
    ch = make_channel(conn, min_depth=1, target=1,
                      cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],'
                              '"time":"12:30"}', tz="UTC")
    conn.execute("UPDATE channels SET bpp_every_days=30 WHERE id=?", (ch,))
    marked = make_post(conn, ch, created_at="2026-01-01T00:00:00+00:00")
    conn.execute("UPDATE posts SET is_bpp=1 WHERE id=?", (marked,))
    _tag(conn, marked, "evening")
    plain = make_post(conn, ch, created_at="2026-01-02T00:00:00+00:00")
    conn.commit()

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    made = run_autofill(conn, config, now)
    assert made == 1

    row = conn.execute(
        "SELECT post_id, is_recycled FROM publications WHERE channel_id=?", (ch,)
    ).fetchone()
    assert row["post_id"] == plain
    assert row["is_recycled"] == 0


# ---- covered bands: interval mode reaches residues, not the whole window ---------
from worker.autofill import _covered_bands  # noqa: E402
from worker.scheduling import parse_cadence  # noqa: E402

_MON_NOON = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
_MON_NINE = datetime(2026, 8, 3, 9, 0, tzinfo=timezone.utc)


def _covered(cadence_json, after, tz="UTC"):
    return _covered_bands(parse_cadence(cadence_json), tz, after, _band_of)


def test_covered_bands_in_times_mode_is_just_the_slot_bands():
    # Unchanged, and must stay exact: under-reporting here would let _assign's early exit
    # stall a queue that could have filled.
    covered = _covered(
        '{"mode":"times","slots":['
        '{"time":"12:30","days":["mon"]},{"time":"18:00","days":["mon"]}]}',
        _MON_NOON,
    )
    assert covered == {"afternoon", "evening"}


def test_covered_bands_for_a_daily_interval_is_the_one_time_it_lands_on():
    # The form's own default: every 24h, 08:00-21:00. It lands at 12:00 and ONLY 12:00, so
    # claiming the whole window would mark all three bands covered and silence the guard.
    covered = _covered(
        '{"mode":"interval","every_minutes":1440,"window":{"from":"08:00","to":"21:00"}}',
        _MON_NOON,
    )
    assert covered == {"afternoon"}


def test_covered_bands_for_a_twelve_hour_interval_is_still_one_band():
    # 12h divides the day evenly, so the other step lands at 00:00 and is skipped by the
    # window. `every_minutes % 1440` would call this a drifting cadence; it isn't.
    covered = _covered(
        '{"mode":"interval","every_minutes":720,"window":{"from":"08:00","to":"21:00"}}',
        _MON_NOON,
    )
    assert covered == {"afternoon"}


def test_covered_bands_for_an_interval_that_genuinely_drifts_is_every_window_band():
    covered = _covered(
        '{"mode":"interval","every_minutes":585,"window":{"from":"08:00","to":"21:00"}}',
        _MON_NINE,
    )
    assert covered == {"morning", "afternoon", "evening"}


def test_covered_bands_for_an_interval_follows_the_phase():
    # Same cadence, a different `after`: an 08:00 start lands at 08:00 forever, which is
    # morning rather than afternoon. This is exactly what the dashboard cannot know.
    cfg = '{"mode":"interval","every_minutes":1440,"window":{"from":"08:00","to":"21:00"}}'
    assert _covered(cfg, datetime(2026, 8, 3, 8, 0, tzinfo=timezone.utc)) == {"morning"}


class _Recorder:
    def __init__(self):
        self.lines = []

    def info(self, msg, *args):
        self.lines.append(msg % args if args else msg)


def test_autofill_logs_held_back_for_a_daily_interval(conn, config):
    """Design §7 with the form's default interval, the case that used to slip through.

    Every 24h between 08:00 and 21:00 reaches one clock time. The evening posts are as
    unreachable as they would be under a single 12:30 time, and the log has to say so —
    while the queue goes on filling from the untagged content and looks perfectly healthy.
    """
    ch = make_channel(
        conn, min_depth=2, target=2, tz="UTC",
        cadence='{"mode":"interval","every_minutes":1440,'
                '"window":{"from":"08:00","to":"21:00"},'
                '"days":["mon","tue","wed","thu","fri","sat","sun"]}',
    )
    for i in range(3):
        _tag(conn, make_post(conn, ch, created_at=f"2026-01-0{i + 1}T00:00:00+00:00"), "evening")
    make_post(conn, ch, created_at="2026-02-01T00:00:00+00:00")

    log = _Recorder()
    run_autofill(conn, config, _MON_NOON, log)
    held = [line for line in log.lines if "held back" in line]
    assert held, log.lines
    assert "3" in held[0] and "evening" in held[0]


def test_assign_reads_due_as_a_SLOT_index_not_a_placement_count():
    """Design §9: pass 2 can skip a slot pass 1 filled.

    Position 1 is due. Slot 0 (09:00) has nothing that fits and is skipped, so by the time
    the due slot comes round only ONE post has been placed... none, in fact. Counting
    placements instead of positions hands the BPP to slot 2 — a recycle a day late, with
    is_recycled written on the wrong row and _last_bpp_date moved with it.
    """
    out = _assign(
        iter([_slot(3, 9, 0), _slot(3, 18, 0), _slot(4, 18, 0)]),
        [_item(1)], {1: {"evening"}, 9: set()}, _band_of, 2,
        {"morning", "evening"}, pool=[_item(9)], due={1},
    )
    assert [(item[0]["post_id"], dt.day, flag) for item, dt, _, flag in out] == [
        (9, 3, True),   # the marked post takes the DUE slot, on day 3
        (1, 4, False),
    ]
