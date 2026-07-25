"""Threads adapter: publish (text/image/carousel), quota gate, caps, preflight, metrics.

Mirrors the Instagram/Facebook adapter test suites (test_text_posts.py, test_metrics.py,
test_platform_dispatch.py) but pins Threads-specific behavior:
  * text posts need no media at all (container -> publish, same as image/carousel)
  * the quota gate IS live (unlike Facebook) because Threads has a real quota endpoint
  * caps are 500 caption chars / 20 carousel children
  * metrics map views/replies/reposts to our columns; quotes stays unmapped in raw_json
  * a metrics fetch failure must be non-fatal, with no fallback endpoint to try instead
"""

from __future__ import annotations

from datetime import datetime, timezone

from worker.metrics import run_metrics
from worker.publisher import publish_one
from worker.tests.conftest import FakeGraphClient


def _call_kinds(client):
    return [kind for kind, _ in client.calls]


def _text_pub(conn, make_publication, caption="hello threads"):
    pub = make_publication(platform="threads", post_type="single", n_assets=0)
    conn.execute(
        "UPDATE posts SET post_type = 'text', caption = ? WHERE id = ?",
        (caption, pub["post_id"]),
    )
    conn.commit()
    return conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()


def test_threads_text_post_publishes(conn, config, make_publication):
    client = FakeGraphClient(threads_limit=(0, 250, 86400))
    pub = _text_pub(conn, make_publication)

    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "posted"
    assert _call_kinds(client) == [
        "threads_limit", "threads_text", "threads_status", "threads_publish",
    ]
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"
    assert row["remote_post_id"] == out.detail


def test_threads_image_post_publishes(conn, config, make_publication):
    client = FakeGraphClient(threads_limit=(0, 250, 86400))
    pub = make_publication(platform="threads", post_type="single", n_assets=1)

    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "posted"
    assert _call_kinds(client) == [
        "threads_limit", "threads_image", "threads_status", "threads_publish",
    ]
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"
    assert row["remote_post_id"] == out.detail


def test_threads_carousel_publishes_children_in_asset_order(conn, config, make_publication):
    client = FakeGraphClient(threads_limit=(0, 250, 86400))
    pub = make_publication(platform="threads", post_type="carousel", n_assets=3)

    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "posted"
    assert _call_kinds(client) == [
        "threads_limit",
        "threads_child", "threads_status",
        "threads_child", "threads_status",
        "threads_child", "threads_status",
        "threads_carousel", "threads_status", "threads_publish",
    ]
    # The parent's `children` argument is the three child ids, in asset order.
    carousel_call = next(c for c in client.calls if c[0] == "threads_carousel")
    assert carousel_call[1] == ("threads-cont-1", "threads-cont-2", "threads-cont-3")


def test_threads_quota_gate_defers_at_capacity_without_creating_a_container(
    conn, config, make_publication
):
    client = FakeGraphClient(threads_limit=(250, 250, 86400))
    pub = make_publication(platform="threads", post_type="single", n_assets=1)

    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "rate_limited"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "scheduled"
    assert row["next_retry_at"] is not None
    assert _call_kinds(client) == ["threads_limit"]  # no container ever created


def test_threads_caption_over_limit_is_rejected_terminally_with_no_api_calls(
    conn, config, make_publication
):
    client = FakeGraphClient(threads_limit=(0, 250, 86400))
    pub = make_publication(platform="threads", post_type="single", n_assets=1)
    conn.execute(
        "UPDATE posts SET caption = ? WHERE id = ?", ("x" * 501, pub["post_id"])
    )
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()

    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "failed"
    assert row["next_retry_at"] is None
    assert "501" in row["last_error"] and "500" in row["last_error"]
    assert client.calls == []


def test_threads_carousel_over_max_is_rejected_terminally(conn, config, make_publication):
    client = FakeGraphClient(threads_limit=(0, 250, 86400))
    pub = make_publication(platform="threads", post_type="carousel", n_assets=21)

    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "failed"
    assert client.calls == []


def test_threads_carousel_at_max_is_accepted(conn, config, make_publication):
    client = FakeGraphClient(threads_limit=(0, 250, 86400))
    pub = make_publication(platform="threads", post_type="carousel", n_assets=20)

    out = publish_one(conn, pub, config, client, dry_run=False)

    assert out.result == "posted"
    assert _call_kinds(client).count("threads_child") == 20


def test_threads_dry_run_makes_no_calls(conn, config, make_publication):
    client = FakeGraphClient(threads_limit=(0, 250, 86400))
    pub = make_publication(platform="threads", post_type="single", n_assets=1)

    out = publish_one(conn, pub, config, client, dry_run=True)

    assert out.result == "dry_run"
    assert out.plan["platform"] == "threads"
    assert client.calls == []


def test_threads_preflight_uses_threads_quota_not_instagrams(conn):
    from worker.preflight import check_channels

    client = FakeGraphClient(threads_limit=(3, 250, 86400))

    class Registry:
        def for_platform(self, platform):
            return client

    rows = [
        {
            "id": 1,
            "account_name": "Test Threads",
            "platform": "threads",
            "access_token": "tok",
            "remote_account_id": "THREADS1",
        }
    ]
    lines = []
    ok = check_channels(rows, Registry(), print_fn=lines.append)

    assert ok is True
    assert any("✓" in line for line in lines)
    assert _call_kinds(client) == ["threads_limit"]
    assert "limit" not in _call_kinds(client)  # not Instagram's get_content_publishing_limit


def _posted_threads_pub(conn, make_publication, now):
    pub = make_publication(platform="threads", post_type="single", n_assets=1, now=now)
    conn.execute(
        """UPDATE publications
              SET status='posted', is_dry_run=0, remote_post_id='threads_1',
                  published_at=?
            WHERE id=?""",
        (now.isoformat(), pub["id"]),
    )
    conn.commit()
    return conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()


def test_threads_metrics_map_to_our_columns(conn, config, make_publication):
    now = datetime.now(timezone.utc)
    pub = _posted_threads_pub(conn, make_publication, now)
    client = FakeGraphClient(
        threads_insights={"views": 500, "likes": 12, "replies": 3, "reposts": 2, "quotes": 1}
    )

    assert run_metrics(conn, config, client, now) == 1

    row = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()
    assert row["impressions"] == 500   # views -> impressions
    assert row["likes"] == 12
    assert row["comments"] == 3        # replies -> comments
    assert row["shares"] == 2          # reposts -> shares
    assert row["reach"] is None
    assert row["saves"] is None
    assert "quotes" in row["raw_json"]
    import json
    raw = json.loads(row["raw_json"])
    assert raw["quotes"] == 1


def test_threads_metrics_failure_is_nonfatal(conn, config, make_publication):
    now = datetime.now(timezone.utc)
    pub = _posted_threads_pub(conn, make_publication, now)
    client = FakeGraphClient(fail_on=["threads_insights"])

    assert run_metrics(conn, config, client, now) == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()[0] == 0
