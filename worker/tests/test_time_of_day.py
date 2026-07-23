"""Band-time config parsing, per-post band lookup, and slot-time resolution."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from worker.time_of_day import (
    BAND_ORDER,
    band_times,
    parse_hhmm,
    post_bands,
    resolve_slot_time,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


class _Cfg:
    tod_morning = "09:00"
    tod_afternoon = "13:00"
    tod_evening = "18:00"


def test_parse_hhmm_ok_and_bad():
    assert parse_hhmm("09:00") == (9, 0)
    assert parse_hhmm("18:30") == (18, 30)
    with pytest.raises(ValueError):
        parse_hhmm("25:00")


def test_band_times_maps_three_specific_bands():
    bt = band_times(_Cfg())
    assert bt == {"morning": (9, 0), "afternoon": (13, 0), "evening": (18, 0)}


def test_resolve_earliest_specific_band_wins():
    bt = band_times(_Cfg())
    assert resolve_slot_time({"evening", "morning"}, bt, (17, 0)) == (9, 0)
    assert resolve_slot_time({"evening"}, bt, (17, 0)) == (18, 0)


def test_resolve_anytime_and_untagged_use_cadence_time():
    bt = band_times(_Cfg())
    assert resolve_slot_time({"anytime"}, bt, (17, 0)) == (17, 0)
    assert resolve_slot_time(set(), bt, (17, 0)) == (17, 0)
    # anytime alongside a specific band -> the specific band still wins.
    assert resolve_slot_time({"anytime", "afternoon"}, bt, (17, 0)) == (13, 0)


def _db(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "d.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for name in ("0001_init.sql", "0002_content_model.sql", "0003_tag_taxonomy.sql"):
        conn.executescript((MIG / name).read_text())
    conn.commit()
    return conn


def test_post_bands_returns_only_time_of_day_tags(tmp_path):
    conn = _db(tmp_path)
    conn.execute("INSERT INTO posts (caption, post_type) VALUES ('x','single')")
    conn.execute("INSERT INTO tags (name, kind) VALUES ('travel','topic')")
    # Attach 'travel' (topic) + 'morning' (time_of_day) to post 1.
    conn.execute(
        "INSERT INTO post_tags (post_id, tag_id) "
        "SELECT 1, id FROM tags WHERE name IN ('travel','morning')"
    )
    conn.commit()
    assert post_bands(conn, 1) == {"morning"}


def test_band_order_is_earliest_first():
    assert BAND_ORDER == ("morning", "afternoon", "evening")
