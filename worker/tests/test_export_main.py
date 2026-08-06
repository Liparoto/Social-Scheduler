"""End-to-end and safety tests for the export entry point."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import zipfile
from datetime import datetime, timezone

import pytest
from openpyxl import load_workbook

from worker.config import Config
from worker.export.__main__ import main, open_readonly, run_export

NOW = datetime(2026, 7, 24, 19, 30, tzinfo=timezone.utc)


def _seed_assets(config, conn):
    """Give every asset row a real file on disk, so copying succeeds."""
    config.asset_storage_dir.mkdir(parents=True, exist_ok=True)
    for row in conn.execute("SELECT id, storage_path FROM assets"):
        path = config.asset_storage_dir / row["storage_path"].split("/")[-1]
        path.write_bytes(f"bytes-{row['id']}".encode())
        conn.execute(
            "UPDATE assets SET storage_path = ? WHERE id = ?", (path.name, row["id"])
        )
    conn.commit()


def test_open_readonly_rejects_writes(db_path):
    conn = open_readonly(db_path)

    with pytest.raises(sqlite3.OperationalError) as excinfo:
        conn.execute("INSERT INTO tags (name) VALUES ('nope')")

    # A missing table would raise the same exception type, so pin down the message
    # too — this confirms query_only is what blocked it, not a schema mistake.
    assert "readonly" in str(excinfo.value).lower()

    conn.close()


def test_export_leaves_the_database_byte_identical(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    before = hashlib.sha256(config.database_path.read_bytes()).hexdigest()

    run_export(config, out_root=tmp_path / "out", now=NOW)

    assert hashlib.sha256(config.database_path.read_bytes()).hexdigest() == before


def test_export_writes_no_token_into_any_file(config, conn, make_publication, tmp_path):
    make_publication(with_token=True)
    _seed_assets(config, conn)
    conn.close()

    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)

    forbidden = (b"tok-123", b"access_token")

    def _assert_clean(blob: bytes, where: str) -> None:
        for needle in forbidden:
            assert needle not in blob, f"token leaked into {where}"

    for path in out_dir.rglob("*"):
        if not path.is_file():
            continue
        # openpyxl DEFLATE-compresses every member of an .xlsx (it's a ZIP archive),
        # so a raw byte scan of the file never sees a token that IS present in a
        # cell — it only sees compressed bytes. Scan each member's decompressed
        # bytes instead for any zip archive; everything else gets the raw scan.
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                for member in archive.namelist():
                    _assert_clean(archive.read(member), f"{path.name}!{member}")
        else:
            _assert_clean(path.read_bytes(), path.name)


def test_main_reports_a_corrupt_database_instead_of_crashing(config, tmp_path, monkeypatch, capsys):
    # A file that exists but is not a valid SQLite database — e.g. a truncated or
    # otherwise corrupted DB file. sqlite3 raises DatabaseError for this, which does
    # NOT subclass OSError, so it must be caught explicitly in main().
    bad_db = tmp_path / "corrupt.db"
    bad_db.write_bytes(b"this is not a database")
    bad_config = Config(**{**config.__dict__, "database_path": bad_db})

    monkeypatch.setattr(Config, "from_env", staticmethod(lambda: bad_config))
    # Don't let a failed run scribble a folder into the real ~/Documents.
    monkeypatch.setattr("worker.export.__main__.DEFAULT_OUT_ROOT", tmp_path / "out")

    exit_code = main([])

    assert exit_code == 1
    out = capsys.readouterr().out
    assert "not modified" in out.lower()


def test_main_returns_1_on_an_unexpected_exception_instead_of_crashing(
    config, tmp_path, monkeypatch, capsys
):
    # Anything not OSError/sqlite3.Error (e.g. openpyxl's IllegalCharacterError, or
    # any other bug) must still exit cleanly for a non-technical person who
    # double-clicked an icon — never a raw traceback.
    monkeypatch.setattr(Config, "from_env", staticmethod(lambda: config))
    monkeypatch.setattr("worker.export.__main__.DEFAULT_OUT_ROOT", tmp_path / "out")

    def _boom(*args, **kwargs):
        raise RuntimeError("kaboom")

    monkeypatch.setattr("worker.export.__main__.collect_all", _boom)

    exit_code = main([])

    assert exit_code == 1
    out = capsys.readouterr().out
    assert "not modified" in out.lower()


def test_export_creates_the_expected_folder_layout(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()

    out_dir, result = run_export(config, out_root=tmp_path / "out", now=NOW)

    assert out_dir.name == "2026-07-24-1930"
    assert (out_dir / "README.txt").is_file()
    assert (out_dir / "SocialScheduler-Export.xlsx").is_file()
    assert (out_dir / "export.json").is_file()
    assert result.copied == 1
    assert (out_dir / "images").is_dir()


def test_export_never_overwrites_a_previous_run(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_root = tmp_path / "out"

    first, _ = run_export(config, out_root=out_root, now=NOW)
    (first / "sentinel.txt").write_text("do not clobber me")
    second, _ = run_export(config, out_root=out_root, now=NOW)

    assert second != first
    assert (first / "sentinel.txt").read_text() == "do not clobber me"


def test_export_of_an_empty_database_still_produces_a_valid_workbook(config, tmp_path):
    out_dir, result = run_export(config, out_root=tmp_path / "out", now=NOW)

    book = load_workbook(out_dir / "SocialScheduler-Export.xlsx")

    assert book.sheetnames == [
        "Posts", "Sends", "Metrics", "Assets", "Channels", "Channel groups",
    ]
    assert result.copied == 0
    assert json.loads((out_dir / "export.json").read_text())["posts"] == []


def test_export_completes_when_an_asset_file_is_missing(config, conn, make_publication, tmp_path):
    make_publication()  # asset rows exist, but no files were written to disk
    conn.close()

    out_dir, result = run_export(config, out_root=tmp_path / "out", now=NOW)

    assert result.missing_asset_ids
    assert "could not be found" in (out_dir / "README.txt").read_text()
    assert (out_dir / "SocialScheduler-Export.xlsx").is_file()


def test_export_holds_one_snapshot_so_a_mid_collection_commit_is_not_visible(
    config, conn, make_publication, tmp_path, monkeypatch
):
    # sqlite3 does not open a transaction for plain reads: without one, each of
    # collect_all's 6+ SELECTs takes its own WAL snapshot, and a commit from
    # another connection (e.g. the worker daemon) between two of them can leave
    # the export self-inconsistent (a Sends row whose post doesn't exist, etc.).
    # We interleave a write from a SEPARATE connection after the export's first
    # read (which establishes its snapshot) but before its later reads, and
    # confirm the later read does not see it.
    pub = make_publication()
    post_id, channel_id = pub["post_id"], pub["channel_id"]
    conn.commit()
    conn.close()

    import worker.export.collect as collect_mod

    original_add_rollups = collect_mod.add_rollups

    def _add_rollups_with_interleaved_write(c, posts):
        other = sqlite3.connect(str(config.database_path))
        other.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, status)"
            " VALUES (?, ?, '2026-08-01T00:00:00+00:00', 'scheduled')",
            (post_id, channel_id),
        )
        other.commit()
        other.close()
        return original_add_rollups(c, posts)

    monkeypatch.setattr(collect_mod, "add_rollups", _add_rollups_with_interleaved_write)

    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)

    data = json.loads((out_dir / "export.json").read_text())
    # Only the original publication (from make_publication) may appear — the one
    # inserted by the separate connection, mid-collection, must not leak in.
    assert len(data["sends"]) == 1


def test_export_transaction_is_open_during_collection(
    config, conn, make_publication, tmp_path, monkeypatch
):
    make_publication()
    conn.commit()
    conn.close()

    import worker.export.collect as collect_mod

    seen_in_transaction = {}
    original_collect_all = collect_mod.collect_all

    def _spy(c, generated_at):
        seen_in_transaction["value"] = c.in_transaction
        return original_collect_all(c, generated_at)

    monkeypatch.setattr("worker.export.__main__.collect_all", _spy)

    run_export(config, out_root=tmp_path / "out", now=NOW)

    assert seen_in_transaction["value"] is True
