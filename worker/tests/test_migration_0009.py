"""0009 rebuilds `channels` to widen its platform CHECK to add 'discord' and 'telegram'.

SQLite cannot ALTER a CHECK, so the table must be rebuilt — and DROP TABLE with foreign
keys ENABLED performs an implicit delete that fires ON DELETE CASCADE. A naive rebuild
therefore reports success while silently deleting every dependent row. These tests exist
to make sure that never ships. Modeled directly on test_migration_0008.py.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"
TARGET = "0009_discord_telegram.sql"

# Every table with a cascading FK onto channels (3 edges).
CHILD_TABLES = [
    "publications",
    "publish_limits",
    "post_targets",
]


def _migrations_before_target() -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name)
    return [f for f in files if f.name < TARGET]


def _counts(conn) -> dict[str, int]:
    return {
        t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in CHILD_TABLES + ["channels"]
    }


def _seed(conn) -> None:
    """Insert exactly one recognisable row into channels and every cascading child."""
    cur = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram', 'SEED CH')"
    )
    channel_id = cur.lastrowid

    cur = conn.execute("INSERT INTO posts (post_type) VALUES ('single')")
    post_id = cur.lastrowid

    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?, ?, ?)",
        (post_id, channel_id, "2026-01-01T00:00:00Z"),
    )

    conn.execute(
        "INSERT INTO publish_limits (channel_id, checked_at) VALUES (?, ?)",
        (channel_id, "2026-01-01T00:00:00Z"),
    )

    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)",
        (post_id, channel_id),
    )


@pytest.fixture
def seeded_db(tmp_path):
    """A DB at migration 0008 with one row in every cascading child of channels."""
    path = tmp_path / "pre0009.db"
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON;")
    for f in _migrations_before_target():
        conn.executescript(f.read_text())
    conn.commit()

    _seed(conn)

    conn.commit()
    conn.close()
    return path


def _apply_target(path: Path) -> sqlite3.Connection:
    """Apply 0009 exactly the way migrate.py does: BEGIN then executescript."""
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("BEGIN;")
    conn.executescript((MIGRATIONS_DIR / TARGET).read_text())
    conn.commit()
    return conn


def test_seed_is_not_vacuous(seeded_db):
    # If this fails, every other test here is meaningless.
    conn = sqlite3.connect(str(seeded_db))
    before = _counts(conn)
    conn.close()
    for table, n in before.items():
        assert n >= 1, f"{table} was not seeded — the other assertions would be vacuous"


def test_every_child_row_survives_the_rebuild(seeded_db):
    conn = sqlite3.connect(str(seeded_db))
    before = _counts(conn)
    conn.close()

    conn = _apply_target(seeded_db)
    after = _counts(conn)
    conn.close()

    assert after == before, (
        "the rebuild changed row counts — a cascade fired. "
        f"before={before} after={after}"
    )


def test_foreign_keys_are_intact_and_re_enabled(seeded_db):
    conn = _apply_target(seeded_db)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    # Enforcement genuinely works afterwards, not just the flag.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (99999, 99999, '2026-01-01T00:00:00Z')"
        )
    conn.close()


def test_the_widened_values_are_accepted(seeded_db):
    conn = _apply_target(seeded_db)
    conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('discord', 'D')"
    )
    conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('telegram', 'T')"
    )
    conn.commit()
    conn.close()


def test_bogus_values_are_still_rejected(seeded_db):
    conn = _apply_target(seeded_db)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO channels (platform, account_name) VALUES ('mastodon', 'M')"
        )
    conn.close()


def test_the_other_constraints_and_defaults_survive(seeded_db):
    """The rebuild must change ONLY the platform enum."""
    conn = _apply_target(seeded_db)
    cur = conn.execute("INSERT INTO channels (platform, account_name) VALUES ('instagram', 'D2')")
    row = conn.execute(
        "SELECT timezone, requires_approval, reuse_min_age_days, is_active, created_at FROM channels WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    assert row[0] == "UTC"
    assert row[1] == 0
    assert row[2] == 180
    assert row[3] == 1
    assert row[4] is not None
    conn.close()


def test_column_definitions_are_unchanged(seeded_db):
    """No column added, removed, renamed, reordered, retyped, or changed NOT NULL/DEFAULT.

    Compares full PRAGMA table_info() rows (cid, name, type, notnull, dflt_value, pk),
    not just names, so a lost NOT NULL or DEFAULT would fail this test. Note:
    PRAGMA table_info doesn't report CHECK constraints, so this doesn't cover those —
    the CHECK behavior itself is exercised by test_bogus_values_are_still_rejected and
    test_the_widened_values_are_accepted.
    """
    conn = sqlite3.connect(str(seeded_db))
    before = [tuple(r) for r in conn.execute("PRAGMA table_info(channels)")]
    conn.close()
    conn = _apply_target(seeded_db)
    after = [tuple(r) for r in conn.execute("PRAGMA table_info(channels)")]
    conn.close()
    assert after == before
    assert len(after) == 18


def test_no_leftover_scratch_tables(seeded_db):
    conn = _apply_target(seeded_db)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "channels_new" not in names
    conn.close()


def test_a_failure_partway_through_rolls_back_cleanly(seeded_db):
    """A crash after the DROP TABLE must not leave `channels` gone.

    Injects a guaranteed failure between `DROP TABLE channels` and the RENAME that
    follows it. Applied the same way migrate.py applies it (BEGIN then executescript()),
    this must raise — and, critically, `channels` must still exist afterwards with its
    original seeded row intact.
    """
    original_sql = (MIGRATIONS_DIR / TARGET).read_text()
    assert "ALTER TABLE channels_new RENAME TO channels;" in original_sql

    doctored_sql = original_sql.replace(
        "ALTER TABLE channels_new RENAME TO channels;",
        "INSERT INTO this_table_does_not_exist (x) VALUES (1);\n"
        "ALTER TABLE channels_new RENAME TO channels;",
    )
    assert doctored_sql != original_sql

    conn = sqlite3.connect(str(seeded_db))
    before_row = conn.execute(
        "SELECT platform, account_name FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()
    assert before_row is not None, "seed fixture broke — nothing to prove survived"

    conn = sqlite3.connect(str(seeded_db))
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("BEGIN;")
    with pytest.raises(sqlite3.OperationalError):
        conn.executescript(doctored_sql)
    conn.rollback()

    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "channels" in names, "channels was left dropped after a failed migration"
    assert "channels_new" not in names, "a scratch table was left behind after rollback"

    after_row = conn.execute(
        "SELECT platform, account_name FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()
    assert after_row == before_row, "the seeded channels row did not survive the rollback"
