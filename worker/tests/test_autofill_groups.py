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
