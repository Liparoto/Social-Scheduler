"""A text post carries a caption and no media.

The composer prevents aiming one at a platform that can't publish it, but a post can be
retargeted later, restored from a backup, or hand-edited — so the worker never trusts the
UI and re-checks against the platform's declared capabilities.
"""

from __future__ import annotations

import pytest

from worker.publisher import publish_one


def _make_text_post(conn, make_publication, platform="instagram", caption="hello threads"):
    """A publication whose post is text-only: caption set, zero assets."""
    pub = make_publication(platform=platform, n_assets=0)
    conn.execute(
        "UPDATE posts SET post_type = 'text', caption = ? WHERE id = ?",
        (caption, pub["post_id"]),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()


def test_a_text_post_is_rejected_terminally_on_a_platform_without_text_support(
    conn, config, fake_client, make_publication
):
    pub = _make_text_post(conn, make_publication, platform="instagram")

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "failed"
    assert row["next_retry_at"] is None          # retrying can't give Instagram a text format
    assert "text" in row["last_error"].lower()
    assert fake_client.calls == []               # nothing attempted against the API


@pytest.fixture
def text_capable_instagram(monkeypatch):
    """Pretend Instagram supports text, so the LATER text rules are reachable.

    Without this the `supports_text` rule fires first and every text test would just be
    re-testing that one branch — the asset and caption rules would never be exercised.
    """
    from worker import clients

    caps = dict(clients.PLATFORM_CAPS)
    caps["instagram"] = clients.PlatformCaps(
        supports_text=True, max_carousel=10, caption_chars={}
    )
    monkeypatch.setattr(clients, "PLATFORM_CAPS", caps)
    monkeypatch.setattr("worker.publisher.PLATFORM_CAPS", caps)
    return caps


def test_a_text_post_with_assets_attached_is_rejected(
    conn, config, fake_client, make_publication, text_capable_instagram
):
    # post_type says text but an image is attached — contradictory, so refuse rather than
    # silently dropping the image or silently ignoring the type.
    pub = make_publication(platform="instagram", n_assets=1)
    conn.execute("UPDATE posts SET post_type = 'text' WHERE id = ?", (pub["post_id"],))
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT last_error FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert "asset" in row["last_error"].lower()


def test_a_text_post_with_no_caption_is_rejected(
    conn, config, fake_client, make_publication, text_capable_instagram
):
    pub = _make_text_post(conn, make_publication, caption="   ")

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT last_error FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert "caption" in row["last_error"].lower()


def test_an_over_length_caption_is_rejected_when_the_platform_declares_a_limit(
    conn, config, fake_client, make_publication, monkeypatch
):
    from worker import clients

    # Give Instagram a tiny limit for this test rather than waiting for Threads to exist.
    capped = dict(clients.PLATFORM_CAPS)
    capped["instagram"] = clients.PlatformCaps(
        supports_text=False, max_carousel=10, caption_chars={"single": 10}
    )
    monkeypatch.setattr(clients, "PLATFORM_CAPS", capped)
    monkeypatch.setattr("worker.publisher.PLATFORM_CAPS", capped)

    pub = make_publication(platform="instagram", n_assets=1)
    conn.execute(
        "UPDATE posts SET caption = ? WHERE id = ?",
        ("x" * 50, pub["post_id"]),
    )
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT last_error FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert "50" in row["last_error"] and "10" in row["last_error"]
    assert fake_client.calls == []


def test_caption_limit_is_looked_up_by_post_type(
    conn, config, fake_client, make_publication, monkeypatch
):
    """A single number would reject both a long text post and a short single-image post —
    this is the whole point of moving to a per-post-type mapping."""
    from worker import clients

    caps = dict(clients.PLATFORM_CAPS)
    caps["instagram"] = clients.PlatformCaps(
        supports_text=True, max_carousel=10, caption_chars={"text": 10, "single": 100}
    )
    monkeypatch.setattr(clients, "PLATFORM_CAPS", caps)
    monkeypatch.setattr("worker.publisher.PLATFORM_CAPS", caps)

    # 50 chars is over the "text" limit (10) ...
    text_pub = _make_text_post(conn, make_publication, caption="x" * 50)
    out = publish_one(conn, text_pub, config, fake_client, dry_run=False)
    assert out.result == "failed"
    row = conn.execute(
        "SELECT last_error FROM publications WHERE id = ?", (text_pub["id"],)
    ).fetchone()
    assert "50" in row["last_error"] and "10" in row["last_error"]

    # ... but under the "single" limit (100), so the same caption length is accepted here.
    single_pub = make_publication(platform="instagram", n_assets=1)
    conn.execute(
        "UPDATE posts SET caption = ? WHERE id = ?", ("x" * 50, single_pub["post_id"])
    )
    conn.commit()
    single_pub = conn.execute(
        "SELECT * FROM publications WHERE id = ?", (single_pub["id"],)
    ).fetchone()

    out2 = publish_one(conn, single_pub, config, fake_client, dry_run=False)
    assert out2.result == "posted"


def test_uploads_media_bytes_platform_does_not_require_a_public_url(
    conn, config, fake_client, make_publication, monkeypatch
):
    """Discord/Telegram-style platforms send the file in the request, so validation must
    check the local file instead of demanding a public_url (which drives the tunnel)."""
    from worker import clients

    caps = dict(clients.PLATFORM_CAPS)
    caps["instagram"] = clients.PlatformCaps(
        supports_text=False, max_carousel=10, caption_chars={}, uploads_media_bytes=True
    )
    monkeypatch.setattr(clients, "PLATFORM_CAPS", caps)
    monkeypatch.setattr("worker.publisher.PLATFORM_CAPS", caps)

    # No public_url, and the local file doesn't exist yet: fails with a clear error.
    missing_pub = make_publication(platform="instagram", n_assets=1, public_url=None)
    out = publish_one(conn, missing_pub, config, fake_client, dry_run=False)
    assert out.result == "failed"
    row = conn.execute(
        "SELECT last_error FROM publications WHERE id = ?", (missing_pub["id"],)
    ).fetchone()
    assert "missing from the local store" in row["last_error"]

    # No public_url, but the local file exists: validation passes.
    present_pub = make_publication(platform="instagram", n_assets=1, public_url=None)
    asset_row = conn.execute(
        """SELECT a.storage_path FROM assets a
           JOIN post_assets pa ON pa.asset_id = a.id
           WHERE pa.post_id = ?""",
        (present_pub["post_id"],),
    ).fetchone()
    local_path = config.asset_storage_dir / asset_row["storage_path"]
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_bytes(b"fake image bytes")

    out2 = publish_one(conn, present_pub, config, fake_client, dry_run=False)
    assert out2.result == "posted"


def test_a_normal_image_post_is_unaffected(conn, config, fake_client, make_publication):
    """Guard against the new rules leaking into the existing path."""
    pub = make_publication(platform="instagram", n_assets=1)

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "posted"
