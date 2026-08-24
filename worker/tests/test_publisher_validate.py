"""_validate: the content-shape gate every publish goes through before any network call.

No dedicated test file existed before Task 3 — `_validate` was exercised only
incidentally, via test_reels_publish.py and test_tiktok_publishing.py. This file adds
direct coverage for the post_type='video' rename (Task 3): 'video' must be a supported
post_type and 'reel' must not be.
"""

import pytest

from worker.publisher import SUPPORTED_POST_TYPES, _NonRetryable, _validate


def test_video_post_type_is_supported():
    assert "video" in SUPPORTED_POST_TYPES
    assert "reel" not in SUPPORTED_POST_TYPES


def test_video_needs_exactly_one_video_asset():
    with pytest.raises(_NonRetryable, match="needs a video asset"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "image", "id": 1}],
            dry_run=True, asset_base_url=None, platform="facebook",
        )


# Task 10 / Task 4: Facebook Reels format validation, via the shared media-limits.json
# (worker/media_limits.py) rather than a Facebook-specific block. A Reel is 3-90 seconds
# and at least 540x960 (verified 2026-08-23, see reference.md); the Facebook feed video
# surface has no such check — its ceiling (20 minutes) is far looser, which is the whole
# reason a "feed" vs "reel" surface distinction exists. These tests now exercise the
# GENERIC _check_media_limits path (any platform/surface), proving the swap from the old
# facebook-and-reel-only block is behaviour-preserving.

def test_a_too_long_reel_is_refused_before_publishing():
    with pytest.raises(_NonRetryable, match="longer than 90s"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 95_000,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_too_short_reel_is_refused():
    with pytest.raises(_NonRetryable, match="shorter than 3s"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 1_500,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_the_same_clip_is_fine_on_the_facebook_feed():
    """95 seconds is over the Reels ceiling but far under the feed's 20 minutes. This is
    the whole reason surface exists."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 95_000,
          "width": 1920, "height": 1080}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="feed",
    )


def test_unknown_duration_does_not_block_a_reel():
    """duration_ms is NULL for assets imported before the video pipeline existed.
    Refusing on unknown would block a clip that is probably fine; Meta is the backstop."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": None,
          "width": 1080, "height": 1920}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


def test_a_too_small_reel_is_refused():
    with pytest.raises(_NonRetryable, match="540x960"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 10_000,
              "width": 480, "height": 852}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


# -- Task 10 boundary values: 3-90 seconds and 540x960 are inclusive on both ends -------


def test_a_reel_at_exactly_3000ms_is_accepted():
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 3_000,
          "width": 1080, "height": 1920}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


def test_a_reel_at_exactly_90000ms_is_accepted():
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 90_000,
          "width": 1080, "height": 1920}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


def test_a_reel_at_2999ms_is_refused():
    with pytest.raises(_NonRetryable, match="shorter than 3s"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 2_999,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_reel_at_90001ms_is_refused():
    with pytest.raises(_NonRetryable, match="longer than 90s"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 90_001,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_reel_at_exactly_540x960_is_accepted():
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 10_000,
          "width": 540, "height": 960}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


def test_a_reel_missing_width_and_height_is_not_blocked_on_dimensions():
    """Same rationale as unknown duration: legacy rows may not carry width/height."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 10_000}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


# -- Aspect ratio: Meta's Reels range is "between 16:9 and 9:16", inclusive both ends --

def test_a_reel_narrower_than_9x16_is_refused():
    with pytest.raises(_NonRetryable, match="aspect ratio"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 10_000,
              "width": 540, "height": 2000}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_21x9_ultrawide_reel_is_refused():
    with pytest.raises(_NonRetryable, match="aspect ratio"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 10_000,
              "width": 2520, "height": 1080}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_reel_at_exactly_9x16_is_accepted():
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 10_000,
          "width": 900, "height": 1600}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


def test_a_reel_at_exactly_16x9_landscape_is_accepted():
    """The upper boundary of Meta's documented range ('between 16:9 and 9:16') is
    16:9 landscape itself — 1920x1080 sits AT the boundary and IS permitted, not
    rejected. Only something more extreme (e.g. 21:9 ultrawide) is refused."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 10_000,
          "width": 1920, "height": 1080}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


def test_a_reel_missing_dimensions_is_not_blocked_on_aspect_ratio():
    """Same rationale as unknown duration/size: legacy rows may not carry width/height
    at all — Meta is the backstop, not this gate."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 10_000, "width": None,
          "height": None}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )


# -- Task 4: Instagram Story duration, via the SAME generic _check_media_limits path as
# the Facebook Reels checks above — this closes the owner's original bug report: a
# 10-minute video attached, targeted at an Instagram Story (60s max), scheduled, and only
# failing at Meta with an error that says nothing about duration. ----------------------

def test_an_over_long_instagram_story_is_refused_terminally():
    with pytest.raises(_NonRetryable, match="Stor"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 600_000,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="instagram", surface="story",
        )


def test_an_in_spec_instagram_story_is_accepted():
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 20_000,
          "width": 1080, "height": 1920}],
        dry_run=True, asset_base_url=None, platform="instagram", surface="story",
    )


def test_the_same_over_long_clip_is_fine_on_the_instagram_feed():
    """600 seconds is over the Story's 60s ceiling but well under the feed's 15 minutes —
    same reasoning as the Facebook feed-vs-reel duration split above."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 600_000,
          "width": 1080, "height": 1920}],
        dry_run=True, asset_base_url=None, platform="instagram", surface="feed",
    )


# -- Finding 1: surface='reel' requires post_type='video' AND a platform with a Reels
# surface. This is the terminal guard against a stale post_targets row (e.g. the
# composer let a video-backed reel target survive after its asset was swapped for an
# image) reaching a create call and double-posting the wrong media. -------------------

def test_a_reel_surface_on_a_non_video_post_is_refused_terminally():
    with pytest.raises(_NonRetryable, match="reel surface needs a video post"):
        _validate(
            {"post_type": "single"},
            [{"media_kind": "image", "id": 1, "storage_path": "a.jpg"}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_reel_surface_on_a_platform_without_a_reels_surface_is_refused_terminally():
    """Instagram's feed video IS Reels — there is no separate 'reel' surface for it
    (see PLATFORM_CAPS in clients.py). A stale row naming surface='reel' on Instagram
    must not slip through just because post_type='video' checks out."""
    with pytest.raises(_NonRetryable, match="reel surface needs a video post"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "storage_path": "a.mp4"}],
            dry_run=True, asset_base_url=None, platform="instagram", surface="reel",
        )
