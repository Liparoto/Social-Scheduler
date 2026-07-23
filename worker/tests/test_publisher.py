"""Tests for the publish state machine — maps directly to the Phase 2 verification gate."""

from __future__ import annotations

from datetime import datetime, timezone

from worker import db
from worker.publisher import publish_one

NOW = datetime(2026, 7, 22, 18, 0, 0, tzinfo=timezone.utc)


def _reload(conn, pub_id):
    return conn.execute("SELECT * FROM publications WHERE id = ?", (pub_id,)).fetchone()


# ---- Dry-run --------------------------------------------------------------------
def test_dry_run_single_publishes_nothing(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="single", n_assets=1)
    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW)

    assert out.result == "dry_run"
    assert fake_client.calls == []  # nothing sent to Meta
    row = _reload(conn, pub["id"])
    assert row["status"] == "posted"
    assert row["is_dry_run"] == 1
    assert row["remote_post_id"] == "DRYRUN"


def test_dry_run_carousel_plans_ordered_assets(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="carousel", n_assets=3)
    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW)

    assert out.result == "dry_run"
    assert out.plan["post_type"] == "carousel"
    assert len(out.plan["asset_urls"]) == 3  # order preserved by sort_order
    assert fake_client.calls == []


# ---- Real publish (fake client) -------------------------------------------------
def test_real_single_success(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="single", n_assets=1)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert out.result == "posted"
    kinds = [c[0] for c in fake_client.calls]
    assert kinds == ["limit", "image", "status", "publish"]
    row = _reload(conn, pub["id"])
    assert row["status"] == "posted"
    assert row["remote_post_id"].startswith("media-")
    assert row["is_dry_run"] == 0
    # rate-limit snapshot was cached
    assert conn.execute("SELECT COUNT(*) FROM publish_limits").fetchone()[0] == 1


def test_real_carousel_success(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="carousel", n_assets=3)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert out.result == "posted"
    kinds = [c[0] for c in fake_client.calls]
    # limit, 3x (child + status), carousel parent, status, publish
    assert kinds == ["limit", "child", "status", "child", "status", "child",
                     "status", "carousel", "status", "publish"]


# ---- Failure: retry with backoff, then terminal, and INDEPENDENCE ---------------
def test_failure_retries_then_terminal_and_is_independent(conn, config, make_publication):
    from worker.tests.conftest import FakeGraphClient

    failing = FakeGraphClient(fail_on=["create"])
    pub = make_publication(post_type="single", n_assets=1)
    other = make_publication(post_type="single", n_assets=1)  # must stay untouched

    # attempt 1 -> retry scheduled
    out = publish_one(conn, pub, config, failing, dry_run=False, now=NOW)
    assert out.result == "retry_scheduled"
    row = _reload(conn, pub["id"])
    assert row["status"] == "scheduled"
    assert row["attempt_count"] == 1
    assert row["next_retry_at"] is not None
    assert "create container boom" in row["last_error"]

    # attempts 2..max -> eventually terminal 'failed' (config.max_attempts == 3).
    # Reload the row each cycle, exactly as the poll loop re-fetches due publications.
    pub = _reload(conn, pub["id"])
    publish_one(conn, pub, config, failing, dry_run=False, now=NOW)
    pub = _reload(conn, pub["id"])
    out = publish_one(conn, pub, config, failing, dry_run=False, now=NOW)
    assert out.result == "failed"
    row = _reload(conn, pub["id"])
    assert row["status"] == "failed"
    assert row["attempt_count"] == 3

    # the other publication was never touched
    other_row = _reload(conn, other["id"])
    assert other_row["status"] == "scheduled"
    assert other_row["attempt_count"] == 0


def test_invalid_post_type_fails_terminally_without_retry(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="reel", n_assets=1)  # not supported until Phase 6
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)
    assert out.result == "failed"
    row = _reload(conn, pub["id"])
    assert row["status"] == "failed"
    assert row["attempt_count"] == 1  # terminal on first try, no backoff loop
    assert "not supported" in row["last_error"]


# ---- Rate-limit gate ------------------------------------------------------------
def test_rate_limit_blocks_publish(conn, config, make_publication):
    from worker.tests.conftest import FakeGraphClient

    maxed = FakeGraphClient(limit=(50, 50, 86400))  # usage >= total
    pub = make_publication(post_type="single", n_assets=1)
    out = publish_one(conn, pub, config, maxed, dry_run=False, now=NOW)

    assert out.result == "rate_limited"
    assert ("publish" not in [c[0] for c in maxed.calls])  # nothing published
    row = _reload(conn, pub["id"])
    assert row["status"] == "scheduled"
    assert row["next_retry_at"] is not None
    assert "rate limit" in row["last_error"]


# ---- One-time auto-retirement -----------------------------------------------------
def test_one_time_retires_only_after_all_targets_posted(conn, config, make_publication):
    from worker.publisher import _maybe_retire_one_time
    from datetime import datetime, timezone
    now = datetime(2026, 7, 22, tzinfo=timezone.utc)

    # A one-time post targeting two channels.
    pub = make_publication(post_type="single", n_assets=1, now=now)
    post_id, chan_a = pub["post_id"], pub["channel_id"]
    conn.execute("UPDATE posts SET content_kind='one_time' WHERE id=?", (post_id,))
    chan_b = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('instagram','B','2','t')").lastrowid
    conn.executemany("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)",
                     [(post_id, chan_a), (post_id, chan_b)])
    conn.commit()

    # Posted to A only -> NOT retired yet.
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
                 "VALUES (?,?, '2026-07-01T00:00:00+00:00', 'posted', '2026-07-01T00:00:00+00:00')",
                 (post_id, chan_a))
    conn.commit()
    assert _maybe_retire_one_time(conn, post_id, now) is False
    assert conn.execute("SELECT content_status FROM posts WHERE id=?", (post_id,)).fetchone()[0] != "retired"

    # Now posted to B too -> retire.
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
                 "VALUES (?,?, '2026-07-02T00:00:00+00:00', 'posted', '2026-07-02T00:00:00+00:00')",
                 (post_id, chan_b))
    conn.commit()
    assert _maybe_retire_one_time(conn, post_id, now) is True
    assert conn.execute("SELECT content_status FROM posts WHERE id=?", (post_id,)).fetchone()[0] == "retired"


# ---- Caption variant selection --------------------------------------------------
def test_caption_selection_prefers_platform_then_rotates_generic(conn, config, make_publication):
    from worker.publisher import _select_caption
    pub = make_publication(post_type="single", n_assets=1)
    post_id = pub["post_id"]

    # No variants yet -> falls back to posts.caption ('hello world' from the fixture).
    assert _select_caption(conn, post_id, "instagram", 0) == "hello world"

    # Two generic variants -> rotate by used_count.
    conn.executemany(
        "INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?,?,?,?)",
        [(post_id, None, "gen-A", 0), (post_id, None, "gen-B", 1)],
    )
    conn.commit()
    assert _select_caption(conn, post_id, "instagram", 0) == "gen-A"
    assert _select_caption(conn, post_id, "instagram", 1) == "gen-B"
    assert _select_caption(conn, post_id, "instagram", 2) == "gen-A"  # wraps

    # An instagram-specific variant wins over generic.
    conn.execute("INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?,?,?,?)",
                 (post_id, "instagram", "ig-special", 5))
    conn.commit()
    assert _select_caption(conn, post_id, "instagram", 0) == "ig-special"
