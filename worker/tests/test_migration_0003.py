"""0003 adds the tag kind column additively and seeds the four time_of_day bands."""
from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


def _apply(conn, name):
    conn.executescript((MIG / name).read_text())
    conn.commit()


def _fresh(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "m.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for name in ("0001_init.sql", "0002_content_model.sql"):
        _apply(conn, name)
    return conn


def test_0003_adds_kind_and_seeds_bands(tmp_path):
    conn = _fresh(tmp_path)
    # A pre-existing (topic-style) tag from before the migration.
    conn.execute("INSERT INTO tags (name) VALUES ('travel')")
    conn.commit()

    _apply(conn, "0003_tag_taxonomy.sql")

    # Existing rows default to topic.
    row = conn.execute("SELECT kind FROM tags WHERE name='travel'").fetchone()
    assert row["kind"] == "topic"

    # The four bands exist with kind time_of_day.
    bands = conn.execute(
        "SELECT name FROM tags WHERE kind='time_of_day' ORDER BY name"
    ).fetchall()
    assert [r["name"] for r in bands] == ["afternoon", "anytime", "evening", "morning"]


def test_0003_is_idempotent_on_reseed(tmp_path):
    conn = _fresh(tmp_path)
    _apply(conn, "0003_tag_taxonomy.sql")
    # Re-running the seed insert must not duplicate (INSERT OR IGNORE on unique name).
    conn.executescript(
        "INSERT OR IGNORE INTO tags (name, kind) VALUES ('morning','time_of_day');"
    )
    conn.commit()
    n = conn.execute("SELECT COUNT(*) AS c FROM tags WHERE name='morning'").fetchone()["c"]
    assert n == 1
