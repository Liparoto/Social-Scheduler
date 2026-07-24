"""Facebook Page publishing calls: exact endpoint paths and parameter encoding.

attached_media has to be sent as indexed, JSON-encoded form fields
(attached_media[0]={"media_fbid":"1"}), which is the fiddly part worth pinning down.
"""

import json

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
    return GraphClient("v25.0", session=FakeSession(responses),
                       base_url="https://graph.facebook.com")


def test_published_photo_posts_url_and_caption_to_the_photos_edge():
    c = client([FakeResponse({"id": "photo-1", "post_id": "page_1_post_1"})])
    out = c.create_page_photo("PAGE1", "https://x.test/a.jpg", "tok", caption="hi")

    url, data = c.session.posts[0]
    assert url == "https://graph.facebook.com/v25.0/PAGE1/photos"
    assert data["url"] == "https://x.test/a.jpg"
    assert data["caption"] == "hi"
    assert data["published"] == "true"
    assert data["access_token"] == "tok"
    assert out == {"id": "photo-1", "post_id": "page_1_post_1"}


def test_unpublished_photo_sends_published_false_and_no_caption():
    # Carousel children are uploaded unpublished; the text belongs on the feed post,
    # so a caption here would be dead weight (and shows up nowhere).
    c = client([FakeResponse({"id": "photo-1"})])
    c.create_page_photo("PAGE1", "https://x.test/a.jpg", "tok",
                        caption="ignored", published=False)

    _url, data = c.session.posts[0]
    assert data["published"] == "false"
    assert "caption" not in data


def test_feed_post_encodes_attached_media_as_indexed_json_fields():
    c = client([FakeResponse({"id": "page_1_post_9"})])
    post_id = c.create_page_feed_post("PAGE1", "tok", message="two photos",
                                      attached_media=["11", "22"])

    url, data = c.session.posts[0]
    assert url == "https://graph.facebook.com/v25.0/PAGE1/feed"
    assert data["message"] == "two photos"
    assert json.loads(data["attached_media[0]"]) == {"media_fbid": "11"}
    assert json.loads(data["attached_media[1]"]) == {"media_fbid": "22"}
    assert post_id == "page_1_post_9"


def test_post_summary_flattens_reactions_comments_and_shares():
    c = client([FakeResponse({
        "reactions": {"summary": {"total_count": 12}},
        "comments": {"summary": {"total_count": 3}},
        "shares": {"count": 2},
        "id": "page_1_post_1",
    })])
    out = c.get_page_post_summary("page_1_post_1", "tok")

    _url, params = c.session.gets[0]
    assert "reactions.summary(total_count)" in params["fields"]
    assert "comments.summary(total_count)" in params["fields"]
    assert "shares" in params["fields"]
    assert out == {"fb_reactions": 12, "fb_comments": 3, "fb_shares": 2}


def test_post_summary_omits_fields_facebook_didnt_return():
    # A post with zero shares has no "shares" key at all — that must not become 0,
    # and must not blow up.
    c = client([FakeResponse({"reactions": {"summary": {"total_count": 1}}})])
    assert c.get_page_post_summary("p1", "tok") == {"fb_reactions": 1}


def test_page_post_insights_parses_the_standard_insights_shape():
    c = client([FakeResponse({"data": [
        {"name": "post_total_media_view_unique", "values": [{"value": 40}]},
    ]})])
    out = c.get_page_post_insights("p1", "tok", ["post_total_media_view_unique"])

    _url, params = c.session.gets[0]
    assert params["metric"] == "post_total_media_view_unique"
    assert out == {"post_total_media_view_unique": 40}


def test_a_failed_call_raises_graph_api_error():
    c = client([FakeResponse({}, ok=False, status_code=400, text="(#100) invalid metric")])
    with pytest.raises(GraphAPIError):
        c.get_page_post_insights("p1", "tok", ["post_impressions"])
