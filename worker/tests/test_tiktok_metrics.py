"""TikTok's numbers, in TikTok's words.

The Threads bug this project already fixed was one platform's vocabulary standing in for
another's. TikTok reports views, likes, comments and shares — and has NO reach and NO
saves. Those must come back ABSENT, never as zero, or a genuine 0 and "this platform has
no such concept" become indistinguishable.
"""

from __future__ import annotations

import pytest

import inspect

from worker.metrics import _FETCHERS, _fetch_tiktok


class FakeTikTok:
    def __init__(self, videos):
        self.videos = videos
        self.asked = None

    def query_videos(self, token, video_ids, fields):
        self.asked = (list(video_ids), list(fields))
        return list(self.videos)


def test_registered_as_a_real_fetcher():
    assert _FETCHERS["tiktok"] is not None


def test_maps_the_counts_tiktok_reports(config):
    # Field names and shape taken from a real response (publication 68, 2026-08-23).
    client = FakeTikTok([{
        "id": "7677325675732176159", "view_count": 900, "like_count": 42,
        "comment_count": 3, "share_count": 7,
    }])

    out = _fetch_tiktok(client, "7677325675732176159", "act.T", config, None, 1)

    assert out == {"view_count": 900, "like_count": 42, "comment_count": 3, "share_count": 7}


def test_asks_for_the_video_by_id(config):
    client = FakeTikTok([{"id": "7677", "view_count": 1}])
    _fetch_tiktok(client, "7677", "act.T", config, None, 1)
    ids, fields = client.asked
    assert ids == ["7677"]
    assert "view_count" in fields


def test_reports_no_reach_and_no_saves(config):
    client = FakeTikTok([{"id": "7677", "view_count": 1}])

    out = _fetch_tiktok(client, "7677", "act.T", config, None, 1)

    # Absent, not zero. TikTok has no such metric, and a 0 would be a claim we cannot make.
    assert "reach" not in out
    assert "saves" not in out and "saved" not in out
    assert "impressions" not in out


def test_a_zero_count_is_kept_because_zero_is_a_real_reading(config):
    """A freshly published video genuinely reads 0 across the board — that is data, and
    dropping it would make a new post look unfetched."""
    client = FakeTikTok([{
        "id": "7677", "view_count": 0, "like_count": 0, "comment_count": 0, "share_count": 0,
    }])

    out = _fetch_tiktok(client, "7677", "act.T", config, None, 1)

    assert out == {"view_count": 0, "like_count": 0, "comment_count": 0, "share_count": 0}


def test_a_missing_video_raises_rather_than_recording_zeros(config):
    """Empty means gone, private again, or still moderating — all 'ask later', not 'zero'."""
    client = FakeTikTok([])

    with pytest.raises(RuntimeError):
        _fetch_tiktok(client, "7677", "act.T", config, None, 1)


def test_every_fetcher_accepts_the_arguments_run_metrics_passes():
    """run_metrics calls fetchers with (client, remote_post_id, token, config, logger,
    pub_id, surface). A fetcher written to a shorter signature raises TypeError on the
    first real fetch — and a unit test that calls it the SHORT way passes happily, which
    is exactly how the TikTok one shipped broken for an hour."""
    for platform, fetch in _FETCHERS.items():
        if fetch is None:
            continue
        params = inspect.signature(fetch).parameters
        required = [p for p in params.values()
                    if p.default is inspect.Parameter.empty
                    and p.kind is not inspect.Parameter.VAR_POSITIONAL]
        assert len(params) >= 7, f"{platform} fetcher takes {len(params)} args, caller passes 7"
        assert len(required) <= 7, f"{platform} fetcher requires more than the caller passes"
