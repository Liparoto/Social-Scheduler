"""Token upkeep.

Every other platform here hands out a credential that sits in the row and keeps working.
TikTok's access token lasts 24 hours and its refresh token ROTATES — each refresh returns a
new one and kills the one you sent. This is the only channel in the project that dies if
the worker does nothing, and the only one where writing half the result is worse than
writing none of it.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

import pytest

from worker import db
from worker.tiktok_api import TikTokAPIError
from worker.tiktok_tokens import TikTokAuthRevoked, refresh_channel_token

NOW = datetime(2026, 8, 23, 12, 0, tzinfo=timezone.utc)


class FakeTikTok:
    def __init__(self, result=None, error=None):
        self.result = result or {
            "access_token": "act.NEWTOKEN",
            "expires_in": 86400,
            "refresh_token": "rft.ROTATEDVALUE",
            "refresh_expires_in": 31536000,
        }
        self.error = error
        self.calls = 0

    def refresh_access_token(self, key, secret, refresh_token):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


@pytest.fixture
def tiktok_config(config):
    return dataclasses.replace(
        config, tiktok_client_key="test-key", tiktok_client_secret="test-secret"
    )


def _tiktok_channel(conn, *, expires_in_hours, refresh_token="rft.OLDVALUE"):
    expiry = (NOW + timedelta(hours=expires_in_hours)).isoformat()
    conn.execute(
        "INSERT INTO channels (platform, account_name, timezone, access_token, "
        "token_expires_at, refresh_token, refresh_token_expires_at) "
        "VALUES ('tiktok', 'tt', 'UTC', 'act.OLDTOKEN', ?, ?, ?)",
        (expiry, refresh_token, (NOW + timedelta(days=300)).isoformat()),
    )
    conn.commit()
    cid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    return db.get_channel(conn, cid)


def test_token_expiring_within_the_hour_is_refreshed(conn, tiktok_config):
    ch = _tiktok_channel(conn, expires_in_hours=0.5)
    client = FakeTikTok()

    out = refresh_channel_token(conn, tiktok_config, client, ch, NOW)

    assert client.calls == 1
    assert out["access_token"] == "act.NEWTOKEN"
    stored = db.get_channel(conn, ch["id"])
    assert stored["access_token"] == "act.NEWTOKEN"
    # The rotated refresh token MUST be stored. Missing this is the failure that kills a
    # channel: the next refresh sends a token TikTok has already invalidated.
    assert stored["refresh_token"] == "rft.ROTATEDVALUE"
    assert stored["token_expires_at"] == (NOW + timedelta(seconds=86400)).isoformat()
    assert stored["refresh_token_expires_at"] == (NOW + timedelta(seconds=31536000)).isoformat()


def test_healthy_token_is_left_alone(conn, tiktok_config):
    ch = _tiktok_channel(conn, expires_in_hours=10)
    client = FakeTikTok()

    out = refresh_channel_token(conn, tiktok_config, client, ch, NOW)

    assert client.calls == 0
    assert out["access_token"] == "act.OLDTOKEN"


def test_an_unknown_expiry_refreshes_rather_than_gambling(conn, tiktok_config):
    """A NULL token_expires_at means we do not know when it dies. Refreshing costs one
    call; assuming it is fine costs a failed publish."""
    ch = _tiktok_channel(conn, expires_in_hours=10)
    conn.execute("UPDATE channels SET token_expires_at = NULL WHERE id = ?", (ch["id"],))
    conn.commit()
    ch = db.get_channel(conn, ch["id"])
    client = FakeTikTok()

    refresh_channel_token(conn, tiktok_config, client, ch, NOW)

    assert client.calls == 1


def test_a_revoked_grant_is_terminal_and_says_reconnect(conn, tiktok_config):
    ch = _tiktok_channel(conn, expires_in_hours=0.1)
    client = FakeTikTok(
        error=TikTokAPIError("POST /v2/oauth/token/ (refresh) -> 200: invalid_grant: revoked")
    )

    with pytest.raises(TikTokAuthRevoked) as exc:
        refresh_channel_token(conn, tiktok_config, client, ch, NOW)

    assert "reconnect" in str(exc.value).lower()


def test_a_transient_failure_stays_retryable(conn, tiktok_config):
    """A network blip must NOT be reported as a revoked authorisation — that would tell the
    owner to reconnect an account that is perfectly fine."""
    ch = _tiktok_channel(conn, expires_in_hours=0.1)
    client = FakeTikTok(
        error=TikTokAPIError("POST /v2/oauth/token/ (refresh) -> request failed: timeout")
    )

    with pytest.raises(TikTokAPIError) as exc:
        refresh_channel_token(conn, tiktok_config, client, ch, NOW)

    assert not isinstance(exc.value, TikTokAuthRevoked)


def test_missing_client_credentials_fail_loudly(conn, config):
    ch = _tiktok_channel(conn, expires_in_hours=0.1)
    client = FakeTikTok()

    with pytest.raises(TikTokAuthRevoked) as exc:
        refresh_channel_token(conn, config, client, ch, NOW)   # config has no TikTok keys

    assert "TIKTOK_CLIENT_KEY" in str(exc.value)
    assert client.calls == 0


def test_a_channel_with_no_refresh_token_says_reconnect(conn, tiktok_config):
    ch = _tiktok_channel(conn, expires_in_hours=0.1, refresh_token=None)
    client = FakeTikTok()

    with pytest.raises(TikTokAuthRevoked) as exc:
        refresh_channel_token(conn, tiktok_config, client, ch, NOW)

    assert "reconnect" in str(exc.value).lower()
    assert client.calls == 0


def test_a_non_tiktok_channel_is_returned_untouched(conn, tiktok_config):
    conn.execute(
        "INSERT INTO channels (platform, account_name, timezone, access_token) "
        "VALUES ('instagram', 'ig', 'UTC', 'tok-123')"
    )
    conn.commit()
    cid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    ch = db.get_channel(conn, cid)
    client = FakeTikTok()

    out = refresh_channel_token(conn, tiktok_config, client, ch, NOW)

    assert client.calls == 0
    assert out["access_token"] == "tok-123"
