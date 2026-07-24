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
    never attempted or past their retry backoff. Ordered oldest-first (fair queueing).
    """
    return conn.execute(
        """
        SELECT * FROM publications
        WHERE status = 'scheduled'
          AND scheduled_at <= ?
          AND is_held = 0
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY scheduled_at ASC
        """,
        (now_iso, now_iso),
    ).fetchall()


def get_channel(conn: sqlite3.Connection, channel_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM channels WHERE id = ?", (channel_id,)
    ).fetchone()


def get_post(conn: sqlite3.Connection, post_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()


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
