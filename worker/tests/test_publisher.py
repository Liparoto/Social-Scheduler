"""Tests for the publish state machine — maps directly to the Phase 2 verification gate."""

from __future__ import annotations

from datetime import datetime, timezone

import requests

from worker import db
from worker.graph_api import GraphClient
from worker.publisher import publish_one
from worker.tests.conftest import FakeGraphClient

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
    # posts.post_type='story' is VESTIGIAL (see migration 0014's header): Stories are a
    # target SURFACE, not a content shape. The old enum value must stay dead rather than
    # quietly start working — publishing a real Story is covered in
    # test_stories_publisher.py, driven by publications.surface.
    pub = make_publication(post_type="story", n_assets=1)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)
    assert out.result == "failed"
    row = _reload(conn, pub["id"])
    assert row["status"] == "failed"
    assert row["attempt_count"] == 1  # terminal on first try, no backoff loop
    assert "not a publishable content shape" in row["last_error"]


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


def test_dry_run_publication_does_not_count_toward_retirement(conn, config, make_publication):
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

    # A dry-run 'posted' publication to A, and a real one to B -> must NOT retire.
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at, "
        "is_dry_run, remote_post_id) VALUES (?,?, '2026-07-01T00:00:00+00:00', 'posted', "
        "'2026-07-01T00:00:00+00:00', 1, 'DRYRUN')",
        (post_id, chan_a),
    )
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?, '2026-07-02T00:00:00+00:00', 'posted', '2026-07-02T00:00:00+00:00')",
        (post_id, chan_b),
    )
    conn.commit()
    assert _maybe_retire_one_time(conn, post_id, now) is False
    assert conn.execute("SELECT content_status FROM posts WHERE id=?", (post_id,)).fetchone()[0] != "retired"

    # Once A also gets a REAL posted publication -> retire.
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?, '2026-07-03T00:00:00+00:00', 'posted', '2026-07-03T00:00:00+00:00')",
        (post_id, chan_a),
    )
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


# ---- Facebook Pages --------------------------------------------------------------
def test_facebook_single_publishes_in_one_call_and_stores_the_feed_post_id(
    conn, config, fake_client, make_publication
):
    pub = make_publication(platform="facebook")
    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "posted"
    kinds = [k for k, _ in fake_client.calls]
    # No "limit": Facebook Pages have no content_publishing_limit endpoint.
    # No container/status polling either — a Page photo publishes in one call.
    assert kinds == ["page_photo"]
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"
    # post_id (the feed post), NOT id (the photo) — insights are read against the post.
    assert row["remote_post_id"] == "page_1"


def test_facebook_carousel_uploads_unpublished_photos_then_one_feed_post(
    conn, config, fake_client, make_publication
):
    pub = make_publication(post_type="carousel", n_assets=3, platform="facebook")
    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "posted"
    kinds = [k for k, _ in fake_client.calls]
    assert kinds == ["page_child", "page_child", "page_child", "page_feed"]
    # The feed post attaches exactly the media_fbids returned by the uploads.
    attached = [arg for k, arg in fake_client.calls if k == "page_feed"][0]
    assert attached == ("photo-1", "photo-2", "photo-3")
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["remote_post_id"] == "page_4"


def test_facebook_publish_failure_is_visible_and_retried(
    conn, config, fake_client, make_publication
):
    pub = make_publication(platform="facebook")
    fake_client.fail_on.add("page_photo")
    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "retry_scheduled"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "scheduled"
    assert row["attempt_count"] == 1
    assert "page photo boom" in row["last_error"]
    assert row["next_retry_at"] is not None


def test_facebook_dry_run_publishes_nothing(
    conn, config, fake_client, make_publication
):
    pub = make_publication(platform="facebook")
    out = publish_one(conn, pub, config, fake_client, dry_run=True)

    assert out.result == "dry_run"
    assert fake_client.calls == []
    assert out.plan["platform"] == "facebook"
    assert out.plan["account_id"] == "PAGE1"


def test_facebook_multi_photo_mid_carousel_child_failure_leaves_it_retryable(
    conn, config, make_publication
):
    """Photo 3 of 5 fails to upload. Photos 1-2 are already uploaded (unpublished) —
    those orphans are a documented gotcha (docs/meta-setup.md), not cleaned up here — but
    the feed post itself must NEVER be created from a partial set, and the publication
    must come back visibly retryable rather than silently stuck or double-posted.
    """
    client = FakeGraphClient(fail_child_index=3)
    pub = make_publication(post_type="carousel", n_assets=5, platform="facebook")
    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "retry_scheduled"
    kinds = [k for k, _ in client.calls]
    # Two successful children, then the third fails — and publishing stops right there.
    assert kinds == ["page_child", "page_child", "page_child"]
    assert "page_feed" not in kinds  # never posts the feed with a partial media set

    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "scheduled"
    assert row["attempt_count"] == 1
    assert row["last_error"] is not None
    assert "child 3" in row["last_error"]
    assert row["next_retry_at"] is not None


# ---- Credential redaction (end to end) -------------------------------------------
# A DNS blip or connection failure during a real publish must never persist the
# access_token to publications.last_error — the dashboard renders that column directly
# on the Overview page. This exercises the REAL GraphClient (not the FakeGraphClient
# used everywhere else in this file) wired to a session that fails at the network layer,
# through publish_one's real error handling and _mark_failure's real DB write, then reads
# the value back from the database exactly like a human checking the dashboard would.
TOKEN_VALUE = "EAAB-super-secret-real-meta-access-token"


class NetworkFailureSession:
    """Mimics a genuine requests.ConnectionError: its message embeds the full request
    URL, access_token and all, exactly like the real requests library does on a DNS
    failure or connection refusal."""

    def get(self, url, params=None, timeout=None):
        token = (params or {}).get("access_token", "")
        raise requests.ConnectionError(
            f"HTTPSConnectionPool(host='graph.facebook.com', port=443): Max retries "
            f"exceeded with url: {url}?access_token={token} "
            f"(Caused by NewConnectionError('...: Name or service not known'))"
        )

    def post(self, url, data=None, timeout=None):
        token = (data or {}).get("access_token", "")
        raise requests.ConnectionError(
            f"HTTPSConnectionPool(host='graph.facebook.com', port=443): Max retries "
            f"exceeded with url: {url}?access_token={token} "
            f"(Caused by NewConnectionError('...: Name or service not known'))"
        )


def test_network_failure_during_publish_never_persists_the_token_to_last_error(
    conn, config, make_publication, monkeypatch
):
    # Force the publication's channel token to the known secret value so we can assert
    # on it precisely (make_publication always inserts "tok-123").
    pub = make_publication(post_type="single", n_assets=1)
    conn.execute(
        "UPDATE channels SET access_token = ? WHERE id = ?", (TOKEN_VALUE, pub["channel_id"])
    )
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()

    real_client = GraphClient(config.graph_version, session=NetworkFailureSession())
    out = publish_one(conn, pub, config, real_client, dry_run=False, now=NOW)

    assert out.result == "retry_scheduled"  # transient network error -> retryable
    row = _reload(conn, pub["id"])
    assert row["last_error"] is not None
    assert TOKEN_VALUE not in row["last_error"]
    # still tells a human what actually went wrong
    assert "graph.facebook.com" in row["last_error"] or "connection" in row["last_error"].lower()
