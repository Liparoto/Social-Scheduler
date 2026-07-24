"""Tests for db-level due-selection helpers."""

from __future__ import annotations

from datetime import datetime, timezone

from worker import db

NOW = datetime(2026, 7, 22, 18, 0, 0, tzinfo=timezone.utc)


def test_fetch_due_publications_excludes_held_rows(conn, make_publication):
    pub = make_publication(post_type="single", n_assets=1, now=NOW)

    conn.execute("UPDATE publications SET is_held = 1 WHERE id = ?", (pub["id"],))
    conn.commit()

    due = db.fetch_due_publications(conn, NOW.isoformat())
    assert pub["id"] not in [row["id"] for row in due]

    conn.execute("UPDATE publications SET is_held = 0 WHERE id = ?", (pub["id"],))
    conn.commit()

    due = db.fetch_due_publications(conn, NOW.isoformat())
    assert pub["id"] in [row["id"] for row in due]
