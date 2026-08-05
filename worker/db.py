"""Database access for the worker.

Thin helpers over sqlite3. Every connection enables WAL + foreign keys (foreign_keys
is per-connection and must be set each time). Row factory returns dict-like rows.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path


def connect(database_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(database_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def fetch_due_publications(conn: sqlite3.Connection, now_iso: str) -> list[sqlite3.Row]:
    """Publications that are ready to be worked: scheduled, past their time, and either
    never attempted or past their retry backoff. Ordered oldest-first (fair queueing),
    with id as an EXPLICIT tie-break: the slides of one Instagram Story all share a
    scheduled_at and must publish in slide order. Slides are inserted in sort_order, so
    ascending id is slide order. Without the tie-break that ordering is left to the query
    plan — today it happens to come out right, which is luck, not a guarantee.
    """
    return conn.execute(
        """
        SELECT * FROM publications
        WHERE status = 'scheduled'
          AND scheduled_at <= ?
          AND is_held = 0
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY scheduled_at ASC, id ASC
        """,
        (now_iso, now_iso),
    ).fetchall()


def get_channel(conn: sqlite3.Connection, channel_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM channels WHERE id = ?", (channel_id,)
    ).fetchone()


def get_post(conn: sqlite3.Connection, post_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()


def get_asset(conn: sqlite3.Connection, asset_id: int) -> sqlite3.Row | None:
    """Look up a single asset by id. Used to resolve a Reel's cover_asset_id — the id can
    be dangling (the referenced row deleted out from under it), so callers must handle
    None rather than assume the FK always resolves.
    """
    return conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()


def get_ordered_assets(conn: sqlite3.Connection, post_id: int) -> list[sqlite3.Row]:
    """Assets for a post, in carousel/child order."""
    return conn.execute(
        """
        SELECT a.*, pa.sort_order
        FROM post_assets pa
        JOIN assets a ON a.id = pa.asset_id
        WHERE pa.post_id = ?
        ORDER BY pa.sort_order ASC
        """,
        (post_id,),
    ).fetchall()


def claim_publication(conn: sqlite3.Connection, publication_id: int, now_iso: str) -> bool:
    """Atomically take ownership of a due publication. True only if THIS call won it.

    The WHERE clause is the entire point: the row moves to 'publishing' only from
    'scheduled', so of any number of concurrent callers exactly one can succeed. SQLite
    applies a single UPDATE atomically, so no explicit transaction is needed for the
    test-and-set itself.

    Claim BEFORE doing any work, never after. publish_one used to load the post and
    assets and make an HTTP quota call while the row still read 'scheduled', and:

      * the dashboard's merge/delete guards allow 'scheduled' through, so a merge could
        CASCADE-delete the row mid-send — the worker's later writes then updated 0 rows
        in silence, leaving a real Instagram post with no record of it;
      * nothing stops two worker daemons running at once, and both would fetch the same
        'scheduled' row and publish it.

    is_held is re-checked here even though fetch_due_publications already filters it —
    a hold applied between the fetch and the claim should still win.
    """
    cur = conn.execute(
        "UPDATE publications SET status = 'publishing', updated_at = ? "
        "WHERE id = ? AND status = 'scheduled' AND is_held = 0",
        (now_iso, publication_id),
    )
    conn.commit()
    return cur.rowcount == 1


def update_publication(conn: sqlite3.Connection, publication_id: int, **fields) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [publication_id]
    conn.execute(f"UPDATE publications SET {cols} WHERE id = ?", values)
    conn.commit()


def update_post(conn: sqlite3.Connection, post_id: int, **fields) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [post_id]
    conn.execute(f"UPDATE posts SET {cols} WHERE id = ?", values)
    conn.commit()


def record_publish_limit(
    conn: sqlite3.Connection,
    channel_id: int,
    quota_usage: int | None,
    quota_total: int | None,
    quota_duration: int | None,
    checked_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO publish_limits
            (channel_id, quota_usage, quota_total, quota_duration, checked_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (channel_id, quota_usage, quota_total, quota_duration, checked_at),
    )
    conn.commit()


def write_heartbeat(conn: sqlite3.Connection, seen_at_iso: str) -> None:
    """Stamp the worker's liveness. The dashboard reads this to know the worker is running.

    Single-row table (id = 1); upsert so the first poll inserts and every poll after updates.
    """
    conn.execute(
        """
        INSERT INTO worker_heartbeat (id, last_seen_at) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        """,
        (seen_at_iso,),
    )
    conn.commit()
