"""Giving up on metrics for a post the platform says is gone.

A post deleted on Instagram after publishing leaves our publication behind, still `posted`
and still carrying a remote_post_id. Every cycle asked for its insights and got error
100/33 back — 703 times in one log file on the owner's install before this shipped.

The volume matters as much as the error. The refresh interval gate is "no post_metrics row
newer than the cutoff", and a FAILED fetch writes no such row, so failure never counted as
an attempt: the 6-hour throttle only ever applied to publications that succeeded.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker.graph_api import GraphAPIError
from worker.metrics import METRICS_FAILURE_LIMIT, publications_needing_metrics, run_metrics
from worker.tests.conftest import FakeGraphClient

NOW = datetime(2026, 8, 21, 18, 0, tzinfo=timezone.utc)


def _channel(conn, token="tok"):
    return conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('instagram','C','ig1',?)",
        (token,),
    ).lastrowid


def _posted_pub(conn, channel_id, *, remote_id="media-gone"):
    published_at = (NOW - timedelta(days=1)).isoformat()
    pid = conn.execute(
        "INSERT INTO posts (post_type, content_status) VALUES ('single', 'ready')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)", (pid, channel_id)
    )
    pub = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, published_at, remote_post_id, is_dry_run)
           VALUES (?,?,?, 'posted', ?, ?, 0)""",
        (pid, channel_id, published_at, published_at, remote_id),
    ).lastrowid
    conn.commit()
    return pub


class GoneClient(FakeGraphClient):
    """Answers every insights call the way Meta answers for a deleted post."""

    def get_media_insights(self, media_id, token, metrics):
        raise GraphAPIError(
            f"GET {media_id}/insights -> 400: ...",
            status_code=400, code=100, error_subcode=33,
        )


class BrokenClient(FakeGraphClient):
    """Fails, but for a reason that says nothing about whether the post still exists."""

    def get_media_insights(self, media_id, token, metrics):
        raise GraphAPIError("GET insights -> request failed: connection reset")


def _row(conn, pub):
    return conn.execute(
        "SELECT remote_missing_at, remote_missing_reason, metrics_failure_streak"
        "  FROM publications WHERE id = ?",
        (pub,),
    ).fetchone()


def test_a_gone_post_is_marked_after_repeated_failures_not_the_first(conn, config):
    channel = _channel(conn)
    pub = _posted_pub(conn, channel)
    client = GoneClient()

    # Error 100/33 covers a DELETED object and a PERMISSIONS problem with one code. Marking
    # on the first one would let an expired token freeze every post on the account at once.
    for attempt in range(1, METRICS_FAILURE_LIMIT):
        run_metrics(conn, config, client, NOW)
        row = _row(conn, pub)
        assert row["remote_missing_at"] is None, f"gave up after only {attempt} failure(s)"
        assert row["metrics_failure_streak"] == attempt

    run_metrics(conn, config, client, NOW)
    row = _row(conn, pub)
    assert row["remote_missing_at"] is not None
    assert "no longer" in (row["remote_missing_reason"] or "").lower()


def test_a_marked_publication_is_never_selected_again(conn, config):
    channel = _channel(conn)
    pub = _posted_pub(conn, channel)
    client = GoneClient()

    for _ in range(METRICS_FAILURE_LIMIT):
        run_metrics(conn, config, client, NOW)
    assert _row(conn, pub)["remote_missing_at"] is not None

    due = publications_needing_metrics(conn, NOW, 30, 6)
    assert [d["id"] for d in due] == [], "the whole point: stop asking"

    # And the calls really do stop, rather than the row merely being flagged.
    before = len(client.calls)
    run_metrics(conn, config, client, NOW)
    assert len(client.calls) == before


def test_an_ordinary_failure_never_marks_the_post_gone(conn, config):
    """A network blip says nothing about whether the post still exists."""
    channel = _channel(conn)
    pub = _posted_pub(conn, channel)
    client = BrokenClient()

    for _ in range(METRICS_FAILURE_LIMIT + 3):
        run_metrics(conn, config, client, NOW)

    row = _row(conn, pub)
    assert row["remote_missing_at"] is None
    assert row["metrics_failure_streak"] == 0, "only gone-shaped failures count"
    assert publications_needing_metrics(conn, NOW, 30, 6), "it must keep being retried"


def test_a_success_clears_the_streak(conn, config):
    """An intermittent error must never accumulate its way to a mark across days."""
    channel = _channel(conn)
    pub = _posted_pub(conn, channel)

    run_metrics(conn, config, GoneClient(), NOW)
    assert _row(conn, pub)["metrics_failure_streak"] == 1

    run_metrics(conn, config, FakeGraphClient(), NOW)
    assert _row(conn, pub)["metrics_failure_streak"] == 0
    assert _row(conn, pub)["remote_missing_at"] is None


def test_a_manual_refresh_unfreezes_a_marked_publication(conn, config):
    """The escape hatch for the permissions case, using the flag that already exists."""
    channel = _channel(conn)
    pub = _posted_pub(conn, channel)
    for _ in range(METRICS_FAILURE_LIMIT):
        run_metrics(conn, config, GoneClient(), NOW)
    assert _row(conn, pub)["remote_missing_at"] is not None

    # Exactly what the dashboard's "refresh metrics" button writes.
    conn.execute(
        "UPDATE publications SET metrics_refresh_requested_at = ? WHERE id = ?",
        (NOW.isoformat(), pub),
    )
    conn.commit()

    assert [d["id"] for d in publications_needing_metrics(conn, NOW, 30, 6)] == [pub], (
        "a manual refresh has to override the mark, like it overrides the age and "
        "interval gates and the platform exclusion"
    )

    run_metrics(conn, config, FakeGraphClient(), NOW)
    row = _row(conn, pub)
    assert row["remote_missing_at"] is None, "a post that answers again is not missing"
    assert row["metrics_failure_streak"] == 0
    got = conn.execute(
        "SELECT COUNT(*) FROM post_metrics WHERE publication_id = ?", (pub,)
    ).fetchone()[0]
    assert got == 1, "and the refresh actually recorded a snapshot"


def test_marking_one_publication_leaves_its_neighbours_alone(conn, config):
    channel = _channel(conn)
    gone = _posted_pub(conn, channel, remote_id="media-gone")
    fine = _posted_pub(conn, channel, remote_id="media-fine")

    class MixedClient(FakeGraphClient):
        def get_media_insights(self, media_id, token, metrics):
            if media_id == "media-gone":
                raise GraphAPIError(
                    "gone", status_code=400, code=100, error_subcode=33
                )
            return super().get_media_insights(media_id, token, metrics)

    client = MixedClient()
    for _ in range(METRICS_FAILURE_LIMIT):
        run_metrics(conn, config, client, NOW)

    assert _row(conn, gone)["remote_missing_at"] is not None
    assert _row(conn, fine)["remote_missing_at"] is None
    assert conn.execute(
        "SELECT COUNT(*) FROM post_metrics WHERE publication_id = ?", (fine,)
    ).fetchone()[0] >= 1, "the healthy post kept collecting metrics throughout"


def test_the_error_parses_metas_codes_rather_than_matching_its_prose():
    """The decision rests on codes, not on message text Meta can reword at any time."""
    body = (
        '{"error":{"message":"Unsupported get request. Object with ID \'123\' does not '
        'exist, cannot be loaded due to missing permissions, or does not support this '
        'operation","type":"IGApiException","code":100,"error_subcode":33}}'
    )
    from worker.graph_api import _error_fields

    assert _error_fields(body) == {"code": 100, "error_subcode": 33}
    assert GraphAPIError("x", **_error_fields(body)).is_missing_object

    # A different failure with the same HTTP status is not the same thing.
    assert not GraphAPIError("x", code=190, error_subcode=463).is_missing_object
    assert not GraphAPIError("x").is_missing_object


def test_error_parsing_survives_a_body_that_is_not_json():
    """An error path must never raise on its way to raising."""
    from worker.graph_api import _error_fields

    for body in ("", "<html>502 Bad Gateway</html>", "null", "[]", '{"error":"a string"}'):
        assert _error_fields(body) == {}
