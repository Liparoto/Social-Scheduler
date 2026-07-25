"""Telegram Bot API client: exact request shape and credential-safety checks.

Telegram's bot token sits in the URL path (/bot<token>/<method>), so every assertion
that touches an error message also checks the token never leaks into it. Telegram can
also return {"ok": false, ...} with an HTTP 200, so success must be judged on the `ok`
field, not the status code.
"""

import pytest

from worker.telegram_api import TelegramAPIError, TelegramClient


class FakeResponse:
    def __init__(self, payload, ok=True, status_code=200, text=""):
        self._payload = payload
        self.ok = ok
        self.status_code = status_code
        self.text = text

    def json(self):
        return self._payload


class FakeSession:
    """Records requests and replays queued responses."""

    def __init__(self, responses=None):
        self.posts = []
        self._responses = list(responses or [])

    def _next(self):
        return self._responses.pop(0) if self._responses else FakeResponse({"ok": True, "result": {}})

    def post(self, url, data=None, files=None, timeout=None):
        self.posts.append((url, data, files))
        return self._next()


TOKEN = "123456:ABC-DEF-super-secret-token"


def client(responses=None):
    return TelegramClient(session=FakeSession(responses))


def test_send_message_posts_chat_id_and_text_to_sendmessage():
    c = client([FakeResponse({"ok": True, "result": {"message_id": 1}})])
    out = c.send_message(TOKEN, "chat-1", "hello world")

    url, data, files = c.session.posts[0]
    assert url == f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    assert data == {"chat_id": "chat-1", "text": "hello world"}
    assert files is None
    assert out == {"message_id": 1}


def test_send_photo_posts_multipart_with_caption():
    c = client([FakeResponse({"ok": True, "result": {"message_id": 2}})])
    out = c.send_photo(TOKEN, "chat-1", ("a.jpg", b"bytes-a"), caption="a caption")

    url, data, files = c.session.posts[0]
    assert url == f"https://api.telegram.org/bot{TOKEN}/sendPhoto"
    assert data["chat_id"] == "chat-1"
    assert data["caption"] == "a caption"
    assert files["photo"] == ("a.jpg", b"bytes-a")
    assert out == {"message_id": 2}


def test_send_photo_without_caption_omits_it():
    c = client([FakeResponse({"ok": True, "result": {}})])
    c.send_photo(TOKEN, "chat-1", ("a.jpg", b"bytes-a"))

    _url, data, _files = c.session.posts[0]
    assert "caption" not in data


def test_send_media_group_builds_media_array_with_attach_names_and_caption_on_first():
    c = client([FakeResponse({"ok": True, "result": [{"message_id": 3}, {"message_id": 4}]})])
    out = c.send_media_group(
        TOKEN,
        "chat-1",
        [("a.jpg", b"1"), ("b.jpg", b"2")],
        caption="group caption",
    )

    url, data, files = c.session.posts[0]
    assert url == f"https://api.telegram.org/bot{TOKEN}/sendMediaGroup"
    assert data["chat_id"] == "chat-1"
    import json
    media = json.loads(data["media"])
    assert media[0] == {"type": "photo", "media": "attach://file0", "caption": "group caption"}
    assert media[1] == {"type": "photo", "media": "attach://file1"}
    assert files["file0"] == ("a.jpg", b"1")
    assert files["file1"] == ("b.jpg", b"2")
    assert out == [{"message_id": 3}, {"message_id": 4}]


def test_ok_false_raises_telegram_api_error_even_on_http_200():
    c = client([FakeResponse({"ok": False, "description": "chat not found"}, ok=True, status_code=200)])
    with pytest.raises(TelegramAPIError):
        c.send_message(TOKEN, "chat-1", "hi")


def test_non_ok_http_status_also_raises():
    c = client([FakeResponse({"ok": False, "description": "unauthorized"}, ok=False, status_code=401)])
    with pytest.raises(TelegramAPIError):
        c.send_message(TOKEN, "chat-1", "hi")


def test_bot_token_never_appears_in_raised_message():
    c = client([FakeResponse({"ok": False, "description": "bad request"}, ok=False, status_code=400)])
    with pytest.raises(TelegramAPIError) as excinfo:
        c.send_message(TOKEN, "chat-1", "hi")
    assert TOKEN not in str(excinfo.value)
    assert "super-secret-token" not in str(excinfo.value)


def test_bot_token_never_appears_in_raised_message_for_media_group():
    c = client([FakeResponse({"ok": False, "description": "bad request"}, ok=False, status_code=400)])
    with pytest.raises(TelegramAPIError) as excinfo:
        c.send_media_group(TOKEN, "chat-1", [("a.jpg", b"1")])
    assert TOKEN not in str(excinfo.value)
    assert "super-secret-token" not in str(excinfo.value)


class RaisingSession:
    """A session whose post raises a network-layer error carrying the real bot token,
    exactly like a genuine requests.ConnectionError would (its message embeds the request
    URL, and the token lives in that URL's path)."""

    def post(self, url, data=None, files=None, timeout=None):
        import requests

        raise requests.ConnectionError(
            f"HTTPSConnectionPool(host='api.telegram.org', port=443): Max retries "
            f"exceeded with url: {url} (Caused by NewConnectionError('...'))"
        )


def test_send_message_network_failure_raises_without_leaking_token():
    c = TelegramClient(session=RaisingSession())
    with pytest.raises(TelegramAPIError) as excinfo:
        c.send_message(TOKEN, "chat-1", "hi")
    message = str(excinfo.value)
    assert TOKEN not in message
    assert "super-secret-token" not in message
    # still says something useful: it was a connection failure to Telegram's API
    assert "api.telegram.org" in message
    assert "ConnectionError" in message or "connection" in message.lower()


class NonJsonResponse:
    """A response whose body isn't JSON at all — e.g. an HTML 502 from an intermediary
    CDN in front of Telegram's API — exactly like real `requests`, whose .json() raises
    a (requests-wrapped) json.JSONDecodeError, a ValueError subclass, in that case."""

    def __init__(self):
        self.ok = False
        self.status_code = 502
        self.text = "<html><body>502 Bad Gateway</body></html>"

    def json(self):
        raise ValueError("Expecting value: line 1 column 1 (char 0)")


class NonJsonSession:
    def post(self, url, data=None, files=None, timeout=None):
        return NonJsonResponse()


def test_non_json_response_raises_telegram_api_error_not_raw_json_decode_error():
    """resp.json() used to be called outside the try/except, so a non-JSON response
    (e.g. an HTML error page) escaped as a raw ValueError/JSONDecodeError instead of the
    client's own TelegramAPIError — breaking the invariant that only TelegramAPIError
    ever leaves this client."""
    c = TelegramClient(session=NonJsonSession())
    with pytest.raises(TelegramAPIError) as excinfo:
        c.send_message(TOKEN, "chat-1", "hi")
    message = str(excinfo.value)
    assert TOKEN not in message
    assert "502" in message
