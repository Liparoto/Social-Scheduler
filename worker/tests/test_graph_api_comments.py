"""First-comment API calls: exact endpoint paths and parameter encoding.

Instagram posts a comment to the media's comment edge. Threads has no comment edge at
all — it reuses the ordinary container endpoint with reply_to_id — so the two are pinned
down side by side here, since assuming they work the same way is the easy mistake.
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


def ig_client(responses=None):
    return GraphClient("v25.0", session=FakeSession(responses),
                       base_url="https://graph.instagram.com")


def threads_client(responses=None):
    return GraphClient("v1.0", session=FakeSession(responses),
                       base_url="https://graph.threads.net")


# ---- Instagram comment edge ----------------------------------------------------------
def test_create_comment_posts_message_to_the_media_comment_edge():
    c = ig_client([FakeResponse({"id": "comment-1"})])
    out = c.create_comment("MEDIA1", "#tags #here", "tok")

    url, data = c.session.posts[0]
    assert url == "https://graph.instagram.com/v25.0/MEDIA1/comments"
    assert data == {"message": "#tags #here", "access_token": "tok"}
    assert out == "comment-1"


def test_over_length_comment_fails_before_any_request():
    """Meta's own error for this says nothing about length, and by the time it arrives
    the post is already live — so the check happens here, before the call."""
    c = ig_client()
    with pytest.raises(GraphAPIError) as exc:
        c.create_comment("MEDIA1", "x" * 2201, "tok")

    assert "2200" in str(exc.value)
    assert c.session.posts == []  # nothing was sent


def test_comment_at_exactly_the_limit_is_allowed():
    c = ig_client([FakeResponse({"id": "comment-1"})])
    assert c.create_comment("MEDIA1", "x" * 2200, "tok") == "comment-1"


def test_comment_api_error_is_wrapped_and_redacted():
    c = ig_client([FakeResponse(
        {}, ok=False, status_code=400,
        text='{"error":{"message":"blah access_token=SECRETVALUE"}}',
    )])
    with pytest.raises(GraphAPIError) as exc:
        c.create_comment("MEDIA1", "#tags", "tok")

    assert "SECRETVALUE" not in str(exc.value)


# ---- Threads self-reply --------------------------------------------------------------
def test_reply_container_sends_reply_to_id_on_the_normal_threads_endpoint():
    c = threads_client([FakeResponse({"id": "reply-cont-1"})])
    out = c.create_threads_container(
        "USER1", "tok", media_type="TEXT", text="#tags", reply_to_id="THREAD1"
    )

    url, data = c.session.posts[0]
    assert url == "https://graph.threads.net/v1.0/USER1/threads"
    assert data["reply_to_id"] == "THREAD1"
    assert data["media_type"] == "TEXT"
    assert data["text"] == "#tags"
    assert out == "reply-cont-1"


def test_ordinary_threads_container_still_omits_reply_to_id():
    """Adding the parameter must not change a single byte of the publish path."""
    c = threads_client([FakeResponse({"id": "cont-1"})])
    c.create_threads_container("USER1", "tok", media_type="TEXT", text="hello")

    _, data = c.session.posts[0]
    assert "reply_to_id" not in data


# ---- Threads topic tag ----------------------------------------------------------------
def test_topic_tag_is_sent_without_its_hash():
    """The API takes the bare word; sending '#Tag' would tag the post '#Tag'."""
    c = threads_client([FakeResponse({"id": "cont-1"})])
    c.create_threads_container(
        "USER1", "tok", media_type="TEXT", text="#Tag and #More", topic_tag="Tag"
    )

    _, data = c.session.posts[0]
    assert data["topic_tag"] == "Tag"
    # The text goes out untouched, hashes and all — declaring the tag is the whole point.
    assert data["text"] == "#Tag and #More"


def test_omitted_topic_tag_is_absent_from_the_payload():
    """Not None-valued, absent. An empty topic_tag is not the same as no topic_tag."""
    c = threads_client([FakeResponse({"id": "cont-1"})])
    c.create_threads_container("USER1", "tok", media_type="TEXT", text="hello")

    _, data = c.session.posts[0]
    assert "topic_tag" not in data
