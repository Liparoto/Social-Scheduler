"""0010 adds a nullable `color_hue` column to `channels` via a plain ALTER TABLE.

Unlike 0008/0009, this migration does NOT rebuild the table — there is no CHECK to
widen, so no cascade-delete risk exists. These tests are the additive-migration
equivalent of test_migration_0009.py, with the rebuild-specific assertions dropped
(no channels_new, no rollback-of-a-rebuild, no foreign_key CASCADE risk to prove
against) and a couple of column-specific assertions added instead.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"
TARGET = "0010_channel_colour.sql"


def _migrations_before_target() -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name)
    return [f for f in files if f.name < TARGET]


@pytest.fixture
def seeded_db(tmp_path):
    """A DB at migration 0009 with one seeded channel row."""
    path = tmp_path / "pre0010.db"
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
    """Apply 0010 exactly the way migrate.py does: BEGIN then executescript."""
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


def test_new_column_exists_and_defaults_to_null(seeded_db):
    conn = _apply_target(seeded_db)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(channels)")}
    assert "color_hue" in cols

    value = conn.execute(
        "SELECT color_hue FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()[0]
    conn.close()
    assert value is None


def test_an_integer_hue_can_be_stored_and_read_back(seeded_db):
    conn = _apply_target(seeded_db)
    conn.execute(
        "UPDATE channels SET color_hue = 210 WHERE account_name = 'SEED CH'"
    )
    conn.commit()
    value = conn.execute(
        "SELECT color_hue FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()[0]
    conn.close()
    assert value == 210


def test_foreign_keys_are_intact(seeded_db):
    conn = _apply_target(seeded_db)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()
