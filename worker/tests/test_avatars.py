"""Which channels the avatar job selects, and which it leaves alone."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from worker.avatars import channels_needing_avatars

NOW = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)


def _channel(conn, *, platform="instagram", name="C", token="tok", account="ig1",
             fetched_at=None, path=None, requested=0, active=1):
    cid = conn.execute(
        """INSERT INTO channels
             (platform, account_name, remote_account_id, access_token, is_active,
              avatar_path, avatar_fetched_at, avatar_refresh_requested)
           VALUES (?,?,?,?,?,?,?,?)""",
        (platform, name, account, token, active, path, fetched_at, requested),
    ).lastrowid
    conn.commit()
    return cid


def _ids(conn, asset_dir):
    return [r["id"] for r in channels_needing_avatars(conn, NOW, asset_dir)]


def test_a_channel_with_no_photo_is_selected(conn, tmp_path):
    cid = _channel(conn)
    assert _ids(conn, tmp_path) == [cid]


def test_a_recently_fetched_channel_is_skipped(conn, tmp_path):
    fetched = (NOW - timedelta(hours=1)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg")
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "1.jpg").write_bytes(b"x")
    assert _ids(conn, tmp_path) == []
    assert cid  # the row exists; it was skipped on freshness, not absence


def test_a_stale_channel_is_selected(conn, tmp_path):
    fetched = (NOW - timedelta(days=8)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg")
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "1.jpg").write_bytes(b"x")
    assert _ids(conn, tmp_path) == [cid]


def test_a_requested_refresh_beats_freshness(conn, tmp_path):
    fetched = (NOW - timedelta(hours=1)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg", requested=1)
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "1.jpg").write_bytes(b"x")
    assert _ids(conn, tmp_path) == [cid]


def test_a_missing_file_beats_freshness(conn, tmp_path):
    # The restored-backup case: avatars are deliberately not in the export bundle, so
    # after a restore the DB says "fetched an hour ago" while the disk has nothing.
    # Without this rule the avatar stays broken for a week.
    fetched = (NOW - timedelta(hours=1)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg")
    assert _ids(conn, tmp_path) == [cid]


def test_unsupported_platforms_are_never_selected(conn, tmp_path):
    _channel(conn, platform="discord", name="D", account="hook1")
    _channel(conn, platform="telegram", name="T", account="chat1")
    assert _ids(conn, tmp_path) == []


def test_channels_without_credentials_are_skipped(conn, tmp_path):
    _channel(conn, token=None, name="NoToken")
    _channel(conn, account=None, name="NoAccount")
    assert _ids(conn, tmp_path) == []


def test_inactive_channels_are_skipped(conn, tmp_path):
    _channel(conn, active=0)
    assert _ids(conn, tmp_path) == []


def test_registry_covers_every_supported_platform():
    from worker.avatars import _URL_FETCHERS
    from worker.clients import SUPPORTED_PLATFORMS

    assert set(_URL_FETCHERS) == set(SUPPORTED_PLATFORMS)
