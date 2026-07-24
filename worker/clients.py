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

from typing import Callable

from .config import Config
from .graph_api import GraphClient

FACEBOOK_BASE = "https://graph.facebook.com"


def base_url_for(platform: str, config: Config) -> str:
    """The Graph API base URL to use for a channel on `platform`."""
    if platform == "facebook":
        return FACEBOOK_BASE
    return config.graph_base


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
