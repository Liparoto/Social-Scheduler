"""0012 adds the four avatar columns to `channels` via plain ALTER TABLE statements.

Additive like 0010 (no CHECK to widen, so no table rebuild and no cascade-delete
risk). These tests prove the existing rows survive untouched, the new columns exist
with the right defaults, and a path round-trips.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"
TARGET = "0012_channel_avatar.sql"


def _migrations_before_target() -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name)
    return [f for f in files if f.name < TARGET]


@pytest.fixture
def seeded_db(tmp_path):
    """A DB at migration 0011 with one seeded channel row."""
    path = tmp_path / "pre0012.db"
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON;")
    for f in _migrations_before_target():
        conn.executescript(f.read_text())
    conn.commit()
    conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram', 'SEED CH')"
    )
    conn.commit()
    conn.close()
    return path


def _apply_target(path: Path) -> sqlite3.Connection:
    """Apply 0012 exactly the way migrate.py does: BEGIN then executescript."""
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("BEGIN;")
    conn.executescript((MIGRATIONS_DIR / TARGET).read_text())
    conn.commit()
    return conn


def test_seed_is_not_vacuous(seeded_db):
    conn = sqlite3.connect(str(seeded_db))
    count = conn.execute("SELECT COUNT(*) FROM channels").fetchone()[0]
    conn.close()
    assert count == 1, "channels was not seeded — the other assertions would be vacuous"


def test_channel_row_survives_with_values_intact(seeded_db):
    conn = sqlite3.connect(str(seeded_db))
    before = conn.execute(
        "SELECT id, platform, account_name FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()

    conn = _apply_target(seeded_db)
    after = conn.execute(
        "SELECT id, platform, account_name FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()

    assert after == before


def test_new_columns_exist_with_expected_defaults(seeded_db):
    conn = _apply_target(seeded_db)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(channels)")}
    assert {"avatar_path", "avatar_fetched_at", "avatar_refresh_requested",
            "avatar_error"} <= cols

    row = conn.execute(
        "SELECT avatar_path, avatar_fetched_at, avatar_refresh_requested, avatar_error"
        " FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()
    # An existing row must read as "no photo yet, nothing requested, no error" so the
    # worker's selection rule picks it up on the next cycle rather than skipping it.
    assert row == (None, None, 0, None)


def test_avatar_path_round_trips(seeded_db):
    conn = _apply_target(seeded_db)
    conn.execute(
        "UPDATE channels SET avatar_path = 'avatars/1.jpg' WHERE account_name = 'SEED CH'"
    )
    conn.commit()
    value = conn.execute(
        "SELECT avatar_path FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()[0]
    conn.close()
    assert value == "avatars/1.jpg"


def test_foreign_keys_are_intact(seeded_db):
    conn = _apply_target(seeded_db)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()
