"""0025 lets a channel be TikTok, and gives publications an honest delivery state.

The rebuild is the risk in this migration, not the CHECK: `channels` has gained sixteen
columns and an index since 0009 rebuilt it last, and a column list copied from that file
would report success while dropping every one of them.
"""

from __future__ import annotations

import sqlite3

import pytest


def _channel(conn, platform="tiktok"):
    conn.execute(
        "INSERT INTO channels (platform, account_name, timezone) VALUES (?, ?, 'UTC')",
        (platform, f"{platform} test"),
    )
    conn.commit()
    return conn.execute("SELECT last_insert_rowid()").fetchone()[0]


def _publication(conn, channel_id, post_type="reel"):
    conn.execute("INSERT INTO posts (post_type) VALUES (?)", (post_type,))
    post = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?, ?, ?)",
        (post, channel_id, "2026-08-23T00:00:00Z"),
    )
    conn.commit()
    return conn.execute("SELECT last_insert_rowid()").fetchone()[0]


def test_tiktok_is_an_accepted_platform(conn):
    assert _channel(conn) > 0


def test_existing_platforms_still_accepted(conn):
    for platform in ("instagram", "facebook", "threads", "discord", "telegram"):
        assert _channel(conn, platform) > 0


def test_unknown_platform_still_rejected(conn):
    with pytest.raises(sqlite3.IntegrityError):
        _channel(conn, "myspace")


def test_channels_keeps_every_column_the_later_migrations_added(conn):
    cols = {row[1] for row in conn.execute("PRAGMA table_info(channels)")}
    # These arrived AFTER 0009's rebuild. A column list copied from that file drops them.
    for col in ("color_hue", "avatar_path", "group_id", "media_synced_at",
                "bpp_every_n_slots", "refresh_token", "refresh_token_expires_at"):
        assert col in cols, f"the channels rebuild dropped {col}"


def test_channels_group_index_survives_the_rebuild(conn):
    names = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='channels'"
        )
    }
    # 0009 said channels had no indexes; 0013 added this one. Dropping the table drops it.
    assert "idx_channels_group" in names


def test_channels_group_fk_survives_the_rebuild(conn):
    fks = [row[2] for row in conn.execute("PRAGMA foreign_key_list(channels)")]
    assert "channel_groups" in fks


def test_delivery_state_accepts_only_the_three_states(conn):
    pub = _publication(conn, _channel(conn))
    for state in ("inbox", "published", "gave_up"):
        conn.execute("UPDATE publications SET delivery_state = ? WHERE id = ?", (state, pub))
    conn.execute("UPDATE publications SET delivery_state = NULL WHERE id = ?", (pub,))
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE publications SET delivery_state = 'posted' WHERE id = ?", (pub,))


def test_delivery_state_defaults_to_null_for_every_other_platform(conn):
    pub = _publication(conn, _channel(conn, "instagram"), post_type="single")
    row = conn.execute(
        "SELECT delivery_state, delivery_checked_at FROM publications WHERE id = ?", (pub,)
    ).fetchone()
    assert row[0] is None and row[1] is None
