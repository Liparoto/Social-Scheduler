"""Instagram Stories: the wire format of a STORIES container.

A Story is a DESTINATION, not a post type (docs/design-instagram-stories.md). These tests
pin the two things that are easy to get wrong on the wire: media_type must be STORIES, and
a caption must NEVER be sent — the field does not exist on this surface.

Publisher-level behaviour (fan-out, validation, per-slide isolation) lives in
test_stories_publisher.py; this file is about the Graph client alone.
"""

import pytest

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
    return GraphClient("v25.0", session=FakeSession(responses),
                       base_url="https://graph.facebook.com")


def test_story_image_container_sends_media_type_stories():
    c = client([FakeResponse({"id": "story-1"})])
    out = c.create_story_container("178414", "tok", image_url="https://x.test/a.jpg")

    url, data = c.session.posts[0]
    assert url == "https://graph.facebook.com/v25.0/178414/media"
    assert data["media_type"] == "STORIES"
    assert data["image_url"] == "https://x.test/a.jpg"
    assert data["access_token"] == "tok"
    assert "video_url" not in data
    assert out == "story-1"


def test_story_video_container_uses_video_url():
    c = client([FakeResponse({"id": "story-2"})])
    out = c.create_story_container("178414", "tok", video_url="https://x.test/a.mp4")

    _url, data = c.session.posts[0]
    assert data["media_type"] == "STORIES"
    assert data["video_url"] == "https://x.test/a.mp4"
    assert "image_url" not in data
    assert out == "story-2"


def test_story_container_never_sends_a_caption():
    """Stories have no caption field. There is deliberately no caption parameter to pass."""
    c = client([FakeResponse({"id": "story-3"})])
    c.create_story_container("178414", "tok", image_url="https://x.test/a.jpg")

    _url, data = c.session.posts[0]
    assert "caption" not in data


def test_story_needs_exactly_one_of_image_or_video():
    """Guard against a caller passing both or neither — either is a programming error,
    and Meta's response to it would be far less legible than this."""
    c = client()
    with pytest.raises(ValueError):
        c.create_story_container("178414", "tok")
    with pytest.raises(ValueError):
        c.create_story_container(
            "178414", "tok", image_url="https://x.test/a.jpg",
            video_url="https://x.test/a.mp4",
        )
