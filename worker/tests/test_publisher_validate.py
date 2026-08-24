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
