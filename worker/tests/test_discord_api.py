"""Discord webhook client: exact request shape and credential-safety checks.

Discord webhooks post directly to a URL that IS the credential (no separate token param),
so every assertion that touches an error message also checks the URL never leaks into it.
"""

import pytest

from worker.discord_api import DiscordAPIError, DiscordClient


class FakeResponse:
    def __init__(self, payload=None, ok=True, status_code=200, text=""):
        self._payload = payload
        self.ok = ok
        self.status_code = status_code
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("No JSON content (empty body)")
        return self._payload


class FakeSession:
    """Records requests and replays queued responses."""

    def __init__(self, responses=None):
        self.posts = []
        self.gets = []
        self._responses = list(responses or [])

    def _next(self):
        return self._responses.pop(0) if self._responses else FakeResponse({"id": "x"})

    def post(self, url, data=None, files=None, json=None, timeout=None):
        self.posts.append((url, data, files, json))
        return self._next()

    def get(self, url, timeout=None):
        self.gets.append(url)
        return self._next()


WEBHOOK_URL = "https://discord.com/api/webhooks/12345/super-secret-token"


def client(responses=None):
    return DiscordClient(session=FakeSession(responses))


def test_text_only_send_posts_json_content_with_no_files_part():
    c = client([FakeResponse({"id": "msg-1"})])
    out = c.send_message(WEBHOOK_URL, content="hello world")

    url, data, files, json_body = c.session.posts[0]
    assert url == WEBHOOK_URL
    assert json_body == {"content": "hello world"}
    assert data is None
    assert files is None
    assert out == {"id": "msg-1"}


def test_one_image_send_uses_multipart_with_payload_json_and_files0():
    c = client([FakeResponse({"id": "msg-2"})])
    c.send_message(WEBHOOK_URL, content="caption", files=[("a.jpg", b"bytes-a")])

    url, data, files, json_body = c.session.posts[0]
    assert url == WEBHOOK_URL
    assert json_body is None
    assert data is not None
    import json as jsonlib
    assert jsonlib.loads(data["payload_json"]) == {"content": "caption"}
    assert files["files[0]"] == ("a.jpg", b"bytes-a")


def test_three_images_send_files0_through_files2():
    c = client([FakeResponse({"id": "msg-3"})])
    c.send_message(
        WEBHOOK_URL,
        files=[("a.jpg", b"1"), ("b.jpg", b"2"), ("c.jpg", b"3")],
    )

    _url, _data, files, _json_body = c.session.posts[0]
    assert files["files[0]"] == ("a.jpg", b"1")
    assert files["files[1]"] == ("b.jpg", b"2")
    assert files["files[2]"] == ("c.jpg", b"3")


def test_get_webhook_gets_the_url_and_returns_the_object():
    c = client([FakeResponse({"id": "wh-1", "name": "bot", "channel_id": "chan-1"})])
    out = c.get_webhook(WEBHOOK_URL)

    assert c.session.gets[0] == WEBHOOK_URL
    assert out == {"id": "wh-1", "name": "bot", "channel_id": "chan-1"}


def test_non_ok_response_raises_discord_api_error():
    c = client([FakeResponse({"message": "bad request"}, ok=False, status_code=400, text="bad request")])
    with pytest.raises(DiscordAPIError):
        c.send_message(WEBHOOK_URL, content="hi")


def test_webhook_url_never_appears_in_raised_message():
    c = client([FakeResponse(None, ok=False, status_code=401, text="Unauthorized")])
    with pytest.raises(DiscordAPIError) as excinfo:
        c.send_message(WEBHOOK_URL, content="hi")
    assert WEBHOOK_URL not in str(excinfo.value)
    # also make sure the token segment specifically never leaks
    assert "super-secret-token" not in str(excinfo.value)


def test_get_webhook_error_also_scrubs_url():
    c = client([FakeResponse(None, ok=False, status_code=404, text="Unknown Webhook")])
    with pytest.raises(DiscordAPIError) as excinfo:
        c.get_webhook(WEBHOOK_URL)
    assert WEBHOOK_URL not in str(excinfo.value)
    assert "super-secret-token" not in str(excinfo.value)


def test_send_message_defensively_parses_empty_204_body():
    c = client([FakeResponse(None, ok=True, status_code=204, text="")])
    out = c.send_message(WEBHOOK_URL, content="hi")
    assert out == {}


def test_send_message_requires_content_or_files():
    c = client()
    with pytest.raises(ValueError):
        c.send_message(WEBHOOK_URL)
