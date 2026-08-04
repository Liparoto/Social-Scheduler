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


def test_due_publications_break_ties_by_id(conn):
    """The slides of one Story share a scheduled_at and MUST go out in slide order.

    Ordering by scheduled_at alone leaves tie order up to SQLite's query plan, so this
    is a regression guard: slides are inserted in sort_order, which makes ascending id
    the publish order the worker has to preserve.
    """
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','carousel')"
    ).lastrowid
    when = "2026-07-22T17:00:00+00:00"
    ids = [
        conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, surface) "
            "VALUES (?,?,?,'story')",
            (pid, cid, when),
        ).lastrowid
        for _ in range(4)
    ]
    conn.commit()

    got = [r["id"] for r in db.fetch_due_publications(conn, NOW.isoformat())]
    assert got == ids, "story slides must publish in insertion (slide) order"
