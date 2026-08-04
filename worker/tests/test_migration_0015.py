"""Migration 0015: assets gain a SECOND derivative pair, for the 9:16 story surface.

Until now an asset had one derivative (publish_path/conform_mode), shaped for the FEED's
4:5..1.91:1 range. A Story is 9:16 — outside that range — so one derivative cannot serve
both surfaces. See docs/design-story-canvas-and-framing.md.
"""

from __future__ import annotations

import sqlite3

import pytest


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _asset(conn, content_hash="h1", **extra):
    keys = ["content_hash", "media_kind", "storage_path", *extra]
    values = [content_hash, "image", "a.jpg", *extra.values()]
    placeholders = ",".join("?" for _ in keys)
    return conn.execute(
        f"INSERT INTO assets ({','.join(keys)}) VALUES ({placeholders})", values
    ).lastrowid


def test_assets_gain_the_story_pair(conn):
    assert "story_path" in cols(conn, "assets")
    assert "story_mode" in cols(conn, "assets")


def test_story_path_defaults_to_null_meaning_send_the_original(conn):
    aid = _asset(conn)
    conn.commit()
    row = conn.execute(
        "SELECT story_path, story_mode FROM assets WHERE id=?", (aid,)
    ).fetchone()
    assert row["story_path"] is None, "NULL means: already 9:16, publish the original"
    assert row["story_mode"] == "blurred", "blurred fill is the default treatment"


def test_story_mode_check_rejects_a_feed_mode(conn):
    """'pad' and 'crop' are FEED conform modes. Only 'crop' is shared; 'pad' must not
    leak across, or a Story would be published with white bars."""
    with pytest.raises(sqlite3.IntegrityError):
        _asset(conn, content_hash="h2", story_mode="pad")


def test_story_mode_check_rejects_anything_unknown(conn):
    with pytest.raises(sqlite3.IntegrityError):
        _asset(conn, content_hash="h3", story_mode="blurry")


def test_both_story_modes_are_accepted(conn):
    for i, mode in enumerate(("blurred", "crop")):
        _asset(conn, content_hash=f"hm{i}", story_mode=mode)
    conn.commit()
    assert conn.execute(
        "SELECT COUNT(*) FROM assets WHERE story_mode IN ('blurred','crop')"
    ).fetchone()[0] == 2


def test_a_story_path_round_trips(conn):
    aid = _asset(conn, content_hash="h4", story_path="story/h4-crop.jpg", story_mode="crop")
    conn.commit()
    row = conn.execute("SELECT story_path, story_mode FROM assets WHERE id=?", (aid,)).fetchone()
    assert row["story_path"] == "story/h4-crop.jpg"
    assert row["story_mode"] == "crop"


def test_the_feed_pair_is_untouched(conn):
    """The whole point is that the two surfaces stop sharing one derivative — the feed's
    columns must survive exactly as they were."""
    for c in ("publish_path", "conform_mode", "needs_review"):
        assert c in cols(conn, "assets"), f"{c} must survive"
    aid = _asset(conn, content_hash="h5", publish_path="pub/h5.jpg", conform_mode="pad")
    conn.commit()
    row = conn.execute(
        "SELECT publish_path, conform_mode, story_path FROM assets WHERE id=?", (aid,)
    ).fetchone()
    assert row["publish_path"] == "pub/h5.jpg"
    assert row["conform_mode"] == "pad", "'pad' is still perfectly valid for the FEED"
    assert row["story_path"] is None, "the two surfaces are independent"
