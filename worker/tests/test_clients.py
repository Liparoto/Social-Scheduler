import pytest

from worker.clients import FACEBOOK_BASE, PLATFORM_CAPS, ClientRegistry, base_url_for


def test_facebook_always_uses_facebook_base_even_on_an_ig_login_install(config):
    # An install configured for the Instagram-Login path must still reach FB Pages
    # on graph.facebook.com — the base is a per-platform fact, not a per-install one.
    config.graph_base = "https://graph.instagram.com"
    assert base_url_for("facebook", config) == FACEBOOK_BASE


def test_instagram_uses_the_installs_configured_base(config):
    config.graph_base = "https://graph.instagram.com"
    assert base_url_for("instagram", config) == "https://graph.instagram.com"


def test_unknown_platform_raises_instead_of_guessing_a_host(config):
    # Silently returning the install's base URL is how a new platform ends up talking to
    # Instagram's API — the failure this task exists to prevent.
    from worker.clients import UnknownPlatform

    with pytest.raises(UnknownPlatform):
        base_url_for("mastodon", config)


def test_registry_builds_one_client_per_base_and_caches_it(config):
    config.graph_base = "https://graph.instagram.com"
    built = []

    def factory(version, base_url):
        built.append(base_url)
        return ("client", base_url)

    reg = ClientRegistry(config, factory=factory)
    ig1 = reg.for_platform("instagram")
    ig2 = reg.for_platform("instagram")
    fb = reg.for_platform("facebook")

    assert ig1 is ig2                      # cached, not rebuilt
    assert ig1 == ("client", "https://graph.instagram.com")
    assert fb == ("client", FACEBOOK_BASE)
    assert built == ["https://graph.instagram.com", FACEBOOK_BASE]


def test_threads_resolves_to_its_own_api_version_through_the_registry(config):
    """The bug this guards: ClientRegistry.for_platform used to build every platform's
    client with the single install-wide config.graph_version. Threads' Graph API is
    versioned independently (v1.0), so a real Threads call would 404 against v25.0. This
    must go through ClientRegistry — a directly constructed GraphClient can't catch it."""
    reg = ClientRegistry(config)

    threads_client = reg.for_platform("threads")
    ig_client = reg.for_platform("instagram")
    fb_client = reg.for_platform("facebook")

    assert threads_client.base == "https://graph.threads.net/v1.0"
    assert ig_client.base == f"{config.graph_base}/{config.graph_version}"
    assert fb_client.base == f"{FACEBOOK_BASE}/{config.graph_version}"


def test_threads_api_version_env_override(config, monkeypatch):
    monkeypatch.setenv("THREADS_API_VERSION", "v2.0")
    from worker.config import Config as ConfigCls

    fresh = ConfigCls.from_env()
    assert fresh.threads_api_version == "v2.0"


def test_threads_api_version_defaults_to_v1(config):
    assert config.threads_api_version == "v1.0"


def test_same_base_url_different_version_yields_different_client_instances(config):
    """Prove the cache key fix: if two platforms shared a base URL but needed different
    versions, the old base-URL-only cache key would silently hand back the wrong client."""
    built = []

    def factory(version, base_url):
        client = object()
        built.append((version, base_url, client))
        return client

    reg = ClientRegistry(config, factory=factory)

    # Force instagram and threads to share a base URL, differing only by version.
    from worker import clients as clients_mod

    monkeypatch_targets = {
        "instagram": lambda _config: "https://shared.example.com",
        "threads": lambda _config: "https://shared.example.com",
    }
    original = dict(clients_mod._BASE_URLS)
    clients_mod._BASE_URLS.update(monkeypatch_targets)
    try:
        ig_client = reg.for_platform("instagram")
        threads_client = reg.for_platform("threads")
        ig_client_again = reg.for_platform("instagram")
    finally:
        clients_mod._BASE_URLS.clear()
        clients_mod._BASE_URLS.update(original)

    assert ig_client is not threads_client   # same base, different version -> different client
    assert ig_client is ig_client_again      # same platform, repeated call -> identical instance
    assert len(built) == 2                   # threads was NOT served from instagram's cache slot


def test_facebook_declares_both_video_surfaces():
    caps = PLATFORM_CAPS["facebook"]
    assert caps.video_surfaces == frozenset({"feed", "reel"})


def test_instagram_has_no_reel_surface():
    """All Instagram feed video IS Reels, so a separate 'reel' surface would mean the
    same thing as 'feed' — two values that can never differ. Facebook-only by design."""
    assert PLATFORM_CAPS["instagram"].video_surfaces == frozenset({"feed", "story"})


def test_supports_video_is_derived_not_stored():
    """autofill's SQL binding still reads caps.supports_video; it must keep working
    without autofill knowing surfaces exist."""
    assert PLATFORM_CAPS["facebook"].supports_video is True
    assert PLATFORM_CAPS["threads"].supports_video is False
    assert PLATFORM_CAPS["threads"].video_surfaces == frozenset()


def test_every_platform_declares_at_least_the_feed_surface():
    from worker.clients import PLATFORM_CAPS

    for name, caps in PLATFORM_CAPS.items():
        assert "feed" in caps.surfaces, f"{name} must be able to publish to a feed"


def test_instagram_is_the_only_story_capable_platform():
    """Mirrors publisher._validate's story rule. When a second platform gains Stories,
    this test and PLATFORM_CAPS change together — and publisher.py does not have to."""
    from worker.clients import PLATFORM_CAPS

    story_capable = {n for n, c in PLATFORM_CAPS.items() if "story" in c.surfaces}
    assert story_capable == {"instagram"}


def test_video_surfaces_never_claims_a_surface_the_platform_lacks():
    """video_surfaces is about which video destinations exist; surfaces is about which
    destinations exist at all. A video-only surface would be unpublishable."""
    from worker.clients import PLATFORM_CAPS

    for name, caps in PLATFORM_CAPS.items():
        assert caps.video_surfaces <= caps.surfaces, f"{name} has a video-only surface"
