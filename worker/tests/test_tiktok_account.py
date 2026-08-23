"""TikTok account-level stats.

TikTok exposes exactly four account numbers and no time series at all, so the history is
built by sampling: one row per day, starting the day this install first runs. Nothing can
backfill it, and the UI must not imply otherwise.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

import pytest

from worker.account_metrics import _ACCOUNT_SYNCS, sync_tiktok_account

NOW = datetime(2026, 8, 23, 20, 0, tzinfo=timezone.utc)

STATS = {
    "follower_count": 412,
    "following_count": 87,
    "likes_count": 9310,     # LIFETIME total, not "likes today"
    "video_count": 23,
}


class FakeTikTok:
    def __init__(self, stats=None, raises=None):
        self.stats = STATS if stats is None else stats
        self.raises = raises
        self.asked_fields = None
        self.calls = 0

    def get_user_info(self, token, fields=()):
        self.calls += 1
        self.asked_fields = tuple(fields)
        if self.raises:
            raise self.raises
        return dict(self.stats)


class Budget:
    def __init__(self, left=10):
        self.left = left

    def exhausted(self, client=None):
        return self.left <= 0

    def spend(self, n=1):
        self.left -= n


@pytest.fixture
def tiktok_channel(conn, make_publication):
    pub = make_publication(platform="tiktok", post_type="reel", n_assets=1,
                           media_kind="video", public_url=None, now=NOW)
    return conn.execute(
        "SELECT * FROM channels WHERE id = ?", (pub["channel_id"],)
    ).fetchone()


@pytest.fixture
def tiktok_config(config):
    return dataclasses.replace(config, tiktok_client_key="k", tiktok_client_secret="s")


def _day(conn, channel_id):
    return conn.execute(
        "SELECT followers_count, follows_count, media_count, likes, lifetime_likes, raw_json "
        "FROM account_metrics WHERE channel_id = ?", (channel_id,)
    ).fetchone()


def test_registered_as_a_real_sync():
    assert _ACCOUNT_SYNCS["tiktok"] is not None


def test_records_the_four_counts_for_today(conn, tiktok_config, tiktok_channel):
    client = FakeTikTok()

    out = sync_tiktok_account(conn, tiktok_config, client, tiktok_channel, NOW, Budget())

    assert out["days"] == 1
    row = _day(conn, tiktok_channel["id"])
    assert row["followers_count"] == 412
    assert row["follows_count"] == 87
    assert row["media_count"] == 23


def test_lifetime_likes_never_lands_in_the_daily_likes_column(conn, tiktok_config,
                                                              tiktok_channel):
    """The whole reason 0026 exists. `likes` means "likes that day" on every other
    platform; TikTok's likes_count is a lifetime total that only goes up."""
    sync_tiktok_account(conn, tiktok_config, FakeTikTok(), tiktok_channel, NOW, Budget())

    row = _day(conn, tiktok_channel["id"])
    assert row["lifetime_likes"] == 9310
    assert row["likes"] is None


def test_asks_for_the_stats_fields(conn, tiktok_config, tiktok_channel):
    client = FakeTikTok()
    sync_tiktok_account(conn, tiktok_config, client, tiktok_channel, NOW, Budget())
    for field in ("follower_count", "following_count", "likes_count", "video_count"):
        assert field in client.asked_fields


def test_does_not_invent_metrics_tiktok_has_no_concept_of(conn, tiktok_config,
                                                          tiktok_channel):
    """No reach, no impressions, no profile views, no engagement. Absent, never zero."""
    sync_tiktok_account(conn, tiktok_config, FakeTikTok(), tiktok_channel, NOW, Budget())

    row = conn.execute(
        "SELECT reach, impressions, views, profile_views, accounts_engaged, "
        "total_interactions, comments, saves, shares FROM account_metrics WHERE channel_id = ?",
        (tiktok_channel["id"],),
    ).fetchone()
    assert all(v is None for v in row), f"invented a metric: {dict(row)}"


def test_an_exhausted_budget_makes_no_call(conn, tiktok_config, tiktok_channel):
    client = FakeTikTok()

    out = sync_tiktok_account(conn, tiktok_config, client, tiktok_channel, NOW, Budget(left=0))

    assert client.calls == 0
    assert out["days"] == 0


def test_a_second_sample_the_same_day_updates_rather_than_duplicating(conn, tiktok_config,
                                                                      tiktok_channel):
    sync_tiktok_account(conn, tiktok_config, FakeTikTok(), tiktok_channel, NOW, Budget())
    later = dict(STATS, follower_count=413)
    sync_tiktok_account(conn, tiktok_config, FakeTikTok(later), tiktok_channel, NOW, Budget())

    rows = conn.execute(
        "SELECT followers_count FROM account_metrics WHERE channel_id = ?",
        (tiktok_channel["id"],),
    ).fetchall()
    assert len(rows) == 1, "one row per day, not one per sample"
    assert rows[0]["followers_count"] == 413
