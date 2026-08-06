"""Migration 0013: channel_groups table + channels.group_id, purely additive."""

from __future__ import annotations

import sqlite3

import pytest


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def test_channel_groups_table_exists_with_autofill_fields(conn):
    # Subset, not equality: the fixture applies EVERY migration, so a later one adding a
    # column to channel_groups (0020 added bpp_every_n_slots) is expected and correct.
    # This test is about what 0013 created, and an equality check turns every legitimate
    # future addition into a failure here.
    assert cols(conn, "channel_groups") >= {
        "id", "name", "timezone", "autofill_enabled", "cadence_config",
        "min_queue_depth", "target_queue_depth", "reuse_min_age_days",
        "is_active", "created_at", "updated_at",
    }


def test_channels_gains_nullable_group_id(conn):
    assert "group_id" in cols(conn, "channels")
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','Solo')"
    ).lastrowid
    conn.commit()
    row = conn.execute("SELECT group_id FROM channels WHERE id=?", (cid,)).fetchone()
    assert row["group_id"] is None, "existing/new channels must default to ungrouped"


def test_group_name_is_unique(conn):
    conn.execute("INSERT INTO channel_groups (name) VALUES ('Personal')")
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO channel_groups (name) VALUES ('Personal')")


def test_deleting_a_group_ungroups_its_channels_without_touching_publications(conn):
    gid = conn.execute("INSERT INTO channel_groups (name) VALUES ('Personal')").lastrowid
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, group_id) VALUES ('instagram','IG',?)",
        (gid,),
    ).lastrowid
    pid = conn.execute("INSERT INTO posts (caption, post_type) VALUES ('x','single')").lastrowid
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)",
        (pid, cid, "2026-08-01T18:00:00+00:00"),
    )
    conn.commit()

    conn.execute("DELETE FROM channel_groups WHERE id=?", (gid,))
    conn.commit()

    assert conn.execute("SELECT group_id FROM channels WHERE id=?", (cid,)).fetchone()[0] is None
    assert conn.execute("SELECT COUNT(*) FROM channels WHERE id=?", (cid,)).fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM publications WHERE channel_id=?", (cid,)
    ).fetchone()[0] == 1, "deleting a group must never cascade into publications"


def test_group_defaults_match_channel_defaults(conn):
    gid = conn.execute("INSERT INTO channel_groups (name) VALUES ('Defaults')").lastrowid
    conn.commit()
    g = conn.execute("SELECT * FROM channel_groups WHERE id=?", (gid,)).fetchone()
    assert g["timezone"] == "UTC"
    assert g["autofill_enabled"] == 0
    assert g["cadence_config"] is None
    assert g["min_queue_depth"] == 0
    assert g["target_queue_depth"] == 0
    assert g["reuse_min_age_days"] == 180
    assert g["is_active"] == 1
