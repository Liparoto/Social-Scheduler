"""The shared media-limits file, read from Python.

The point of a shared file is that the worker and the dashboard cannot disagree. These
tests cover THIS side; test_media_limits_agreement.py (Task 2) proves both sides agree.
"""

import json

import pytest

from worker import media_limits


@pytest.fixture(autouse=True)
def _reset_limits_cache():
    """load_limits is lru_cache'd, and monkeypatch can restore RAW_PATH but not a cache.
    Without this, a test that deliberately loads a MALFORMED file leaves that parse in the
    cache for every later caller in the suite — which surfaces as unrelated tests failing
    only when run together. Clearing after each test keeps the pollution inside the test
    that created it."""
    yield
    media_limits.load_limits.cache_clear()


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


# --- Schema validation coverage -------------------------------------------------
#
# Finding (review, 2026-08-24): load_limits() validated fields INSIDE each
# platform.surface.kind entry but never validated the top-level shape. A typo like
# "paltforms" loaded with zero exceptions and silently enforced nothing — exactly the
# "malformed degrades into allow everything" outcome Principle #2 forbids. These tests
# cover that fix, plus the validation branches below it that had no coverage at all
# (that gap is how the top-level hole went unnoticed in the first place).
#
# load_limits() is @lru_cache(maxsize=1), so every test here must call
# cache_clear() after monkeypatching RAW_PATH — otherwise it silently reuses a
# previous test's parsed result and passes for the wrong reason.

_VALID_ENTRY = {
    "schema_version": 1,
    "platforms": {
        "testplatform": {
            "feed": {
                "video": {"max_duration_ms": 1000, "note": "a test fixture, not a real platform"}
            }
        }
    },
}


def _load(tmp_path, monkeypatch, data):
    """Write `data` as media-limits.json, point the loader at it, and load it fresh."""
    path = tmp_path / "media-limits.json"
    path.write_text(json.dumps(data))
    monkeypatch.setattr(media_limits, "RAW_PATH", path)
    media_limits.load_limits.cache_clear()
    return media_limits.load_limits()


def test_a_missing_platforms_key_fails_loudly(tmp_path, monkeypatch):
    """schema_version alone, no platforms key at all — the exact shape of a file that
    lost its platforms block, not just a typo inside it."""
    with pytest.raises(media_limits.MediaLimitsError):
        _load(tmp_path, monkeypatch, {"schema_version": 1})


def test_platforms_that_is_not_a_dict_fails_loudly(tmp_path, monkeypatch):
    with pytest.raises(media_limits.MediaLimitsError):
        _load(tmp_path, monkeypatch, {"schema_version": 1, "platforms": ["not", "a", "dict"]})


def test_an_unrecognised_top_level_key_fails_loudly(tmp_path, monkeypatch):
    """The typo the reviewer actually simulated: 'platforms' misspelled as 'paltforms'.
    Before this fix, this loaded with ZERO exceptions and enforced nothing."""
    bad = {"schema_version": 1, "paltforms": _VALID_ENTRY["platforms"]}
    with pytest.raises(media_limits.MediaLimitsError):
        _load(tmp_path, monkeypatch, bad)


def test_an_unrecognised_key_inside_an_entry_fails_loudly(tmp_path, monkeypatch):
    bad = json.loads(json.dumps(_VALID_ENTRY))  # deep copy
    bad["platforms"]["testplatform"]["feed"]["video"]["not_a_real_field"] = 123
    with pytest.raises(media_limits.MediaLimitsError):
        _load(tmp_path, monkeypatch, bad)


def test_an_entry_with_no_note_fails_loudly(tmp_path, monkeypatch):
    bad = json.loads(json.dumps(_VALID_ENTRY))
    del bad["platforms"]["testplatform"]["feed"]["video"]["note"]
    with pytest.raises(media_limits.MediaLimitsError):
        _load(tmp_path, monkeypatch, bad)


@pytest.mark.parametrize("bad_aspect", [
    [16],             # not a [w, h] pair
    ["16", "9"],       # strings, not ints
    [0, 9],            # zero is not positive
])
def test_a_malformed_min_aspect_fails_loudly(tmp_path, monkeypatch, bad_aspect):
    bad = json.loads(json.dumps(_VALID_ENTRY))
    bad["platforms"]["testplatform"]["feed"]["video"]["min_aspect"] = bad_aspect
    with pytest.raises(media_limits.MediaLimitsError):
        _load(tmp_path, monkeypatch, bad)


def test_a_wrong_schema_version_fails_loudly(tmp_path, monkeypatch):
    bad = json.loads(json.dumps(_VALID_ENTRY))
    bad["schema_version"] = 2
    with pytest.raises(media_limits.MediaLimitsError):
        _load(tmp_path, monkeypatch, bad)


def test_an_empty_platforms_dict_does_not_raise(tmp_path, monkeypatch):
    """Empty is legal, not malformed — this file legitimately starts with just
    Facebook and grows platform by platform. Conflating 'nothing recorded yet' with
    'broken' would make every future addition look like a prior bug."""
    raw = _load(tmp_path, monkeypatch, {"schema_version": 1, "platforms": {}})
    assert raw["platforms"] == {}
