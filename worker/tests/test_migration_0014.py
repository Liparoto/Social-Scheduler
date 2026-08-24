"""Migration 0014: post_targets gains a surface (PK widens); publications gains
surface + asset_id additively.

Instagram Stories are a DESTINATION, not a post type — see
docs/design-instagram-stories.md. These tests pin the three things that make that
model work: one channel can be targeted on two surfaces, existing data is untouched,
and a scheduled Story cannot be silently orphaned by deleting its asset.
"""

from __future__ import annotations

import sqlite3

import pytest


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _post_and_channel(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','single')"
    ).lastrowid
    return pid, cid


def test_both_tables_gain_surface(conn):
    assert "surface" in cols(conn, "post_targets")
    assert "surface" in cols(conn, "publications")
    assert "asset_id" in cols(conn, "publications")


def test_existing_rows_default_to_feed(conn):
    pid, cid = _post_and_channel(conn)
    conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, cid))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)",
        (pid, cid, "2026-08-01T18:00:00+00:00"),
    )
    conn.commit()
    assert conn.execute("SELECT surface FROM post_targets").fetchone()[0] == "feed"
    row = conn.execute("SELECT surface, asset_id FROM publications").fetchone()
    assert row["surface"] == "feed"
    assert row["asset_id"] is None, "a feed send means ALL assets, not a specific one"


def test_one_channel_can_be_targeted_on_both_surfaces(conn):
    """The whole point of widening the primary key."""
    pid, cid = _post_and_channel(conn)
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'feed')",
        (pid, cid),
    )
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
        (pid, cid),
    )
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM post_targets").fetchone()[0] == 2


def test_the_same_surface_twice_is_still_rejected(conn):
    pid, cid = _post_and_channel(conn)
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
        (pid, cid),
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
            (pid, cid),
        )


def test_surface_check_rejects_anything_else(conn):
    """'reel' is not used here: migration 0027 deliberately adds it to this CHECK for
    Facebook Reels, so it stopped being an example of a rejected value. Any surface
    nothing has ever defined still must be refused."""
    pid, cid = _post_and_channel(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'bogus')",
            (pid, cid),
        )


def test_publications_surface_check_rejects_anything_else(conn):
    """See test_surface_check_rejects_anything_else: 'reel' is now a valid surface
    (migration 0027), so it can no longer stand in for an invalid one."""
    pid, cid = _post_and_channel(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, surface) "
            "VALUES (?,?,?,'bogus')",
            (pid, cid, "2026-08-01T18:00:00+00:00"),
        )


def test_deleting_an_asset_a_story_send_needs_is_refused(conn):
    """ON DELETE RESTRICT: a scheduled Story must never be silently orphaned."""
    pid, cid = _post_and_channel(conn)
    aid = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path) "
        "VALUES ('h1','image','a.jpg')"
    ).lastrowid
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, surface, asset_id) "
        "VALUES (?,?,?,'story',?)",
        (pid, cid, "2026-08-01T18:00:00+00:00", aid),
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM assets WHERE id=?", (aid,))


def test_post_targets_channel_index_survives_the_rebuild(conn):
    names = {r["name"] for r in conn.execute("PRAGMA index_list(post_targets)").fetchall()}
    assert "idx_post_targets_channel" in names


def test_cascade_from_posts_still_works_after_the_rebuild(conn):
    """The rebuild disables foreign keys; if they aren't restored, this silently passes
    with orphaned rows instead of cascading."""
    pid, cid = _post_and_channel(conn)
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'feed')",
        (pid, cid),
    )
    conn.commit()
    conn.execute("DELETE FROM posts WHERE id=?", (pid,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM post_targets").fetchone()[0] == 0
