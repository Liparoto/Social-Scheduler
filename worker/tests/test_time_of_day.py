"""Band-time config parsing, per-post band lookup, and band derivation/matching."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from worker.time_of_day import (
    BAND_ORDER,
    band_times,
    derive_band,
    parse_hhmm,
    post_allows_band,
    post_bands,
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


def test_derive_band_exact_hits_and_nearest():
    bt = band_times(_Cfg())
    assert derive_band(9, 0, bt) == "morning"
    assert derive_band(13, 0, bt) == "afternoon"
    assert derive_band(18, 0, bt) == "evening"
    # 12:30 is 30 min from 13:00 and 210 from 09:00 — this install's live cadence time.
    assert derive_band(12, 30, bt) == "afternoon"


def test_derive_band_does_not_wrap_around_midnight():
    bt = band_times(_Cfg())
    assert derive_band(23, 0, bt) == "evening"   # 300 min from 18:00, 840 from 09:00
    assert derive_band(2, 0, bt) == "morning"    # 420 min from 09:00, 960 from 18:00


def test_derive_band_breaks_a_tie_toward_the_earlier_band():
    bt = band_times(_Cfg())
    assert derive_band(11, 0, bt) == "morning"   # exactly 120 min from 09:00 and from 13:00


def test_derive_band_follows_a_non_default_config():
    class Late:
        tod_morning = "06:00"
        tod_afternoon = "14:00"
        tod_evening = "22:00"

    bt = band_times(Late())
    assert derive_band(9, 0, bt) == "morning"
    assert derive_band(19, 0, bt) == "evening"   # 180 from 22:00, 300 from 14:00


def test_post_allows_band_untagged_and_anytime_fit_anything():
    assert post_allows_band(set(), "morning") is True
    assert post_allows_band(set(), "evening") is True
    assert post_allows_band({"anytime"}, "evening") is True


def test_post_allows_band_a_specific_band_fits_only_itself():
    assert post_allows_band({"evening"}, "evening") is True
    assert post_allows_band({"evening"}, "morning") is False
    # anytime alongside a specific band does NOT widen it: the specific tag is a request.
    assert post_allows_band({"anytime", "evening"}, "morning") is False


def test_post_allows_band_two_specific_bands_mean_either():
    assert post_allows_band({"morning", "evening"}, "morning") is True
    assert post_allows_band({"morning", "evening"}, "evening") is True
    assert post_allows_band({"morning", "evening"}, "afternoon") is False
