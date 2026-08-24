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
from .discord_api import DiscordClient
from .graph_api import GraphClient
from .telegram_api import TelegramClient
from .tiktok_api import TikTokClient

FACEBOOK_BASE = "https://graph.facebook.com"
THREADS_BASE = "https://graph.threads.net"
DISCORD_BASE = "https://discord.com/api/v10"
TELEGRAM_BASE = "https://api.telegram.org"
TIKTOK_BASE = "https://open.tiktokapis.com"

# Every platform this worker has an adapter for. Adding one here without also adding it to
# clients._BASE_URLS, publisher._PUBLISHERS, publisher._QUOTA_GATED, preflight._CHECKS and
# metrics._FETCHERS fails test_platform_dispatch.py — which is the point.
SUPPORTED_PLATFORMS = ("instagram", "facebook", "threads", "discord", "telegram",
                       "tiktok")


class UnknownPlatform(Exception):
    """A channel names a platform this worker has no adapter for."""


# Base-URL resolver per platform. A registry, not an if-chain, so this list can't silently
# drift from SUPPORTED_PLATFORMS/_PUBLISHERS/_CHECKS/_FETCHERS the way a hand-written
# `if platform == ... elif ... else raise` could.
_BASE_URLS: dict[str, Callable[[Config], str]] = {
    "facebook": lambda _config: FACEBOOK_BASE,
    "instagram": lambda config: config.graph_base,
    "threads": lambda _config: THREADS_BASE,
    "discord": lambda _config: DISCORD_BASE,
    "telegram": lambda _config: TELEGRAM_BASE,
    "tiktok": lambda _config: TIKTOK_BASE,
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
    # Discord's version is pinned in DISCORD_BASE itself (.../api/v10); recorded here too
    # so the registry never has to special-case a platform for "no separate version".
    "discord": lambda _config: "v10",
    # Telegram has no API versioning at all. Empty string documents that fact rather than
    # pretending a version exists.
    "telegram": lambda _config: "",
    # TikTok versions by path segment (/v2/...), which the client builds into each path
    # rather than into its base URL. Recorded here so the registry never has to
    # special-case a platform, same as Discord above.
    "tiktok": lambda _config: "v2",
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
    # WHICH video destinations this platform has, not merely whether it has any. A bool
    # cannot express Facebook, where the same clip goes to the feed as an ordinary video
    # OR to Reels — two different endpoints with different rules. Empty = no video path,
    # the safe default: worst case autofill under-selects rather than queuing a video a
    # channel can never publish (which fails terminally forever — see select_candidates).
    video_surfaces: frozenset[str] = frozenset()
    # False when the credential alone identifies the destination, so there is no separate
    # account id to store or ask for (Discord's webhook URL is both address and secret).
    uses_account_id: bool = True
    # True when the platform can publish still images at all. Every platform but TikTok
    # can, which is why this defaults True — a new platform keeps today's behaviour unless
    # it explicitly opts out. TikTok's photo endpoint accepts only PULL_FROM_URL from a
    # DNS-verified domain, and this install serves assets from an ephemeral trycloudflare
    # URL it does not own, so photos are unreachable rather than merely unbuilt.
    supports_images: bool = True
    # True when this platform constrains aspect ratio, so it should be sent the
    # Instagram-conformed derivative (assets.publish_path) rather than the untouched
    # original. Defaults True so every platform keeps today's behaviour unless it
    # explicitly opts out below.
    needs_conformed_media: bool = True
    # Whether this platform's FEED video has aspect-ratio rules of its own. True keeps
    # today's behaviour everywhere. False only for Facebook, whose /videos edge accepts
    # any ratio up to 20 minutes — Instagram's feed video IS Reels and genuinely is
    # constrained, so the two cannot share one platform-wide answer. Only meaningful for
    # the "feed" surface; a platform's Reels/Story surfaces are governed by
    # needs_conformed_media as before (see _needs_conformed in publisher.py).
    feed_video_is_constrained: bool = True

    def caption_limit(self, post_type: str) -> int | None:
        return self.caption_chars.get(post_type)

    @property
    def supports_video(self) -> bool:
        """Kept so autofill's :supports_video binding needs no knowledge of surfaces."""
        return bool(self.video_surfaces)


PLATFORM_CAPS: dict[str, PlatformCaps] = {
    # Instagram: feed carousels cap at 10 (see reference.md). No text-only format.
    # All Instagram feed video IS Reels, so there is no separate "reel" surface — it
    # would mean the same thing as "feed", two values that can never differ.
    "instagram": PlatformCaps(
        supports_text=False, max_carousel=10, caption_chars={},
        video_surfaces=frozenset({"feed", "story"}),
    ),
    # Facebook Pages: attached_media multi-photo posts cap at 10. No text-only format
    # here either — a Page status update is a different product surface we don't publish.
    # Video has two genuinely different destinations: feed video (POST /{page}/videos,
    # any aspect ratio, <=20 min) and Reels (POST /{page}/video_reels, vertical, 3-90s).
    "facebook": PlatformCaps(
        supports_text=False, max_carousel=10, caption_chars={},
        video_surfaces=frozenset({"feed", "reel"}), feed_video_is_constrained=False,
    ),
    # Threads: text-first. 500-character text limit, 2-20 carousel children,
    # 250 API-published posts per rolling 24h (verified 2026-07-25).
    "threads": PlatformCaps(
        supports_text=True, max_carousel=20,
        caption_chars={"text": 500, "single": 500, "carousel": 500},
    ),
    # Discord webhook: 2000-char message, up to 10 attachments, uploads bytes itself.
    # The webhook URL is both address and secret, so there is no separate account id.
    # Discord has no aspect-ratio rules of its own, so it should get the untouched
    # original rather than the Instagram-shaped derivative.
    "discord": PlatformCaps(
        supports_text=True, max_carousel=10,
        caption_chars={"text": 2000, "single": 2000, "carousel": 2000},
        uploads_media_bytes=True, uses_account_id=False, needs_conformed_media=False,
    ),
    # Telegram bot: 4096 for a text message but only 1024 once media is attached;
    # sendMediaGroup takes 2-10 items. Uploads bytes itself.
    # Telegram, like Discord, has no aspect-ratio rules — send the untouched original.
    "telegram": PlatformCaps(
        supports_text=True, max_carousel=10,
        caption_chars={"text": 4096, "single": 1024, "carousel": 1024},
        uploads_media_bytes=True, uses_account_id=True, needs_conformed_media=False,
    ),
    # TikTok: video only (see supports_images above). Uploads bytes itself via chunked
    # FILE_UPLOAD, so like Discord/Telegram it needs neither a public URL nor cloudflared.
    # caption_chars is EMPTY because the inbox endpoint has no caption field at all — the
    # creator writes one in the TikTok app — so there is no limit to enforce rather than a
    # limit we happen not to know. max_carousel=0 for the same reason: there is no
    # multi-image format here to cap. needs_conformed_media=False both because TikTok has
    # its own aspect rules and because its app review guidelines forbid altering the
    # creator's content.
    "tiktok": PlatformCaps(
        supports_text=False, max_carousel=0, caption_chars={},
        uploads_media_bytes=True, video_surfaces=frozenset({"feed"}), supports_images=False,
        uses_account_id=True, needs_conformed_media=False,
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


# How to build a client per platform. ClientRegistry used to hardcode GraphClient; Discord and
# Telegram are not Graph APIs, and the publisher only ever calls clients by method name, so the
# construction is the only Meta-specific part left.
_CLIENT_FACTORIES: dict[str, Callable[[str, str], object]] = {
    "instagram": lambda version, base: GraphClient(version, base_url=base),
    "facebook": lambda version, base: GraphClient(version, base_url=base),
    "threads": lambda version, base: GraphClient(version, base_url=base),
    "discord": lambda _version, base: DiscordClient(base_url=base),
    "telegram": lambda _version, base: TelegramClient(base_url=base),
    "tiktok": lambda _version, base: TikTokClient(base_url=base),
}

assert set(_CLIENT_FACTORIES) == set(SUPPORTED_PLATFORMS), (
    "clients._CLIENT_FACTORIES and clients.SUPPORTED_PLATFORMS disagree"
)


class ClientRegistry:
    """Lazily builds and caches one client per (platform, base URL, API version) triple.

    Caching on base+version alone would let two platforms that happen to share both
    (unlikely today, but not impossible) collide and hand back a client built for the
    wrong platform's factory. Keying on platform too closes that off.
    """

    def __init__(self, config: Config, factory: Callable[[str, str], object] | None = None) -> None:
        self._config = config
        # None (the default) means: build each platform's client via its own entry in
        # _CLIENT_FACTORIES. Tests inject an explicit factory to hand back a fake client
        # for every platform instead — that injected-factory path must keep working
        # exactly as it does today.
        self._factory = factory
        self._cache: dict[tuple[str, str, str], object] = {}

    def for_platform(self, platform: str):
        base = base_url_for(platform, self._config)
        version = api_version_for(platform, self._config)
        key = (platform, base, version)
        if key not in self._cache:
            factory = self._factory or _CLIENT_FACTORIES[platform]
            self._cache[key] = factory(version, base)
        return self._cache[key]
