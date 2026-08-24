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


# Task 10: Facebook Reels format validation. A Reel is 3-90 seconds and at least
# 540x960 (verified 2026-08-23, see reference.md); the Facebook feed video surface has
# no such check — its ceiling (20 minutes) is far looser, which is the whole reason a
# "feed" vs "reel" surface distinction exists.

def test_a_too_long_reel_is_refused_before_publishing():
    with pytest.raises(_NonRetryable, match="90 seconds"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 95_000,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_too_short_reel_is_refused():
    with pytest.raises(_NonRetryable, match="3 seconds"):
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
    with pytest.raises(_NonRetryable, match="3 seconds"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 2_999,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_reel_at_90001ms_is_refused():
    with pytest.raises(_NonRetryable, match="90 seconds"):
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
