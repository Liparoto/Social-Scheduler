"""Facebook video: surface picks the endpoint, and the id we store is the FEED POST id.

The id-resolution risk is the point of this file: create_page_video/create_page_reel
return the VIDEO node, but Facebook metrics (get_page_post_summary) read reactions,
comments, and shares off the FEED POST node. Those are different graph nodes, and
resolving one to the other is a three-step fallback (see _resolve_fb_post_id in
publisher.py) — this suite exercises all three steps discretely, including proving
step 1 (post_id already in the publish response) skips the step-2 lookup entirely.

It also exercises the asymmetric safety property that governs this whole file: unlike
Instagram (which polls BEFORE publish_container, so any poll failure is safe to raise
and retry), Facebook's create call has ALREADY published the video by the time polling
or id-resolution runs. So nothing after the create call may raise in a way that causes
publish_one to retry — a retry there means create_page_video/create_page_reel gets
called AGAIN against an already-live post. Only a definitive "processing failed"
signal (ERROR/EXPIRED) may fail the send.
"""

import pytest

from worker.publisher import _NonRetryable, _publish_facebook


class FakeClient:
    """create_page_video/create_page_reel return the FULL response dict (not a bare
    id string) — matching create_page_photo's convention. video_response controls
    exactly what that dict contains, so tests can control whether post_id is present.

    A status of "RAISE" makes get_page_video_status raise instead of returning a
    status, simulating a network blip mid-poll. lookup_raises makes
    get_page_video_post_id raise instead of returning, simulating the same on the
    id-resolution GET.
    """

    def __init__(self, statuses=None, video_response=None, lookup_post_id="LOOKUP1",
                 lookup_raises=False):
        self.calls = []
        self.lookup_calls = []
        self._statuses = list(statuses if statuses is not None else ["FINISHED"])
        self._video_response = dict(video_response if video_response is not None else {"id": "v1"})
        self._lookup_post_id = lookup_post_id
        self._lookup_raises = lookup_raises

    def create_page_video(self, page_id, file_url, token, description=None):
        self.calls.append(("video", page_id, file_url, description))
        return dict(self._video_response)

    def create_page_reel(self, page_id, file_url, token, description=None):
        self.calls.append(("reel", page_id, file_url, description))
        response = dict(self._video_response)
        response.setdefault("video_id", response.get("id", "v1"))
        return response

    def get_page_video_status(self, video_id, token):
        status = self._statuses.pop(0) if self._statuses else "FINISHED"
        if status == "RAISE":
            raise ConnectionError("simulated network blip")
        return status

    def get_page_video_post_id(self, video_id, token):
        self.lookup_calls.append(video_id)
        if self._lookup_raises:
            raise RuntimeError("simulated graph api 500")
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


def test_a_failed_transcode_raises_and_is_retryable_not_silent():
    """ERROR/EXPIRED means the video never went live: raising here IS safe (nothing was
    published), and the plain RuntimeError is retryable, not terminal — unlike
    _NonRetryable, publish_one backs off and tries again rather than failing forever."""
    client = FakeClient(statuses=["ERROR"])
    with pytest.raises(RuntimeError, match="ERROR"):
        _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)


def test_an_unknown_surface_is_refused_terminally():
    with pytest.raises(_NonRetryable, match="surface"):
        _publish_facebook(client=FakeClient(), plan=_plan("story"), token="TOK",
                          config=Cfg(), sleep_fn=lambda _s: None)


# -- Reels poll budget, actually proven -------------------------------------------
# A Cfg where the image and Reels budgets are equal (like the one above) passes
# identically whether the code uses the right budget or the wrong one — it proves
# nothing. These pin it: the image budget is deliberately too low (2 tries) to ever
# reach the 3rd poll's FINISHED, so reaching it at all is only possible via the Reels
# budget. Mirrors test_publish_reel_passes_cover_offset_and_uses_the_reels_budget in
# test_reels_publish.py.
class _DistinctBudgetCfg:
    status_poll_interval = 5
    status_poll_max_tries = 2
    reels_status_poll_interval = 10
    reels_status_poll_max_tries = 90


def test_feed_video_uses_the_reels_budget_not_the_image_one():
    client = FakeClient(statuses=["processing", "processing", "FINISHED"],
                         video_response={"id": "v1", "post_id": "POST1"})
    sleeps = []
    result = _publish_facebook(client, _plan("feed"), "TOK", _DistinctBudgetCfg(), sleeps.append)
    assert result == "POST1"
    # All 3 statuses consumed: only reachable with max_tries=90 (Reels), not 2 (image).
    assert client._statuses == []
    # Slept at the Reels interval (10), never the image one (5).
    assert sleeps == [10, 10]


def test_reel_video_uses_the_reels_budget_not_the_image_one():
    client = FakeClient(statuses=["processing", "processing", "FINISHED"],
                         video_response={"id": "v1", "post_id": "POST1"})
    sleeps = []
    result = _publish_facebook(client, _plan("reel"), "TOK", _DistinctBudgetCfg(), sleeps.append)
    assert result == "POST1"
    assert client._statuses == []
    assert sleeps == [10, 10]


# -- The post is already live: nothing after create() may cause a re-publish -------
def test_poll_budget_exhaustion_is_not_terminal_and_still_records_the_post():
    """Meta is just slow; the video is already live. Exhausting the poll budget must
    return the resolved post id, not raise — raising here would make publish_one
    retry, and a retry re-publishes an already-live video."""
    client = FakeClient(statuses=["processing", "processing", "processing"],
                         video_response={"id": "v1", "post_id": "POST1"})
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert result == "POST1"
    assert client._statuses == []


def test_poll_status_check_raising_is_not_terminal_and_still_records_the_post():
    """A network blip mid-poll must be treated like exhaustion, not like ERROR: we
    know the video published, we just don't know its processing state."""
    client = FakeClient(statuses=["RAISE"], video_response={"id": "v1", "post_id": "POST1"})
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert result == "POST1"


def test_post_id_lookup_raising_falls_back_to_the_video_id_without_escaping():
    """get_page_video_post_id's _get raises on any non-2xx/network failure — it does
    NOT return None for that case. That exception must never escape _resolve_fb_post_id:
    the video is already live, so letting it propagate would mark the publish
    retryable and cause a duplicate create_page_video/create_page_reel call."""
    client = FakeClient(video_response={"id": "v1"}, lookup_raises=True)
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert result == "v1"
    assert client.lookup_calls == ["v1"]


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


# -- Finding 2 (final review): no video_id/id at all must be TERMINAL, not retryable --
def test_missing_video_id_in_create_response_is_terminal_not_retryable():
    """This happens AFTER the create call — the video is already live on the Page. A
    plain RuntimeError here would be caught by publish_one's generic handler and
    retried, and a retry means create_page_video runs AGAIN against a Page where the
    video is already live: the exact double-post the governing principle at the top of
    this file forbids. _NonRetryable records it as a visible terminal failure instead."""
    client = FakeClient(video_response={})
    with pytest.raises(_NonRetryable, match="had no"):
        _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
