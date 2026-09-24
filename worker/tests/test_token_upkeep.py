"""Meta token upkeep (worker/token_upkeep.py).

The failure this guards against: a 60-day Threads token expired on 2026-09-22 with nothing
renewing or even tracking it, and the first sign was a failed post. Expired tokens cannot
be renewed, so every test here is really about one of three promises — renew early, never
lose a working token, and tell a human only what a human can fix.
"""

from __future__ import annotations

import dataclasses
import logging
from datetime import datetime, timedelta, timezone

import pytest
import requests

from worker import db
from worker.token_upkeep import (
    CHECK_EVERY,
    RETRY_AFTER,
    check_channel,
    run_token_upkeep,
)

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)
OLD = "TH_OLD_TOKEN_VALUE"
NEW = "TH_NEW_TOKEN_VALUE"


class FakeResp:
    def __init__(self, status: int, body: dict):
        self.status_code = status
        self.ok = status < 400
        self._body = body

    def json(self):
        return self._body


class FakeSession:
    """Routes by the URL's last path segment. Each route is a FakeResp or an exception."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, dict(params or {})))
        result = self.routes[url.rsplit("/", 1)[-1]]
        if isinstance(result, Exception):
            raise result
        return result

    def called(self, endpoint: str) -> bool:
        return any(url.endswith("/" + endpoint) for url, _ in self.calls)


def _epoch(dt: datetime) -> int:
    return int(dt.timestamp())


def _channel(conn, platform="threads", token=OLD, expires_at=None, next_check=None):
    cur = conn.execute(
        "INSERT INTO channels (platform, account_name, timezone, remote_account_id, "
        "access_token, token_expires_at, token_next_check_at) VALUES (?,?,?,?,?,?,?)",
        (platform, "Test", "UTC", "123", token, expires_at, next_check),
    )
    conn.commit()
    return db.get_channel(conn, cur.lastrowid)


@pytest.fixture
def ig_login_config(config):
    return dataclasses.replace(config, graph_base="https://graph.instagram.com")


def _debug(expires: datetime | None, valid=True):
    return FakeResp(200, {"data": {
        "is_valid": valid, "expires_at": _epoch(expires) if expires else 0,
    }})


RENEWED = FakeResp(200, {"access_token": NEW, "token_type": "bearer", "expires_in": 5184000})


# -- Threads ---------------------------------------------------------------------------

def test_threads_far_from_expiry_records_the_date_and_does_not_renew(conn, config):
    ch = _channel(conn)
    session = FakeSession({"debug_token": _debug(NOW + timedelta(days=50))})

    assert check_channel(conn, config, ch, NOW, session=session) == "ok"

    row = db.get_channel(conn, ch["id"])
    assert row["access_token"] == OLD
    assert row["token_expires_at"] == (NOW + timedelta(days=50)).replace(microsecond=0).isoformat()
    assert row["token_error"] is None
    assert row["token_next_check_at"] == (NOW + CHECK_EVERY).isoformat()
    assert not session.called("refresh_access_token")


def test_threads_inside_two_weeks_renews_and_stores_the_new_token(conn, config):
    ch = _channel(conn)
    session = FakeSession({
        "debug_token": _debug(NOW + timedelta(days=10)),
        "refresh_access_token": RENEWED,
    })

    assert check_channel(conn, config, ch, NOW, session=session) == "renewed"

    row = db.get_channel(conn, ch["id"])
    assert row["access_token"] == NEW
    assert row["token_expires_at"] == (NOW + timedelta(seconds=5184000)).isoformat()
    assert row["token_error"] is None
    url, params = session.calls[-1]
    assert url == "https://graph.threads.net/refresh_access_token"
    assert params == {"grant_type": "th_refresh_token", "access_token": OLD}


def test_threads_failed_renewal_keeps_the_working_token_and_says_so(conn, config):
    ch = _channel(conn)
    session = FakeSession({
        "debug_token": _debug(NOW + timedelta(days=5)),
        "refresh_access_token": FakeResp(400, {"error": {"message": "nope", "code": 100}}),
    })

    assert check_channel(conn, config, ch, NOW, session=session) == "error"

    row = db.get_channel(conn, ch["id"])
    assert row["access_token"] == OLD                      # untouched
    assert row["token_expires_at"] is not None             # the countdown survives
    assert "Automatic renewal failed" in row["token_error"]


def test_expired_token_asks_for_a_reconnect(conn, config):
    ch = _channel(conn)
    session = FakeSession({"debug_token": FakeResp(400, {"error": {
        "message": "Error validating access token: Session has expired", "code": 190,
    }})})

    assert check_channel(conn, config, ch, NOW, session=session) == "error"

    row = db.get_channel(conn, ch["id"])
    assert row["access_token"] == OLD
    assert "no longer valid" in row["token_error"]
    assert "Reconnect" in row["token_error"]


def test_network_trouble_retries_in_an_hour_and_bothers_nobody(conn, config):
    ch = _channel(conn)
    session = FakeSession({"debug_token": requests.ConnectionError(
        "https://graph.threads.net/v1.0/debug_token?access_token=TH_OLD_TOKEN_VALUE")})

    assert check_channel(conn, config, ch, NOW, session=session) == "retry"

    row = db.get_channel(conn, ch["id"])
    assert row["token_error"] is None
    assert row["token_next_check_at"] == (NOW + RETRY_AFTER).isoformat()


def test_meta_5xx_is_transient_too(conn, config):
    ch = _channel(conn)
    session = FakeSession({"debug_token": FakeResp(503, {})})
    assert check_channel(conn, config, ch, NOW, session=session) == "retry"


def test_a_success_clears_an_old_error(conn, config):
    ch = _channel(conn)
    conn.execute("UPDATE channels SET token_error = 'stale' WHERE id = ?", (ch["id"],))
    session = FakeSession({"debug_token": _debug(NOW + timedelta(days=50))})
    check_channel(conn, config, db.get_channel(conn, ch["id"]), NOW, session=session)
    assert db.get_channel(conn, ch["id"])["token_error"] is None


# -- Instagram (Instagram Login) -------------------------------------------------------

def test_instagram_unknown_expiry_renews_to_learn_the_date(conn, ig_login_config):
    ch = _channel(conn, platform="instagram", token="IGA_OLD")
    session = FakeSession({"refresh_access_token": RENEWED})

    assert check_channel(conn, ig_login_config, ch, NOW, session=session) == "renewed"

    row = db.get_channel(conn, ch["id"])
    assert row["access_token"] == NEW
    url, params = session.calls[0]
    assert url == "https://graph.instagram.com/refresh_access_token"
    assert params["grant_type"] == "ig_refresh_token"


def test_instagram_with_weeks_left_makes_no_call(conn, ig_login_config):
    ch = _channel(conn, platform="instagram", token="IGA_OLD",
                  expires_at=(NOW + timedelta(days=40)).isoformat())
    session = FakeSession({})
    assert check_channel(conn, ig_login_config, ch, NOW, session=session) == "ok"
    assert session.calls == []


def test_instagram_brand_new_token_is_not_an_alarm(conn, ig_login_config):
    """Meta refuses to renew a token under 24h old — the normal state just after a
    reconnect. If the token still works, that is fine and silent."""
    ch = _channel(conn, platform="instagram", token="IGA_OLD")
    session = FakeSession({
        "refresh_access_token": FakeResp(400, {"error": {"message": "too new", "code": 10}}),
        "me": FakeResp(200, {"user_id": "1784"}),
    })
    assert check_channel(conn, ig_login_config, ch, NOW, session=session) == "ok"
    row = db.get_channel(conn, ch["id"])
    assert row["access_token"] == "IGA_OLD"
    assert row["token_error"] is None


def test_instagram_dead_token_is_flagged(conn, ig_login_config):
    ch = _channel(conn, platform="instagram", token="IGA_OLD")
    dead = FakeResp(400, {"error": {"message": "Session has expired", "code": 190}})
    session = FakeSession({"refresh_access_token": dead, "me": dead})
    assert check_channel(conn, ig_login_config, ch, NOW, session=session) == "error"
    assert "no longer valid" in db.get_channel(conn, ch["id"])["token_error"]


def test_instagram_known_close_expiry_and_failed_renewal_is_flagged(conn, ig_login_config):
    ch = _channel(conn, platform="instagram", token="IGA_OLD",
                  expires_at=(NOW + timedelta(days=3)).isoformat())
    session = FakeSession({"refresh_access_token": FakeResp(
        400, {"error": {"message": "nope", "code": 100}})})
    assert check_channel(conn, ig_login_config, ch, NOW, session=session) == "error"
    row = db.get_channel(conn, ch["id"])
    assert row["access_token"] == "IGA_OLD"
    assert "Automatic renewal failed" in row["token_error"]


# -- Facebook (check only) -------------------------------------------------------------

def test_facebook_page_token_that_never_expires_is_ok(conn, config):
    cfg = dataclasses.replace(config, meta_app_id="app", meta_app_secret="secret")
    ch = _channel(conn, platform="facebook", token="EAAPAGE")
    session = FakeSession({"debug_token": _debug(None)})
    assert check_channel(conn, cfg, ch, NOW, session=session) == "ok"
    row = db.get_channel(conn, ch["id"])
    assert row["token_expires_at"] is None
    assert row["token_error"] is None
    assert session.calls[0][1]["access_token"] == "app|secret"
    assert not session.called("refresh_access_token")


def test_facebook_without_app_credentials_makes_no_call(conn, config):
    ch = _channel(conn, platform="facebook", token="EAAPAGE")
    session = FakeSession({})
    assert check_channel(conn, config, ch, NOW, session=session) == "ok"
    assert session.calls == []


def test_facebook_expiring_token_warns_early(conn, config):
    cfg = dataclasses.replace(config, meta_app_id="app", meta_app_secret="secret")
    ch = _channel(conn, platform="facebook", token="EAAPAGE")
    session = FakeSession({"debug_token": _debug(NOW + timedelta(days=7))})
    assert check_channel(conn, cfg, ch, NOW, session=session) == "error"
    assert "can't be renewed automatically" in db.get_channel(conn, ch["id"])["token_error"]


# -- the cycle -------------------------------------------------------------------------

def test_cycle_skips_channels_that_are_not_due(conn, config):
    _channel(conn, next_check=(NOW + timedelta(hours=3)).isoformat())
    session = FakeSession({})
    assert run_token_upkeep(conn, config, NOW, session=session) == 0
    assert session.calls == []


def test_cycle_skips_tiktok_and_inactive_channels(conn, config):
    _channel(conn, platform="tiktok")
    ch = _channel(conn)
    conn.execute("UPDATE channels SET is_active = 0 WHERE id = ?", (ch["id"],))
    conn.commit()
    session = FakeSession({})
    run_token_upkeep(conn, config, NOW, session=session)
    assert session.calls == []


def test_cycle_counts_renewals_and_survives_a_crash(conn, config, monkeypatch):
    _channel(conn)
    _channel(conn)
    session = FakeSession({
        "debug_token": _debug(NOW + timedelta(days=3)),
        "refresh_access_token": RENEWED,
    })
    assert run_token_upkeep(conn, config, NOW, session=session) == 2

    # A bug in one channel's step must not stop the cycle.
    import worker.token_upkeep as mod

    def boom(*_a, **_k):
        raise RuntimeError("bug")

    monkeypatch.setattr(mod, "_check_threads", boom)
    conn.execute("UPDATE channels SET token_next_check_at = NULL")
    conn.commit()
    assert run_token_upkeep(conn, config, NOW, session=session) == 0


def test_no_token_ever_reaches_the_log(conn, config, caplog):
    ch = _channel(conn)
    session = FakeSession({
        "debug_token": _debug(NOW + timedelta(days=3)),
        "refresh_access_token": RENEWED,
    })
    logger = logging.getLogger("test-token-upkeep")
    with caplog.at_level(logging.DEBUG, logger="test-token-upkeep"):
        check_channel(conn, config, ch, NOW, session=session, logger=logger)
        # And a network error whose text embeds the token:
        conn.execute("UPDATE channels SET token_next_check_at = NULL")
        session.routes["debug_token"] = requests.ConnectionError(
            f"https://graph.threads.net/x?access_token={NEW}")
        check_channel(conn, config, db.get_channel(conn, ch["id"]), NOW,
                      session=session, logger=logger)
    assert OLD not in caplog.text
    assert NEW not in caplog.text
    row = db.get_channel(conn, ch["id"])
    assert NEW not in (row["token_error"] or "")
