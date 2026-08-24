"""An unrecognised platform must fail LOUDLY and locally.

Before this, platform branching used two-way ternaries and bare `else`, so a channel on a
new platform inherited Instagram's behavior: it would be published through Instagram's
container flow and preflighted against Instagram's quota endpoint. These tests pin the
replacement — explicit registries, per-item terminal failure, no collateral damage.
"""

from __future__ import annotations

import pytest

from worker.clients import SUPPORTED_PLATFORMS
from worker.publisher import publish_one


def _force_platform(conn, channel_id: int, platform: str) -> None:
    """Bypass the CHECK constraint to simulate a stale/unknown platform value in the DB.

    Migration 0008 rebuilt `channels` with CHECK (platform IN ('instagram', 'facebook',
    'threads')) — verified against sqlite_master rather than assumed, since a mismatched
    replace() would leave the UPDATE below silently constrained and the test would pass
    for the wrong reason (or fail confusingly). Rewriting sqlite_master alone is not
    enough: SQLite caches the parsed schema (including CHECK constraints) per connection,
    so the UPDATE below would still be rejected by the OLD constraint until the cached
    schema is invalidated. Bumping `schema_version` forces a reparse on next access.
    """
    original_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'channels'"
    ).fetchone()[0]
    needle = "'instagram', 'facebook', 'threads'"
    assert needle in original_sql, (
        f"expected channels CHECK to contain {needle!r}; got: {original_sql!r}"
    )
    replacement = needle + f", '{platform}'"

    conn.execute("PRAGMA writable_schema = ON")
    conn.execute(
        "UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE name = 'channels'",
        (needle, replacement),
    )
    conn.commit()
    # Force this connection to reparse sqlite_master — otherwise its cached CHECK
    # constraint (parsed at connect/first-use time) still rejects the new value below.
    schema_version = conn.execute("PRAGMA schema_version").fetchone()[0]
    conn.execute(f"PRAGMA schema_version = {schema_version + 1}")
    conn.execute("PRAGMA writable_schema = OFF")
    conn.commit()

    new_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'channels'"
    ).fetchone()[0]
    assert replacement in new_sql, "CHECK rewrite did not take effect"

    conn.execute("UPDATE channels SET platform = ? WHERE id = ?", (platform, channel_id))
    conn.commit()


def test_all_registries_cover_exactly_the_supported_platforms():
    """The guard that makes adding a platform mechanical: miss a registry, fail here."""
    from worker.clients import PLATFORM_CAPS, _API_VERSIONS, _BASE_URLS, _CLIENT_FACTORIES
    from worker.metrics import _FETCHERS
    from worker.preflight import _CHECKS
    from worker.publisher import _PUBLISHERS, _QUOTA_GATED, _QUOTA_READERS

    assert set(_BASE_URLS) == set(SUPPORTED_PLATFORMS), "clients base-url registry out of sync"
    assert set(_API_VERSIONS) == set(SUPPORTED_PLATFORMS), "clients API-version registry out of sync"
    assert set(_CLIENT_FACTORIES) == set(SUPPORTED_PLATFORMS), "clients client-factory registry out of sync"
    assert set(_PUBLISHERS) == set(SUPPORTED_PLATFORMS), "publisher registry out of sync"
    assert set(_CHECKS) == set(SUPPORTED_PLATFORMS), "preflight registry out of sync"
    assert set(_FETCHERS) == set(SUPPORTED_PLATFORMS), "metrics registry out of sync"
    assert set(_QUOTA_GATED) == set(SUPPORTED_PLATFORMS), "quota-gate declaration out of sync"
    assert set(PLATFORM_CAPS) == set(SUPPORTED_PLATFORMS), "capability registry out of sync"
    gated = {p for p, gated in _QUOTA_GATED.items() if gated}
    assert set(_QUOTA_READERS) == gated, "quota-reader registry must match _QUOTA_GATED==True"


def test_platform_caps_are_declared_for_every_supported_platform():
    from worker.clients import PLATFORM_CAPS

    assert set(PLATFORM_CAPS) == set(SUPPORTED_PLATFORMS), "capability registry out of sync"


def test_neither_meta_platform_claims_text_support():
    """Instagram and Facebook have no text-only post format — a caps typo here would let
    the publisher send a captionless-image-less post at them."""
    from worker.clients import PLATFORM_CAPS

    assert PLATFORM_CAPS["instagram"].supports_text is False
    assert PLATFORM_CAPS["facebook"].supports_text is False
    assert PLATFORM_CAPS["instagram"].max_carousel == 10


def test_caption_limits_are_declared_per_post_type():
    from worker.clients import PLATFORM_CAPS

    # Threads' 500 applies to every type it supports; Meta declares no limit at all.
    assert PLATFORM_CAPS["threads"].caption_limit("text") == 500
    assert PLATFORM_CAPS["threads"].caption_limit("single") == 500
    assert PLATFORM_CAPS["instagram"].caption_limit("single") is None
    # An unknown post type must not invent a limit.
    assert PLATFORM_CAPS["threads"].caption_limit("video") is None


def test_meta_platforms_do_not_upload_bytes_themselves():
    from worker.clients import PLATFORM_CAPS

    # Meta fetches media from a public URL, which is what the tunnel exists for.
    for platform in ("instagram", "facebook", "threads"):
        assert PLATFORM_CAPS[platform].uploads_media_bytes is False
        assert PLATFORM_CAPS[platform].uses_account_id is True


def test_only_meta_platforms_declare_needs_conformed_media():
    """Instagram/Facebook/Threads constrain aspect ratio, so they must keep receiving the
    Instagram-conformed derivative. Discord and Telegram have no aspect-ratio rules, so they
    should get the untouched original instead."""
    from worker.clients import PLATFORM_CAPS, SUPPORTED_PLATFORMS

    assert set(PLATFORM_CAPS) == set(SUPPORTED_PLATFORMS)
    for platform in ("instagram", "facebook", "threads"):
        assert PLATFORM_CAPS[platform].needs_conformed_media is True
    for platform in ("discord", "telegram"):
        assert PLATFORM_CAPS[platform].needs_conformed_media is False


def test_an_unsupported_platform_fails_terminally_and_visibly(
    conn, config, fake_client, make_publication
):
    pub = make_publication()
    _force_platform(conn, pub["channel_id"], "mastodon")

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "failed"          # terminal: retrying can't add an adapter
    assert row["next_retry_at"] is None
    assert "mastodon" in row["last_error"]
    assert fake_client.calls == []            # nothing was attempted against any API


def test_one_unsupported_channel_does_not_affect_another_publication(
    conn, config, fake_client, make_publication
):
    bad = make_publication()
    good = make_publication()
    _force_platform(conn, bad["channel_id"], "mastodon")

    publish_one(conn, bad, config, fake_client, dry_run=False)
    out = publish_one(conn, good, config, fake_client, dry_run=False)

    assert out.result == "posted"
    good_row = conn.execute("SELECT status FROM publications WHERE id = ?", (good["id"],)).fetchone()
    bad_row = conn.execute("SELECT status FROM publications WHERE id = ?", (bad["id"],)).fetchone()
    assert good_row["status"] == "posted"
    assert bad_row["status"] == "failed"


def test_preflight_reports_an_unsupported_platform_without_calling_any_api(conn, fake_client):
    from worker.preflight import check_channels

    class Registry:
        def __init__(self):
            self.asked = []

        def for_platform(self, platform):
            self.asked.append(platform)
            return fake_client

    rows = [
        {
            "id": 7,
            "account_name": "Someplace",
            "platform": "mastodon",
            "access_token": "tok",
            "remote_account_id": "abc",
        }
    ]
    lines = []
    registry = Registry()
    ok = check_channels(rows, registry, print_fn=lines.append)

    assert ok is False
    assert any("mastodon" in line for line in lines)
    assert fake_client.calls == []       # must NOT fall through to Instagram's quota call


def test_an_unknown_platform_does_not_abort_the_rest_of_the_batch(
    conn, config, fake_client, make_publication, monkeypatch
):
    """run_once resolves a client per publication; a raising lookup must not kill the batch.

    This has to go through run_once, not publish_one — run_once is the only place
    base_url_for is called, so it's the only place the raise can escape.
    """
    from datetime import datetime, timezone

    from worker.clients import ClientRegistry
    from worker.run import run_once

    now = datetime(2026, 7, 22, 18, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    bad = make_publication(post_type="single", n_assets=1, now=now)
    good = make_publication(post_type="single", n_assets=1, now=now)
    _force_platform(conn, bad["channel_id"], "mastodon")

    # A real registry, so base_url_for actually raises for 'mastodon' — but handing back
    # the fake client for the platforms it does know.
    registry = ClientRegistry(config, factory=lambda version, base_url: fake_client)

    n = run_once(conn, config, fake_client, client_for=registry.for_platform, now=now)

    bad_row = conn.execute(
        "SELECT status, last_error FROM publications WHERE id = ?", (bad["id"],)
    ).fetchone()
    good_row = conn.execute(
        "SELECT status FROM publications WHERE id = ?", (good["id"],)
    ).fetchone()

    assert bad_row["status"] == "failed"
    assert "mastodon" in bad_row["last_error"]
    assert good_row["status"] == "posted"   # the batch carried on
    assert n == 2                           # both were processed, not abandoned


def test_a_platform_with_a_publisher_but_no_base_url_fails_loudly_not_via_fallback(
    conn, config, fake_client, make_publication, monkeypatch
):
    """Guards the specific bug the final review found: run the documented recipe for adding
    a platform (add it to SUPPORTED_PLATFORMS + the three dispatch registries) but forget
    clients._BASE_URLS, and the OLD code fell through to whatever client main() happened to
    build for Instagram — silently publishing through the wrong platform's API host while
    reporting 'posted'. That is a registry-disagreement bug, not an unsupported channel, and
    must fail the affected publication loudly instead of guessing.

    Simulated here by deleting 'facebook' from clients._BASE_URLS while leaving it in
    publisher._PUBLISHERS (facebook is a genuinely supported platform, so this reproduces
    the disagreement without touching real platform support).
    """
    from datetime import datetime, timezone

    import worker.clients as clients_mod
    from worker.clients import ClientRegistry
    from worker.publisher import _PUBLISHERS
    from worker.run import run_once

    assert "facebook" in _PUBLISHERS  # sanity: facebook DOES have a publisher

    now = datetime(2026, 7, 22, 18, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)
    # Reproduce the disagreement: facebook keeps its publisher but loses its base URL.
    monkeypatch.setattr(
        clients_mod, "_BASE_URLS", {"instagram": lambda config: config.graph_base}
    )

    bad = make_publication(post_type="single", n_assets=1, now=now, platform="facebook")
    good = make_publication(post_type="single", n_assets=1, now=now, platform="instagram")

    registry = ClientRegistry(config, factory=lambda version, base_url: fake_client)

    n = run_once(conn, config, fake_client, client_for=registry.for_platform, now=now)

    bad_row = conn.execute(
        "SELECT status, next_retry_at, last_error FROM publications WHERE id = ?",
        (bad["id"],),
    ).fetchone()
    good_row = conn.execute(
        "SELECT status FROM publications WHERE id = ?", (good["id"],)
    ).fetchone()

    assert bad_row["status"] == "failed"
    assert bad_row["next_retry_at"] is None
    assert "disagree" in bad_row["last_error"]
    assert "facebook" in bad_row["last_error"]
    # Must NOT have been silently published through the fallback (Instagram) client.
    facebook_call_kinds = {"page_photo", "page_child", "page_feed"}
    assert not any(kind in facebook_call_kinds for kind, _ in fake_client.calls)
    assert good_row["status"] == "posted"   # the batch carried on
    assert n == 2                           # both were processed, not abandoned


def test_the_probe_registry_is_guarded_like_every_other_one():
    """insights_probe._PROBES was the ONE platform registry with no assert against
    SUPPORTED_PLATFORMS — which is precisely how 'tiktok' came to be missing from it
    without anything complaining. A platform absent from the others is a loud import
    error; absent from this one it was silently 'unchecked'."""
    from worker.clients import SUPPORTED_PLATFORMS
    from worker.insights_probe import _PROBES

    assert set(_PROBES) == set(SUPPORTED_PLATFORMS), "probe registry out of sync"


def test_facebook_has_a_real_probe_now_that_a_page_exists():
    from worker.insights_probe import _PROBES, probe_facebook

    assert _PROBES["facebook"] is probe_facebook


def test_the_facebook_probe_still_asks_about_the_retired_names():
    """A probe that only asks about names it expects to work cannot tell you when a dead
    one comes back, nor confirm a name really is gone rather than merely unused."""
    from worker.insights_probe import FB_PAGE_CANDIDATES

    for retired in ("page_impressions", "page_impressions_unique", "page_fans",
                    "page_fan_adds", "page_fan_removes", "page_engaged_users"):
        assert retired in FB_PAGE_CANDIDATES, f"{retired} dropped from the probe"
    for survivor in ("page_views_total", "page_post_engagements",
                     "page_daily_follows_unique", "page_video_views"):
        assert survivor in FB_PAGE_CANDIDATES
