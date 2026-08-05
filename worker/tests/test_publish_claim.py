"""Conditional claiming: a publication is claimed atomically before any work is done.

THE RACE THIS CLOSES. `fetch_due_publications` selects rows with status='scheduled'.
publish_one then loaded the post and assets into memory and made an HTTP quota call, and
only *after* all that wrote status='publishing'. Throughout that window the row still
read 'scheduled', which is what every guard elsewhere checks. Two consequences, both
real:

  * The dashboard's merge/delete guards block 'posted'/'publishing' but let 'scheduled'
    through, so a merge could CASCADE-delete a publication the worker was mid-send on.
    The worker's later status writes then updated 0 rows silently: a real Instagram post
    existed with no database record of it.
  * Two worker daemons — which nothing prevents (no single-instance guard) — could both
    fetch the same row and both publish it.

The fix is one conditional UPDATE that only succeeds from 'scheduled', so exactly one
caller can ever win the row.
"""

from __future__ import annotations

from datetime import datetime, timezone

from worker import db, publisher

NOW = datetime(2026, 8, 5, 12, 0, 0, tzinfo=timezone.utc)


# ---- db.claim_publication ------------------------------------------------------------
def test_claim_succeeds_from_scheduled_and_marks_it_publishing(conn, make_publication):
    pub = make_publication(post_type="single", n_assets=1, now=NOW)

    assert db.claim_publication(conn, pub["id"], NOW.isoformat()) is True

    row = conn.execute("SELECT status FROM publications WHERE id=?", (pub["id"],)).fetchone()
    assert row["status"] == "publishing"


def test_claim_fails_when_another_worker_already_claimed_it(conn, make_publication):
    """The two-daemon case: the second caller must lose, and must not disturb the row."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    assert db.claim_publication(conn, pub["id"], NOW.isoformat()) is True

    assert db.claim_publication(conn, pub["id"], NOW.isoformat()) is False

    row = conn.execute("SELECT status FROM publications WHERE id=?", (pub["id"],)).fetchone()
    assert row["status"] == "publishing"


def test_claim_fails_when_the_row_was_deleted(conn, make_publication):
    """The merge/delete case: the post went away mid-flight, CASCADE took the publication."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    conn.execute("DELETE FROM publications WHERE id=?", (pub["id"],))
    conn.commit()

    assert db.claim_publication(conn, pub["id"], NOW.isoformat()) is False


def test_claim_fails_on_an_already_posted_row(conn, make_publication):
    """Never re-publish something already sent, whatever put it in the due list."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    db.update_publication(conn, pub["id"], status="posted")

    assert db.claim_publication(conn, pub["id"], NOW.isoformat()) is False


def test_claim_fails_on_a_held_row(conn, make_publication):
    """Queue control can hold a send; a held row must not be claimable."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    db.update_publication(conn, pub["id"], is_held=1)

    assert db.claim_publication(conn, pub["id"], NOW.isoformat()) is False


# ---- publish_one honours the claim ---------------------------------------------------
def test_publish_one_publishes_nothing_when_the_claim_is_lost(
    conn, config, fake_client, make_publication
):
    """The decisive test. Simulates the other daemon winning the row first, then asks
    publish_one to process it. It must make NO Graph API calls at all."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    db.update_publication(conn, pub["id"], status="publishing")  # someone else won it

    outcome = publisher.publish_one(
        conn, pub, config, fake_client, dry_run=False,
        asset_base_url="https://assets.test", now=NOW,
    )

    assert outcome.result == "skipped"
    assert fake_client.calls == [], "must make NO Graph API calls for a row it does not own"


def test_publish_one_does_not_crash_when_the_publication_was_deleted(
    conn, config, fake_client, make_publication
):
    """Merge/delete cascaded the row away between fetch and publish."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    conn.execute("DELETE FROM publications WHERE id=?", (pub["id"],))
    conn.commit()

    outcome = publisher.publish_one(
        conn, pub, config, fake_client, dry_run=False,
        asset_base_url="https://assets.test", now=NOW,
    )

    assert outcome.result == "skipped"
    assert fake_client.calls == []


def test_publish_one_claims_before_the_quota_check(conn, config, make_publication):
    """The window being closed is specifically 'before the HTTP quota call', since that
    call is the slowest thing between fetch and the old claim point. If the status is not
    already 'publishing' by the time the quota reader runs, the window is still open."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    seen = {}

    class _QuotaSpyClient:
        def get_content_publishing_limit(self, acct, token):
            seen["status_during_quota_check"] = conn.execute(
                "SELECT status FROM publications WHERE id=?", (pub["id"],)
            ).fetchone()["status"]
            return (0, 50, 86400)

        def create_image_container(self, *a, **kw):
            return "CONTAINER"

        def get_container_status(self, *a, **kw):
            return "FINISHED"

        def publish_container(self, *a, **kw):
            return "MEDIA1"

    publisher.publish_one(
        conn, pub, config, _QuotaSpyClient(), dry_run=False,
        asset_base_url="https://assets.test", now=NOW,
    )

    assert seen["status_during_quota_check"] == "publishing"


def test_a_normal_publish_still_succeeds(conn, config, fake_client, make_publication):
    """The claim must not break the happy path."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)

    outcome = publisher.publish_one(
        conn, pub, config, fake_client, dry_run=False,
        asset_base_url="https://assets.test", now=NOW,
    )

    assert outcome.result == "posted"
    row = conn.execute("SELECT status FROM publications WHERE id=?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"


def test_dry_run_is_unaffected_by_claiming(conn, config, fake_client, make_publication):
    """A dry run publishes nothing, so it neither needs nor takes the claim — and must
    still report a dry_run outcome rather than being skipped."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)

    outcome = publisher.publish_one(
        conn, pub, config, fake_client, dry_run=True,
        asset_base_url="https://assets.test", now=NOW,
    )

    assert outcome.result == "dry_run"
    assert fake_client.calls == [], "a dry run sends nothing"
