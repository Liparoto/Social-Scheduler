#!/usr/bin/env python3
"""
inspect_db.py — quick look at this install's database, plus a test-data seeder.

    python3 inspect_db.py            # list tables, row counts, and key PRAGMAs
    python3 inspect_db.py --seed     # insert a sample channel + asset (for local testing)

Standard library only. Reuses migrate.py's env loading / DB path resolution.
"""

import os
import sys
import sqlite3

from migrate import load_env, resolve_db_path, REPO_ROOT


def connect() -> sqlite3.Connection:
    load_env(REPO_ROOT / ".env")
    conn = sqlite3.connect(str(resolve_db_path()))
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    return conn


def show(conn: sqlite3.Connection) -> None:
    journal = conn.execute("PRAGMA journal_mode;").fetchone()[0]
    fk = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
    print(f"DB       : {resolve_db_path()}")
    print(f"journal  : {journal}   foreign_keys: {fk}")
    print("-" * 48)

    tables = [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name;"
        )
    ]
    if not tables:
        print("(no tables — run: python3 migrate.py)")
        return
    width = max(len(t) for t in tables)
    for t in tables:
        count = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"  {t.ljust(width)}  {count:>6} row(s)")


def seed(conn: sqlite3.Connection) -> None:
    """Insert a harmless sample channel + asset so downstream phases have something to read."""
    default_tz = os.environ.get("DEFAULT_TIMEZONE", "UTC")
    conn.execute(
        """
        INSERT INTO channels (platform, account_name, business_label, timezone)
        VALUES ('instagram', 'Test Account', 'Sandbox', ?)
        """,
        (default_tz,),
    )
    conn.execute(
        """
        INSERT INTO assets (content_hash, media_kind, original_filename, storage_path)
        VALUES ('seedhash-0000000000000000', 'image', 'sample.jpg', 'assets/sample.jpg')
        """
    )
    conn.commit()
    print("Seeded 1 channel + 1 asset.")


def main() -> int:
    conn = connect()
    if "--seed" in sys.argv:
        seed(conn)
        print("-" * 48)
    show(conn)
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
