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


@dataclass(frozen=True)
class PlatformCaps:
    """What a platform can actually publish.

    Declared as data so validation is a lookup rather than a scatter of `if platform ==`
    checks, and so a new platform cannot be added without stating what it supports.
    """

    supports_text: bool          # can publish a post with a caption and no media
    max_carousel: int            # maximum children in a multi-image post
    max_caption_chars: int | None  # None = no limit this worker enforces


PLATFORM_CAPS: dict[str, PlatformCaps] = {
    # Instagram: feed carousels cap at 10 (see reference.md). No text-only format.
    "instagram": PlatformCaps(supports_text=False, max_carousel=10, max_caption_chars=None),
    # Facebook Pages: attached_media multi-photo posts cap at 10. No text-only format
    # here either — a Page status update is a different product surface we don't publish.
    "facebook": PlatformCaps(supports_text=False, max_carousel=10, max_caption_chars=None),
    # Threads: text-first. 500-character text limit, 2-20 carousel children,
    # 250 API-published posts per rolling 24h (verified 2026-07-25).
    "threads": PlatformCaps(supports_text=True, max_carousel=20, max_caption_chars=500),
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


class ClientRegistry:
    """Lazily builds and caches one Graph client per base URL."""

    def __init__(self, config: Config, factory: Callable[[str, str], object] | None = None) -> None:
        self._config = config
        self._factory = factory or (
            lambda version, base_url: GraphClient(version, base_url=base_url)
        )
        self._cache: dict[str, object] = {}

    def for_platform(self, platform: str):
        base = base_url_for(platform, self._config)
        if base not in self._cache:
            self._cache[base] = self._factory(self._config.graph_version, base)
        return self._cache[base]
