"""Migration 0018: the Insights hub tables, purely additive.

The three properties worth locking down are the ones the sync jobs rely on being true:
one row per (channel, remote post), one row per (channel, day), and a publication delete
that does NOT take account history with it.
"""

from __future__ import annotations

import sqlite3

import pytest


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _channel(conn, name="IG"):
    return conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram', ?)", (name,)
    ).lastrowid


def _publication(conn, channel_id):
    post_id = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','single')"
    ).lastrowid
    return conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)",
        (post_id, channel_id, "2026-08-01T18:00:00+00:00"),
    ).lastrowid


def test_new_tables_exist(conn):
    for table in ("remote_media", "media_metrics", "account_metrics", "audience_demographics"):
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone(), f"{table} missing"


def test_channels_gains_sync_bookkeeping(conn):
    channel_cols = cols(conn, "channels")
    for col in (
        "media_synced_at", "insights_synced_at", "media_backfill_complete",
        "insights_error", "insights_refresh_requested",
    ):
        assert col in channel_cols

    cid = _channel(conn)
    conn.commit()
    row = conn.execute(
        "SELECT media_synced_at, media_backfill_complete, insights_refresh_requested "
        "FROM channels WHERE id=?", (cid,),
    ).fetchone()
    # NULL "never synced" must be distinguishable from a real sync that found nothing —
    # the UI renders those two states very differently.
    assert row["media_synced_at"] is None
    assert row["media_backfill_complete"] == 0
    assert row["insights_refresh_requested"] == 0


def test_remote_media_is_unique_per_channel_and_remote_id(conn):
    """Re-running a full backfill must be idempotent, which is this index's whole job."""
    cid = _channel(conn)
    conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id) VALUES (?, 'abc')", (cid,)
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO remote_media (channel_id, remote_post_id) VALUES (?, 'abc')", (cid,)
        )


def test_same_remote_id_on_a_different_channel_is_allowed(conn):
    """Uniqueness is per channel, not global — two accounts can surface the same id."""
    a, b = _channel(conn, "A"), _channel(conn, "B")
    conn.execute("INSERT INTO remote_media (channel_id, remote_post_id) VALUES (?, 'abc')", (a,))
    conn.execute("INSERT INTO remote_media (channel_id, remote_post_id) VALUES (?, 'abc')", (b,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) c FROM remote_media").fetchone()["c"] == 2


def test_deleting_a_publication_keeps_the_account_history(conn):
    """ON DELETE SET NULL, not CASCADE. A publication is OUR record of a send; a
    remote_media row is the ACCOUNT'S history. Deleting the former must never erase the
    latter, or past charts silently rewrite themselves."""
    cid = _channel(conn)
    pub_id = _publication(conn, cid)
    rm_id = conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id, publication_id) "
        "VALUES (?, 'abc', ?)", (cid, pub_id),
    ).lastrowid
    conn.execute(
        "INSERT INTO media_metrics (remote_media_id, fetched_at, reach) VALUES (?, ?, 99)",
        (rm_id, "2026-08-05T00:00:00+00:00"),
    )
    conn.commit()

    conn.execute("DELETE FROM publications WHERE id=?", (pub_id,))
    conn.commit()

    row = conn.execute("SELECT publication_id FROM remote_media WHERE id=?", (rm_id,)).fetchone()
    assert row is not None, "remote_media row must survive its publication being deleted"
    assert row["publication_id"] is None
    assert conn.execute(
        "SELECT COUNT(*) c FROM media_metrics WHERE remote_media_id=?", (rm_id,)
    ).fetchone()["c"] == 1, "its metrics history must survive too"


def test_deleting_a_channel_removes_its_synced_data(conn):
    """The opposite direction IS a cascade: a removed channel's synced copies are
    meaningless without it, and leaving them would strand rows no screen can reach."""
    cid = _channel(conn)
    rm_id = conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id) VALUES (?, 'abc')", (cid,)
    ).lastrowid
    conn.execute(
        "INSERT INTO media_metrics (remote_media_id, fetched_at) VALUES (?, '2026-08-05T00:00:00')",
        (rm_id,),
    )
    conn.execute(
        "INSERT INTO account_metrics (channel_id, day, fetched_at) "
        "VALUES (?, '2026-08-05', '2026-08-05T00:00:00')", (cid,),
    )
    conn.execute(
        "INSERT INTO audience_demographics (channel_id, day, audience, breakdown, dimension, value)"
        " VALUES (?, '2026-08-05', 'followers', 'age', '25-34', 10)", (cid,),
    )
    conn.commit()

    conn.execute("DELETE FROM channels WHERE id=?", (cid,))
    conn.commit()

    for table in ("remote_media", "media_metrics", "account_metrics", "audience_demographics"):
        assert conn.execute(f"SELECT COUNT(*) c FROM {table}").fetchone()["c"] == 0, table


def test_account_metrics_upserts_one_row_per_day(conn):
    """The load-bearing property: a job that runs twice in a day must not double it."""
    cid = _channel(conn)
    for followers, reach, at in ((100, 500, "T01"), (111, 555, "T07")):
        conn.execute(
            """INSERT INTO account_metrics (channel_id, day, followers_count, reach, fetched_at)
               VALUES (?, '2026-08-05', ?, ?, ?)
               ON CONFLICT (channel_id, day) DO UPDATE SET
                 followers_count = excluded.followers_count,
                 reach           = excluded.reach,
                 fetched_at      = excluded.fetched_at""",
            (cid, followers, reach, at),
        )
    conn.commit()

    rows = conn.execute("SELECT * FROM account_metrics WHERE channel_id=?", (cid,)).fetchall()
    assert len(rows) == 1
    assert rows[0]["followers_count"] == 111, "the later fetch must win"
    assert rows[0]["reach"] == 555


def test_account_metric_columns_are_nullable(conn):
    """NULL means 'this platform did not report it' and must stay distinct from 0.
    Threads has no reach; a row with reach=0 would be a lie."""
    cid = _channel(conn)
    conn.execute(
        "INSERT INTO account_metrics (channel_id, day, fetched_at) VALUES (?, '2026-08-05', 'T')",
        (cid,),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM account_metrics WHERE channel_id=?", (cid,)).fetchone()
    assert row["reach"] is None and row["followers_count"] is None


def test_audience_demographics_rejects_unknown_audience_or_breakdown(conn):
    cid = _channel(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO audience_demographics "
            "(channel_id, day, audience, breakdown, dimension, value) "
            "VALUES (?, '2026-08-05', 'strangers', 'age', '25-34', 1)", (cid,),
        )
    conn.rollback()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO audience_demographics "
            "(channel_id, day, audience, breakdown, dimension, value) "
            "VALUES (?, '2026-08-05', 'followers', 'zodiac', 'Leo', 1)", (cid,),
        )


def test_audience_demographics_is_unique_per_bucket(conn):
    """Re-running the daily sync upserts a bucket rather than stacking duplicates."""
    cid = _channel(conn)
    args = (cid, "2026-08-05", "followers", "age", "25-34")
    conn.execute(
        "INSERT INTO audience_demographics "
        "(channel_id, day, audience, breakdown, dimension, value) VALUES (?,?,?,?,?, 10)", args
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO audience_demographics "
            "(channel_id, day, audience, breakdown, dimension, value) VALUES (?,?,?,?,?, 20)", args
        )


def test_post_metrics_is_untouched(conn):
    """0018 must not have altered the publish-side metrics table autofill depends on."""
    assert cols(conn, "post_metrics") == {
        "id", "publication_id", "fetched_at", "reach", "impressions", "likes",
        "comments", "saves", "shares", "video_views", "raw_json", "created_at",
    }
