"""Migration 0028: auto-fill config moves from columns on channels/channel_groups to
one row per (owner, surface) in autofill_lanes.

See docs/design-autofill-lanes.md §3. These tests pin the three things that make the
move safe: the ownership constraint actually bites, cascade delete cleans up lanes,
and the backfill reproduces every existing unit's settings exactly as a feed lane.
"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


@pytest.fixture
def pre_0028(tmp_path):
    """A DB migrated to 0027 only, so rows can be seeded BEFORE 0028's backfill runs.

    The shared `conn` fixture replays every migration including 0028, which leaves no
    window to insert the pre-existing rows the backfill is supposed to find. This
    fixture stops one migration short on purpose.
    """
    path = tmp_path / "pre.db"
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for sql_file in sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name):
        if sql_file.name.startswith("0028"):
            break
        conn.executescript(sql_file.read_text())
    conn.commit()
    return conn


def apply_0028(conn):
    conn.executescript((MIGRATIONS_DIR / "0028_autofill_lanes.sql").read_text())
    conn.commit()


def test_table_and_columns_exist(conn):
    assert cols(conn, "autofill_lanes") == {
        "id", "channel_id", "group_id", "surface", "enabled",
        "cadence_config", "min_queue_depth", "target_queue_depth",
        "reuse_min_age_days",
    }


def test_a_lane_must_have_exactly_one_owner(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    gid = conn.execute(
        "INSERT INTO channel_groups (name) VALUES ('G')"
    ).lastrowid
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO autofill_lanes (channel_id, group_id, surface) VALUES (?,?,'feed')",
            (cid, gid),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO autofill_lanes (surface) VALUES ('feed')")


def test_one_lane_per_owner_per_surface(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    conn.execute(
        "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'feed')", (cid,)
    )
    conn.execute(
        "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'story')", (cid,)
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'feed')", (cid,)
        )


def test_deleting_the_owner_takes_its_lanes(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    conn.execute(
        "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'story')", (cid,)
    )
    conn.commit()
    conn.execute("DELETE FROM channels WHERE id = ?", (cid,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM autofill_lanes").fetchone()[0] == 0


def test_backfill_reproduces_a_group_as_a_feed_lane(pre_0028):
    conn = pre_0028
    gid = conn.execute(
        """INSERT INTO channel_groups
             (name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES ('Personal','America/New_York',1,'{"days":["mon"],"time":"18:00"}',3,7,90)"""
    ).lastrowid
    conn.commit()
    apply_0028(conn)

    lane = conn.execute(
        "SELECT * FROM autofill_lanes WHERE group_id = ?", (gid,)
    ).fetchone()
    assert lane["surface"] == "feed"
    assert lane["enabled"] == 1
    assert lane["cadence_config"] == '{"days":["mon"],"time":"18:00"}'
    assert lane["min_queue_depth"] == 3
    assert lane["target_queue_depth"] == 7
    assert lane["reuse_min_age_days"] == 90
    assert lane["channel_id"] is None


def test_backfill_covers_ungrouped_channels_and_skips_grouped_ones(pre_0028):
    conn = pre_0028
    gid = conn.execute("INSERT INTO channel_groups (name) VALUES ('G')").lastrowid
    solo = conn.execute(
        """INSERT INTO channels (platform, account_name, autofill_enabled, target_queue_depth)
           VALUES ('instagram','Solo',1,5)"""
    ).lastrowid
    member = conn.execute(
        """INSERT INTO channels (platform, account_name, group_id, autofill_enabled)
           VALUES ('instagram','Member',?,1)""",
        (gid,),
    ).lastrowid
    conn.commit()
    apply_0028(conn)

    assert conn.execute(
        "SELECT target_queue_depth FROM autofill_lanes WHERE channel_id = ?", (solo,)
    ).fetchone()[0] == 5
    assert conn.execute(
        "SELECT COUNT(*) FROM autofill_lanes WHERE channel_id = ?", (member,)
    ).fetchone()[0] == 0, "a grouped channel fills through its group, so it gets no lane"


def test_backfill_creates_no_story_lanes(pre_0028):
    conn = pre_0028
    conn.execute(
        "INSERT INTO channels (platform, account_name, autofill_enabled) VALUES ('instagram','IG',1)"
    )
    conn.commit()
    apply_0028(conn)
    assert conn.execute(
        "SELECT COUNT(*) FROM autofill_lanes WHERE surface != 'feed'"
    ).fetchone()[0] == 0, "a story lane is opt-in; the migration must not invent one"
