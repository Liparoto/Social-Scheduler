"""Publish one publication to its channel.

publish_one() is the heart of the worker. It is deliberately pure-ish: it takes an
open connection, the publication row, config, a Graph client, and an explicit dry_run
flag, and returns a PublishOutcome. All state changes are written back to the
publications row so the dashboard can see exactly what happened.

Failure is ALWAYS visible: on error we increment attempt_count, record last_error, and
either schedule a backed-off retry or, once attempts are exhausted, land in terminal
'failed'. One publication failing never touches another — each is independent.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import db
from .clients import PLATFORM_CAPS, SUPPORTED_PLATFORMS, PlatformCaps
from .config import Config
from .redact import redact

MIN_CAROUSEL = 2
SUPPORTED_POST_TYPES = ("single", "carousel", "text")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


@dataclass
class PublishOutcome:
    result: str  # 'posted' | 'dry_run' | 'retry_scheduled' | 'failed' | 'rate_limited'
    detail: str
    plan: dict = field(default_factory=dict)


class _NonRetryable(Exception):
    """A problem that retrying won't fix (bad config/data) -> terminal failure."""


def _maybe_retire_one_time(conn, post_id: int, now: datetime) -> bool:
    """Retire a one-time post once EVERY targeted channel has posted it. Returns True if retired."""
    targets = conn.execute(
        "SELECT channel_id FROM post_targets WHERE post_id = ?", (post_id,)
    ).fetchall()
    if not targets:
        return False
    for t in targets:
        done = conn.execute(
            "SELECT 1 FROM publications WHERE post_id = ? AND channel_id = ? "
            "AND status = 'posted' AND is_dry_run = 0 LIMIT 1",
            (post_id, t["channel_id"]),
        ).fetchone()
        if not done:
            return False
    db.update_post(conn, post_id, content_status="retired", updated_at=_iso(now))
    return True


def _load_targets(conn, pub):
    channel = db.get_channel(conn, pub["channel_id"])
    post = db.get_post(conn, pub["post_id"])
    if channel is None:
        raise _NonRetryable(f"channel {pub['channel_id']} not found")
    if post is None:
        raise _NonRetryable(f"post {pub['post_id']} not found")
    assets = db.get_ordered_assets(conn, pub["post_id"])
    return channel, post, assets


def _resolve_url(asset, asset_base_url: str | None) -> str | None:
    """The public URL Meta will download from.

    Precedence: an explicit external public_url (the manual/paste escape hatch) wins;
    otherwise prefer the Meta-conformed derivative at publish_path if present; otherwise
    fall back to the original storage_path (content hash). None means the asset can't
    currently be served publicly.
    """
    external = asset["public_url"]
    if external:
        return external
    if asset_base_url:
        rel = None
        # keys() guard: legacy rows / some test fixtures may not carry publish_path.
        if "publish_path" in asset.keys() and asset["publish_path"]:
            rel = asset["publish_path"]
        elif asset["storage_path"]:
            rel = asset["storage_path"]
        if rel:
            return f"{asset_base_url.rstrip('/')}/{rel}"
    return None


def _resolve_local_path(asset, caps: PlatformCaps, config) -> Path | None:
    """The on-disk file to upload, for platforms that send bytes rather than a URL.

    Precedence depends on the platform's caps: when needs_conformed_media is True (Meta
    platforms, which constrain aspect ratio), prefer the Meta-conformed derivative at
    publish_path, falling back to the original — same precedence as _resolve_url. When
    needs_conformed_media is False (Discord, Telegram — no aspect-ratio rules at all),
    prefer the untouched original at storage_path, falling back to publish_path only if
    the original is missing. The fallback is existence-aware — it checks the file is
    actually on disk, not just that the DB column is non-empty — since storage_path is
    always populated at upload time and would otherwise make the fallback unreachable.
    Returns None when neither candidate exists, so validation can fail loudly instead of
    the publish blowing up mid-request.
    """

    def _candidate(rel) -> Path | None:
        if not rel:
            return None
        path = Path(rel)
        if not path.is_absolute():
            path = config.asset_storage_dir / path
        return path if path.exists() else None

    has_publish_path = "publish_path" in asset.keys() and asset["publish_path"]
    original = _candidate(asset["storage_path"])
    conformed = _candidate(asset["publish_path"] if has_publish_path else None)
    if caps.needs_conformed_media:
        return conformed or original
    return original or conformed


def _validate(post, assets, dry_run: bool, asset_base_url: str | None, platform: str,
              caption: str | None = None, config=None) -> None:
    if platform not in _PUBLISHERS:
        raise _NonRetryable(
            f"unsupported platform '{platform}' — this worker has no adapter for it"
        )
    caps = PLATFORM_CAPS[platform]
    post_type = post["post_type"]
    if post_type not in SUPPORTED_POST_TYPES:
        raise _NonRetryable(
            f"post_type '{post_type}' not supported until Phase 6 (Reels/Stories)"
        )
    if post_type == "single" and len(assets) != 1:
        raise _NonRetryable(f"single post needs exactly 1 asset, has {len(assets)}")
    if post_type == "carousel" and not (MIN_CAROUSEL <= len(assets) <= caps.max_carousel):
        raise _NonRetryable(
            f"carousel needs {MIN_CAROUSEL}-{caps.max_carousel} assets, has {len(assets)}"
        )
    if post_type == "text":
        if not caps.supports_text:
            raise _NonRetryable(f"{platform} cannot publish text-only posts")
        if assets:
            raise _NonRetryable(
                f"a text post must have no assets, has {len(assets)}"
            )
        if not (caption or "").strip():
            raise _NonRetryable("a text post needs a caption")
    limit = caps.caption_limit(post_type)
    if limit is not None and caption is not None and len(caption) > limit:
        raise _NonRetryable(
            f"caption is {len(caption)} characters; {platform} allows {limit} "
            f"for a {post_type} post"
        )
    if not dry_run:
        if caps.uploads_media_bytes:
            missing = [a["id"] for a in assets if _resolve_local_path(a, caps, config) is None]
            if missing:
                raise _NonRetryable(f"asset files missing from the local store: {missing}")
        else:
            missing = [a["id"] for a in assets if not _resolve_url(a, asset_base_url)]
            if missing:
                raise _NonRetryable(
                    f"assets have no public URL (no tunnel and no stored public_url): {missing}"
                )


def _select_caption(conn, post_id: int, platform: str, used_count: int) -> str | None:
    """Platform-specific caption if present (rotated); else generic rotated; else posts.caption."""
    variants = conn.execute(
        "SELECT platform, body FROM caption_variants WHERE post_id = ? ORDER BY sort_order, id",
        (post_id,),
    ).fetchall()
    if variants:
        specific = [v["body"] for v in variants if v["platform"] == platform]
        if specific:
            return specific[used_count % len(specific)]
        generic = [v["body"] for v in variants if v["platform"] is None]
        if generic:
            return generic[used_count % len(generic)]
    post = db.get_post(conn, post_id)
    return post["caption"] if post else None


def _build_plan(channel, post, assets, asset_base_url: str | None, caption: str | None,
                 config=None) -> dict:
    # For real publishes every asset resolves (validated above). In dry-run there is no
    # tunnel, so show a readable local marker instead of a live URL.
    asset_urls = [
        _resolve_url(a, asset_base_url) or f"(local:{a['storage_path']})" for a in assets
    ]
    # Local on-disk paths, for byte-upload platforms (Discord/Telegram). None entries are
    # expected in dry-run or when the platform doesn't use them.
    caps = PLATFORM_CAPS[channel["platform"]]
    asset_paths = [
        _resolve_local_path(a, caps, config) if config is not None else None for a in assets
    ]
    return {
        "platform": channel["platform"],
        "account": channel["account_name"],
        # IG user id, or FB Page id — whichever this channel's platform uses.
        "account_id": channel["remote_account_id"],
        "post_type": post["post_type"],
        "caption": caption,
        "first_comment": post["first_comment"],
        "asset_urls": asset_urls,
        "asset_paths": asset_paths,
    }


def _poll_until_finished(client, container_id, token, config, sleep_fn, status_fn=None) -> None:
    """Poll a container's status_code until FINISHED. Small images are usually ready
    immediately; carousels/video need this. ERROR/EXPIRED are terminal failures.

    status_fn lets other platforms reuse this same poll loop against their own status
    call (e.g. Threads' get_threads_container_status, whose field is named `status`
    rather than Instagram's `status_code`) without duplicating the loop.
    """
    status_fn = status_fn or client.get_container_status
    for _ in range(config.status_poll_max_tries):
        status = status_fn(container_id, token)
        if status == "FINISHED":
            return
        if status in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"container {container_id} status={status}")
        sleep_fn(config.status_poll_interval)
    raise RuntimeError(f"container {container_id} not FINISHED after polling")


def _publish_single(client, plan, token, config, sleep_fn) -> str:
    ig = plan["account_id"]
    container = client.create_image_container(
        ig, plan["asset_urls"][0], token, caption=plan["caption"]
    )
    _poll_until_finished(client, container, token, config, sleep_fn)
    return client.publish_container(ig, container, token)


def _publish_carousel(client, plan, token, config, sleep_fn) -> str:
    ig = plan["account_id"]
    children = []
    for url in plan["asset_urls"]:
        child = client.create_image_container(ig, url, token, is_carousel_item=True)
        _poll_until_finished(client, child, token, config, sleep_fn)
        children.append(child)
    parent = client.create_carousel_container(
        ig, children, token, caption=plan["caption"]
    )
    _poll_until_finished(client, parent, token, config, sleep_fn)
    return client.publish_container(ig, parent, token)


def _publish_fb_single(client, plan, token) -> str:
    """One call, no container polling. Returns the FEED POST id (what insights use)."""
    res = client.create_page_photo(
        plan["account_id"], plan["asset_urls"][0], token, caption=plan["caption"]
    )
    # Prefer post_id (the feed post) when present, even if falsy. Fall back to the
    # photo id only when post_id is genuinely absent from the response, so a response
    # missing post_id still records something we can look up, rather than crashing.
    return res["post_id"] if "post_id" in res else res["id"]


def _publish_fb_multi(client, plan, token) -> str:
    """Upload each photo unpublished, then attach them all to one feed post."""
    page = plan["account_id"]
    media_fbids = []
    for url in plan["asset_urls"]:
        res = client.create_page_photo(page, url, token, published=False)
        media_fbids.append(res["id"])
    return client.create_page_feed_post(
        page, token, message=plan["caption"], attached_media=media_fbids
    )


def _publish_instagram(client, plan, token, config, sleep_fn) -> str:
    post_type = plan["post_type"]
    if post_type == "single":
        return _publish_single(client, plan, token, config, sleep_fn)
    elif post_type == "carousel":
        return _publish_carousel(client, plan, token, config, sleep_fn)
    else:
        raise _NonRetryable(f"instagram adapter has no publish path for post_type '{post_type}'")


def _publish_facebook(client, plan, token, config, sleep_fn) -> str:
    post_type = plan["post_type"]
    if post_type == "single":
        return _publish_fb_single(client, plan, token)
    elif post_type == "carousel":
        return _publish_fb_multi(client, plan, token)
    else:
        raise _NonRetryable(f"facebook adapter has no publish path for post_type '{post_type}'")


def _publish_threads(client, plan, token, config, sleep_fn) -> str:
    """Container -> publish, like Instagram, but text posts need no media at all."""
    user = plan["account_id"]
    post_type = plan["post_type"]

    if post_type == "text":
        container = client.create_threads_container(
            user, token, media_type="TEXT", text=plan["caption"]
        )
    elif post_type == "single":
        container = client.create_threads_container(
            user, token, media_type="IMAGE",
            image_url=plan["asset_urls"][0], text=plan["caption"],
        )
    elif post_type == "carousel":
        children = []
        for url in plan["asset_urls"]:
            child = client.create_threads_container(
                user, token, media_type="IMAGE", image_url=url, is_carousel_item=True
            )
            _poll_until_finished(
                client, child, token, config, sleep_fn,
                status_fn=client.get_threads_container_status,
            )
            children.append(child)
        container = client.create_threads_container(
            user, token, media_type="CAROUSEL", children=children, text=plan["caption"]
        )
    else:
        raise _NonRetryable(f"threads adapter has no publish path for post_type '{post_type}'")

    _poll_until_finished(
        client, container, token, config, sleep_fn,
        status_fn=client.get_threads_container_status,
    )
    return client.publish_threads_container(user, container, token)


def _read_asset(path: Path) -> tuple[str, bytes]:
    """(filename, bytes) shape both Discord's `files` list and Telegram's photo/media-group
    parts want. Validation already guarantees these paths exist before we get here."""
    return (path.name, path.read_bytes())


def _publish_discord(client, plan, token, config, sleep_fn) -> str:
    """Discord's "token" is the webhook URL itself — there is no separate account id.
    One POST per post_type: text sends `content` alone, single/carousel attach files.
    Discord replies 204 (empty body) unless the webhook is asked to wait for the message,
    so a missing id in the response is expected, not an error — fall back to a stable
    marker rather than crashing on a None remote_post_id.
    """
    caption = plan["caption"]
    post_type = plan["post_type"]
    if post_type == "text":
        result = client.send_message(token, content=caption)
    elif post_type in ("single", "carousel"):
        files = [_read_asset(p) for p in plan["asset_paths"]]
        result = client.send_message(token, content=caption, files=files)
    else:
        raise _NonRetryable(f"discord adapter has no publish path for post_type '{post_type}'")
    message_id = result.get("id")
    return str(message_id) if message_id is not None else "posted"


def _publish_telegram(client, plan, token, config, sleep_fn) -> str:
    """Telegram's target is plan["account_id"] (the chat id/username); the bot token is
    the credential. sendMediaGroup returns a list of Message objects rather than a single
    one, so the id extraction differs for carousels.
    """
    chat_id = plan["account_id"]
    caption = plan["caption"]
    post_type = plan["post_type"]
    if post_type == "text":
        result = client.send_message(token, chat_id, caption)
    elif post_type == "single":
        photo = _read_asset(plan["asset_paths"][0])
        result = client.send_photo(token, chat_id, photo, caption=caption)
    elif post_type == "carousel":
        photos = [_read_asset(p) for p in plan["asset_paths"]]
        result = client.send_media_group(token, chat_id, photos, caption=caption)
    else:
        raise _NonRetryable(f"telegram adapter has no publish path for post_type '{post_type}'")
    if isinstance(result, list):
        result = result[0] if result else {}
    message_id = (result or {}).get("message_id")
    return str(message_id) if message_id is not None else "posted"


# Publish entry point per platform. Uniform signature so the dispatch below is a lookup,
# not a chain of ifs whose final `else` silently means "Instagram".
_PUBLISHERS = {
    "instagram": _publish_instagram,
    "facebook": _publish_facebook,
    "threads": _publish_threads,
    "discord": _publish_discord,
    "telegram": _publish_telegram,
}

# Whether each platform exposes a runtime publish quota to read before posting. An
# explicit declaration for every supported platform, not a whitelist that defaults new
# platforms to "no gate" by omission — that silently violates the project rule of never
# hardcoding (or skipping) the publish rate limit. False means "this platform genuinely
# has no quota endpoint", never "we didn't get round to it":
#   * instagram — has content_publishing_limit; must be gated.
#   * facebook  — Facebook Pages have no content_publishing_limit endpoint, so there is
#                 nothing to read; inventing a hardcoded number would be worse than not
#                 gating.
#   * threads   — has its own threads_publishing_limit endpoint (250 published posts per
#                 rolling 24h, per Meta's docs — read live, never hardcoded); must be
#                 gated like Instagram.
#   * discord   — a webhook has no publish quota endpoint at all.
#   * telegram  — the Bot API exposes no publish quota endpoint at all.
_QUOTA_GATED = {
    "instagram": True,
    "facebook": False,
    "threads": True,
    "discord": False,
    "telegram": False,
}

# The quota-reading call differs per gated platform (Instagram and Threads expose the same
# (usage, total, duration) shape but through different endpoints/methods), so the gate looks
# up which method to call here rather than hardcoding Instagram's. Only platforms that are
# actually gated belong here — see the assertion below.
_QUOTA_READERS = {
    "instagram": lambda c, acct, tok: c.get_content_publishing_limit(acct, tok),
    "threads": lambda c, acct, tok: c.get_threads_publishing_limit(acct, tok),
}

assert set(_PUBLISHERS) == set(SUPPORTED_PLATFORMS), (
    "publisher._PUBLISHERS and clients.SUPPORTED_PLATFORMS disagree"
)
assert set(_QUOTA_GATED) == set(SUPPORTED_PLATFORMS), (
    "publisher._QUOTA_GATED and clients.SUPPORTED_PLATFORMS disagree"
)
assert set(_QUOTA_READERS) == {p for p, gated in _QUOTA_GATED.items() if gated}, (
    "publisher._QUOTA_READERS must have exactly the platforms _QUOTA_GATED marks True"
)


def _mark_failure(conn, pub, config, now, error: str, terminal: bool) -> PublishOutcome:
    # Defence in depth: any exception string reaching this point (including ones from
    # future code paths that stringify an exception without going through a client's own
    # redaction) gets scrubbed before it is written to publications.last_error, which the
    # dashboard renders directly on the Overview page.
    error = redact(error)
    attempts = pub["attempt_count"] + 1
    if terminal or attempts >= config.max_attempts:
        db.update_publication(
            conn, pub["id"],
            status="failed", attempt_count=attempts, last_error=error,
            next_retry_at=None, updated_at=_iso(now),
        )
        return PublishOutcome("failed", error)
    backoff = config.base_backoff_seconds * (2 ** (attempts - 1))
    retry_at = _iso(now + timedelta(seconds=backoff))
    db.update_publication(
        conn, pub["id"],
        status="scheduled", attempt_count=attempts, last_error=error,
        next_retry_at=retry_at, updated_at=_iso(now),
    )
    return PublishOutcome("retry_scheduled", f"{error} (retry at {retry_at})")


def publish_one(
    conn,
    pub,
    config: Config,
    client,
    *,
    dry_run: bool,
    asset_base_url: str | None = None,
    now: datetime | None = None,
    logger=None,
    sleep_fn=time.sleep,
) -> PublishOutcome:
    now = now or _utcnow()

    def log(msg):
        if logger:
            logger.info("[pub %s] %s", pub["id"], msg)

    # 1. Load + validate. Bad data/config is a terminal (non-retryable) failure.
    try:
        channel, post, assets = _load_targets(conn, pub)
        used_count = conn.execute(
            "SELECT COUNT(*) FROM publications WHERE post_id=? AND channel_id=? AND status='posted'",
            (pub["post_id"], pub["channel_id"]),
        ).fetchone()[0]
        caption = _select_caption(conn, post["id"], channel["platform"], used_count)
        _validate(post, assets, dry_run, asset_base_url, channel["platform"], caption, config)
        plan = _build_plan(channel, post, assets, asset_base_url, caption, config)
    except _NonRetryable as exc:
        log(f"validation failed: {exc}")
        return _mark_failure(conn, pub, config, now, str(exc), terminal=True)

    # 2. Dry-run: exercise the whole state machine, publish nothing.
    if dry_run:
        log(f"DRY-RUN plan: {plan}")
        db.update_publication(
            conn, pub["id"],
            status="posted", is_dry_run=1, published_at=_iso(now),
            remote_post_id="DRYRUN", last_error=None, next_retry_at=None,
            updated_at=_iso(now),
        )
        return PublishOutcome("dry_run", "dry-run: nothing published", plan)

    token = channel["access_token"]
    ig = plan["account_id"]

    # 3. Rate-limit gate: read Meta's REAL quota, cache it, refuse if exhausted.
    #    Only platforms _QUOTA_GATED marks True — Facebook Pages expose no
    #    content_publishing_limit endpoint, and inventing a hardcoded number here would
    #    be worse than not gating. Which method to call is per-platform (_QUOTA_READERS)
    #    since Instagram and Threads expose the same shape through different endpoints.
    if _QUOTA_GATED.get(plan["platform"]):
        try:
            usage, total, duration = _QUOTA_READERS[plan["platform"]](client, ig, token)
            db.record_publish_limit(conn, channel["id"], usage, total, duration, _iso(now))
            if usage is not None and total is not None and usage >= total:
                retry_at = _iso(now + timedelta(seconds=config.rate_limit_backoff_seconds))
                db.update_publication(
                    conn, pub["id"],
                    status="scheduled", next_retry_at=retry_at,
                    last_error=f"rate limit reached ({usage}/{total})", updated_at=_iso(now),
                )
                log(f"rate limit reached {usage}/{total}; deferring to {retry_at}")
                return PublishOutcome("rate_limited", f"quota {usage}/{total}")
        except Exception as exc:  # noqa: BLE001 — a quota-check failure is retryable
            log(f"quota check failed: {exc}")
            return _mark_failure(conn, pub, config, now, f"quota check: {exc}", terminal=False)

    # 4. Publish for real.
    db.update_publication(conn, pub["id"], status="publishing", updated_at=_iso(now))
    try:
        media_id = _PUBLISHERS[plan["platform"]](client, plan, token, config, sleep_fn)
    except _NonRetryable as exc:
        # An adapter that can't handle this post_type at all (e.g. a future post_type
        # SUPPORTED_POST_TYPES accepts but this platform's publish function doesn't
        # branch on) is bad data/config, not a transient error — fail terminally like
        # every other unsupported combination, never silently retry it.
        log(f"publish failed (non-retryable): {exc}")
        return _mark_failure(conn, pub, config, now, str(exc), terminal=True)
    except Exception as exc:  # noqa: BLE001 — transient publish error, retry with backoff
        log(f"publish failed: {exc}")
        return _mark_failure(conn, pub, config, now, f"publish: {exc}", terminal=False)

    db.update_publication(
        conn, pub["id"],
        status="posted", remote_post_id=media_id, published_at=_iso(now),
        last_error=None, next_retry_at=None, updated_at=_iso(now),
    )
    if post["content_kind"] == "one_time":
        _maybe_retire_one_time(conn, post["id"], now)
    log(f"published -> {media_id}")
    return PublishOutcome("posted", media_id, plan)
