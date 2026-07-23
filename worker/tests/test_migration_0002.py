"""0002 applies additively and backfills existing installs correctly."""
from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


def _apply(conn, name):
    conn.executescript((MIG / name).read_text())
    conn.commit()


def test_0002_backfills_existing_data(tmp_path):
    p = tmp_path / "m.db"
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    _apply(conn, "0001_init.sql")

    # Seed a pre-migration install: a channel, a captioned post, a publication.
    conn.execute("INSERT INTO channels (platform, account_name) VALUES ('instagram','C')")
    conn.execute("INSERT INTO posts (caption, post_type) VALUES ('hello', 'single')")
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at) "
                 "VALUES (1, 1, '2026-01-01T00:00:00+00:00')")
    conn.commit()

    _apply(conn, "0002_content_model.sql")

    post = conn.execute("SELECT content_kind, content_status, cooldown_days "
                        "FROM posts WHERE id=1").fetchone()
    assert post["content_kind"] == "evergreen"
    assert post["content_status"] == "ready"   # existing content stays eligible
    assert post["cooldown_days"] is None

    tgt = conn.execute("SELECT channel_id FROM post_targets WHERE post_id=1").fetchall()
    assert [r["channel_id"] for r in tgt] == [1]   # inferred from the publication

    cap = conn.execute("SELECT platform, body FROM caption_variants WHERE post_id=1").fetchall()
    assert len(cap) == 1 and cap[0]["platform"] is None and cap[0]["body"] == "hello"


def test_0002_new_post_defaults_to_draft(tmp_path):
    p = tmp_path / "m2.db"
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    _apply(conn, "0001_init.sql")
    _apply(conn, "0002_content_model.sql")
    # A post created AFTER the migration defaults to draft (nothing auto-posts by accident).
    conn.execute("INSERT INTO posts (caption, post_type) VALUES ('new', 'single')")
    conn.commit()
    row = conn.execute("SELECT content_status, content_kind FROM posts WHERE id=1").fetchone()
    assert row["content_status"] == "draft"
    assert row["content_kind"] == "evergreen"
