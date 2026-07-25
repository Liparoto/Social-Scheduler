"""0008 rebuilds `channels` and `posts` to widen two enum CHECKs.

SQLite cannot ALTER a CHECK, so the tables must be rebuilt — and DROP TABLE with foreign
keys ENABLED performs an implicit delete that fires ON DELETE CASCADE. A naive rebuild
therefore reports success while silently deleting every dependent row (measured: a seeded
publications row went 1 -> 0). These tests exist to make sure that never ships.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"
TARGET = "0008_platform_foundation.sql"

# Every table with a cascading FK onto channels or posts (9 edges, 7 tables).
# NOTE: post_metrics is NOT listed here. It has no direct FK onto channels/posts — it
# cascades from publications (post_metrics -> publications -> posts/channels), so a wipe
# is only caught transitively today, via publications being wiped. If a future migration
# touches publications directly (not channels/posts), this list won't cover post_metrics
# and it should be added explicitly.
CHILD_TABLES = [
    "post_assets",
    "publications",
    "post_tags",
    "publish_limits",
    "post_periods",
    "post_targets",
    "caption_variants",
]


def _migrations_before_target() -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name)
    return [f for f in files if f.name < TARGET]


def _counts(conn) -> dict[str, int]:
    return {
        t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in CHILD_TABLES + ["channels", "posts"]
    }


def _seed(conn) -> None:
    """Insert exactly one recognisable row into every table involved in the rebuild.

    Values chosen to be identifiable (e.g. account_name='SEED CH') so a surviving row
    is unambiguous. Only NOT NULL / no-default columns are supplied; everything else
    relies on the schema's own defaults (also exercised elsewhere by
    test_the_other_constraints_and_defaults_survive).
    """
    cur = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram', 'SEED CH')"
    )
    channel_id = cur.lastrowid

    cur = conn.execute("INSERT INTO posts (post_type) VALUES ('single')")
    post_id = cur.lastrowid

    cur = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path) "
        "VALUES ('seedhash123', 'image', '/seed/asset.jpg')"
    )
    asset_id = cur.lastrowid

    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, 0)",
        (post_id, asset_id),
    )

    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?, ?, ?)",
        (post_id, channel_id, "2026-01-01T00:00:00Z"),
    )

    cur = conn.execute("INSERT INTO tags (name) VALUES ('SEED TAG')")
    tag_id = cur.lastrowid
    conn.execute(
        "INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)", (post_id, tag_id)
    )

    conn.execute(
        "INSERT INTO publish_limits (channel_id, checked_at) VALUES (?, ?)",
        (channel_id, "2026-01-01T00:00:00Z"),
    )

    cur = conn.execute("INSERT INTO periods (name) VALUES ('SEED PERIOD')")
    period_id = cur.lastrowid
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?, ?, 'green')",
        (post_id, period_id),
    )

    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)",
        (post_id, channel_id),
    )

    conn.execute(
        "INSERT INTO caption_variants (post_id, body) VALUES (?, 'SEED CAPTION')",
        (post_id,),
    )


@pytest.fixture
def seeded_db(tmp_path):
    """A DB at migration 0007 with one row in every cascading child table.

    Seeding is deliberately verified (see test_seed_is_not_vacuous) so this fixture
    can't quietly produce an empty DB and make the real assertions meaningless.
    """
    path = tmp_path / "pre0008.db"
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
    """Apply 0008 exactly the way migrate.py does: BEGIN then executescript."""
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
        "INSERT INTO channels (platform, account_name) VALUES ('threads', 'T')"
    )
    conn.execute("INSERT INTO posts (post_type) VALUES ('text')")
    conn.commit()
    conn.close()


def test_bogus_values_are_still_rejected(seeded_db):
    conn = _apply_target(seeded_db)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO channels (platform, account_name) VALUES ('mastodon', 'M')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type) VALUES ('bogus')")
    conn.close()


def test_the_other_constraints_and_defaults_survive(seeded_db):
    """The rebuild must change ONLY the two target enums."""
    conn = _apply_target(seeded_db)
    # Other CHECKs still enforced.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type, status) VALUES ('single', 'bogus')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type, content_kind) VALUES ('single', 'bogus')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type, content_status) VALUES ('single', 'bogus')")
    # Defaults still applied.
    cur = conn.execute("INSERT INTO channels (platform, account_name) VALUES ('instagram', 'D')")
    row = conn.execute(
        "SELECT timezone, requires_approval, reuse_min_age_days, is_active, created_at FROM channels WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    assert row[0] == "UTC"
    assert row[1] == 0
    assert row[2] == 180
    assert row[3] == 1
    assert row[4] is not None
    p = conn.execute("INSERT INTO posts (post_type) VALUES ('single')")
    prow = conn.execute(
        "SELECT status, content_kind, content_status, cooldown_days FROM posts WHERE id = ?",
        (p.lastrowid,),
    ).fetchone()
    assert prow == ("draft", "evergreen", "draft", None)
    conn.close()


def test_column_definitions_are_unchanged(seeded_db):
    """No column added, removed, renamed, reordered, retyped, or changed NOT NULL/DEFAULT.

    Compares full PRAGMA table_info() rows (cid, name, type, notnull, dflt_value, pk),
    not just names, so a lost NOT NULL or DEFAULT would fail this test. Note:
    PRAGMA table_info doesn't report CHECK constraints, so this doesn't cover those —
    the CHECK behavior itself is exercised by test_bogus_values_are_still_rejected and
    test_the_other_constraints_and_defaults_survive.
    """
    conn = sqlite3.connect(str(seeded_db))
    before = {
        t: [tuple(r) for r in conn.execute(f"PRAGMA table_info({t})")]
        for t in ("channels", "posts")
    }
    conn.close()
    conn = _apply_target(seeded_db)
    after = {
        t: [tuple(r) for r in conn.execute(f"PRAGMA table_info({t})")]
        for t in ("channels", "posts")
    }
    conn.close()
    assert after == before


def test_no_leftover_scratch_tables(seeded_db):
    conn = _apply_target(seeded_db)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "channels_new" not in names
    assert "posts_new" not in names
    conn.close()


def test_a_failure_partway_through_rolls_back_cleanly(seeded_db):
    """A crash after the first DROP TABLE must not leave `channels` gone.

    Simulates the reviewer's failure injection: the migration's SQL is doctored so a
    statement fails AFTER `channels` has already been dropped and rebuilt, but before the
    script finishes. Applied the same way migrate.py applies it (BEGIN then
    executescript()), this must raise — and, critically, `channels` must still exist
    afterwards with its original seeded row intact. Before the fix (no explicit BEGIN/
    COMMIT inside the .sql file), executescript() autocommits every statement
    individually, so `channels` stays dropped/renamed away and the row is lost even
    though the script as a whole "failed".
    """
    original_sql = (MIGRATIONS_DIR / TARGET).read_text()
    assert "ALTER TABLE channels_new RENAME TO channels;" in original_sql

    # Inject a guaranteed failure between `DROP TABLE channels` and the RENAME that
    # follows it — this is the exact line the reviewer injected a failure at. Without
    # atomicity, `channels` is gone (dropped) and `channels_new` is left orphaned,
    # un-renamed, by the time the script raises.
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
