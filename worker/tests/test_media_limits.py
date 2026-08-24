"""The shared media-limits file, read from Python.

The point of a shared file is that the worker and the dashboard cannot disagree. These
tests cover THIS side; test_media_limits_agreement.py (Task 2) proves both sides agree.
"""

import json

import pytest

from worker import media_limits


def test_facebook_reel_limits_are_loaded():
    lim = media_limits.limits_for("facebook", "reel", "video")
    assert lim is not None
    assert lim["min_duration_ms"] == 3000
    assert lim["max_duration_ms"] == 90_000


def test_an_unknown_platform_has_no_limits():
    """Absent means NOT ENFORCED — never a guess, never a default."""
    assert media_limits.limits_for("myspace", "feed", "video") is None


def test_a_platform_with_no_entry_for_that_surface_has_no_limits():
    assert media_limits.limits_for("facebook", "story", "video") is None


def test_an_in_spec_reel_has_no_violations():
    asset = {"media_kind": "video", "duration_ms": 30_000, "width": 1080, "height": 1920}
    assert media_limits.check("facebook", "reel", asset) == []


@pytest.mark.parametrize("duration_ms,kind", [
    (2_999, "too_short"),
    (90_001, "too_long"),
])
def test_out_of_spec_duration_is_reported(duration_ms, kind):
    asset = {"media_kind": "video", "duration_ms": duration_ms, "width": 1080, "height": 1920}
    kinds = [v.kind for v in media_limits.check("facebook", "reel", asset)]
    assert kinds == [kind]


@pytest.mark.parametrize("duration_ms", [3_000, 90_000])
def test_the_exact_boundaries_are_ACCEPTED(duration_ms):
    """Inclusive at both ends, per the global constraint. This is the assertion most
    likely to drift between the two languages, which is why it is pinned on both sides."""
    asset = {"media_kind": "video", "duration_ms": duration_ms, "width": 1080, "height": 1920}
    assert media_limits.check("facebook", "reel", asset) == []


def test_exactly_16_by_9_is_ACCEPTED():
    """Meta documents 'between 16:9 and 9:16'. A float comparison can exclude this
    boundary by rounding; exact fractions cannot."""
    asset = {"media_kind": "video", "duration_ms": 30_000, "width": 1920, "height": 1080}
    assert media_limits.check("facebook", "reel", asset) == []


def test_ultrawide_is_refused():
    asset = {"media_kind": "video", "duration_ms": 30_000, "width": 2520, "height": 1080}
    kinds = [v.kind for v in media_limits.check("facebook", "reel", asset)]
    assert kinds == ["wrong_aspect"]


def test_unknown_metadata_never_refuses():
    """duration_ms/width/height are NULL for assets predating the video pipeline. The
    platform is the backstop; refusing on 'we don't know' would block valid media."""
    asset = {"media_kind": "video", "duration_ms": None, "width": None, "height": None}
    assert media_limits.check("facebook", "reel", asset) == []


def test_every_entry_carries_a_note():
    """A number with no recorded source is a number nobody can re-verify later."""
    raw = json.loads(media_limits.RAW_PATH.read_text())
    for platform, surfaces in raw["platforms"].items():
        for surface, kinds in surfaces.items():
            for kind, entry in kinds.items():
                assert entry.get("note"), f"{platform}.{surface}.{kind} has no note"


def test_a_malformed_file_fails_loudly(tmp_path, monkeypatch):
    """A broken config is a bug, not a platform fact. It must NEVER degrade into
    'allow everything' — that would silently disable every check in the app."""
    bad = tmp_path / "bad.json"
    bad.write_text("{ not json")
    monkeypatch.setattr(media_limits, "RAW_PATH", bad)
    media_limits.load_limits.cache_clear()
    with pytest.raises(media_limits.MediaLimitsError):
        media_limits.load_limits()
