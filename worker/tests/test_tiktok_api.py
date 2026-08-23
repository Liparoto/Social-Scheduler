"""TikTokClient: the OAuth pair and the read-only identity call.

TikTok returns HTTP 200 with {"error": {"code": "access_token_invalid"}} on failure, so the
BODY is the success signal, not the status code — the same trap Telegram's `ok` field sets.
"""

from __future__ import annotations

import pytest

from worker.tiktok_api import TikTokAPIError, TikTokClient


class FakeResponse:
    def __init__(self, payload, status=200, text=""):
        self._payload = payload
        self.status_code = status
        self.ok = status < 400
        self.text = text or str(payload)

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.response

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.response

    def put(self, url, **kwargs):
        self.calls.append(("PUT", url, kwargs))
        return self.response


TOKENS = {
    "access_token": "act.NEW",
    "expires_in": 86400,
    "refresh_token": "rft.ROTATED",
    "refresh_expires_in": 31536000,
    "open_id": "open-1",
}


def test_exchange_code_posts_form_encoded_with_pkce_verifier():
    session = FakeSession(FakeResponse(TOKENS))
    client = TikTokClient(session=session)
    out = client.exchange_code("key", "secret", "code-1", "http://localhost:3939/cb", "verifier-1")
    assert out["access_token"] == "act.NEW"
    _, url, kwargs = session.calls[0]
    assert url.endswith("/v2/oauth/token/")
    # Form-encoded, NOT json — TikTok rejects a JSON body on this endpoint.
    assert kwargs["data"]["grant_type"] == "authorization_code"
    assert kwargs["data"]["code_verifier"] == "verifier-1"
    assert kwargs["data"]["redirect_uri"] == "http://localhost:3939/cb"
    assert "json" not in kwargs


def test_refresh_returns_the_rotated_refresh_token():
    session = FakeSession(FakeResponse(TOKENS))
    client = TikTokClient(session=session)
    out = client.refresh_access_token("key", "secret", "rft.OLD")
    # The whole point: the NEW refresh token must come back, or the channel dies at the
    # next refresh.
    assert out["refresh_token"] == "rft.ROTATED"
    assert session.calls[0][2]["data"]["grant_type"] == "refresh_token"


def test_error_body_on_http_200_still_raises():
    session = FakeSession(
        FakeResponse({"error": {"code": "invalid_grant", "message": "revoked", "log_id": "L1"}})
    )
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "secret", "rft.OLD")
    assert "invalid_grant" in str(exc.value)


def test_secrets_never_appear_in_an_error():
    session = FakeSession(FakeResponse({"error": {"code": "bad", "message": "no"}}))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "SUPERSECRETVALUE", "rft.SENSITIVEVALUE")
    assert "SUPERSECRETVALUE" not in str(exc.value)
    assert "rft.SENSITIVEVALUE" not in str(exc.value)


def test_get_user_info_sends_bearer_and_requested_fields():
    session = FakeSession(
        FakeResponse({"data": {"user": {"display_name": "Kelan"}}, "error": {"code": "ok"}})
    )
    client = TikTokClient(session=session)
    user = client.get_user_info("act.TOKEN", fields=("open_id", "display_name"))
    assert user["display_name"] == "Kelan"
    _, _, kwargs = session.calls[0]
    assert kwargs["headers"]["Authorization"] == "Bearer act.TOKEN"
    assert "display_name" in kwargs["params"]["fields"]


def test_non_json_response_becomes_a_tiktok_error():
    session = FakeSession(FakeResponse(None, status=502, text="<html>bad gateway</html>"))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError):
        client.get_user_info("act.TOKEN")


def test_a_network_failure_never_leaks_the_request_via_the_exception_chain():
    import requests

    class BoomSession:
        def post(self, url, **kwargs):
            raise requests.RequestException("connection to open.tiktokapis.com failed")

    client = TikTokClient(session=BoomSession())
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "secret", "rft.OLD")
    # `from None`, not `from exc`: the original exception's own str() must not survive
    # into a traceback via __cause__, where it could carry the request back out.
    assert exc.value.__cause__ is None
