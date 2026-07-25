#!/usr/bin/env python3
"""
migrate.py — apply pending SQL migrations to this install's SQLite database.

The database schema lives in /migrations as plain, numbered .sql files. This script
applies any that haven't been applied yet, in order, each in its own transaction, and
records them in a `schema_migrations` table so re-running is safe (idempotent).

Uses ONLY the Python standard library, so a fresh clone can run it before setting up
any virtualenv:

    python3 migrate.py            # apply pending migrations
    python3 migrate.py --status   # show applied vs pending, apply nothing

The DB path comes from DATABASE_PATH in .env (or the environment), defaulting to
./data/socialscheduler.db. Each install migrates its OWN database.
"""

import os
import sys
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
MIGRATIONS_DIR = REPO_ROOT / "migrations"
DEFAULT_DB_PATH = REPO_ROOT / "data" / "socialscheduler.db"


def load_env(env_path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines) so we don't depend on python-dotenv here.

    Does not override variables already set in the real environment.
    """
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_db_path() -> Path:
    raw = os.environ.get("DATABASE_PATH")
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (REPO_ROOT / p)
    return DEFAULT_DB_PATH


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    # WAL persists on the file; foreign_keys is per-connection and must be set every time.
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    conn.commit()


def applied_versions(conn: sqlite3.Connection) -> set:
    return {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}


def migration_files() -> list:
    if not MIGRATIONS_DIR.exists():
        return []
    return sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)


def main() -> int:
    status_only = "--status" in sys.argv

    load_env(REPO_ROOT / ".env")
    db_path = resolve_db_path()
    conn = connect(db_path)
    ensure_migrations_table(conn)

    done = applied_versions(conn)
    files = migration_files()
    pending = [f for f in files if f.name not in done]

    print(f"Database : {db_path}")
    print(f"Applied  : {len(done)} migration(s)")
    print(f"Pending  : {len(pending)} migration(s)")

    if status_only:
        for f in files:
            mark = "✓" if f.name in done else "•"
            print(f"  {mark} {f.name}")
        conn.close()
        return 0

    if not pending:
        print("Nothing to do — schema is up to date.")
        conn.close()
        return 0

    for f in pending:
        sql = f.read_text()
        print(f"Applying {f.name} ...", end=" ")
        try:
            conn.execute("BEGIN;")
            # NOTE: sqlite3's executescript() issues an implicit COMMIT before it runs,
            # which ends the BEGIN above — so by the time the migration's SQL runs, this
            # connection is back in autocommit mode and every statement in the script
            # commits individually. Migration scripts may therefore open and manage their
            # own transaction (see 0008_platform_foundation.sql for an example: it needs
            # BOTH an explicit BEGIN/COMMIT around its DDL for atomicity AND a
            # `PRAGMA foreign_keys = OFF` outside any transaction, because that PRAGMA is
            # a silent no-op while a transaction is open. If this BEGIN is ever changed to
            # keep a real transaction open across executescript(), 0008's foreign_keys
            # PRAGMA would stop taking effect with NO error raised, and cascading deletes
            # would fire silently — re-check 0008 against any change here.
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO schema_migrations (version) VALUES (?);", (f.name,)
            )
            conn.commit()
            print("done.")
        except Exception as exc:  # noqa: BLE001 — surface the real error, don't swallow it
            conn.rollback()
            print("FAILED.")
            print(f"  Error: {exc}", file=sys.stderr)
            conn.close()
            return 1

    print("All pending migrations applied.")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
