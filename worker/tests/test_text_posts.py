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
        supports_text=True, max_carousel=10, max_caption_chars=None
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
        supports_text=False, max_carousel=10, max_caption_chars=10
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


def test_a_normal_image_post_is_unaffected(conn, config, fake_client, make_publication):
    """Guard against the new rules leaking into the existing path."""
    pub = make_publication(platform="instagram", n_assets=1)

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "posted"
