"""Facebook Page account metrics.

Every expectation here comes from probing a LIVE Page on 2026-08-23 rather than from
Meta's docs. The headline finding: page_impressions, page_impressions_unique and
page_fans are all retired and answer "(#100) The value must be a valid insights metric".
So a Page has no reach and no impressions at account level, and its follower count has to
come from the node rather than from insights the way Instagram's does.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from worker.account_metrics import _ACCOUNT_SYNCS, sync_facebook_account

NOW = datetime(2026, 8, 23, 20, 0, tzinfo=timezone.utc)


class FakeGraph:
    def __init__(self, totals=None, series=None, totals_raises=None):
        self.totals = {"followers_count": 1240, "fan_count": 1200} if totals is None else totals
        self.series = series if series is not None else {
            "page_views_total": [("2026-08-22T07:00:00+0000", 31)],
            "page_post_engagements": [("2026-08-22T07:00:00+0000", 12)],
            "page_daily_follows_unique": [("2026-08-22T07:00:00+0000", 3)],
            "page_video_views": [("2026-08-22T07:00:00+0000", 88)],
        }
        self.totals_raises = totals_raises
        self.asked_metrics = None

    def get_page_totals(self, page_id, token):
        if self.totals_raises:
            raise self.totals_raises
        return dict(self.totals)

    def get_account_insights_series(self, account_id, token, metrics, **kwargs):
        self.asked_metrics = list(metrics)
        return {k: list(v) for k, v in self.series.items()}


class Budget:
    def __init__(self, left=10):
        self.left = left

    def exhausted(self, client=None):
        return self.left <= 0

    def spend(self, n=1):
        self.left -= n


@pytest.fixture
def fb_channel(conn, make_publication):
    pub = make_publication(platform="facebook", post_type="single", n_assets=1, now=NOW)
    return conn.execute(
        "SELECT * FROM channels WHERE id = ?", (pub["channel_id"],)
    ).fetchone()


def test_registered_as_a_real_sync():
    assert _ACCOUNT_SYNCS["facebook"] is not None


def test_followers_come_from_the_node_not_insights(conn, config, fb_channel):
    """page_fans is retired, so the follower count has no insights source at all."""
    client = FakeGraph()

    sync_facebook_account(conn, config, client, fb_channel, NOW, Budget())

    row = conn.execute(
        "SELECT followers_count FROM account_metrics WHERE channel_id = ? AND day = ?",
        (fb_channel["id"], "2026-08-23"),
    ).fetchone()
    assert row["followers_count"] == 1240


def test_falls_back_to_fan_count_when_followers_count_is_absent(conn, config, fb_channel):
    client = FakeGraph(totals={"fan_count": 987})

    sync_facebook_account(conn, config, client, fb_channel, NOW, Budget())

    row = conn.execute(
        "SELECT followers_count FROM account_metrics WHERE channel_id = ? AND day = ?",
        (fb_channel["id"], "2026-08-23"),
    ).fetchone()
    assert row["followers_count"] == 987


def test_maps_the_surviving_insight_names_onto_columns(conn, config, fb_channel):
    sync_facebook_account(conn, config, FakeGraph(), fb_channel, NOW, Budget())

    row = conn.execute(
        "SELECT profile_views, total_interactions, follows_gained, views "
        "FROM account_metrics WHERE channel_id = ? AND day = ?",
        (fb_channel["id"], "2026-08-22"),
    ).fetchone()
    assert row["profile_views"] == 31          # page_views_total
    assert row["total_interactions"] == 12     # page_post_engagements
    assert row["follows_gained"] == 3          # page_daily_follows_unique
    assert row["views"] == 88                  # page_video_views


def test_never_invents_reach_or_impressions(conn, config, fb_channel):
    """Both source metrics are retired. Absent, not zero — a 0 would claim the Page
    reached nobody, which is a different statement from Meta no longer reporting it."""
    sync_facebook_account(conn, config, FakeGraph(), fb_channel, NOW, Budget())

    rows = conn.execute(
        "SELECT reach, impressions FROM account_metrics WHERE channel_id = ?",
        (fb_channel["id"],),
    ).fetchall()
    assert all(r["reach"] is None and r["impressions"] is None for r in rows)


def test_requests_only_the_configured_metric_names(conn, config, fb_channel):
    """Names are config so a retirement is an .env edit, not a release."""
    import dataclasses

    client = FakeGraph()
    cfg = dataclasses.replace(config, fb_account_metrics="page_views_total,page_video_views")

    sync_facebook_account(conn, cfg, client, fb_channel, NOW, Budget())

    assert client.asked_metrics == ["page_views_total", "page_video_views"]


def test_a_page_with_no_insights_data_still_records_followers(conn, config, fb_channel):
    """The live Page had 1 follower and every insight empty. A card showing the follower
    count beats an empty card that reads as broken."""
    client = FakeGraph(totals={"followers_count": 1}, series={})

    out = sync_facebook_account(conn, config, client, fb_channel, NOW, Budget())

    assert out["days"] >= 1
    row = conn.execute(
        "SELECT followers_count FROM account_metrics WHERE channel_id = ? AND day = ?",
        (fb_channel["id"], "2026-08-23"),
    ).fetchone()
    assert row["followers_count"] == 1


def test_an_exhausted_budget_makes_no_calls(conn, config, fb_channel):
    client = FakeGraph()

    out = sync_facebook_account(conn, config, client, fb_channel, NOW, Budget(left=0))

    assert out["days"] == 0
    assert client.asked_metrics is None
