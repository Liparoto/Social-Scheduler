"""Recovering publications abandoned mid-send.

claim_publication stops two daemons publishing one row, but nothing moved a claimed row
back: fetch_due_publications only selects 'scheduled', so a worker that died between the
claim and the final status write left that row at 'publishing' forever — never retried,
never reported. A scheduled post silently never happened.

The two properties that matter pull in opposite directions, and both are tested here:
a genuinely abandoned row must be surfaced, and a publish still legitimately in flight
must NOT be, because recovering that one is how you double-post.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker import db

NOW = datetime(2026, 8, 5, 12, 0, 0, tzinfo=timezone.utc)
LEASE = 1800  # seconds; matches Config.publish_claim_lease_seconds


def _publication(conn, *, status="publishing", updated_ago_seconds=None, created_ago=None):
    post_id = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','single')"
    ).lastrowid
    channel_id = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','A')"
    ).lastrowid
    updated_at = (
        (NOW - timedelta(seconds=updated_ago_seconds)).isoformat()
        if updated_ago_seconds is not None
        else None
    )
    created_at = (NOW - timedelta(seconds=created_ago or 0)).isoformat()
    pub_id = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, updated_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (post_id, channel_id, (NOW - timedelta(hours=2)).isoformat(), status,
         updated_at, created_at),
    ).lastrowid
    conn.commit()
    return pub_id


def _status(conn, pub_id):
    return conn.execute(
        "SELECT * FROM publications WHERE id = ?", (pub_id,)
    ).fetchone()


def test_a_row_abandoned_past_the_lease_is_marked_failed(conn):
    pub_id = _publication(conn, updated_ago_seconds=LEASE + 60)

    recovered = db.recover_stale_claims(conn, NOW.isoformat(), LEASE)

    assert [r["id"] for r in recovered] == [pub_id]
    row = _status(conn, pub_id)
    assert row["status"] == "failed"
    assert "may or may not have reached the platform" in row["last_error"]


def test_a_publish_still_in_flight_is_left_alone(conn):
    """The dangerous direction. A Reel legitimately holds 'publishing' for ~15 minutes of
    transcode polling; recovering it mid-send would re-queue a post that is already on
    its way and publish it twice — the exact failure claiming exists to prevent."""
    pub_id = _publication(conn, updated_ago_seconds=LEASE - 60)

    assert db.recover_stale_claims(conn, NOW.isoformat(), LEASE) == []
    assert _status(conn, pub_id)["status"] == "publishing"


def test_recovery_never_re_queues_the_post(conn):
    """Marked failed, NOT scheduled. The worker may have died after the platform accepted
    the post but before it could record the result, so the post can already be live and
    this row is the only thing that does not know. Re-queueing would post it twice; a
    human checks the account and uses Retry."""
    pub_id = _publication(conn, updated_ago_seconds=LEASE + 60)

    db.recover_stale_claims(conn, NOW.isoformat(), LEASE)

    row = _status(conn, pub_id)
    assert row["status"] != "scheduled", "must never silently re-queue"
    assert row["next_retry_at"] is None, "and must not schedule an automatic retry"


def test_scheduled_and_posted_rows_are_untouched(conn):
    """Only 'publishing' is ambiguous. A 'scheduled' row was never claimed and a 'posted'
    row already finished; touching either would invent a failure."""
    scheduled = _publication(conn, status="scheduled", updated_ago_seconds=LEASE * 10)
    posted = _publication(conn, status="posted", updated_ago_seconds=LEASE * 10)

    assert db.recover_stale_claims(conn, NOW.isoformat(), LEASE) == []
    assert _status(conn, scheduled)["status"] == "scheduled"
    assert _status(conn, posted)["status"] == "posted"


def test_a_row_with_no_updated_at_falls_back_to_created_at(conn):
    """updated_at is NULL until something writes it. Without the COALESCE the comparison
    is NULL, the row never matches, and it stays stranded forever — the precise failure
    this function exists to end."""
    pub_id = _publication(conn, updated_ago_seconds=None, created_ago=LEASE + 60)

    recovered = db.recover_stale_claims(conn, NOW.isoformat(), LEASE)

    assert [r["id"] for r in recovered] == [pub_id]
    assert _status(conn, pub_id)["status"] == "failed"


def test_a_fresh_row_with_no_updated_at_is_left_alone(conn):
    """The same fallback must not sweep a row claimed moments ago."""
    pub_id = _publication(conn, updated_ago_seconds=None, created_ago=60)

    assert db.recover_stale_claims(conn, NOW.isoformat(), LEASE) == []
    assert _status(conn, pub_id)["status"] == "publishing"


# ---- lease 0: the first cycle of a fresh process --------------------------------------
# main() takes an exclusive OS lock before any cycle runs, and the kernel drops that lock
# when the holder dies however it dies. So on the FIRST cycle of a new process, a row at
# 'publishing' provably belongs to no live worker — waiting out the full lease only keeps
# a dead send invisible for another half hour. run.py passes lease 0 there; these cover
# what that argument actually buys, and that it changes nothing else.
def test_lease_zero_recovers_a_row_claimed_moments_ago(conn):
    pub_id = _publication(conn, updated_ago_seconds=1)

    recovered = db.recover_stale_claims(conn, NOW.isoformat(), 0)

    assert [r["id"] for r in recovered] == [pub_id]
    assert _status(conn, pub_id)["status"] == "failed"


def test_lease_zero_still_never_re_queues(conn):
    """Recovering sooner must not become recovering differently: the post may already be
    live, so the destination is still 'failed' for a human to judge."""
    pub_id = _publication(conn, updated_ago_seconds=1)

    db.recover_stale_claims(conn, NOW.isoformat(), 0)

    row = _status(conn, pub_id)
    assert row["status"] == "failed"
    assert row["next_retry_at"] is None
    assert "may or may not have reached the platform" in row["last_error"]


def test_lease_zero_still_only_touches_publishing_rows(conn):
    scheduled = _publication(conn, status="scheduled", updated_ago_seconds=1)
    posted = _publication(conn, status="posted", updated_ago_seconds=1)

    assert db.recover_stale_claims(conn, NOW.isoformat(), 0) == []
    assert _status(conn, scheduled)["status"] == "scheduled"
    assert _status(conn, posted)["status"] == "posted"


def test_recovery_is_idempotent(conn):
    """Every cycle calls this. The second pass must find nothing rather than rewriting
    the error and resetting updated_at forever."""
    _publication(conn, updated_ago_seconds=LEASE + 60)

    assert len(db.recover_stale_claims(conn, NOW.isoformat(), LEASE)) == 1
    assert db.recover_stale_claims(conn, NOW.isoformat(), LEASE) == []


def test_several_stranded_rows_are_all_recovered(conn):
    ids = [_publication(conn, updated_ago_seconds=LEASE + 60) for _ in range(3)]

    recovered = db.recover_stale_claims(conn, NOW.isoformat(), LEASE)

    assert sorted(r["id"] for r in recovered) == sorted(ids)
    assert all(_status(conn, i)["status"] == "failed" for i in ids)


def test_a_recovered_row_can_still_be_retried_by_hand(conn):
    """Failed is a human-actionable state, not a dead end — the dashboard's Retry moves
    it back to 'scheduled', which is what makes 'fail, do not re-queue' acceptable."""
    pub_id = _publication(conn, updated_ago_seconds=LEASE + 60)
    db.recover_stale_claims(conn, NOW.isoformat(), LEASE)

    conn.execute(
        "UPDATE publications SET status='scheduled', last_error=NULL WHERE id=?", (pub_id,)
    )
    conn.commit()

    assert _status(conn, pub_id)["status"] == "scheduled"
    assert db.claim_publication(conn, pub_id, NOW.isoformat()) is True


def test_the_claim_and_recovery_pair_survives_a_full_round_trip(conn):
    """End to end: claim wins once, a second daemon loses, the winner dies, the next
    cycle surfaces it."""
    pub_id = _publication(conn, status="scheduled", updated_ago_seconds=10)

    assert db.claim_publication(conn, pub_id, NOW.isoformat()) is True
    assert db.claim_publication(conn, pub_id, NOW.isoformat()) is False, (
        "a second daemon must lose the row"
    )

    later = NOW + timedelta(seconds=LEASE + 60)
    recovered = db.recover_stale_claims(conn, later.isoformat(), LEASE)
    assert [r["id"] for r in recovered] == [pub_id]
    assert _status(conn, pub_id)["status"] == "failed"
