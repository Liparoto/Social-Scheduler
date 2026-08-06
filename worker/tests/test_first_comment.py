"""First-comment automation — the post-publish comment, per platform.

The rule this file exists to defend: a first comment is attempted only AFTER the media is
live, and a failure to comment must NEVER downgrade the publication. The post cannot be
unpublished, so turning a live post into a 'failed' row would be a lie. The comment gets
its own status column and fails there, visibly.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from worker.publisher import _build_plan, publish_one, run_first_comment_retries
from worker.tests.conftest import FakeGraphClient

NOW = datetime(2026, 8, 5, 18, 0, 0, tzinfo=timezone.utc)
TAGS = "#physicaltherapy #mobility"


def _reload(conn, pub_id):
    return conn.execute("SELECT * FROM publications WHERE id = ?", (pub_id,)).fetchone()


# ---- Instagram ----------------------------------------------------------------------
def test_instagram_posts_first_comment_after_publish(conn, config, fake_client,
                                                     make_publication):
    pub = make_publication(post_type="single", n_assets=1, first_comment=TAGS)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert out.result == "posted"
    kinds = [c[0] for c in fake_client.calls]
    # The comment lands LAST — after publish, never before.
    assert kinds == ["limit", "image", "status", "publish", "comment"]

    comment_call = fake_client.calls[-1]
    assert comment_call[1] == "media-2"   # commented on the published media id
    assert comment_call[2] == TAGS        # ...with the real text

    row = _reload(conn, pub["id"])
    assert row["status"] == "posted"
    assert row["first_comment_status"] == "posted"
    assert row["first_comment_remote_id"] == "comment-3"
    assert row["first_comment_error"] is None


def test_carousel_comments_on_the_parent_media(conn, config, fake_client,
                                               make_publication):
    pub = make_publication(post_type="carousel", n_assets=3, first_comment=TAGS)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert out.result == "posted"
    assert [c[0] for c in fake_client.calls][-1] == "comment"
    row = _reload(conn, pub["id"])
    # The comment goes on the published carousel, not on any child container.
    assert fake_client.calls[-1][1] == row["remote_post_id"]
    assert row["first_comment_status"] == "posted"


# ---- The load-bearing case: a failed comment must not fail the post ------------------
def test_comment_failure_leaves_the_publication_posted(conn, config, make_publication):
    """The post is already live. A comment failure is recorded on its own column and
    nowhere else — status stays 'posted', last_error stays clean, no retry is scheduled."""
    client = FakeGraphClient(fail_on=["comment"])
    pub = make_publication(post_type="single", n_assets=1, first_comment=TAGS)

    out = publish_one(conn, pub, config, client, dry_run=False, now=NOW)

    assert out.result == "posted"          # the PUBLISH succeeded and says so
    row = _reload(conn, pub["id"])
    assert row["status"] == "posted"
    assert row["remote_post_id"] == "media-2"
    assert row["last_error"] is None       # not a publish failure
    assert row["next_retry_at"] is None    # never re-runs; would double-post the comment
    assert row["attempt_count"] == 0       # publish attempts, untouched by the comment
    # ...but the comment failure is visible, with a reason.
    assert row["first_comment_status"] == "failed"
    assert "comment boom" in row["first_comment_error"]


def test_comment_failure_does_not_block_sibling_publications(conn, config,
                                                             make_publication):
    """Per-target independence: one channel's broken comment must not touch another's."""
    client = FakeGraphClient(fail_on=["comment"])
    pub = make_publication(post_type="single", n_assets=1, first_comment=TAGS)
    other = make_publication(post_type="single", n_assets=1, first_comment=TAGS)

    publish_one(conn, pub, config, client, dry_run=False, now=NOW)
    other_row = _reload(conn, other["id"])
    assert other_row["status"] == "scheduled"
    assert other_row["first_comment_status"] == "none"


# ---- When NOT to comment ------------------------------------------------------------
def test_no_first_comment_means_no_call(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="single", n_assets=1, first_comment=None)
    publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert "comment" not in [c[0] for c in fake_client.calls]
    assert _reload(conn, pub["id"])["first_comment_status"] == "none"


def test_whitespace_only_first_comment_is_not_work(conn, config, fake_client,
                                                   make_publication):
    """An empty textarea round-trips as '' or '\\n' through the composer. Posting that
    would put a blank comment on a live post."""
    pub = make_publication(post_type="single", n_assets=1, first_comment="   \n  ")
    publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert "comment" not in [c[0] for c in fake_client.calls]
    assert _reload(conn, pub["id"])["first_comment_status"] == "none"


def test_stories_never_get_a_first_comment(conn, config, fake_client, make_publication):
    """A Story has no comment edge. Nulled in the PLAN (like the caption) so dry-run
    output tells the truth, not merely skipped at the call site."""
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           first_comment=TAGS)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert out.result == "posted"
    assert "comment" not in [c[0] for c in fake_client.calls]
    assert _reload(conn, pub["id"])["first_comment_status"] == "none"


def test_dry_run_plans_the_comment_but_sends_nothing(conn, config, fake_client,
                                                     make_publication):
    pub = make_publication(post_type="single", n_assets=1, first_comment=TAGS)
    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW)

    assert out.result == "dry_run"
    assert fake_client.calls == []
    assert out.plan["first_comment"] == TAGS   # visible in the plan the owner reads
    assert _reload(conn, pub["id"])["first_comment_status"] == "none"


def test_story_plan_nulls_the_comment(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           first_comment=TAGS)
    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW)
    assert out.plan["first_comment"] is None
    assert out.plan["caption"] is None  # the precedent this follows


# ---- Threads: a self-reply, not a comment edge ---------------------------------------
def test_threads_first_comment_is_a_self_reply(conn, config, fake_client,
                                               make_publication):
    pub = make_publication(post_type="single", n_assets=1, platform="threads",
                           first_comment=TAGS)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW)

    assert out.result == "posted"
    kinds = [c[0] for c in fake_client.calls]
    assert kinds == [
        "threads_limit", "threads_image", "threads_status", "threads_publish",
        # the reply: its own container -> poll -> publish, same as any Threads post
        "threads_reply", "threads_status", "threads_publish",
    ]
    reply_to_id, text = fake_client.calls[4][1]
    assert reply_to_id == "threads-media-2"   # replying to the thread just published
    assert text == TAGS

    row = _reload(conn, pub["id"])
    assert row["first_comment_status"] == "posted"
    # The reply is itself a published thread, so it gets a thread id of its own —
    # NOT a comment id. That is what a Threads "first comment" actually is.
    assert row["first_comment_remote_id"] == "threads-media-4"
    assert row["remote_post_id"] == "threads-media-2"  # the post itself, unchanged


def test_threads_reply_failure_leaves_the_thread_posted(conn, config, make_publication):
    client = FakeGraphClient(fail_on=["threads_reply"])
    pub = make_publication(post_type="single", n_assets=1, platform="threads",
                           first_comment=TAGS)

    out = publish_one(conn, pub, config, client, dry_run=False, now=NOW)

    assert out.result == "posted"
    row = _reload(conn, pub["id"])
    assert row["status"] == "posted"
    assert row["first_comment_status"] == "failed"
    assert "threads create container boom" in row["first_comment_error"]


# ---- Platforms with no first-comment support -----------------------------------------
def test_platform_without_support_records_none_not_failed(conn, config, make_publication,
                                                          fake_discord_client):
    """Discord has no first-comment concept. That is 'not applicable', not a failure —
    marking it 'failed' would cry wolf on every single Discord post."""
    # A text post with no assets: Discord uploads BYTES, so an image post would need
    # real files on disk, which has nothing to do with what this test is checking.
    pub = make_publication(post_type="text", n_assets=0, platform="discord",
                           first_comment=TAGS)
    out = publish_one(conn, pub, config, fake_discord_client, dry_run=False, now=NOW)

    assert out.result == "posted"
    row = _reload(conn, pub["id"])
    assert row["first_comment_status"] == "none"
    assert row["first_comment_error"] is None


# ---- Manual retry --------------------------------------------------------------------
def _fail_then_request_retry(conn, config, make_publication, **kw):
    """Publish with a comment that fails, then flag the row the way the dashboard does."""
    pub = make_publication(post_type="single", n_assets=1, first_comment=TAGS, **kw)
    publish_one(conn, pub, config, FakeGraphClient(fail_on=["comment", "threads_reply"]),
                dry_run=False, now=NOW)
    conn.execute(
        "UPDATE publications SET first_comment_retry_requested = 1 WHERE id = ?",
        (pub["id"],),
    )
    conn.commit()
    return pub


def test_requested_retry_posts_the_comment_and_clears_the_flag(conn, config,
                                                               make_publication):
    pub = _fail_then_request_retry(conn, config, make_publication)
    client = FakeGraphClient()

    assert run_first_comment_retries(conn, config, client, NOW) == 1

    assert [c[0] for c in client.calls] == ["comment"]
    assert client.calls[0][1] == "media-2"   # the already-published media
    assert client.calls[0][2] == TAGS
    row = _reload(conn, pub["id"])
    assert row["first_comment_status"] == "posted"
    assert row["first_comment_error"] is None
    assert row["first_comment_retry_requested"] == 0


def test_a_failed_comment_is_never_retried_without_being_asked(conn, config,
                                                               make_publication):
    """The safety property. A live post must not grow a second comment because the poll
    loop decided to have another go."""
    pub = make_publication(post_type="single", n_assets=1, first_comment=TAGS)
    publish_one(conn, pub, config, FakeGraphClient(fail_on=["comment"]),
                dry_run=False, now=NOW)
    assert _reload(conn, pub["id"])["first_comment_status"] == "failed"

    client = FakeGraphClient()
    assert run_first_comment_retries(conn, config, client, NOW) == 0
    assert client.calls == []


def test_a_retry_that_fails_again_clears_the_flag_and_stays_failed(conn, config,
                                                                   make_publication):
    """One click means one attempt. Leaving the flag set would turn a single click into
    an unbounded retry loop against a live post."""
    pub = _fail_then_request_retry(conn, config, make_publication)

    run_first_comment_retries(conn, config, FakeGraphClient(fail_on=["comment"]), NOW)

    row = _reload(conn, pub["id"])
    assert row["first_comment_status"] == "failed"
    assert row["first_comment_retry_requested"] == 0
    assert "comment boom" in row["first_comment_error"]


def test_dry_run_leaves_the_retry_queued_rather_than_swallowing_it(conn, config,
                                                                   make_publication):
    pub = _fail_then_request_retry(conn, config, make_publication)
    client = FakeGraphClient()

    assert run_first_comment_retries(conn, config, client, NOW, dry_run=True) == 0

    assert client.calls == []
    row = _reload(conn, pub["id"])
    assert row["first_comment_retry_requested"] == 1   # still queued for later
    assert row["first_comment_status"] == "failed"


def test_retry_ignores_publications_that_never_went_out(conn, config, make_publication):
    """A scheduled (or dry-run) row has no live media to comment on."""
    pub = make_publication(post_type="single", n_assets=1, first_comment=TAGS)
    conn.execute(
        "UPDATE publications SET first_comment_retry_requested = 1 WHERE id = ?",
        (pub["id"],),
    )
    conn.commit()

    client = FakeGraphClient()
    assert run_first_comment_retries(conn, config, client, NOW) == 0
    assert client.calls == []


def test_threads_retry_reuses_the_self_reply_path(conn, config, make_publication):
    pub = _fail_then_request_retry(conn, config, make_publication, platform="threads")
    client = FakeGraphClient()

    assert run_first_comment_retries(conn, config, client, NOW) == 1

    assert [c[0] for c in client.calls] == [
        "threads_reply", "threads_status", "threads_publish",
    ]
    reply_to_id, text = client.calls[0][1]
    assert reply_to_id == "threads-media-2"
    assert text == TAGS
    assert _reload(conn, pub["id"])["first_comment_status"] == "posted"


# ---- Registry consistency ------------------------------------------------------------
def test_every_supported_platform_declares_comment_support():
    """Mirrors test_platform_dispatch: a new platform must make an explicit choice about
    first comments rather than silently inheriting one."""
    from worker.clients import SUPPORTED_PLATFORMS
    from worker.publisher import _COMMENTERS

    assert set(_COMMENTERS) == set(SUPPORTED_PLATFORMS)


# ---- Plan building -------------------------------------------------------------------
@pytest.mark.parametrize("raw,expected", [
    (TAGS, TAGS),
    ("  #trimmed  ", "#trimmed"),
    ("", None),
    ("   ", None),
    (None, None),
])
def test_build_plan_normalises_the_comment(raw, expected):
    post = {"post_type": "single", "caption": "hi", "first_comment": raw}
    channel = {"platform": "instagram", "account_name": "a", "remote_account_id": "1"}
    plan = _build_plan(channel, post, [], "https://assets.test", "hi")
    assert plan["first_comment"] == expected
