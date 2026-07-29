"""Reels publishing: container creation, cover offset, and the longer poll budget.

Follows the same fake-session idiom as test_graph_api_threads.py / test_graph_api_facebook.py
(GraphClient is the real class name; the brief's draft invented a nonexistent
`GraphAPIClient(base_url=..., version=...)` API that doesn't match worker/graph_api.py).
"""

from dataclasses import fields

import pytest

from worker import db, publisher
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


def test_create_video_container_sends_cover_url_when_given():
    """A custom cover image is a real public URL Meta cURLs, separate from thumb_offset."""
    c = client([FakeResponse({"id": "C4"})])
    c.create_video_container(
        "IG1", "https://x/v.mp4", "TOKEN", cover_url="https://img.example/cover.jpg"
    )

    _url, data = c.session.posts[0]
    assert data["cover_url"] == "https://img.example/cover.jpg"
    assert "thumb_offset" not in data


def test_create_video_container_omits_cover_url_when_not_given():
    """Not chosen -> not sent at all, mirroring thumb_offset's own None handling."""
    c = client([FakeResponse({"id": "C5"})])
    c.create_video_container("IG1", "https://x/v.mp4", "TOKEN", thumb_offset=1200)

    _url, data = c.session.posts[0]
    assert "cover_url" not in data
    assert data["thumb_offset"] == 1200


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


# ---- _publish_reel: cover_url vs. thumb_offset are mutually exclusive at the client call --
def test_publish_reel_sends_cover_url_and_omits_thumb_offset_when_cover_set():
    """When the plan carries a cover_url, create_video_container must receive cover_url
    and NOT thumb_offset — never both, even though the plan also happens to carry a
    cover_frame_ms of None here (as _build_plan produces when a cover wins)."""
    calls = {}

    class _C:
        def create_video_container(self, ig, url, token, caption=None,
                                    thumb_offset=None, cover_url=None):
            calls["kwargs"] = {"thumb_offset": thumb_offset, "cover_url": cover_url}
            return "CONT"

        def get_container_status(self, cid, token):
            return "FINISHED"

        def publish_container(self, ig, cid, token):
            return "MEDIA1"

    class _Cfg:
        status_poll_interval = 0
        status_poll_max_tries = 1
        reels_status_poll_interval = 0
        reels_status_poll_max_tries = 1

    plan = {
        "platform": "instagram", "post_type": "reel", "account_id": "IG1",
        "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
        "caption": "hi", "cover_frame_ms": None, "cover_url": "https://img.example/cover.jpg",
    }
    got = publisher._publish_instagram(_C(), plan, "TOKEN", _Cfg(), lambda _: None)

    assert got == "MEDIA1"
    assert calls["kwargs"] == {"thumb_offset": None, "cover_url": "https://img.example/cover.jpg"}


def test_publish_reel_still_sends_thumb_offset_when_no_cover_url_in_plan():
    """A plan with no cover_url key at all (e.g. built before this feature, or a plain
    dict fixture) must fall back to thumb_offset exactly as before — no regression."""
    calls = {}

    class _C:
        def create_video_container(self, ig, url, token, caption=None,
                                    thumb_offset=None, cover_url=None):
            calls["kwargs"] = {"thumb_offset": thumb_offset, "cover_url": cover_url}
            return "CONT"

        def get_container_status(self, cid, token):
            return "FINISHED"

        def publish_container(self, ig, cid, token):
            return "MEDIA1"

    class _Cfg:
        status_poll_interval = 0
        status_poll_max_tries = 1
        reels_status_poll_interval = 0
        reels_status_poll_max_tries = 1

    plan = {
        "platform": "instagram", "post_type": "reel", "account_id": "IG1",
        "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
        "caption": "hi", "cover_frame_ms": 0,
    }
    got = publisher._publish_instagram(_C(), plan, "TOKEN", _Cfg(), lambda _: None)

    assert got == "MEDIA1"
    # 0 is the explicit "first frame" choice and must survive, never dropped as falsy.
    assert calls["kwargs"] == {"thumb_offset": 0, "cover_url": None}


# ---- _build_plan: resolves cover_asset_id against real DB rows -----------------------
def _reel_video_asset_id(conn, post_id):
    return conn.execute(
        "SELECT asset_id FROM post_assets WHERE post_id = ?", (post_id,)
    ).fetchone()[0]


def _set_dangling_cover(conn, video_id, cover_frame_ms, missing_cover_id=999999):
    """Point video_id's cover_asset_id at a row that does not exist. The conn fixture
    enables `PRAGMA foreign_keys = ON` (as production connections do), which would
    normally reject this — exactly why it needs a dedicated helper. This mirrors how a
    dangling id actually arises per the design doc: a hand-edited /data database, since
    a live app can never delete a still-referenced row while foreign_keys is on.
    """
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute(
        "UPDATE assets SET cover_frame_ms = ?, cover_asset_id = ? WHERE id = ?",
        (cover_frame_ms, missing_cover_id, video_id),
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def test_build_plan_with_cover_asset_id_carries_cover_url_and_no_frame(conn, config, make_publication):
    pub = make_publication(post_type="reel", media_kind="video", public_url=None)
    video_id = _reel_video_asset_id(conn, pub["post_id"])
    cover_id = conn.execute(
        """INSERT INTO assets (content_hash, media_kind, storage_path, public_url)
           VALUES (?, 'image', ?, NULL)""",
        ("cover-hash-1", "assets/cover-1.jpg"),
    ).lastrowid
    conn.execute(
        "UPDATE assets SET cover_frame_ms = ?, cover_asset_id = ? WHERE id = ?",
        (1500, cover_id, video_id),
    )
    conn.commit()

    channel = db.get_channel(conn, pub["channel_id"])
    post = db.get_post(conn, pub["post_id"])
    assets = db.get_ordered_assets(conn, pub["post_id"])
    plan = publisher._build_plan(
        channel, post, assets, "https://tunnel.test", post["caption"], config, conn
    )

    assert plan["cover_url"] == "https://tunnel.test/assets/cover-1.jpg"
    # cover_url wins -> thumb_offset is omitted (None), even though cover_frame_ms=1500
    # is still stored on the asset for later (removing the cover restores it).
    assert plan["cover_frame_ms"] is None


def test_build_plan_without_cover_asset_id_uses_thumb_offset_as_before(conn, config, make_publication):
    pub = make_publication(post_type="reel", media_kind="video", public_url=None)
    video_id = _reel_video_asset_id(conn, pub["post_id"])
    conn.execute("UPDATE assets SET cover_frame_ms = ? WHERE id = ?", (777, video_id))
    conn.commit()

    channel = db.get_channel(conn, pub["channel_id"])
    post = db.get_post(conn, pub["post_id"])
    assets = db.get_ordered_assets(conn, pub["post_id"])
    plan = publisher._build_plan(
        channel, post, assets, "https://tunnel.test", post["caption"], config, conn
    )

    assert plan["cover_frame_ms"] == 777
    assert plan["cover_url"] is None


def test_build_plan_dangling_cover_asset_id_falls_back_to_thumb_offset(conn, config, make_publication):
    """cover_asset_id points at a row that no longer exists (deleted out from under it).
    A missing cover is cosmetic -> fall back to the frame offset, never raise."""
    pub = make_publication(post_type="reel", media_kind="video", public_url=None)
    video_id = _reel_video_asset_id(conn, pub["post_id"])
    _set_dangling_cover(conn, video_id, cover_frame_ms=2400)

    channel = db.get_channel(conn, pub["channel_id"])
    post = db.get_post(conn, pub["post_id"])
    assets = db.get_ordered_assets(conn, pub["post_id"])
    plan = publisher._build_plan(
        channel, post, assets, "https://tunnel.test", post["caption"], config, conn
    )

    assert plan["cover_url"] is None
    assert plan["cover_frame_ms"] == 2400


# ---- end-to-end through publish_one: cover_url reaches the client, dangling id doesn't
#      break the publish ----------------------------------------------------------------
class FakeReelsClient:
    """A fake Graph client with the Reels method surface (create_video_container plus
    the poll/publish/quota calls publish_one exercises for Instagram), separate from
    FakeGraphClient in conftest.py, which never implements create_video_container."""

    def __init__(self):
        self.calls = []

    def create_video_container(self, ig_user_id, video_url, token, caption=None,
                                thumb_offset=None, cover_url=None):
        self.calls.append(("container", video_url, caption, thumb_offset, cover_url))
        return "CONT1"

    def get_container_status(self, container_id, token):
        return "FINISHED"

    def publish_container(self, ig_user_id, creation_id, token):
        self.calls.append(("publish", creation_id))
        return "MEDIA1"

    def get_content_publishing_limit(self, ig_user_id, token):
        return (0, 50, 86400)


def test_publish_one_sends_cover_url_end_to_end(conn, config, make_publication):
    pub = make_publication(post_type="reel", media_kind="video", public_url=None)
    video_id = _reel_video_asset_id(conn, pub["post_id"])
    cover_id = conn.execute(
        """INSERT INTO assets (content_hash, media_kind, storage_path, public_url)
           VALUES (?, 'image', ?, NULL)""",
        ("cover-hash-2", "assets/cover-2.jpg"),
    ).lastrowid
    conn.execute(
        "UPDATE assets SET cover_frame_ms = ?, cover_asset_id = ? WHERE id = ?",
        (1500, cover_id, video_id),
    )
    conn.commit()

    client = FakeReelsClient()
    out = publisher.publish_one(
        conn, pub, config, client, dry_run=False, asset_base_url="https://tunnel.test",
    )

    assert out.result == "posted"
    assert out.plan["cover_url"] == "https://tunnel.test/assets/cover-2.jpg"
    assert out.plan["cover_frame_ms"] is None
    _kind, _url, _caption, thumb_offset, cover_url = client.calls[0]
    assert cover_url == "https://tunnel.test/assets/cover-2.jpg"
    assert thumb_offset is None


def test_publish_one_dangling_cover_asset_id_falls_back_and_still_publishes(
    conn, config, make_publication
):
    """The trap this test exists to catch: a dangling cover_asset_id must not raise and
    must not block the publish. A missing cover is cosmetic; refusing to publish a
    Reel over it would be far worse."""
    pub = make_publication(post_type="reel", media_kind="video", public_url=None)
    video_id = _reel_video_asset_id(conn, pub["post_id"])
    _set_dangling_cover(conn, video_id, cover_frame_ms=2400)

    client = FakeReelsClient()
    out = publisher.publish_one(
        conn, pub, config, client, dry_run=False, asset_base_url="https://tunnel.test",
    )

    assert out.result == "posted"
    assert out.plan["cover_url"] is None
    assert out.plan["cover_frame_ms"] == 2400
    _kind, _url, _caption, thumb_offset, cover_url = client.calls[0]
    assert thumb_offset == 2400
    assert cover_url is None
