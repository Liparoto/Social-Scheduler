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


def test_manual_flag_overrides_interval_and_is_cleared(conn, config, fake_client):
    ch = _channel(conn)
    _, pub = _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat())
    # A fresh snapshot at NOW → within the 6h interval, so normally skipped.
    conn.execute(
        "INSERT INTO post_metrics (publication_id, fetched_at, reach) VALUES (?,?,10)",
        (pub, NOW.isoformat()),
    )
    conn.commit()
    assert run_metrics(conn, config, fake_client, NOW) == 0  # gated by interval

    conn.execute(
        "UPDATE publications SET metrics_refresh_requested_at=? WHERE id=?",
        (NOW.isoformat(), pub),
    )
    conn.commit()
    assert run_metrics(conn, config, fake_client, NOW) == 1  # flag overrides the gate
    flag = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id=?", (pub,)
    ).fetchone()[0]
    assert flag is None  # cleared after the fetch


def test_manual_flag_cleared_even_on_fetch_failure(conn, config):
    from worker.tests.conftest import FakeGraphClient
    ch = _channel(conn)
    _, pub = _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat())
    conn.execute(
        "UPDATE publications SET metrics_refresh_requested_at=? WHERE id=?",
        (NOW.isoformat(), pub),
    )
    conn.commit()
    client = FakeGraphClient(fail_on=["insights"])
    assert run_metrics(conn, config, client, NOW) == 0  # fetch failed, nothing recorded
    flag = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id=?", (pub,)
    ).fetchone()[0]
    assert flag is None  # cleared even though the fetch failed


def test_manual_flag_overrides_age_window_and_is_cleared(conn, config, fake_client):
    """A manual refresh is user-initiated and one-shot, so it bypasses the age cap
    (metrics_max_age_days), not just the 6h interval — otherwise the flag would stick."""
    ch = _channel(conn)
    # Published 40 days ago — beyond the 30-day default window; never auto-refreshed.
    old = (NOW - timedelta(days=40)).isoformat()
    _, pub = _posted_pub(conn, ch, published_at=old)
    assert run_metrics(conn, config, fake_client, NOW) == 0  # age-gated normally

    conn.execute(
        "UPDATE publications SET metrics_refresh_requested_at=? WHERE id=?",
        (NOW.isoformat(), pub),
    )
    conn.commit()
    assert run_metrics(conn, config, fake_client, NOW) == 1  # manual flag bypasses the age gate
    flag = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id=?", (pub,)
    ).fetchone()[0]
    assert flag is None  # cleared, so the UI won't read "Queued" forever


def _posted_fb_pub(conn, make_publication, now):
    """A Facebook publication already posted, due for a metrics fetch."""
    pub = make_publication(platform="facebook", now=now)
    conn.execute(
        """UPDATE publications
              SET status='posted', is_dry_run=0, remote_post_id='page_1',
                  published_at=?
            WHERE id=?""",
        (now.isoformat(), pub["id"]),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()


def test_facebook_metrics_use_the_page_endpoints_and_map_to_our_columns(
    conn, config, fake_client, make_publication
):
    now = datetime.now(timezone.utc)
    pub = _posted_fb_pub(conn, make_publication, now)

    assert run_metrics(conn, config, fake_client, now) == 1

    kinds = [k for k, _ in fake_client.calls]
    assert "page_summary" in kinds
    assert "insights" not in kinds  # the IG media-insights call must not be used

    row = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()
    assert row["likes"] == 12       # reactions total
    assert row["comments"] == 3
    assert row["shares"] == 2
    assert row["reach"] == 40       # post_total_media_view_unique
    assert row["saves"] is None     # an Instagram-only concept


def test_a_deprecated_insight_metric_still_records_the_stable_counts(
    conn, config, fake_client, make_publication
):
    # Meta retired a batch of post-insight names on 2026-06-15 and keeps changing them.
    # An invalid-metric error must NOT cost us the reactions/comments/shares we can get.
    now = datetime.now(timezone.utc)
    pub = _posted_fb_pub(conn, make_publication, now)
    fake_client.fail_on.add("page_insights")

    assert run_metrics(conn, config, fake_client, now) == 1

    row = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()
    assert row["likes"] == 12
    assert row["comments"] == 3
    assert row["reach"] is None      # unavailable, stored as unknown rather than 0


def test_losing_the_stable_counts_skips_the_snapshot(
    conn, config, fake_client, make_publication
):
    now = datetime.now(timezone.utc)
    pub = _posted_fb_pub(conn, make_publication, now)
    fake_client.fail_on.add("page_summary")

    assert run_metrics(conn, config, fake_client, now) == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()[0] == 0


def test_metrics_pick_the_client_for_each_channels_platform(
    conn, config, fake_client, make_publication
):
    now = datetime.now(timezone.utc)
    _posted_fb_pub(conn, make_publication, now)
    seen = []

    def client_for(platform):
        seen.append(platform)
        return fake_client

    assert run_metrics(conn, config, fake_client, now, client_for=client_for) == 1
    assert seen == ["facebook"]
