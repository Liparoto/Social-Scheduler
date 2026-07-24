from worker.clients import FACEBOOK_BASE, ClientRegistry, base_url_for


def test_facebook_always_uses_facebook_base_even_on_an_ig_login_install(config):
    # An install configured for the Instagram-Login path must still reach FB Pages
    # on graph.facebook.com — the base is a per-platform fact, not a per-install one.
    config.graph_base = "https://graph.instagram.com"
    assert base_url_for("facebook", config) == FACEBOOK_BASE


def test_instagram_uses_the_installs_configured_base(config):
    config.graph_base = "https://graph.instagram.com"
    assert base_url_for("instagram", config) == "https://graph.instagram.com"


def test_unknown_platform_falls_back_to_the_installs_base(config):
    assert base_url_for("mastodon", config) == config.graph_base


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
