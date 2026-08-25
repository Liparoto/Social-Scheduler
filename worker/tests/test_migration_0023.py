"""Migration 0023: posts.archived_at — a Library visibility flag, and ONLY that.

The dashboard needed a way to get a posted item out of the Library, because deletePost()
refuses any post with a live send (erasing it would erase the record of something that is
on Instagram). Archiving is that way out: it hides the post, it destroys nothing.

What these tests pin is the boundary, not the feature. `archived_at` must stay out of the
worker's selection rules — auto-fill eligibility runs on content_status, which is visible
and editable in the UI, and the Archive dialog offers to set it in the same step. Teaching
the worker to skip archived posts would put the same decision behind two switches, one of
them invisible from the dashboard. If that trade is ever revisited it should break a test
and start a conversation, not slip in as an obvious-looking tidy-up.
"""

from __future__ import annotations

from datetime import datetime, timezone

from worker.autofill import eligible_candidates


NOW = datetime(2026, 8, 20, 18, 0, tzinfo=timezone.utc)


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _channel(conn):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, min_queue_depth,
              target_queue_depth, reuse_min_age_days, remote_account_id, access_token)
           VALUES ('instagram','IG','America/New_York',1,3,5,180,'acct1','tok')"""
    ).lastrowid


def _ready_post(conn, channel_id):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at) "
        "VALUES ('x','single','draft','ready','evergreen','2026-01-01T00:00:00+00:00')"
    ).lastrowid
    aid = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, public_url) "
        "VALUES (?,?,?,?)",
        (f"h{pid}", "image", f"{pid}.jpg", "https://a.test/x.jpg"),
    ).lastrowid
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)", (pid, aid)
    )
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, channel_id)
    )
    conn.commit()
    return pid


def test_posts_gains_archived_at(conn):
    assert "archived_at" in cols(conn, "posts")


def test_existing_posts_are_not_archived(conn):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','single')"
    ).lastrowid
    conn.commit()
    assert conn.execute(
        "SELECT archived_at FROM posts WHERE id=?", (pid,)
    ).fetchone()[0] is None


def test_archiving_alone_does_not_hide_a_post_from_auto_fill(conn):
    """The deliberate boundary. Read the module docstring before changing this."""
    from worker import db

    cid = _channel(conn)
    pid = _ready_post(conn, cid)
    conn.execute(
        "UPDATE posts SET archived_at='2026-08-20T00:00:00+00:00' WHERE id=?", (pid,)
    )
    conn.commit()

    ch = db.get_channel(conn, cid)
    picked = [r["post_id"] for r in eligible_candidates(conn, ch, NOW, 10, surface="feed")]
    assert pid in picked, (
        "archived_at is a dashboard visibility flag; content_status is the automation "
        "gate. If auto-fill should skip archived posts, that is a design change — say so "
        "in docs/design-archive-library.md rather than making this test pass."
    )


def test_content_status_is_still_what_stops_auto_fill(conn):
    """The other half: the switch the Archive dialog sets really does stop selection."""
    from worker import db

    cid = _channel(conn)
    pid = _ready_post(conn, cid)
    conn.execute(
        "UPDATE posts SET archived_at='2026-08-20T00:00:00+00:00', content_status='retired' "
        "WHERE id=?",
        (pid,),
    )
    conn.commit()

    ch = db.get_channel(conn, cid)
    assert pid not in [
        r["post_id"] for r in eligible_candidates(conn, ch, NOW, 10, surface="feed")
    ]
