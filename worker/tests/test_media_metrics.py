"""Per-post metrics for the whole account: due-selection and the no-double-spend path.

The reuse path is the one worth guarding. worker/metrics.py has already paid Meta for a
reading of every post we published; refetching it here would spend quota the account-wide
backfill needs, and on a long-running install most posts are ours.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker.media_metrics import (
    FEED_EXTRA_METRICS, REELS_EXTRA_METRICS, instagram_metrics_for,
    media_needing_metrics, run_media_metrics, sync_channel_media_metrics,
)
from worker.media_sync import CallBudget
from worker.metrics import REQUESTED_METRICS

NOW = datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc)


class FakeInsightClient:
    def __init__(self, insights=None, fail_for=None):
        self._insights = insights or {"reach": 100, "likes": 10, "comments": 2,
                                      "saved": 1, "shares": 0}
        self._fail_for = fail_for or set()
        self.asked: list[str] = []
        self.last_usage_pct = None
        self.retry_after_seconds = 0

    def get_media_insights(self, media_id, token, metrics):
        self.asked.append(media_id)
        if media_id in self._fail_for:
            raise RuntimeError("insights unavailable for this media")
        return dict(self._insights)

    def get_threads_insights(self, media_id, token, metrics):
        return self.get_media_insights(media_id, token, metrics)


def _channel(conn, platform="instagram"):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES (?, 'A', 'acct1', 'tok')", (platform,),
    ).lastrowid
    conn.commit()
    return conn.execute("SELECT * FROM channels WHERE id=?", (cid,)).fetchone()


def _media(conn, channel_id, remote_id, *, days_ago=1, publication_id=None, deleted=0):
    return conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id, published_at, "
        "publication_id, is_deleted) VALUES (?,?,?,?,?)",
        (channel_id, remote_id, (NOW - timedelta(days=days_ago)).isoformat(),
         publication_id, deleted),
    ).lastrowid


def _publication_with_metrics(conn, channel_id, remote_id, *, fetched_ago_hours=1, reach=555):
    post_id = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','single')"
    ).lastrowid
    pub_id = conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, remote_post_id) "
        "VALUES (?,?,?,'posted',?)",
        (post_id, channel_id, "2026-08-01T00:00:00+00:00", remote_id),
    ).lastrowid
    conn.execute(
        "INSERT INTO post_metrics (publication_id, fetched_at, reach, likes) VALUES (?,?,?,?)",
        (pub_id, (NOW - timedelta(hours=fetched_ago_hours)).isoformat(), reach, 42),
    )
    conn.commit()
    return pub_id


def _budget(calls=200):
    return CallBudget(calls, 80)


def _metric_rows(conn):
    return conn.execute(
        "SELECT mm.*, rm.remote_post_id FROM media_metrics mm "
        "JOIN remote_media rm ON rm.id = mm.remote_media_id"
    ).fetchall()


# -- which metrics a given post may be asked for --------------------------------------
#
# Instagram rejects the WHOLE call with 400 when one metric is invalid for the media type,
# so a name in the wrong list does not degrade that metric — it loses every metric for
# that post. All names below were verified one at a time against real media on the live
# account (2026-08-05).

def test_every_post_type_asks_for_views():
    """`views` replaced video_views and plays, which now 400 on every media type — Reels
    included. Without it a Reel has no view count at all, which is what prompted this."""
    assert "views" in REQUESTED_METRICS
    for product_type in ("REELS", "FEED", None):
        assert "views" in instagram_metrics_for(
            {"media_product_type": product_type, "media_type": "VIDEO"}
        )


def test_the_retired_names_are_never_requested():
    """video_views and plays 400 on everything now. Requesting either would take the
    whole call down with it."""
    for media in ({"media_product_type": "REELS"}, {"media_product_type": "FEED"}):
        asked = instagram_metrics_for({**media, "media_type": "VIDEO"})
        assert "video_views" not in asked and "plays" not in asked


def test_a_reel_gets_the_watch_time_metrics():
    asked = instagram_metrics_for({"media_product_type": "REELS", "media_type": "VIDEO"})
    assert set(REELS_EXTRA_METRICS) <= set(asked)


def test_a_reel_is_never_asked_for_feed_only_metrics():
    """profile_visits and follows are rejected by Reels — the split runs both ways."""
    asked = instagram_metrics_for({"media_product_type": "REELS", "media_type": "VIDEO"})
    assert not set(FEED_EXTRA_METRICS) & set(asked)


def test_a_feed_post_is_never_asked_for_reels_metrics(  ):
    """The expensive direction: one Reels-only name here would wipe out metrics for
    every image and carousel on the account."""
    for media_type in ("IMAGE", "CAROUSEL_ALBUM"):
        asked = instagram_metrics_for(
            {"media_product_type": "FEED", "media_type": media_type}
        )
        assert not set(REELS_EXTRA_METRICS) & set(asked)
        assert set(FEED_EXTRA_METRICS) <= set(asked)


def test_a_feed_video_is_not_treated_as_a_reel():
    """media_type='VIDEO' does not make it a Reel — media_product_type does. Keying on
    the wrong field would send Reels metrics to an ordinary feed video and 400."""
    asked = instagram_metrics_for({"media_product_type": "FEED", "media_type": "VIDEO"})
    assert not set(REELS_EXTRA_METRICS) & set(asked)


def test_an_unknown_product_type_falls_back_to_the_feed_set():
    """Safer default: the feed extras are valid for more media types than the Reels ones,
    and a wrong guess here costs every metric on the post."""
    asked = instagram_metrics_for({"media_product_type": None, "media_type": "IMAGE"})
    assert not set(REELS_EXTRA_METRICS) & set(asked)


# -- due selection -------------------------------------------------------------------

def test_a_post_with_no_metrics_is_always_due_however_old(conn, config):
    """This is what populates the leaderboard across a fresh install's whole backfill."""
    channel = _channel(conn)
    _media(conn, channel["id"], "ancient", days_ago=900)
    conn.commit()
    due = media_needing_metrics(conn, channel["id"], NOW, config.metrics_max_age_days,
                                config.metrics_min_interval_hours, 100)
    assert [d["remote_post_id"] for d in due] == ["ancient"]


def test_an_old_post_that_already_has_a_reading_is_left_alone(conn, config):
    """Its numbers are static. Refreshing history every cycle would spend the entire
    budget re-reading values that cannot change."""
    channel = _channel(conn)
    media_id = _media(conn, channel["id"], "ancient", days_ago=900)
    conn.execute(
        "INSERT INTO media_metrics (remote_media_id, fetched_at, reach) VALUES (?,?,1)",
        (media_id, (NOW - timedelta(days=300)).isoformat()),
    )
    conn.commit()
    assert media_needing_metrics(conn, channel["id"], NOW, config.metrics_max_age_days,
                                 config.metrics_min_interval_hours, 100) == []


def test_a_recent_post_refreshes_once_its_interval_elapses(conn, config):
    channel = _channel(conn)
    media_id = _media(conn, channel["id"], "recent", days_ago=2)
    conn.execute(
        "INSERT INTO media_metrics (remote_media_id, fetched_at, reach) VALUES (?,?,1)",
        (media_id, (NOW - timedelta(minutes=5)).isoformat()),
    )
    conn.commit()
    assert media_needing_metrics(conn, channel["id"], NOW, config.metrics_max_age_days,
                                 config.metrics_min_interval_hours, 100) == []

    conn.execute("UPDATE media_metrics SET fetched_at = ?",
                 ((NOW - timedelta(hours=config.metrics_min_interval_hours + 1)).isoformat(),))
    conn.commit()
    assert len(media_needing_metrics(conn, channel["id"], NOW, config.metrics_max_age_days,
                                     config.metrics_min_interval_hours, 100)) == 1


def test_deleted_posts_are_not_refetched(conn, config):
    """The post is gone from the platform; asking about it only produces errors."""
    channel = _channel(conn)
    _media(conn, channel["id"], "gone", deleted=1)
    conn.commit()
    assert media_needing_metrics(conn, channel["id"], NOW, config.metrics_max_age_days,
                                 config.metrics_min_interval_hours, 100) == []


def test_due_posts_come_newest_first(conn, config):
    """When the budget runs out mid-backfill, the posts most likely to be looked at
    should already be covered."""
    channel = _channel(conn)
    for days in (400, 1, 90):
        _media(conn, channel["id"], f"p{days}", days_ago=days)
    conn.commit()
    due = media_needing_metrics(conn, channel["id"], NOW, config.metrics_max_age_days,
                                config.metrics_min_interval_hours, 100)
    assert [d["remote_post_id"] for d in due] == ["p1", "p90", "p400"]


# -- the no-double-spend path --------------------------------------------------------

def test_a_fresh_publication_snapshot_is_reused_without_an_api_call(conn, config):
    channel = _channel(conn)
    pub_id = _publication_with_metrics(conn, channel["id"], "ours", reach=555)
    _media(conn, channel["id"], "ours", publication_id=pub_id)
    conn.commit()

    client = FakeInsightClient()
    result = sync_channel_media_metrics(conn, config, client, channel, NOW, _budget())

    assert result == {"fetched": 0, "reused": 1, "failed": 0}
    assert client.asked == [], "the API must not be called for a reading we already hold"
    row = _metric_rows(conn)[0]
    assert row["reach"] == 555, "the reused values must be the publication's, not the fake's"


def test_a_stale_publication_snapshot_is_refetched(conn, config):
    """Reuse is only correct while the snapshot is fresh; past the interval the post's
    numbers have moved and the copy would be wrong."""
    channel = _channel(conn)
    pub_id = _publication_with_metrics(
        conn, channel["id"], "ours",
        fetched_ago_hours=config.metrics_min_interval_hours + 5, reach=555,
    )
    _media(conn, channel["id"], "ours", publication_id=pub_id)
    conn.commit()

    client = FakeInsightClient()
    result = sync_channel_media_metrics(conn, config, client, channel, NOW, _budget())

    assert result["fetched"] == 1 and result["reused"] == 0
    assert _metric_rows(conn)[0]["reach"] == 100


def test_a_post_we_did_not_publish_is_always_fetched(conn, config):
    channel = _channel(conn)
    _media(conn, channel["id"], "theirs")
    conn.commit()
    client = FakeInsightClient()
    sync_channel_media_metrics(conn, config, client, channel, NOW, _budget())
    assert client.asked == ["theirs"]


def test_the_reused_row_records_where_it_came_from(conn, config):
    """A copied reading must be traceable — otherwise a wrong number has no provenance."""
    channel = _channel(conn)
    pub_id = _publication_with_metrics(conn, channel["id"], "ours")
    _media(conn, channel["id"], "ours", publication_id=pub_id)
    conn.commit()
    sync_channel_media_metrics(conn, config, FakeInsightClient(), channel, NOW, _budget())
    assert "copied_from_post_metrics" in _metric_rows(conn)[0]["raw_json"]


# -- resilience ----------------------------------------------------------------------

def test_one_unavailable_post_does_not_stop_the_others(conn, config):
    """Meta rejects insights on some older media. Expected, not fatal."""
    channel = _channel(conn)
    for remote_id in ("good1", "bad", "good2"):
        _media(conn, channel["id"], remote_id)
    conn.commit()

    result = sync_channel_media_metrics(
        conn, config, FakeInsightClient(fail_for={"bad"}), channel, NOW, _budget()
    )
    assert result["fetched"] == 2 and result["failed"] == 1
    assert {r["remote_post_id"] for r in _metric_rows(conn)} == {"good1", "good2"}


def test_the_call_budget_bounds_a_backfill(conn, config):
    channel = _channel(conn)
    for index in range(10):
        _media(conn, channel["id"], f"p{index}", days_ago=index + 1)
    conn.commit()

    result = sync_channel_media_metrics(conn, config, FakeInsightClient(), channel, NOW,
                                        _budget(calls=4))
    assert result["fetched"] == 4, "the rest must wait for the next cycle"


def test_reused_rows_do_not_consume_the_call_budget(conn, config):
    """They cost no API call, so charging them would cut a backfill short for nothing."""
    channel = _channel(conn)
    for index in range(3):
        pub_id = _publication_with_metrics(conn, channel["id"], f"ours{index}")
        _media(conn, channel["id"], f"ours{index}", publication_id=pub_id, days_ago=index + 1)
    conn.commit()

    budget = _budget(calls=1)
    result = sync_channel_media_metrics(conn, config, FakeInsightClient(), channel, NOW, budget)
    assert result["reused"] == 3 and budget.remaining == 1


def test_platforms_without_post_insights_are_skipped(conn, config):
    for platform in ("discord", "telegram", "facebook"):
        channel = _channel(conn, platform)
        _media(conn, channel["id"], f"{platform}-1")
    conn.commit()
    assert run_media_metrics(conn, config, now=NOW,
                             client_for=lambda p: FakeInsightClient()) == 0
    assert _metric_rows(conn) == []
