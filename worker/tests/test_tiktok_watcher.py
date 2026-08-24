"""The watcher answers one question: did the creator ever publish it?

Shaped by what a real delivery actually did (spec R1, answered 2026-08-23). The status
went to PUBLISH_COMPLETE the moment the creator published, and the post id appeared
separately once the video was public and through moderation. Those are two different
facts and the watcher must not conflate them:

  * PUBLISH_COMPLETE  -> the creator published it. Immediate, visibility-independent.
  * post id           -> a METRICS key. Only ever appears for a PUBLIC video.

A video published to Friends Only reaches the first and never the second. Promoting on
the post id would leave that send reading "waiting in your inbox" forever.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

import pytest

from worker.tiktok_watcher import GIVE_UP_AFTER, run_tiktok_watcher

NOW = datetime(2026, 8, 23, 20, 0, tzinfo=timezone.utc)


class FakeTikTok:
    """Returns a fixed status payload; records how often it was asked."""

    def __init__(self, payload=None, raises=None):
        self.payload = payload if payload is not None else {"status": "SEND_TO_USER_INBOX"}
        self.raises = raises
        self.calls = 0

    def fetch_publish_status(self, token, publish_id):
        self.calls += 1
        if self.raises:
            raise self.raises
        return dict(self.payload)

    def refresh_access_token(self, key, secret, refresh_token):
        return {
            "access_token": "act.FRESH", "expires_in": 86400,
            "refresh_token": "rft.NEXT", "refresh_expires_in": 31536000,
        }


@pytest.fixture
def tiktok_config(config):
    return dataclasses.replace(
        config, tiktok_client_key="k", tiktok_client_secret="s"
    )


@pytest.fixture
def delivered(conn, make_publication):
    """A TikTok send that reached the creator's inbox, as publish_one leaves it."""
    pub = make_publication(platform="tiktok", post_type="video", n_assets=1,
                           media_kind="video", public_url=None, now=NOW)
    conn.execute(
        "UPDATE publications SET status='posted', delivery_state='inbox', "
        "remote_container_id='pub-1', published_at=?, delivery_checked_at=NULL WHERE id=?",
        (NOW.isoformat(), pub["id"]),
    )
    conn.commit()
    return pub


def _row(conn, pub_id):
    return conn.execute(
        "SELECT delivery_state, remote_post_id, delivery_checked_at "
        "FROM publications WHERE id = ?", (pub_id,)
    ).fetchone()


def test_still_in_the_inbox_stays_in_the_inbox(conn, tiktok_config, delivered):
    client = FakeTikTok({"status": "SEND_TO_USER_INBOX"})

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(minutes=30))

    row = _row(conn, delivered["id"])
    assert row["delivery_state"] == "inbox"
    assert row["remote_post_id"] is None
    # The check itself is recorded, or the interval gate can never throttle anything.
    assert row["delivery_checked_at"] is not None


def test_publish_complete_promotes_even_with_no_post_id(conn, tiktok_config, delivered):
    """The case the original design got wrong. A video published to Friends Only reports
    PUBLISH_COMPLETE and never yields a post id — it is live, and must say so."""
    client = FakeTikTok({"status": "PUBLISH_COMPLETE"})

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(minutes=30))

    row = _row(conn, delivered["id"])
    assert row["delivery_state"] == "published"
    assert row["remote_post_id"] is None      # nothing for metrics, correctly


def test_publish_complete_with_a_post_id_records_both(conn, tiktok_config, delivered):
    client = FakeTikTok({
        "status": "PUBLISH_COMPLETE",
        "publicaly_available_post_id": ["7677325675732176159"],
    })

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(minutes=30))

    row = _row(conn, delivered["id"])
    assert row["delivery_state"] == "published"
    assert row["remote_post_id"] == "7677325675732176159"


def test_a_published_send_without_a_post_id_is_still_watched(conn, tiktok_config, delivered):
    """A creator can publish privately and make it public later, at which point the post
    id appears. Dropping the row at 'published' would lose metrics forever."""
    run_tiktok_watcher(conn, tiktok_config, FakeTikTok({"status": "PUBLISH_COMPLETE"}), NOW)
    assert _row(conn, delivered["id"])["delivery_state"] == "published"

    later = NOW + timedelta(hours=2)
    client = FakeTikTok({
        "status": "PUBLISH_COMPLETE", "publicaly_available_post_id": ["7677325675732176159"],
    })
    run_tiktok_watcher(conn, tiktok_config, client, later)

    assert client.calls == 1, "a published row with no post id must still be polled"
    assert _row(conn, delivered["id"])["remote_post_id"] == "7677325675732176159"


def test_a_row_with_both_is_finished_and_never_polled_again(conn, tiktok_config, delivered):
    conn.execute(
        "UPDATE publications SET delivery_state='published', remote_post_id='7677' WHERE id=?",
        (delivered["id"],),
    )
    conn.commit()
    client = FakeTikTok()

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(hours=5))

    assert client.calls == 0


def test_gives_up_after_the_window(conn, tiktok_config, delivered):
    client = FakeTikTok({"status": "SEND_TO_USER_INBOX"})

    run_tiktok_watcher(conn, tiktok_config, client, NOW + GIVE_UP_AFTER + timedelta(hours=1))

    assert _row(conn, delivered["id"])["delivery_state"] == "gave_up"


def test_a_gave_up_row_is_never_polled_again(conn, tiktok_config, delivered):
    conn.execute(
        "UPDATE publications SET delivery_state='gave_up' WHERE id=?", (delivered["id"],)
    )
    conn.commit()
    client = FakeTikTok()

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(days=1))

    assert client.calls == 0


def test_respects_the_poll_interval(conn, tiktok_config, delivered):
    client = FakeTikTok({"status": "SEND_TO_USER_INBOX"})

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(minutes=20))
    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(minutes=21))

    assert client.calls == 1, "a row checked a minute ago must not be re-polled"


def test_polls_less_often_once_the_send_is_old(conn, tiktok_config, delivered):
    client = FakeTikTok({"status": "SEND_TO_USER_INBOX"})
    # Past the fast window: a 20-minute gap is no longer enough to earn a poll.
    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(hours=8))
    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(hours=8, minutes=20))
    assert client.calls == 1
    # An hour later it is due again.
    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(hours=9, minutes=5))
    assert client.calls == 2


def test_a_failed_check_changes_nothing(conn, tiktok_config, delivered):
    """A network error is not evidence about the post — it must not advance the state."""
    client = FakeTikTok(raises=RuntimeError("network"))

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(minutes=30))

    row = _row(conn, delivered["id"])
    assert row["delivery_state"] == "inbox"
    assert row["remote_post_id"] is None


def test_dry_run_sends_are_never_watched(conn, tiktok_config, delivered):
    conn.execute("UPDATE publications SET is_dry_run=1 WHERE id=?", (delivered["id"],))
    conn.commit()
    client = FakeTikTok()

    run_tiktok_watcher(conn, tiktok_config, client, NOW + timedelta(minutes=30))

    assert client.calls == 0
