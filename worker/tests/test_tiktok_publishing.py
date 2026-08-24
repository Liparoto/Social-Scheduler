"""Publishing to TikTok DELIVERS — it does not post.

The load-bearing assertion in this file is that a delivered send records no
remote_post_id. That one fact is what keeps the metrics due-query away from a video
nobody has published yet, and what keeps the queue from claiming it is live.
"""

from __future__ import annotations

import pytest

from worker.clients import PLATFORM_CAPS, SUPPORTED_PLATFORMS
from worker.publisher import _DELIVERS_TO_INBOX, _NonRetryable, _validate, publish_one


def _write_local_file(config, conn, post_id, data=b"video-bytes"):
    rows = conn.execute(
        """SELECT a.storage_path FROM assets a
           JOIN post_assets pa ON pa.asset_id = a.id
           WHERE pa.post_id = ? ORDER BY pa.sort_order""",
        (post_id,),
    ).fetchall()
    for row in rows:
        path = config.asset_storage_dir / row["storage_path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


# ---- Registration ---------------------------------------------------------------------


def test_tiktok_is_registered_in_every_platform_registry():
    """Thirteen registries assert against SUPPORTED_PLATFORMS at import. Missing one stops
    the worker from starting at all, so this names them rather than leaving the failure to
    an AssertionError during a publish cycle."""
    from worker.account_metrics import _ACCOUNT_SYNCS
    from worker.avatars import _URL_FETCHERS
    from worker.clients import _API_VERSIONS, _BASE_URLS, _CLIENT_FACTORIES
    from worker.media_metrics import _FETCHERS as MEDIA_FETCHERS
    from worker.media_sync import _ADAPTERS
    from worker.metrics import _FETCHERS
    from worker.preflight import _CHECKS
    from worker.publisher import _COMMENTERS, _PUBLISHERS, _QUOTA_GATED

    assert "tiktok" in SUPPORTED_PLATFORMS
    registries = {
        "clients._BASE_URLS": _BASE_URLS,
        "clients._API_VERSIONS": _API_VERSIONS,
        "clients.PLATFORM_CAPS": PLATFORM_CAPS,
        "clients._CLIENT_FACTORIES": _CLIENT_FACTORIES,
        "publisher._PUBLISHERS": _PUBLISHERS,
        "publisher._QUOTA_GATED": _QUOTA_GATED,
        "publisher._COMMENTERS": _COMMENTERS,
        "publisher._DELIVERS_TO_INBOX": _DELIVERS_TO_INBOX,
        "preflight._CHECKS": _CHECKS,
        "metrics._FETCHERS": _FETCHERS,
        "media_metrics._FETCHERS": MEDIA_FETCHERS,
        "account_metrics._ACCOUNT_SYNCS": _ACCOUNT_SYNCS,
        "media_sync._ADAPTERS": _ADAPTERS,
        "avatars._URL_FETCHERS": _URL_FETCHERS,
    }
    missing = [name for name, reg in registries.items() if "tiktok" not in reg]
    assert not missing, f"tiktok missing from: {missing}"


def test_only_tiktok_delivers_to_an_inbox():
    assert _DELIVERS_TO_INBOX["tiktok"] is True
    for platform in SUPPORTED_PLATFORMS:
        if platform != "tiktok":
            assert _DELIVERS_TO_INBOX[platform] is False, (
                f"{platform} publishes on command and must not be marked as delivering"
            )


def test_tiktok_has_no_first_comment_and_no_quota_to_read():
    from worker.publisher import _COMMENTERS, _QUOTA_GATED

    # Both are declared rather than omitted: None/False here means "this platform genuinely
    # has no such thing", never "not wired up yet".
    assert _COMMENTERS["tiktok"] is None
    assert _QUOTA_GATED["tiktok"] is False


# ---- Capabilities ---------------------------------------------------------------------


def test_tiktok_declares_video_only():
    caps = PLATFORM_CAPS["tiktok"]
    assert caps.supports_video is True
    assert caps.supports_images is False   # photos need a DNS-verified domain — spec Gate 2
    assert caps.supports_text is False
    assert caps.uploads_media_bytes is True     # chunked FILE_UPLOAD; no tunnel needed
    assert caps.needs_conformed_media is False  # send the original, unaltered


def test_every_other_platform_still_accepts_images():
    for platform in SUPPORTED_PLATFORMS:
        if platform != "tiktok":
            assert PLATFORM_CAPS[platform].supports_images is True


def test_tiktok_enforces_no_caption_limit_because_it_sends_no_caption():
    assert PLATFORM_CAPS["tiktok"].caption_limit("video") is None


# ---- Validation -----------------------------------------------------------------------


@pytest.mark.parametrize("post_type", ["single", "carousel"])
def test_validate_refuses_an_image_post_to_tiktok(post_type):
    post = {"post_type": post_type, "first_comment": None}
    assets = [
        {"id": i, "media_kind": "image", "storage_path": f"a{i}.jpg", "publish_path": None}
        for i in range(1 if post_type == "single" else 3)
    ]
    with pytest.raises(_NonRetryable) as exc:
        _validate(post, assets, True, None, "tiktok", None)
    assert "video only" in str(exc.value)


def test_validate_refuses_a_text_post_to_tiktok():
    post = {"post_type": "text", "first_comment": None}
    with pytest.raises(_NonRetryable):
        _validate(post, [], True, None, "tiktok", "just words")


def test_validate_accepts_a_video_post_to_tiktok():
    post = {"post_type": "video", "first_comment": None}
    assets = [{"id": 1, "media_kind": "video", "storage_path": "a.mp4", "publish_path": None}]
    _validate(post, assets, True, None, "tiktok", None)   # must not raise


def test_validate_still_accepts_an_image_post_everywhere_else():
    post = {"post_type": "single", "first_comment": None}
    assets = [{"id": 1, "media_kind": "image", "storage_path": "a.jpg", "publish_path": None}]
    for platform in ("instagram", "facebook", "threads", "discord", "telegram"):
        _validate(post, assets, True, None, platform, "hello")   # must not raise


# ---- Publishing -----------------------------------------------------------------------


def test_delivered_send_records_the_publish_id_but_no_post_id(
    conn, config, fake_tiktok_client, make_publication
):
    """Decision 6, in one assertion: 'delivered' is not 'posted'."""
    pub = make_publication(platform="tiktok", post_type="video", n_assets=1,
                           media_kind="video", public_url=None)
    _write_local_file(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_tiktok_client, dry_run=False)

    assert out.result == "posted"
    row = conn.execute(
        "SELECT status, delivery_state, remote_container_id, remote_post_id "
        "FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()
    assert row["status"] == "posted"              # the WORKER's job succeeded
    assert row["delivery_state"] == "inbox"       # ...TikTok has published nothing
    assert row["remote_container_id"] == "pub-1"  # the publish_id (an upload session)
    assert row["remote_post_id"] is None          # nothing for metrics to chase yet


def test_delivery_uploads_the_bytes_and_waits_for_the_inbox_status(
    conn, config, make_publication
):
    from worker.tests.conftest import FakeTikTokClient

    client = FakeTikTokClient(status_sequence=[
        {"status": "PROCESSING_UPLOAD"},
        {"status": "PROCESSING_UPLOAD"},
        {"status": "SEND_TO_USER_INBOX"},
    ])
    pub = make_publication(platform="tiktok", post_type="video", n_assets=1,
                           media_kind="video", public_url=None)
    _write_local_file(config, conn, pub["post_id"])

    publish_one(conn, pub, config, client, dry_run=False, sleep_fn=lambda _s: None)

    kinds = [c[0] for c in client.calls]
    assert kinds[0] == "tt_init"
    assert kinds[1] == "tt_upload"
    # Polled until delivered rather than assuming the upload landed.
    assert kinds.count("tt_status") == 3


def test_a_failed_upload_status_fails_the_publication_with_tiktoks_reason(
    conn, config, make_publication
):
    from worker.tests.conftest import FakeTikTokClient

    client = FakeTikTokClient(status_sequence=[
        {"status": "FAILED", "fail_reason": "video_format_unsupported"}
    ])
    pub = make_publication(platform="tiktok", post_type="video", n_assets=1,
                           media_kind="video", public_url=None)
    _write_local_file(config, conn, pub["post_id"])

    publish_one(conn, pub, config, client, dry_run=False, sleep_fn=lambda _s: None)

    row = conn.execute(
        "SELECT status, last_error, delivery_state FROM publications WHERE id = ?",
        (pub["id"],),
    ).fetchone()
    assert row["status"] in ("scheduled", "failed")   # not posted, whichever retry state
    assert "video_format_unsupported" in row["last_error"]
    assert row["delivery_state"] is None              # nothing was delivered


def test_an_image_post_to_tiktok_fails_terminally_rather_than_retrying(
    conn, config, fake_tiktok_client, make_publication
):
    pub = make_publication(platform="tiktok", post_type="single", n_assets=1,
                           media_kind="image", public_url=None)
    _write_local_file(config, conn, pub["post_id"])

    publish_one(conn, pub, config, fake_tiktok_client, dry_run=False)

    row = conn.execute(
        "SELECT status, next_retry_at, last_error FROM publications WHERE id = ?",
        (pub["id"],),
    ).fetchone()
    assert row["status"] == "failed"
    assert row["next_retry_at"] is None    # bad config, not a transient error
    assert "video only" in row["last_error"]
    assert fake_tiktok_client.calls == []  # refused before a single API call


def test_dry_run_touches_tiktok_not_at_all(
    conn, config, fake_tiktok_client, make_publication
):
    pub = make_publication(platform="tiktok", post_type="video", n_assets=1,
                           media_kind="video", public_url=None)

    out = publish_one(conn, pub, config, fake_tiktok_client, dry_run=True)

    assert out.result == "dry_run"
    assert fake_tiktok_client.calls == []
    row = conn.execute(
        "SELECT delivery_state, remote_post_id FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()
    # A dry run leaves the delivery state alone — it delivered nothing.
    assert row["delivery_state"] is None
    assert row["remote_post_id"] == "DRYRUN"


# ---- Token refresh, wired into the publish path ---------------------------------------


def test_publishing_refreshes_an_expiring_token_first(conn, config, make_publication):
    """The refresh has to happen INSIDE the publish path, not in a background job: a token
    refreshed an hour ago by some other loop can still expire between then and the upload."""
    import dataclasses

    from worker.tests.conftest import FakeTikTokClient

    client = FakeTikTokClient()
    tiktok_config = dataclasses.replace(
        config, tiktok_client_key="k", tiktok_client_secret="s"
    )
    pub = make_publication(platform="tiktok", post_type="video", n_assets=1,
                           media_kind="video", public_url=None)
    _write_local_file(config, conn, pub["post_id"])
    # Push the token to the edge of expiry.
    conn.execute(
        "UPDATE channels SET token_expires_at = ? WHERE id = ?",
        ("2020-01-01T00:00:00+00:00", pub["channel_id"]),
    )
    conn.commit()

    publish_one(conn, pub, tiktok_config, client, dry_run=False, sleep_fn=lambda _s: None)

    kinds = [c[0] for c in client.calls]
    assert kinds[0] == "tt_refresh", f"expected a refresh before anything else, got {kinds}"
    stored = conn.execute(
        "SELECT access_token FROM channels WHERE id = ?", (pub["channel_id"],)
    ).fetchone()
    assert stored["access_token"] == "act.REFRESHED"


def test_a_revoked_authorisation_fails_terminally_and_says_reconnect(
    conn, config, make_publication
):
    import dataclasses

    from worker.tests.conftest import FakeTikTokClient

    client = FakeTikTokClient()
    tiktok_config = dataclasses.replace(
        config, tiktok_client_key="k", tiktok_client_secret="s"
    )
    pub = make_publication(platform="tiktok", post_type="video", n_assets=1,
                           media_kind="video", public_url=None)
    _write_local_file(config, conn, pub["post_id"])
    # No refresh token and an expired access token: only a human can fix this.
    conn.execute(
        "UPDATE channels SET token_expires_at = ?, refresh_token = NULL WHERE id = ?",
        ("2020-01-01T00:00:00+00:00", pub["channel_id"]),
    )
    conn.commit()

    publish_one(conn, pub, tiktok_config, client, dry_run=False, sleep_fn=lambda _s: None)

    row = conn.execute(
        "SELECT status, next_retry_at, last_error FROM publications WHERE id = ?",
        (pub["id"],),
    ).fetchone()
    assert row["status"] == "failed"
    assert row["next_retry_at"] is None      # retrying cannot reconnect an account
    assert "reconnect" in row["last_error"].lower()
