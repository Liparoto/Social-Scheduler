"""Fetching, validating and storing avatar bytes — including every failure mode."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

import worker.avatars as avatars_mod
from worker.avatars import run_avatars

NOW = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
JPEG = b"\xff\xd8\xff" + b"body-one"
JPEG_TWO = b"\xff\xd8\xff" + b"body-two"
PNG = b"\x89PNG\r\n\x1a\n" + b"body"


class FakeAvatarClient:
    """Only the two methods the avatar job uses."""

    def __init__(self, url="https://cdn/pic.jpg", payload=JPEG, fail_on=None):
        self.url = url
        self.payload = payload
        self.fail_on = set(fail_on or [])
        self.downloads = 0

    def get_instagram_profile_picture_url(self, account_id, token):
        if "url" in self.fail_on:
            raise RuntimeError("lookup boom")
        return self.url

    def download_image_bytes(self, url, max_bytes=5_000_000):
        self.downloads += 1
        if "download" in self.fail_on:
            raise RuntimeError("download boom")
        return self.payload


def _channel(conn, **kw):
    cid = conn.execute(
        """INSERT INTO channels
             (platform, account_name, remote_account_id, access_token)
           VALUES ('instagram', 'C', 'ig1', 'tok')"""
    ).lastrowid
    if kw:
        sets = ", ".join(f"{k} = ?" for k in kw)
        conn.execute(f"UPDATE channels SET {sets} WHERE id = ?", (*kw.values(), cid))
    conn.commit()
    return cid


def _row(conn, cid):
    return conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()


def test_a_successful_fetch_writes_the_file_and_records_the_path(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient()

    assert run_avatars(conn, config, client, NOW) == 1

    row = _row(conn, cid)
    assert row["avatar_path"] == f"avatars/{cid}.jpg"
    assert row["avatar_fetched_at"] == NOW.isoformat()
    assert row["avatar_error"] is None
    assert (config.asset_storage_dir / row["avatar_path"]).read_bytes() == JPEG


def test_the_extension_follows_the_actual_bytes_not_the_url(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient(url="https://cdn/pic.jpg", payload=PNG)

    run_avatars(conn, config, client, NOW)

    assert _row(conn, cid)["avatar_path"] == f"avatars/{cid}.png"


def test_a_non_image_response_is_rejected_and_nothing_is_written(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient(payload=b"<html>Sorry, an error occurred</html>")

    assert run_avatars(conn, config, client, NOW) == 0

    row = _row(conn, cid)
    assert row["avatar_path"] is None
    assert "not an image" in row["avatar_error"]
    assert not (config.asset_storage_dir / "avatars").exists() or not list(
        (config.asset_storage_dir / "avatars").iterdir()
    )


def test_a_failed_lookup_keeps_the_existing_photo(conn, config):
    cid = _channel(conn, avatar_path="avatars/existing.jpg")
    (config.asset_storage_dir / "avatars").mkdir(parents=True, exist_ok=True)
    (config.asset_storage_dir / "avatars" / "existing.jpg").write_bytes(JPEG)
    client = FakeAvatarClient(fail_on=["url"])

    run_avatars(conn, config, client, NOW)

    row = _row(conn, cid)
    assert row["avatar_path"] == "avatars/existing.jpg", "must not clear a working photo"
    assert row["avatar_error"]
    assert (config.asset_storage_dir / "avatars" / "existing.jpg").exists()


def test_a_failure_clears_the_refresh_request_so_a_click_cannot_wedge(conn, config):
    cid = _channel(conn, avatar_refresh_requested=1)
    client = FakeAvatarClient(fail_on=["download"])

    run_avatars(conn, config, client, NOW)

    assert _row(conn, cid)["avatar_refresh_requested"] == 0


def test_no_photo_on_the_account_is_recorded_without_an_error(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient(url=None)

    run_avatars(conn, config, client, NOW)

    row = _row(conn, cid)
    assert row["avatar_path"] is None
    assert row["avatar_error"] is None, "having no photo is a normal state, not a failure"
    assert row["avatar_fetched_at"] == NOW.isoformat(), "so it is not retried every cycle"


def test_an_unchanged_photo_is_not_rewritten(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient()
    run_avatars(conn, config, client, NOW)
    path = config.asset_storage_dir / _row(conn, cid)["avatar_path"]
    first_mtime = path.stat().st_mtime_ns

    later = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
    run_avatars(conn, config, client, later)

    assert path.stat().st_mtime_ns == first_mtime, "same content hash — no rewrite"
    assert _row(conn, cid)["avatar_fetched_at"] == later.isoformat()


def test_a_changed_photo_replaces_the_file(conn, config):
    cid = _channel(conn)
    run_avatars(conn, config, FakeAvatarClient(payload=JPEG), NOW)

    later = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
    run_avatars(conn, config, FakeAvatarClient(payload=JPEG_TWO), later)

    path = config.asset_storage_dir / _row(conn, cid)["avatar_path"]
    assert path.read_bytes() == JPEG_TWO


def test_one_channel_failing_does_not_stop_the_next(conn, config):
    first = _channel(conn)
    second = conn.execute(
        """INSERT INTO channels (platform, account_name, remote_account_id, access_token)
           VALUES ('instagram', 'C2', 'ig2', 'tok2')"""
    ).lastrowid
    conn.commit()

    class HalfBroken(FakeAvatarClient):
        def get_instagram_profile_picture_url(self, account_id, token):
            if account_id == "ig1":
                raise RuntimeError("lookup boom")
            return self.url

    assert run_avatars(conn, config, HalfBroken(), NOW) == 1
    assert _row(conn, first)["avatar_error"]
    assert _row(conn, second)["avatar_path"] == f"avatars/{second}.jpg"


def test_the_token_never_reaches_avatar_error(conn, config):
    cid = _channel(conn)

    class LeakyClient(FakeAvatarClient):
        def get_instagram_profile_picture_url(self, account_id, token):
            raise RuntimeError("GET failed: access_token=EAAsupersecrettokenvalue")

    run_avatars(conn, config, LeakyClient(), NOW)

    assert "EAAsupersecrettokenvalue" not in _row(conn, cid)["avatar_error"]


def test_a_selection_failure_returns_zero_without_raising(conn, config, monkeypatch):
    """channels_needing_avatars runs BEFORE the per-channel try/except, so a locked-DB
    error there (the dashboard is a concurrent writer against the same SQLite file) must
    be caught at the top level rather than escaping run_avatars — the docstring's "must
    never raise" contract has to hold even when selection itself is what fails.
    """
    _channel(conn)

    def _boom(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(avatars_mod, "channels_needing_avatars", _boom)

    assert run_avatars(conn, config, FakeAvatarClient(), NOW) == 0


def test_a_failed_store_does_not_leave_a_stray_temp_file(conn, config, monkeypatch):
    """A write or replace failure inside _store_avatar (disk full, permissions) must not
    leave `.{id}.{ext}.tmp` behind — that failure mode recurs every cycle, so an unlinked
    orphan would accumulate in avatars/ forever.
    """
    cid = _channel(conn)
    client = FakeAvatarClient()

    def _boom_replace(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(avatars_mod.os, "replace", _boom_replace)

    run_avatars(conn, config, client, NOW)

    row = _row(conn, cid)
    assert row["avatar_error"], "the per-channel handler should still record the failure"

    avatar_dir = config.asset_storage_dir / "avatars"
    leftover_tmp = list(avatar_dir.glob("*.tmp")) if avatar_dir.exists() else []
    assert leftover_tmp == []
