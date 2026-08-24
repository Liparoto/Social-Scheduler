"""0027 rebuilds three tables with cascading children. The risk is silent data loss:
a dropped index, a lost column, or children cascaded away by a DROP TABLE that ran with
foreign keys still enabled. Each assertion below names one of those failures.
"""

import sqlite3
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def _apply_through(conn, last: str) -> None:
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.name > last:
            break
        conn.executescript(path.read_text())


@pytest.fixture
def db(tmp_path):
    conn = sqlite3.connect(tmp_path / "t.db")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _apply_through(conn, "0026_tiktok_account_stats.sql")
    return conn


def test_reel_posts_become_video(db):
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'reel')")
    db.commit()
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    assert db.execute("SELECT post_type FROM posts WHERE id = 1").fetchone()[0] == "video"


def test_reel_surface_is_accepted(db):
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'video')")
    db.execute("INSERT INTO channels (id, platform, account_name) VALUES (1, 'facebook', 'APT')")
    db.execute("INSERT INTO post_targets (post_id, channel_id, surface) VALUES (1, 1, 'reel')")
    db.commit()
    assert db.execute("SELECT COUNT(*) FROM post_targets WHERE surface='reel'").fetchone()[0] == 1


def test_bogus_surface_is_still_refused(db):
    """The CHECK must still bite — a widened constraint that accepts anything is no
    constraint, and would let a typo schedule a send to nowhere."""
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'video')")
    db.execute("INSERT INTO channels (id, platform, account_name) VALUES (1, 'facebook', 'APT')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO post_targets (post_id, channel_id, surface) VALUES (1, 1, 'tiktok')")


def test_children_survive_the_rebuild(db):
    """The whole point of PRAGMA foreign_keys = OFF. With it on, DROP TABLE publications
    cascades and these metric rows vanish silently."""
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'single')")
    db.execute("INSERT INTO channels (id, platform, account_name) VALUES (1, 'facebook', 'APT')")
    db.execute(
        "INSERT INTO publications (id, post_id, channel_id, scheduled_at) "
        "VALUES (9, 1, 1, '2026-01-01T00:00:00Z')"
    )
    db.execute("INSERT INTO post_metrics (publication_id, fetched_at) VALUES (9, '2026-01-01T00:00:00Z')")
    db.commit()

    # The test only proves anything if enforcement is genuinely ON before the rebuild —
    # it currently gets there by luck (0008 and 0014 each end with PRAGMA foreign_keys =
    # ON, and this fixture connection inherits that). Assert the precondition explicitly
    # so the test fails loudly instead of going quiet if that ever stops being true.
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1

    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())

    assert db.execute("SELECT COUNT(*) FROM post_metrics").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM publications WHERE id = 9").fetchone()[0] == 1
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    # Enforcement must also be restored afterwards, not just left off for convenience.
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_indexes_survive_the_rebuild(db):
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    names = {
        r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
        )
    }
    for expected in (
        "idx_publications_channel_sched",
        "idx_publications_retry",
        "idx_publications_post",
        "idx_post_targets_channel",
        "idx_posts_archived_at",
    ):
        assert expected in names, f"{expected} was dropped by the rebuild"
