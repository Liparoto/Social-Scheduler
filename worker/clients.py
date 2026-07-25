"""Which Graph API host to talk to, per channel platform.

META_GRAPH_BASE is a per-INSTALL setting, but the correct host is really a per-PLATFORM
fact: Facebook Pages always live on graph.facebook.com, while Instagram may be reached
via graph.facebook.com (Facebook-Login path) or graph.instagram.com (Instagram-Login
path) depending on how this install is set up. So FB pins its own host and IG keeps
whatever the install configured — which lets one install mix IG and FB channels.

Clients are cached per base URL: they hold a requests.Session, so reusing them keeps
connection pooling and avoids rebuilding one per publication.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .config import Config
from .graph_api import GraphClient

FACEBOOK_BASE = "https://graph.facebook.com"
THREADS_BASE = "https://graph.threads.net"

# Every platform this worker has an adapter for. Adding one here without also adding it to
# clients._BASE_URLS, publisher._PUBLISHERS, publisher._QUOTA_GATED, preflight._CHECKS and
# metrics._FETCHERS fails test_platform_dispatch.py — which is the point.
SUPPORTED_PLATFORMS = ("instagram", "facebook", "threads")


class UnknownPlatform(Exception):
    """A channel names a platform this worker has no adapter for."""


# Base-URL resolver per platform. A registry, not an if-chain, so this list can't silently
# drift from SUPPORTED_PLATFORMS/_PUBLISHERS/_CHECKS/_FETCHERS the way a hand-written
# `if platform == ... elif ... else raise` could.
_BASE_URLS: dict[str, Callable[[Config], str]] = {
    "facebook": lambda _config: FACEBOOK_BASE,
    "instagram": lambda config: config.graph_base,
    "threads": lambda _config: THREADS_BASE,
}

assert set(_BASE_URLS) == set(SUPPORTED_PLATFORMS), (
    "clients._BASE_URLS and clients.SUPPORTED_PLATFORMS disagree"
)

# API-version resolver per platform. Threads versions its Graph API independently of the
# Instagram/Facebook epoch (currently v1.0 vs v25.0+), so it cannot share the install-wide
# `Config.graph_version` the way IG/FB do — a registry, like _BASE_URLS, so a new platform
# can't silently inherit the wrong version.
_API_VERSIONS: dict[str, Callable[[Config], str]] = {
    "facebook": lambda config: config.graph_version,
    "instagram": lambda config: config.graph_version,
    "threads": lambda config: config.threads_api_version,
}

assert set(_API_VERSIONS) == set(SUPPORTED_PLATFORMS), (
    "clients._API_VERSIONS and clients.SUPPORTED_PLATFORMS disagree"
)


@dataclass(frozen=True)
class PlatformCaps:
    """What a platform can actually publish.

    Declared as data so validation is a lookup rather than a scatter of `if platform ==`
    checks, and so a new platform cannot be added without stating what it supports.
    """

    supports_text: bool          # can publish a post with a caption and no media
    max_carousel: int            # maximum children in a multi-image post
    # Caption limits differ BY POST TYPE on some platforms — Telegram allows 4096 characters
    # for a text post but only 1024 once a photo is attached — so this is a mapping, not one
    # number. A post type absent from the mapping has no limit we enforce.
    caption_chars: dict[str, int]
    # True when the platform accepts the file bytes in the publish request. Meta fetches media
    # from a public URL (which is why publishing opens a tunnel); these platforms do not, so
    # they need neither a public URL nor cloudflared.
    uploads_media_bytes: bool = False
    # False when the credential alone identifies the destination, so there is no separate
    # account id to store or ask for (Discord's webhook URL is both address and secret).
    uses_account_id: bool = True

    def caption_limit(self, post_type: str) -> int | None:
        return self.caption_chars.get(post_type)


PLATFORM_CAPS: dict[str, PlatformCaps] = {
    # Instagram: feed carousels cap at 10 (see reference.md). No text-only format.
    "instagram": PlatformCaps(supports_text=False, max_carousel=10, caption_chars={}),
    # Facebook Pages: attached_media multi-photo posts cap at 10. No text-only format
    # here either — a Page status update is a different product surface we don't publish.
    "facebook": PlatformCaps(supports_text=False, max_carousel=10, caption_chars={}),
    # Threads: text-first. 500-character text limit, 2-20 carousel children,
    # 250 API-published posts per rolling 24h (verified 2026-07-25).
    "threads": PlatformCaps(
        supports_text=True, max_carousel=20,
        caption_chars={"text": 500, "single": 500, "carousel": 500},
    ),
}

assert set(PLATFORM_CAPS) == set(SUPPORTED_PLATFORMS), (
    "clients.PLATFORM_CAPS and clients.SUPPORTED_PLATFORMS disagree"
)


def base_url_for(platform: str, config: Config) -> str:
    """The Graph API base URL to use for a channel on `platform`.

    Raises UnknownPlatform rather than guessing. Falling back to the install's configured
    base is how an unrecognised platform ends up quietly talking to Instagram's API.
    """
    resolver = _BASE_URLS.get(platform)
    if resolver is None:
        raise UnknownPlatform(platform)
    return resolver(config)


def api_version_for(platform: str, config: Config) -> str:
    """The Graph API version to use for a channel on `platform`.

    Raises UnknownPlatform rather than guessing, same reasoning as base_url_for.
    """
    resolver = _API_VERSIONS.get(platform)
    if resolver is None:
        raise UnknownPlatform(platform)
    return resolver(config)


class ClientRegistry:
    """Lazily builds and caches one Graph client per (base URL, API version) pair.

    Caching on base URL alone would be wrong now that platforms can share a base URL but
    need different versions — it would hand back a client built for the wrong version.
    """

    def __init__(self, config: Config, factory: Callable[[str, str], object] | None = None) -> None:
        self._config = config
        self._factory = factory or (
            lambda version, base_url: GraphClient(version, base_url=base_url)
        )
        self._cache: dict[tuple[str, str], object] = {}

    def for_platform(self, platform: str):
        base = base_url_for(platform, self._config)
        version = api_version_for(platform, self._config)
        key = (base, version)
        if key not in self._cache:
            self._cache[key] = self._factory(version, base)
        return self._cache[key]
