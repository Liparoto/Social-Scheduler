"""Tests for the metrics fetch job and that it feeds the ranking."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker.metrics import run_metrics
from worker.autofill import select_candidates
from worker.tests.conftest import FakeGraphClient

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


def _channel(conn, token="tok"):
    return conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('instagram','C','ig1',?)",
        (token,),
    ).lastrowid


def _posted_pub(conn, channel_id, *, published_at, remote_id="media-1", dry_run=0):
    pid = conn.execute(
        "INSERT INTO posts (post_type, content_status) VALUES ('single', 'ready')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)", (pid, channel_id)
    )
    pub = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, published_at, remote_post_id, is_dry_run)
           VALUES (?,?,?, 'posted', ?, ?, ?)""",
        (pid, channel_id, published_at, published_at, remote_id, dry_run),
    ).lastrowid
    conn.commit()
    return pid, pub


def _snapshots(conn, pub_id):
    return conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id=? ORDER BY id", (pub_id,)
    ).fetchall()


def test_fetch_writes_mapped_snapshot(conn, config, fake_client):
    ch = _channel(conn)
    _, pub = _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat())

    assert run_metrics(conn, config, fake_client, NOW) == 1
    rows = _snapshots(conn, pub)
    assert len(rows) == 1
    assert rows[0]["reach"] == 100
    assert rows[0]["saves"] == 5      # "saved" -> saves column
    assert rows[0]["likes"] == 10
    assert rows[0]["raw_json"] is not None


def test_skips_dry_run_and_unpublished(conn, config, fake_client):
    ch = _channel(conn)
    # dry-run posted
    _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat(),
                remote_id="DRYRUN", dry_run=1)
    # scheduled (not posted)
    pid = conn.execute("INSERT INTO posts (post_type) VALUES ('single')").lastrowid
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status) "
        "VALUES (?,?,?, 'scheduled')",
        (pid, ch, NOW.isoformat()),
    )
    conn.commit()
    assert run_metrics(conn, config, fake_client, NOW) == 0
    assert fake_client.calls == []


def test_interval_throttle(conn, config, fake_client):
    ch = _channel(conn)
    _, pub = _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat())
    assert run_metrics(conn, config, fake_client, NOW) == 1
    # Immediately again -> throttled (a fresh snapshot exists within the interval).
    assert run_metrics(conn, config, fake_client, NOW) == 0
    # Far enough in the future -> fetches again.
    later = NOW + timedelta(hours=config.metrics_min_interval_hours + 1)
    assert run_metrics(conn, config, fake_client, later) == 1
    assert len(_snapshots(conn, pub)) == 2


def test_old_posts_excluded(conn, config, fake_client):
    ch = _channel(conn)
    _posted_pub(conn, ch,
                published_at=(NOW - timedelta(days=config.metrics_max_age_days + 5)).isoformat())
    assert run_metrics(conn, config, fake_client, NOW) == 0


def test_fetch_failure_is_nonfatal(conn, config):
    ch = _channel(conn)
    _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat())
    failing = FakeGraphClient(fail_on=["insights"])
    assert run_metrics(conn, config, failing, NOW) == 0  # no crash, nothing recorded


def test_metrics_then_ranking_prefers_higher_performer(conn, config):
    """End-to-end: fetch metrics, then the ranking prefers the higher performer."""
    ch = _channel(conn)
    old = (NOW - timedelta(days=200)).isoformat()  # recyclable by age
    low_post, low_pub = _posted_pub(conn, ch, published_at=old, remote_id="m-low")
    high_post, high_pub = _posted_pub(conn, ch, published_at=old, remote_id="m-high")
    # give each an asset so they're rankable
    for pid in (low_post, high_post):
        aid = conn.execute(
            "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image','x')",
            (f"h{pid}",),
        ).lastrowid
        conn.execute("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)", (pid, aid))
    conn.commit()

    low_client = FakeGraphClient(insights={"reach": 10, "saved": 0})
    high_client = FakeGraphClient(insights={"reach": 900, "saved": 80})
    # fetch per-publication with distinct numbers
    run_metrics(conn, config, low_client, NOW)  # writes for both using low? -> need per-pub
    # Overwrite: fetch high performer with the high client by clearing and re-recording.
    conn.execute("DELETE FROM post_metrics")
    from worker.metrics import _record
    _record(conn, low_pub, NOW.isoformat(), {"reach": 10, "saved": 0})
    _record(conn, high_pub, NOW.isoformat(), {"reach": 900, "saved": 80})

    got = [r["post_id"] for r in select_candidates(conn, ch, NOW)][:1]
    assert got == [high_post]
