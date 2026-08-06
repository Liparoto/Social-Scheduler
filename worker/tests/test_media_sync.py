"""Media sync: pagination bounds, idempotency, publication linking, deletion flagging.

The bounds are the interesting part. This job walks an account with ~1000 posts against a
rate limit it does not control, so "when does it stop" has four different right answers
and getting any of them wrong is either an infinite crawl or a silent partial sync.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from worker.media_sync import (
    CallBudget, parse_meta_timestamp, run_media_sync, sync_channel_media,
)

NOW = datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc)


class FakeMediaClient:
    """Serves pre-built pages and records how many list calls were made."""

    def __init__(self, pages, usage_pct=None, retry_after=0):
        self.pages = pages
        self.calls = 0
        self.last_usage_pct = usage_pct
        self.retry_after_seconds = retry_after

    def _serve(self, next_url):
        index = 0 if next_url is None else int(next_url)
        self.calls += 1
        items = self.pages[index]
        has_more = index + 1 < len(self.pages)
        return items, (str(index + 1) if has_more else None)

    def get_user_media(self, account_id, token, *, limit=100, fields=None, next_url=None):
        return self._serve(next_url)

    def get_threads_user_media(self, user_id, token, *, limit=100, fields=None, next_url=None):
        return self._serve(next_url)


def _item(post_id, *, days_ago=0, caption="hello", media_type="IMAGE"):
    ts = (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%S+0000")
    return {
        "id": post_id, "media_type": media_type, "media_product_type": "FEED",
        "permalink": f"https://instagram.com/p/{post_id}", "caption": caption,
        "thumbnail_url": f"https://cdn.test/{post_id}.jpg", "timestamp": ts,
    }


def _channel(conn, platform="instagram", *, backfill_complete=0):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token, "
        "media_backfill_complete) VALUES (?, 'Acct', 'acct1', 'tok', ?)",
        (platform, backfill_complete),
    ).lastrowid
    conn.commit()
    return conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()


def _budget(config):
    return CallBudget(config.insights_max_calls_per_cycle, config.insights_usage_pct_ceiling)


def _rows(conn, channel_id):
    return conn.execute(
        "SELECT * FROM remote_media WHERE channel_id = ? ORDER BY published_at DESC",
        (channel_id,),
    ).fetchall()


# -- timestamp normalisation ---------------------------------------------------------

@pytest.mark.parametrize("raw,expected_prefix", [
    ("2026-08-06T01:00:24+0000", "2026-08-06T01:00:24+00:00"),
    ("2026-08-06T01:00:24+00:00", "2026-08-06T01:00:24+00:00"),
])
def test_meta_timestamps_normalise_to_colon_offsets(raw, expected_prefix):
    """Windows are filtered by STRING comparison in SQL, so a mixed offset format would
    produce quietly wrong date ranges rather than an error."""
    assert parse_meta_timestamp(raw) == expected_prefix


def test_unparseable_timestamp_is_none_not_a_crash():
    assert parse_meta_timestamp("not-a-date") is None
    assert parse_meta_timestamp(None) is None


def test_naive_timestamp_is_assumed_utc():
    assert parse_meta_timestamp("2026-08-06T01:00:24") == "2026-08-06T01:00:24+00:00"


# -- the basic walk ------------------------------------------------------------------

def test_walks_every_page_and_stores_each_post(conn, config):
    channel = _channel(conn)
    client = FakeMediaClient([[_item("a"), _item("b", days_ago=1)], [_item("c", days_ago=2)]])

    summary = sync_channel_media(conn, config, client, channel, NOW, _budget(config))

    assert summary["pages"] == 2 and summary["seen"] == 3 and summary["new"] == 3
    assert summary["complete"] is True
    rows = _rows(conn, channel["id"])
    assert [r["remote_post_id"] for r in rows] == ["a", "b", "c"]
    assert rows[0]["permalink"] == "https://instagram.com/p/a"
    assert rows[0]["media_product_type"] == "FEED"


def test_resyncing_is_idempotent_and_refreshes_changed_fields(conn, config):
    """Re-walking the same pages must update in place, never duplicate — the whole reason
    this job needs no pagination cursor."""
    channel = _channel(conn)
    sync_channel_media(conn, config, FakeMediaClient([[_item("a", caption="old")]]),
                       channel, NOW, _budget(config))
    channel = conn.execute("SELECT * FROM channels WHERE id=?", (channel["id"],)).fetchone()
    summary = sync_channel_media(conn, config, FakeMediaClient([[_item("a", caption="new")]]),
                                 channel, NOW, _budget(config))

    rows = _rows(conn, channel["id"])
    assert len(rows) == 1, "a re-sync must not duplicate"
    assert rows[0]["caption"] == "new"
    assert summary["new"] == 0, "an updated row is not a new row"


def test_marks_backfill_complete_when_the_walk_finishes(conn, config):
    channel = _channel(conn)
    sync_channel_media(conn, config, FakeMediaClient([[_item("a")]]),
                       channel, NOW, _budget(config))
    row = conn.execute(
        "SELECT media_backfill_complete, media_synced_at FROM channels WHERE id=?",
        (channel["id"],),
    ).fetchone()
    assert row["media_backfill_complete"] == 1
    assert row["media_synced_at"] is not None


# -- the four stop conditions --------------------------------------------------------

def test_stops_at_the_age_cutoff(conn, config):
    """/media is newest-first, so the first out-of-window post means all later ones are."""
    config.media_sync_max_age_days = 10
    channel = _channel(conn)
    client = FakeMediaClient([[_item("recent", days_ago=1), _item("ancient", days_ago=400)],
                              [_item("older-still", days_ago=500)]])

    summary = sync_channel_media(conn, config, client, channel, NOW, _budget(config))

    assert [r["remote_post_id"] for r in _rows(conn, channel["id"])] == ["recent"]
    assert client.calls == 1, "must not fetch page 2 after crossing the cutoff"
    assert summary["complete"] is True


def test_stops_at_the_max_posts_cap(conn, config):
    config.media_sync_max_posts = 2
    channel = _channel(conn)
    client = FakeMediaClient([[_item("a"), _item("b", days_ago=1), _item("c", days_ago=2)]])

    sync_channel_media(conn, config, client, channel, NOW, _budget(config))

    assert len(_rows(conn, channel["id"])) == 2


def test_incremental_sync_walks_a_bounded_refresh_window(conn, config):
    """After backfill, each cycle re-walks a window off the top instead of stopping at
    the newest known post. Stopping early would mean no existing row is ever revisited,
    so edits and deletions would never be seen again."""
    config.media_sync_refresh_posts = 2
    channel = _channel(conn)
    sync_channel_media(conn, config, FakeMediaClient([[_item("old", days_ago=5)]]),
                       channel, NOW, _budget(config))
    channel = conn.execute("SELECT * FROM channels WHERE id=?", (channel["id"],)).fetchone()
    assert channel["media_backfill_complete"] == 1

    client = FakeMediaClient([[_item("new", days_ago=0), _item("old", days_ago=5)],
                              [_item("ancient", days_ago=99)]])
    sync_channel_media(conn, config, client, channel, NOW, _budget(config))

    assert {r["remote_post_id"] for r in _rows(conn, channel["id"])} == {"old", "new"}
    assert client.calls == 1, "the refresh window must bound the walk, not re-crawl history"


def test_the_refresh_window_does_not_re_crawl_full_history(conn, config):
    """The whole point of the window: a 988-post account must not re-page all of it
    every six hours."""
    config.media_sync_refresh_posts = 1
    channel = _channel(conn, backfill_complete=1)
    client = FakeMediaClient([[_item("a")], [_item("b", days_ago=1)], [_item("c", days_ago=2)]])

    sync_channel_media(conn, config, client, channel, NOW, _budget(config))

    assert client.calls == 1 and len(_rows(conn, channel["id"])) == 1


def test_budget_exhaustion_pauses_without_claiming_completion(conn, config):
    """A partial sync must NOT set backfill_complete, or the next cycle would switch to
    incremental mode and the unread history would never be fetched."""
    channel = _channel(conn)
    client = FakeMediaClient([[_item("a")], [_item("b", days_ago=1)], [_item("c", days_ago=2)]])
    budget = CallBudget(1, 80)

    summary = sync_channel_media(conn, config, client, channel, NOW, budget)

    assert summary["complete"] is False
    assert client.calls == 1
    assert conn.execute(
        "SELECT media_backfill_complete FROM channels WHERE id=?", (channel["id"],)
    ).fetchone()["media_backfill_complete"] == 0


def test_stops_when_meta_reports_high_rate_limit_usage(conn, config):
    """Metrics being a few hours stale is cheaper than throttling the publish path."""
    channel = _channel(conn)
    client = FakeMediaClient([[_item("a")], [_item("b", days_ago=1)]], usage_pct=95)
    budget = CallBudget(100, 80)

    sync_channel_media(conn, config, client, channel, NOW, budget)

    assert client.calls == 0
    assert "95%" in budget.stopped_reason


def test_unknown_usage_does_not_block_the_sync(conn, config):
    """A missing header means unknown, which must not be read as 'plenty left' NOR as a
    reason to refuse work — the call budget stays the bound."""
    channel = _channel(conn)
    client = FakeMediaClient([[_item("a")]], usage_pct=None)
    sync_channel_media(conn, config, client, channel, NOW, CallBudget(100, 80))
    assert client.calls == 1


def test_stops_while_meta_is_actively_throttling(conn, config):
    channel = _channel(conn)
    client = FakeMediaClient([[_item("a")]], retry_after=600)
    budget = CallBudget(100, 80)
    sync_channel_media(conn, config, client, channel, NOW, budget)
    assert client.calls == 0 and "throttling" in budget.stopped_reason


# -- linking back to our own publications --------------------------------------------

def _publication(conn, channel_id, remote_id, *, dry_run=0):
    post_id = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','single')"
    ).lastrowid
    pub = conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, "
        "remote_post_id, is_dry_run) VALUES (?,?,?,'posted',?,?)",
        (post_id, channel_id, "2026-08-01T00:00:00+00:00", remote_id, dry_run),
    ).lastrowid
    conn.commit()
    return pub


def test_links_remote_posts_to_the_publication_that_created_them(conn, config):
    channel = _channel(conn)
    pub_id = _publication(conn, channel["id"], "a")

    sync_channel_media(conn, config, FakeMediaClient([[_item("a"), _item("b", days_ago=1)]]),
                       channel, NOW, _budget(config))

    rows = {r["remote_post_id"]: r["publication_id"] for r in _rows(conn, channel["id"])}
    assert rows["a"] == pub_id
    assert rows["b"] is None, "a post made outside this tool must stay unlinked"


def test_dry_run_publications_never_capture_a_remote_post(conn, config):
    """Every dry-run publication carries the literal 'DRYRUN' as its remote id, so
    without an explicit guard they would all collide onto one remote post."""
    channel = _channel(conn)
    _publication(conn, channel["id"], "DRYRUN", dry_run=1)
    _publication(conn, channel["id"], "DRYRUN", dry_run=1)

    sync_channel_media(conn, config, FakeMediaClient([[_item("DRYRUN")]]),
                       channel, NOW, _budget(config))

    assert _rows(conn, channel["id"])[0]["publication_id"] is None


# -- deletion flagging ---------------------------------------------------------------

def test_posts_that_disappear_are_flagged_not_deleted(conn, config):
    """Their metrics were true for the period they were live; hard-deleting would
    silently rewrite past charts."""
    channel = _channel(conn)
    sync_channel_media(conn, config, FakeMediaClient([[_item("a"), _item("b", days_ago=1)]]),
                       channel, NOW, _budget(config))
    channel = conn.execute("SELECT * FROM channels WHERE id=?", (channel["id"],)).fetchone()

    # "b" is gone from the account now.
    sync_channel_media(conn, config, FakeMediaClient([[_item("a")]]),
                       channel, NOW, _budget(config))

    rows = {r["remote_post_id"]: r["is_deleted"] for r in _rows(conn, channel["id"])}
    assert rows == {"a": 0, "b": 1}
    assert len(_rows(conn, channel["id"])) == 2, "the row itself must survive"


def test_deletion_flagging_never_reaches_past_the_walked_window(conn, config):
    """A post older than anything we looked at was never searched for, so its absence
    proves nothing. Without this guard a bounded backfill would mark the account's whole
    older history as deleted."""
    channel = _channel(conn)
    conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id, published_at) "
        "VALUES (?, 'ancient', ?)",
        (channel["id"], (NOW - timedelta(days=900)).isoformat()),
    )
    conn.commit()

    config.media_sync_max_age_days = 30
    # The walk stops at the age cutoff, so it can only vouch for the last 30 days.
    client = FakeMediaClient([[_item("a"), _item("beyond-cutoff", days_ago=200)]])
    sync_channel_media(conn, config, client, channel, NOW, _budget(config))

    rows = {r["remote_post_id"]: r["is_deleted"] for r in _rows(conn, channel["id"])}
    assert rows["ancient"] == 0, "outside the searched window — absence proves nothing"


def test_a_walk_that_exhausts_every_page_can_vouch_for_the_whole_account(conn, config):
    """When the pages run out we really did see everything, so a post we still hold and
    did not see is genuinely gone — even an old one."""
    channel = _channel(conn)
    conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id, published_at) "
        "VALUES (?, 'long-gone', ?)",
        (channel["id"], (NOW - timedelta(days=400)).isoformat()),
    )
    conn.commit()

    sync_channel_media(conn, config, FakeMediaClient([[_item("a")]]),
                       channel, NOW, _budget(config))

    rows = {r["remote_post_id"]: r["is_deleted"] for r in _rows(conn, channel["id"])}
    assert rows["long-gone"] == 1


def test_a_reappearing_post_is_unflagged(conn, config):
    channel = _channel(conn)
    conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id, published_at, is_deleted) "
        "VALUES (?, 'a', ?, 1)", (channel["id"], NOW.isoformat()),
    )
    conn.commit()
    sync_channel_media(conn, config, FakeMediaClient([[_item("a")]]),
                       channel, NOW, _budget(config))
    assert _rows(conn, channel["id"])[0]["is_deleted"] == 0


# -- the run_media_sync driver -------------------------------------------------------

def test_platforms_without_a_media_list_are_skipped_not_guessed(conn, config):
    for platform in ("discord", "telegram", "facebook"):
        _channel(conn, platform)
    called = []

    def client_for(platform):
        called.append(platform)
        return FakeMediaClient([[]])

    assert run_media_sync(conn, config, now=NOW, client_for=client_for) == 0
    assert called == [], "no client should even be requested for these platforms"


def test_channels_missing_credentials_are_skipped(conn, config):
    conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id) "
        "VALUES ('instagram', 'No token', 'acct1')"
    )
    conn.commit()
    assert run_media_sync(conn, config, now=NOW, client_for=lambda p: FakeMediaClient([[]])) == 0


def test_one_failing_channel_does_not_stop_the_others(conn, config):
    good = _channel(conn, "instagram")
    bad = _channel(conn, "threads")

    class Boom(FakeMediaClient):
        def get_threads_user_media(self, *a, **kw):
            raise RuntimeError("token expired for access_token=SECRET")

    def client_for(platform):
        return Boom([[]]) if platform == "threads" else FakeMediaClient([[_item("a")]])

    synced = run_media_sync(conn, config, now=NOW, client_for=client_for)

    assert synced == 1
    assert len(_rows(conn, good["id"])) == 1
    error = conn.execute(
        "SELECT insights_error FROM channels WHERE id=?", (bad["id"],)
    ).fetchone()["insights_error"]
    assert error and "SECRET" not in error, "a stored error must never carry the token"


def test_a_synced_channel_is_not_resynced_before_its_interval(conn, config):
    channel = _channel(conn)
    calls = []

    def client_for(platform):
        client = FakeMediaClient([[_item("a")]])
        calls.append(client)
        return client

    assert run_media_sync(conn, config, now=NOW, client_for=client_for) == 1
    assert run_media_sync(conn, config, now=NOW, client_for=client_for) == 0, "too soon"

    later = NOW + timedelta(hours=config.insights_sync_interval_hours + 1)
    assert run_media_sync(conn, config, now=later, client_for=client_for) == 1


def test_a_manual_refresh_request_overrides_the_interval(conn, config):
    channel = _channel(conn)
    run_media_sync(conn, config, now=NOW, client_for=lambda p: FakeMediaClient([[_item("a")]]))
    conn.execute(
        "UPDATE channels SET insights_refresh_requested = 1 WHERE id = ?", (channel["id"],)
    )
    conn.commit()
    assert run_media_sync(conn, config, now=NOW, client_for=lambda p: FakeMediaClient([[_item("a")]])) == 1
