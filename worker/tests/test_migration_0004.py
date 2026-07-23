"""0004 adds the metrics-refresh flag column additively."""
from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


def _apply(conn, name):
    conn.executescript((MIG / name).read_text())
    conn.commit()


def test_0004_adds_flag_column(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "m.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for name in ("0001_init.sql", "0002_content_model.sql",
                 "0003_tag_taxonomy.sql", "0004_metrics_refresh.sql"):
        _apply(conn, name)

    cols = [r["name"] for r in conn.execute("PRAGMA table_info(publications)").fetchall()]
    assert "metrics_refresh_requested_at" in cols

    # New publications default the flag to NULL.
    conn.execute("INSERT INTO channels (platform, account_name) VALUES ('instagram','C')")
    conn.execute("INSERT INTO posts (post_type) VALUES ('single')")
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at) "
                 "VALUES (1, 1, '2026-01-01T00:00:00+00:00')")
    conn.commit()
    row = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id=1"
    ).fetchone()
    assert row["metrics_refresh_requested_at"] is None
