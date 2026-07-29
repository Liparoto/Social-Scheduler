"""Reels publishing: container creation, cover offset, and the longer poll budget.

Follows the same fake-session idiom as test_graph_api_threads.py / test_graph_api_facebook.py
(GraphClient is the real class name; the brief's draft invented a nonexistent
`GraphAPIClient(base_url=..., version=...)` API that doesn't match worker/graph_api.py).
"""

from dataclasses import fields

import pytest

from worker import publisher
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


def test_reel_is_an_allowed_post_type():
    assert "reel" in publisher.SUPPORTED_POST_TYPES


def test_reel_needs_exactly_one_video_asset():
    post = {"post_type": "reel", "first_comment": None}
    caps_ok = [{"id": 1, "media_kind": "video", "storage_path": "a.mp4"}]
    # one video: fine
    publisher._validate(post, caps_ok, True, "https://x", "instagram", caption="hi")

    # two assets: refused
    with pytest.raises(publisher._NonRetryable, match="exactly 1"):
        publisher._validate(post, caps_ok * 2, True, "https://x", "instagram", caption="hi")

    # an IMAGE asset: refused. This is the guard that stops a mis-typed post from
    # sending a JPEG to the REELS endpoint.
    with pytest.raises(publisher._NonRetryable, match="video"):
        publisher._validate(
            post,
            [{"id": 1, "media_kind": "image", "storage_path": "a.jpg"}],
            True, "https://x", "instagram", caption="hi",
        )


@pytest.mark.parametrize("platform", ["facebook", "threads", "discord", "telegram"])
def test_reel_fails_terminally_on_every_other_platform(platform):
    """No platform except Instagram publishes Reels. Each must refuse TERMINALLY with a
    clear message — never retry forever, never silently drop the video."""
    plan = {"platform": platform, "post_type": "reel", "account_id": "X",
            "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
            "caption": "hi", "cover_frame_ms": None}
    with pytest.raises(publisher._NonRetryable, match="reel"):
        publisher._PUBLISHERS[platform](object(), plan, "TOKEN", object(), lambda _: None)


def test_publish_reel_passes_cover_offset_and_uses_the_reels_budget():
    """Not FINISHED until the 3rd poll, with the image budget's max_tries deliberately
    set too low (2) to ever get there. If _publish_reel used the image budget instead
    of the Reels one, this would raise "not FINISHED after polling" before publish is
    ever called. The recorded sleep_fn intervals additionally pin *which* budget's
    interval was actually used, not just that polling happened enough times.
    """
    calls = {}
    sleeps = []

    class _C:
        def create_video_container(self, ig, url, token, caption=None, thumb_offset=None):
            calls["container"] = (ig, url, caption, thumb_offset)
            return "CONT"

        def get_container_status(self, cid, token):
            calls.setdefault("polls", 0)
            calls["polls"] += 1
            return "FINISHED" if calls["polls"] >= 3 else "IN_PROGRESS"

        def publish_container(self, ig, cid, token):
            calls["published"] = (ig, cid)
            return "MEDIA123"

    class _Cfg:
        # Distinguishable budgets: the image budget cannot survive 3 polls (max_tries=2),
        # so reaching FINISHED at poll 3 is only possible via the Reels budget.
        status_poll_interval = 5
        status_poll_max_tries = 2
        reels_status_poll_interval = 10
        reels_status_poll_max_tries = 90

    plan = {"platform": "instagram", "post_type": "reel", "account_id": "IG1",
            "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
            "caption": "hello", "cover_frame_ms": 2400}
    got = publisher._publish_instagram(_C(), plan, "TOKEN", _Cfg(), sleeps.append)

    assert got == "MEDIA123"
    assert calls["container"] == ("IG1", "https://x/v.mp4", "hello", 2400)
    assert calls["published"] == ("IG1", "CONT")
    assert calls["polls"] == 3
    # sleep_fn was invoked with the Reels interval (10), never the image interval (5) —
    # pins that _publish_reel is actually passing interval=/max_tries= through to the
    # poll loop rather than relying on the loop's image defaults.
    assert sleeps == [10, 10]


def test_reel_poll_exhaustion_is_retryable_not_terminal():
    """A container still transcoding must come back on the next cycle, not burn the post."""
    polls = {"count": 0}

    class _C:
        def create_video_container(self, *a, **kw):
            return "CONT"

        def get_container_status(self, cid, token):
            polls["count"] += 1
            return "IN_PROGRESS"

        def publish_container(self, *a):
            raise AssertionError("must not publish an unfinished container")

    class _Cfg:
        status_poll_interval = 0
        status_poll_max_tries = 1
        reels_status_poll_interval = 0
        reels_status_poll_max_tries = 2

    plan = {"platform": "instagram", "post_type": "reel", "account_id": "IG1",
            "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
            "caption": None, "cover_frame_ms": None}
    with pytest.raises(RuntimeError) as exc:
        publisher._publish_instagram(_C(), plan, "TOKEN", _Cfg(), lambda _: None)
    # RuntimeError (not _NonRetryable) is what publish_one treats as retryable.
    assert not isinstance(exc.value, publisher._NonRetryable)
    # Exhausted the Reels budget (max_tries=2), never the image budget (max_tries=1) —
    # pins that _publish_reel actually used reels_status_poll_max_tries to poll.
    assert polls["count"] == 2
