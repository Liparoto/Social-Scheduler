"""Facebook video: surface picks the endpoint, and the id we store is the FEED POST id.

The id-resolution risk is the point of this file: create_page_video/create_page_reel
return the VIDEO node, but Facebook metrics (get_page_post_summary) read reactions,
comments, and shares off the FEED POST node. Those are different graph nodes, and
resolving one to the other is a three-step fallback (see _resolve_fb_post_id in
publisher.py) — this suite exercises all three steps discretely, including proving
step 1 (post_id already in the publish response) skips the step-2 lookup entirely.
"""

import pytest

from worker.publisher import _NonRetryable, _publish_facebook


class FakeClient:
    """create_page_video/create_page_reel return the FULL response dict (not a bare
    id string) — matching create_page_photo's convention. video_response controls
    exactly what that dict contains, so tests can control whether post_id is present.
    """

    def __init__(self, statuses=None, video_response=None, lookup_post_id="LOOKUP1"):
        self.calls = []
        self.lookup_calls = []
        self._statuses = list(statuses or ["FINISHED"])
        self._video_response = dict(video_response if video_response is not None else {"id": "v1"})
        self._lookup_post_id = lookup_post_id

    def create_page_video(self, page_id, file_url, token, description=None):
        self.calls.append(("video", page_id, file_url, description))
        return dict(self._video_response)

    def create_page_reel(self, page_id, file_url, token, description=None):
        self.calls.append(("reel", page_id, file_url, description))
        response = dict(self._video_response)
        response.setdefault("video_id", response.get("id", "v1"))
        return response

    def get_page_video_status(self, video_id, token):
        return self._statuses.pop(0) if self._statuses else "FINISHED"

    def get_page_video_post_id(self, video_id, token):
        self.lookup_calls.append(video_id)
        return self._lookup_post_id


class Cfg:
    reels_status_poll_interval = 0
    reels_status_poll_max_tries = 3
    status_poll_interval = 0
    status_poll_max_tries = 3


def _plan(surface):
    return {
        "account_id": "PAGE", "post_type": "video", "surface": surface,
        "asset_urls": ["https://x.test/a.mp4"], "caption": "hello", "media_kind": "video",
    }


def test_feed_surface_uses_the_videos_edge():
    client = FakeClient(video_response={"id": "v1", "post_id": "POST1"})
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert client.calls[0][0] == "video"
    assert result == "POST1"


def test_reel_surface_uses_the_reels_edge():
    client = FakeClient(video_response={"id": "v1", "post_id": "POST1"})
    result = _publish_facebook(client, _plan("reel"), "TOK", Cfg(), lambda _s: None)
    assert client.calls[0][0] == "reel"
    assert result == "POST1"


def test_it_polls_until_finished_before_resolving():
    client = FakeClient(statuses=["processing", "processing", "FINISHED"],
                         video_response={"id": "v1", "post_id": "POST1"})
    _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert client._statuses == []


def test_a_failed_transcode_is_terminal_not_silent():
    client = FakeClient(statuses=["ERROR"])
    with pytest.raises(RuntimeError, match="ERROR"):
        _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)


def test_an_unknown_surface_is_refused_terminally():
    with pytest.raises(_NonRetryable, match="surface"):
        _publish_facebook(client=FakeClient(), plan=_plan("story"), token="TOK",
                          config=Cfg(), sleep_fn=lambda _s: None)


# -- Three-step id resolution -----------------------------------------------------
# Case 1: post_id is already in the publish response -> use it directly, and the
# step-2 lookup must NOT run. Avoiding that needless round-trip is the entire point
# of checking the response first.
def test_post_id_in_publish_response_is_used_without_a_lookup():
    client = FakeClient(video_response={"id": "v1", "post_id": "POST1"},
                         lookup_post_id="SHOULD_NOT_BE_USED")
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert result == "POST1"
    assert client.lookup_calls == []


# Case 2: post_id absent from the response, but the follow-up GET resolves one.
def test_missing_post_id_falls_back_to_the_lookup():
    client = FakeClient(video_response={"id": "v1"}, lookup_post_id="LOOKUP1")
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert result == "LOOKUP1"
    assert client.lookup_calls == ["v1"]


# Case 3: neither the response nor the lookup has a post_id -> never lose the id
# entirely, fall back to the video id so a human can still find the post.
def test_missing_post_id_and_failed_lookup_falls_back_to_the_video_id():
    client = FakeClient(video_response={"id": "v1"}, lookup_post_id=None)
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert result == "v1"
    assert client.lookup_calls == ["v1"]


def test_reel_id_resolution_also_falls_back_to_the_video_id():
    client = FakeClient(video_response={"id": "v1"}, lookup_post_id=None)
    result = _publish_facebook(client, _plan("reel"), "TOK", Cfg(), lambda _s: None)
    assert result == "v1"
    assert client.lookup_calls == ["v1"]
