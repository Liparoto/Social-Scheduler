"""Reels publishing: container creation, cover offset, and the longer poll budget.

Follows the same fake-session idiom as test_graph_api_threads.py / test_graph_api_facebook.py
(GraphClient is the real class name; the brief's draft invented a nonexistent
`GraphAPIClient(base_url=..., version=...)` API that doesn't match worker/graph_api.py).
"""

from dataclasses import fields

from worker.graph_api import GraphClient


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
        self.gets = []
        self._responses = list(responses or [])

    def _next(self):
        return self._responses.pop(0) if self._responses else FakeResponse({"id": "x"})

    def post(self, url, data=None, timeout=None):
        self.posts.append((url, data))
        return self._next()

    def get(self, url, params=None, timeout=None):
        self.gets.append((url, params))
        return self._next()


def client(responses=None):
    return GraphClient(
        "v25.0", session=FakeSession(responses), base_url="https://graph.facebook.com"
    )


def test_create_video_container_sends_reels_media_type():
    c = client([FakeResponse({"id": "CONTAINER1"})])
    got = c.create_video_container("IG1", "https://x/v.mp4", "TOKEN", caption="hi")

    assert got == "CONTAINER1"
    url, data = c.session.posts[0]
    assert url == "https://graph.facebook.com/v25.0/IG1/media"
    assert data["media_type"] == "REELS"
    assert data["video_url"] == "https://x/v.mp4"
    assert data["caption"] == "hi"
    # Not chosen -> not sent at all, so Meta applies its own default (frame 0).
    assert "thumb_offset" not in data


def test_create_video_container_sends_thumb_offset_when_given():
    c = client([FakeResponse({"id": "C2"})])
    c.create_video_container("IG1", "https://x/v.mp4", "TOKEN", thumb_offset=2400)

    _url, data = c.session.posts[0]
    assert data["thumb_offset"] == 2400


def test_thumb_offset_zero_is_sent_not_dropped():
    """0 is a legitimate explicit choice (the first frame) and must survive the
    falsy check that `if thumb_offset:` would get wrong."""
    c = client([FakeResponse({"id": "C3"})])
    c.create_video_container("IG1", "https://x/v.mp4", "TOKEN", thumb_offset=0)

    _url, data = c.session.posts[0]
    assert data["thumb_offset"] == 0


def test_reels_poll_budget_is_longer_than_the_image_budget():
    from worker.config import Config

    defaults = {f.name: f.default for f in fields(Config)}
    interval = defaults["reels_status_poll_interval"]
    tries = defaults["reels_status_poll_max_tries"]
    assert interval * tries >= 900, "Reels need at least a 15-minute ceiling"

    image_budget = defaults["status_poll_interval"] * defaults["status_poll_max_tries"]
    assert interval * tries > image_budget
