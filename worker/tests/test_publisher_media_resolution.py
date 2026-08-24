"""Task 9: don't crop a Facebook feed video to 9:16.

Facebook's feed video endpoint (/{page}/videos) accepts ANY aspect ratio up to 20
minutes; Facebook Reels (/{page}/video_reels) requires vertical. Without a per-surface
conformance decision, a landscape clip gets cropped to 9:16 for a feed post that never
needed it — a visible quality regression.

The decision lives in three places that must never disagree:
  * _needs_conformed(caps, surface, media_kind) — the single rule.
  * _resolve_rel(asset, surface, needs_conformed) — file precedence, given the rule's
    answer. Takes the answer as a plain bool rather than `caps` itself, because it is
    also used by the dry-run marker in _build_plan, which has no caps of its own to
    consult for that computation inline.
  * _resolve_url / _resolve_local_path — the two real callers, one per delivery style
    (Meta platforms publish by URL; Discord/Telegram/TikTok upload bytes).

This file also pins that the dry-run marker _build_plan shows and what a real publish
would actually send resolve to the SAME file — this exact class of bug already happened
once for Instagram Stories (see _resolve_rel's docstring).
"""

from __future__ import annotations

import dataclasses

from worker.clients import PLATFORM_CAPS, PlatformCaps
from worker.publisher import _build_plan, _needs_conformed, _resolve_local_path, _resolve_rel, _resolve_url

FACEBOOK_CAPS = PLATFORM_CAPS["facebook"]
INSTAGRAM_CAPS = PLATFORM_CAPS["instagram"]


def _asset(storage_path="orig.mp4", publish_path="conformed.mp4", media_kind="video", **extra):
    return {
        "public_url": None,
        "storage_path": storage_path,
        "publish_path": publish_path,
        "media_kind": media_kind,
        "id": 1,
        **extra,
    }


# ---- _resolve_rel: file precedence given an already-computed needs_conformed --------

def test_facebook_feed_video_keeps_the_original_framing():
    asset = {"storage_path": "orig.mp4", "publish_path": "conformed.mp4", "media_kind": "video"}
    assert _resolve_rel(asset, surface="feed", needs_conformed=False) == "orig.mp4"


def test_facebook_reel_uses_the_conformed_derivative():
    asset = {"storage_path": "orig.mp4", "publish_path": "conformed.mp4", "media_kind": "video"}
    assert _resolve_rel(asset, surface="reel", needs_conformed=True) == "conformed.mp4"


def test_a_reel_without_a_derivative_falls_back_to_the_original():
    """Better to publish the original and let Meta reject a bad ratio than to resolve to
    nothing and fail with 'no media', which says nothing about the real cause."""
    asset = {"storage_path": "orig.mp4", "publish_path": None, "media_kind": "video"}
    assert _resolve_rel(asset, surface="reel", needs_conformed=True) == "orig.mp4"


def test_default_needs_conformed_preserves_todays_behaviour():
    """The keyword defaults to True so any caller that doesn't yet know about surface
    policy (there shouldn't be any left, but belt-and-suspenders) keeps the old
    'conformed or original' answer."""
    asset = {"storage_path": "orig.mp4", "publish_path": "conformed.mp4", "media_kind": "video"}
    assert _resolve_rel(asset, surface="feed") == "conformed.mp4"


# ---- _needs_conformed: the single rule ------------------------------------------------

def test_facebook_feed_video_does_not_need_conforming():
    assert _needs_conformed(FACEBOOK_CAPS, "feed", "video") is False


def test_facebook_reel_video_needs_conforming():
    assert _needs_conformed(FACEBOOK_CAPS, "reel", "video") is True


def test_facebook_feed_image_still_needs_conforming():
    """Only VIDEO on the FEED surface is exempt. Images keep today's behaviour
    everywhere — Facebook's photo endpoint has its own crop rules the conform step
    already targets."""
    assert _needs_conformed(FACEBOOK_CAPS, "feed", "image") is True


def test_instagram_feed_video_still_needs_conforming():
    """Instagram feed video IS Reels and genuinely is constrained — the exemption is
    Facebook-only."""
    assert _needs_conformed(INSTAGRAM_CAPS, "feed", "video") is True


def test_instagram_story_video_still_needs_conforming():
    assert _needs_conformed(INSTAGRAM_CAPS, "story", "video") is True


# ---- _resolve_url: the real caller for Meta platforms (publish by URL) --------------

def test_resolve_url_facebook_feed_video_uses_original():
    asset = _asset()
    url = _resolve_url(asset, "https://t.example", surface="feed", caps=FACEBOOK_CAPS)
    assert url == "https://t.example/orig.mp4"


def test_resolve_url_facebook_reel_uses_conformed():
    asset = _asset()
    url = _resolve_url(asset, "https://t.example", surface="reel", caps=FACEBOOK_CAPS)
    assert url == "https://t.example/conformed.mp4"


def test_resolve_url_without_caps_keeps_old_behaviour():
    """The cover-image call site in _build_plan doesn't pass caps because the answer is
    irrelevant for surface='cover' (see _resolve_rel) — this pins that omitting caps
    doesn't silently change behaviour for anyone else who might do the same."""
    asset = _asset()
    url = _resolve_url(asset, "https://t.example", surface="feed")
    assert url == "https://t.example/conformed.mp4"


def test_resolve_url_facebook_feed_image_unaffected():
    asset = _asset(storage_path="orig.jpg", publish_path="conformed.jpg", media_kind="image")
    url = _resolve_url(asset, "https://t.example", surface="feed", caps=FACEBOOK_CAPS)
    assert url == "https://t.example/conformed.jpg"


# ---- _resolve_local_path: the byte-upload path, wired through the same rule ---------
# No byte-upload platform has this exception today (only Facebook, which publishes by
# URL, does) — this proves the rule is shared through _needs_conformed rather than
# duplicated, by constructing a synthetic caps with the exemption turned on.

_SYNTHETIC_BYTE_UPLOAD_CAPS = dataclasses.replace(
    PLATFORM_CAPS["discord"], feed_video_is_constrained=False, needs_conformed_media=True,
)


def test_resolve_local_path_honours_the_shared_rule_for_feed_video(tmp_path, config):
    orig = tmp_path / "orig.mp4"
    conformed = tmp_path / "conformed.mp4"
    orig.write_bytes(b"o")
    conformed.write_bytes(b"c")
    asset = _asset(storage_path=str(orig), publish_path=str(conformed))
    path = _resolve_local_path(asset, _SYNTHETIC_BYTE_UPLOAD_CAPS, config, surface="feed")
    assert path == orig


def test_resolve_local_path_reel_still_prefers_conformed(tmp_path, config):
    orig = tmp_path / "orig.mp4"
    conformed = tmp_path / "conformed.mp4"
    orig.write_bytes(b"o")
    conformed.write_bytes(b"c")
    asset = _asset(storage_path=str(orig), publish_path=str(conformed))
    path = _resolve_local_path(asset, _SYNTHETIC_BYTE_UPLOAD_CAPS, config, surface="reel")
    assert path == conformed


# ---- Dry-run vs real publish must agree ----------------------------------------------
# _build_plan's dry-run marker (no asset_base_url) and its real-publish URL (with one)
# must resolve to the same underlying file for the same surface. This already broke
# once for Instagram Stories (see _resolve_rel's docstring) — pin it here for the new
# Facebook feed-video exemption too.

def _facebook_channel():
    return {"platform": "facebook", "account_name": "Test Page", "remote_account_id": "123"}


def test_dry_run_marker_agrees_with_real_publish_for_facebook_feed_video():
    asset = _asset()
    post = {"post_type": "video", "first_comment": None}

    real_plan = _build_plan(_facebook_channel(), post, [asset], "https://t.example", None,
                             surface="feed")
    dry_plan = _build_plan(_facebook_channel(), post, [asset], None, None, surface="feed")

    assert real_plan["asset_urls"] == ["https://t.example/orig.mp4"]
    assert dry_plan["asset_urls"] == ["(local:orig.mp4)"]
    # Same underlying file (orig.mp4) named in both — a real publish and the dry run
    # that supposedly previews it cannot disagree about what gets sent.


def test_dry_run_marker_agrees_with_real_publish_for_facebook_reel():
    asset = _asset()
    post = {"post_type": "video", "first_comment": None}

    real_plan = _build_plan(_facebook_channel(), post, [asset], "https://t.example", None,
                             surface="reel")
    dry_plan = _build_plan(_facebook_channel(), post, [asset], None, None, surface="reel")

    assert real_plan["asset_urls"] == ["https://t.example/conformed.mp4"]
    assert dry_plan["asset_urls"] == ["(local:conformed.mp4)"]
