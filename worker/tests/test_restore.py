"""Restoring a backup folder over an install.

The headline test is the round trip: export, destroy the install, restore, and prove the
content came back. Everything else here guards the ways a restore can go wrong destructively
— running over a live worker, leaving stale WAL sidecars, or overwriting the current
database with no way back.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from worker import single_instance
from worker.export.__main__ import DB_COPY_NAME, run_export
from worker.restore import (
    RestoreError,
    apply_restore,
    main,
    plan_restore,
    save_current_database,
)

NOW = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)


def _seed_assets(config, conn):
    """Give every asset row real bytes on disk, distinct per asset so a restore that
    swapped two files would be caught rather than merely counted."""
    config.asset_storage_dir.mkdir(parents=True, exist_ok=True)
    for row in conn.execute("SELECT id, storage_path FROM assets"):
        path = config.asset_storage_dir / row["storage_path"].split("/")[-1]
        path.write_bytes(f"asset-bytes-{row['id']}".encode())
        conn.execute(
            "UPDATE assets SET storage_path = ? WHERE id = ?", (path.name, row["id"])
        )
    conn.commit()


def _wipe_install(config):
    """Simulate the disaster: the database and the whole asset store are gone.

    rmtree for directories, not unlink — the asset store has a `pub/` subdirectory for
    conformed copies on a real install, and unlink() on a directory raises.
    """
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(config.database_path) + suffix)
        if p.exists():
            p.unlink()
    for f in config.asset_storage_dir.glob("*"):
        if f.is_dir():
            shutil.rmtree(f)
        else:
            f.unlink()


def test_round_trip_brings_back_posts_and_image_bytes(
    config, conn, make_publication, tmp_path
):
    make_publication()
    _seed_assets(config, conn)
    posts_before = [
        (r["id"], r["caption"]) for r in conn.execute("SELECT id, caption FROM posts")
    ]
    assets_before = {
        r["storage_path"]: (config.asset_storage_dir / r["storage_path"]).read_bytes()
        for r in conn.execute("SELECT storage_path FROM assets")
    }
    assert posts_before and assets_before, "precondition: there is something to lose"
    conn.close()

    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    _wipe_install(config)
    assert not config.database_path.exists()

    plan = plan_restore(out_dir, config)
    apply_restore(plan, config, NOW)

    restored = sqlite3.connect(str(config.database_path))
    try:
        posts_after = list(restored.execute("SELECT id, caption FROM posts"))
    finally:
        restored.close()
    assert posts_after == posts_before

    # The real test of the rename mapping: every file is back under the CONTENT-HASH name
    # the database refers to, holding its own original bytes.
    for storage_path, expected in assets_before.items():
        dest = config.asset_storage_dir / storage_path
        assert dest.is_file(), f"{storage_path} was not restored"
        assert dest.read_bytes() == expected, f"{storage_path} restored the wrong bytes"


def test_dry_run_changes_nothing(config, conn, make_publication, tmp_path, capsys):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    _wipe_install(config)

    assert main([str(out_dir)]) == 0

    assert not config.database_path.exists(), "a dry run must not write the database"
    assert list(config.asset_storage_dir.glob("*")) == []
    assert "DRY RUN" in capsys.readouterr().out


def test_refuses_a_folder_without_a_database_copy(config, tmp_path):
    backup = tmp_path / "old-style-backup"
    backup.mkdir()
    (backup / "export.json").write_text(json.dumps({"format_version": 1, "posts": []}))

    with pytest.raises(RestoreError) as excinfo:
        plan_restore(backup, config)
    # Backups predating this feature are a real case, so the message has to name the
    # situation rather than just failing.
    assert DB_COPY_NAME in str(excinfo.value)


def test_refuses_a_truncated_database_before_touching_the_live_one(
    config, conn, make_publication, tmp_path
):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    # A half-copied file: right name, not a database.
    (out_dir / DB_COPY_NAME).write_bytes(b"SQLite format 3\x00 and then nothing")

    with pytest.raises(RestoreError) as excinfo:
        plan_restore(out_dir, config)
    assert "not a readable" in str(excinfo.value)
    assert config.database_path.exists(), "the live database must be untouched"


def test_rejects_a_backup_from_a_future_version(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    bundle = json.loads((out_dir / "export.json").read_text())
    bundle["format_version"] = 99
    (out_dir / "export.json").write_text(json.dumps(bundle))

    with pytest.raises(RestoreError) as excinfo:
        plan_restore(out_dir, config)
    assert "99" in str(excinfo.value)


def test_refuses_while_a_worker_holds_the_lock(
    config, conn, make_publication, tmp_path, capsys
):
    """The most dangerous case: replacing the database under a running worker."""
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    before = config.database_path.read_bytes()

    lock_path = config.database_path.parent / "run" / "worker.lock"
    single_instance.acquire(lock_path, wait_seconds=0)
    try:
        assert main([str(out_dir), "--apply"]) == 1
    finally:
        single_instance.release()

    assert config.database_path.read_bytes() == before, "nothing may be written"
    out = capsys.readouterr().out
    assert "still running" in out
    assert "Stop-SocialScheduler-Mac" in out, "tell them what to actually do"


def test_saves_the_current_database_before_replacing_it(
    config, conn, make_publication, tmp_path
):
    make_publication()
    _seed_assets(config, conn)
    conn.execute("INSERT INTO tags (name) VALUES ('only-in-the-old-database')")
    conn.commit()
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)

    # Change the install AFTER exporting, so the saved copy is provably the newer one.
    live = sqlite3.connect(str(config.database_path))
    live.execute("INSERT INTO tags (name) VALUES ('added-after-the-backup')")
    live.commit()
    live.close()

    plan = plan_restore(out_dir, config)
    result = apply_restore(plan, config, NOW)

    saved = Path(result["saved_database_to"])
    assert saved.is_file()
    kept = sqlite3.connect(str(saved))
    try:
        names = [r[0] for r in kept.execute("SELECT name FROM tags")]
    finally:
        kept.close()
    assert "added-after-the-backup" in names, "the way back must include the newest work"


def test_restoring_removes_stale_wal_sidecars(config, conn, make_publication, tmp_path):
    """A -wal belonging to the OLD database, left beside a NEW one, is how a restore
    corrupts an install."""
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)

    wal = Path(str(config.database_path) + "-wal")
    shm = Path(str(config.database_path) + "-shm")
    wal.write_bytes(b"stale wal from the database being replaced")
    shm.write_bytes(b"stale shm")

    plan = plan_restore(out_dir, config)
    apply_restore(plan, config, NOW)

    assert not wal.exists()
    assert not shm.exists()
    # And the result is genuinely usable, not merely tidy.
    restored = sqlite3.connect(str(config.database_path))
    try:
        assert restored.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        restored.close()


def test_an_asset_already_on_disk_is_left_alone(config, conn, make_publication, tmp_path):
    """Filenames are content hashes, so a file already present IS the file. Re-copying
    1.5 GB of identical bytes is the thing to avoid."""
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)

    plan = plan_restore(out_dir, config)
    assert plan.counts["images_already_present"] == plan.counts["images"]
    result = apply_restore(plan, config, NOW)
    assert result["images_restored"] == 0
    assert result["images_skipped"] == plan.counts["images"]


def test_restoring_onto_a_fresh_clone_has_nothing_to_save(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    _wipe_install(config)

    # No database to preserve is normal here, not an error.
    assert save_current_database(config, NOW) is None
    plan = plan_restore(out_dir, config)
    result = apply_restore(plan, config, NOW)
    assert result["saved_database_to"] == ""
    assert config.database_path.is_file()


def test_a_missing_image_in_the_backup_is_reported_not_fatal(
    config, conn, make_publication, tmp_path
):
    """A partial backup still restores everything it does have."""
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    _wipe_install(config)

    images = sorted((out_dir / "images").glob("*"))
    assert images, "precondition: the backup has images"
    images[0].unlink()

    plan = plan_restore(out_dir, config)
    assert plan.counts["images_missing"] >= 1
    result = apply_restore(plan, config, NOW)
    assert result["images_missing"] >= 1
    assert config.database_path.is_file(), "the database still restores"


def test_a_conformed_copy_in_a_subdirectory_is_restored_into_that_subdirectory(
    config, conn, make_publication, tmp_path
):
    """publish_path is not always a bare filename.

    On the live install every conformed copy lives under `pub/`, e.g.
    `pub/da5ef001….mp4`, while storage_path is a bare content-hash name. So the restore has
    to create directories on the way, not just drop files into the asset root. Found by
    running the round trip against a copy of real data — the unit fixtures all used bare
    names and would never have caught it.
    """
    make_publication()
    _seed_assets(config, conn)
    row = conn.execute("SELECT id, storage_path FROM assets LIMIT 1").fetchone()
    nested = f"pub/{row['storage_path']}"
    (config.asset_storage_dir / "pub").mkdir(parents=True, exist_ok=True)
    (config.asset_storage_dir / nested).write_bytes(b"conformed-bytes")
    conn.execute("UPDATE assets SET publish_path = ? WHERE id = ?", (nested, row["id"]))
    conn.commit()
    conn.close()

    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)
    _wipe_install(config)

    plan = plan_restore(out_dir, config)
    apply_restore(plan, config, NOW)

    restored = config.asset_storage_dir / nested
    assert restored.is_file(), "the pub/ subdirectory was not recreated"
    assert restored.read_bytes() == b"conformed-bytes"
