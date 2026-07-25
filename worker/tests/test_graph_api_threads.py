"""Threads publishing calls: exact endpoint paths and parameter encoding.

Threads names its container-status field `status` (not IG's `status_code`), and its
insights envelope for lifetime metrics uses `total_value.value` rather than IG/FB's
`values[0].value` — both are pinned down here since they're easy to get backwards.
"""

import pytest

from worker.graph_api import GraphAPIError, GraphClient


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
    return GraphClient("v1.0", session=FakeSession(responses),
                       base_url="https://graph.threads.net")


def test_text_container_posts_media_type_text_and_text_no_image_url():
    c = client([FakeResponse({"id": "container-1"})])
    out = c.create_threads_container("USER1", "tok", media_type="TEXT", text="hello world")

    url, data = c.session.posts[0]
    assert url == "https://graph.threads.net/v1.0/USER1/threads"
    assert data["media_type"] == "TEXT"
    assert data["text"] == "hello world"
    assert data["access_token"] == "tok"
    assert "image_url" not in data
    assert out == "container-1"


def test_image_container_sends_media_type_image_and_image_url_and_optional_text():
    c = client([FakeResponse({"id": "container-2"})])
    out = c.create_threads_container(
        "USER1", "tok", media_type="IMAGE", image_url="https://x.test/a.jpg", text="caption"
    )

    url, data = c.session.posts[0]
    assert url == "https://graph.threads.net/v1.0/USER1/threads"
    assert data["media_type"] == "IMAGE"
    assert data["image_url"] == "https://x.test/a.jpg"
    assert data["text"] == "caption"
    assert out == "container-2"


def test_carousel_child_sends_is_carousel_item_true():
    c = client([FakeResponse({"id": "child-1"})])
    c.create_threads_container(
        "USER1", "tok", media_type="IMAGE", image_url="https://x.test/a.jpg",
        is_carousel_item=True,
    )

    _url, data = c.session.posts[0]
    assert data["is_carousel_item"] == "true"


def test_carousel_parent_sends_media_type_carousel_and_comma_joined_children():
    c = client([FakeResponse({"id": "parent-1"})])
    out = c.create_threads_container(
        "USER1", "tok", media_type="CAROUSEL", children=["child-1", "child-2"], text="hi"
    )

    _url, data = c.session.posts[0]
    assert data["media_type"] == "CAROUSEL"
    assert data["children"] == "child-1,child-2"
    assert data["text"] == "hi"
    assert out == "parent-1"


def test_get_threads_container_status_reads_status_field():
    c = client([FakeResponse({"status": "FINISHED"})])
    out = c.get_threads_container_status("container-1", "tok")

    url, params = c.session.gets[0]
    assert url == "https://graph.threads.net/v1.0/container-1"
    assert params["fields"] == "status"
    assert out == "FINISHED"


def test_get_threads_container_status_raises_when_status_field_missing():
    """A malformed response (no `status` field) must fail fast, not be treated as a
    permanently-pending status that burns every poll retry."""
    c = client([FakeResponse({})])
    with pytest.raises(GraphAPIError):
        c.get_threads_container_status("container-1", "tok")


def test_publish_threads_container_posts_creation_id_and_returns_id():
    c = client([FakeResponse({"id": "published-1"})])
    out = c.publish_threads_container("USER1", "creation-1", "tok")

    url, data = c.session.posts[0]
    assert url == "https://graph.threads.net/v1.0/USER1/threads_publish"
    assert data["creation_id"] == "creation-1"
    assert out == "published-1"


def test_publishing_limit_reads_usage_and_config():
    c = client([FakeResponse({"data": [
        {"quota_usage": 7, "config": {"quota_total": 250, "quota_duration": 86400}},
    ]})])
    out = c.get_threads_publishing_limit("USER1", "tok")
    assert out == (7, 250, 86400)


def test_publishing_limit_handles_empty_data_safely():
    c = client([FakeResponse({"data": []})])
    out = c.get_threads_publishing_limit("USER1", "tok")
    assert out == (None, None, None)


def test_insights_prefers_total_value_when_present():
    c = client([FakeResponse({"data": [
        {"name": "views", "total_value": {"value": 42}},
    ]})])
    out = c.get_threads_insights("media-1", "tok", ["views"])
    assert out == {"views": 42}


def test_insights_falls_back_to_values_list():
    c = client([FakeResponse({"data": [
        {"name": "likes", "values": [{"value": 9}]},
    ]})])
    out = c.get_threads_insights("media-1", "tok", ["likes"])
    assert out == {"likes": 9}


def test_a_failed_call_raises_graph_api_error():
    c = client([FakeResponse({}, ok=False, status_code=400, text="bad request")])
    with pytest.raises(GraphAPIError):
        c.get_threads_insights("media-1", "tok", ["views"])
