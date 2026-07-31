"""Profile-photo URL lookups and the raw-bytes download, per platform.

The key behaviour these lock down is the difference between "no photo" (returns None,
the caller falls back to the initial circle) and "the request failed" (raises, the
caller records avatar_error and keeps whatever photo it already had).
"""

from __future__ import annotations

import pytest

from worker.graph_api import GraphAPIError, GraphClient


class FakeResponse:
    def __init__(self, payload=None, *, status=200, content=b"", text=""):
        self._payload = payload if payload is not None else {}
        self.status_code = status
        self.ok = 200 <= status < 300
        self.content = content
        self.text = text
        self.headers = {}
        self.yielded = 0  # Track total bytes yielded for early-stop validation

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=8192):
        for i in range(0, len(self.content), chunk_size):
            chunk = self.content[i : i + chunk_size]
            self.yielded += len(chunk)
            yield chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, params=None, timeout=None, stream=False):
        self.calls.append((url, params, stream))
        return self.response


def _client(response):
    session = FakeSession(response)
    return GraphClient("v25.0", session=session), session


def test_instagram_returns_the_profile_picture_url():
    client, session = _client(FakeResponse({"profile_picture_url": "https://cdn/ig.jpg"}))
    assert client.get_instagram_profile_picture_url("ig1", "tok") == "https://cdn/ig.jpg"
    _, params, _ = session.calls[0]
    assert params["fields"] == "profile_picture_url"


def test_instagram_returns_none_when_the_field_is_absent():
    client, _ = _client(FakeResponse({"id": "ig1"}))
    assert client.get_instagram_profile_picture_url("ig1", "tok") is None


def test_facebook_unwraps_the_nested_picture_payload():
    client, _ = _client(
        FakeResponse({"picture": {"data": {"url": "https://cdn/fb.jpg",
                                           "is_silhouette": False}}})
    )
    assert client.get_page_picture_url("page1", "tok") == "https://cdn/fb.jpg"


def test_facebook_treats_the_default_silhouette_as_no_photo():
    # is_silhouette means the Page never set a picture — Meta still returns a URL, to a
    # generic grey figure. Storing that is strictly worse than our initial circle, which
    # at least identifies the account.
    client, _ = _client(
        FakeResponse({"picture": {"data": {"url": "https://cdn/blank.jpg",
                                           "is_silhouette": True}}})
    )
    assert client.get_page_picture_url("page1", "tok") is None


def test_threads_returns_its_own_field_name():
    client, session = _client(
        FakeResponse({"threads_profile_picture_url": "https://cdn/th.jpg"})
    )
    assert client.get_threads_profile_picture_url("th1", "tok") == "https://cdn/th.jpg"
    _, params, _ = session.calls[0]
    assert params["fields"] == "threads_profile_picture_url"


def test_a_failed_lookup_raises_rather_than_returning_none():
    client, _ = _client(FakeResponse(status=400, text="Bad token"))
    with pytest.raises(GraphAPIError):
        client.get_instagram_profile_picture_url("ig1", "tok")


def test_download_returns_the_raw_bytes():
    client, session = _client(FakeResponse(content=b"\xff\xd8\xffhello"))
    assert client.download_image_bytes("https://cdn/ig.jpg") == b"\xff\xd8\xffhello"
    _, _, stream = session.calls[0]
    assert stream is True, "the download must stream so max_bytes can stop it early"


def test_download_refuses_a_response_larger_than_max_bytes():
    # Payload must be > chunk_size (8192) so iter_content yields multiple chunks.
    # This tests that the download stops early rather than buffering everything
    # and checking the size afterward — a naive implementation would buffer all 30000
    # bytes before checking > 1000, while the real streaming one stops after ~1000.
    response = FakeResponse(content=b"x" * 30000)
    client, _ = _client(response)
    with pytest.raises(GraphAPIError, match="too large"):
        client.download_image_bytes("https://cdn/ig.jpg", max_bytes=1000)
    # Assert the download stopped early: yielded total must be well below the full 30000.
    # We allow a few chunks worth of overshoot (8192 * 1 = ~8KB overhead), but nowhere
    # near all 30000 bytes.
    assert response.yielded < 10000, (
        f"expected early stop (< 10000 bytes yielded), but got {response.yielded}; "
        f"streaming check failed — naive buffer-then-check would not stop early"
    )
