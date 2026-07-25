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

from . import db
from .clients import SUPPORTED_PLATFORMS
from .config import Config

MIN_CAROUSEL = 2
MAX_CAROUSEL = 10  # Graph API limit (see reference.md), NOT the app's 20.
SUPPORTED_POST_TYPES = ("single", "carousel")


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


def _validate(post, assets, dry_run: bool, asset_base_url: str | None, platform: str) -> None:
    if platform not in _PUBLISHERS:
        raise _NonRetryable(
            f"unsupported platform '{platform}' — this worker has no adapter for it"
        )
    post_type = post["post_type"]
    if post_type not in SUPPORTED_POST_TYPES:
        raise _NonRetryable(
            f"post_type '{post_type}' not supported until Phase 6 (Reels/Stories)"
        )
    if post_type == "single" and len(assets) != 1:
        raise _NonRetryable(f"single post needs exactly 1 asset, has {len(assets)}")
    if post_type == "carousel" and not (MIN_CAROUSEL <= len(assets) <= MAX_CAROUSEL):
        raise _NonRetryable(
            f"carousel needs {MIN_CAROUSEL}-{MAX_CAROUSEL} assets, has {len(assets)}"
        )
    if not dry_run:
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


def _build_plan(channel, post, assets, asset_base_url: str | None, caption: str | None) -> dict:
    # For real publishes every asset resolves (validated above). In dry-run there is no
    # tunnel, so show a readable local marker instead of a live URL.
    asset_urls = [
        _resolve_url(a, asset_base_url) or f"(local:{a['storage_path']})" for a in assets
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
    }


def _poll_until_finished(client, container_id, token, config, sleep_fn) -> None:
    """Poll a container's status_code until FINISHED. Small images are usually ready
    immediately; carousels/video need this. ERROR/EXPIRED are terminal failures.
    """
    for _ in range(config.status_poll_max_tries):
        status = client.get_container_status(container_id, token)
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
    if plan["post_type"] == "single":
        return _publish_single(client, plan, token, config, sleep_fn)
    return _publish_carousel(client, plan, token, config, sleep_fn)


def _publish_facebook(client, plan, token, config, sleep_fn) -> str:
    if plan["post_type"] == "single":
        return _publish_fb_single(client, plan, token)
    return _publish_fb_multi(client, plan, token)


# Publish entry point per platform. Uniform signature so the dispatch below is a lookup,
# not a chain of ifs whose final `else` silently means "Instagram".
_PUBLISHERS = {
    "instagram": _publish_instagram,
    "facebook": _publish_facebook,
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
_QUOTA_GATED = {
    "instagram": True,
    "facebook": False,
}

assert set(_PUBLISHERS) == set(SUPPORTED_PLATFORMS), (
    "publisher._PUBLISHERS and clients.SUPPORTED_PLATFORMS disagree"
)
assert set(_QUOTA_GATED) == set(SUPPORTED_PLATFORMS), (
    "publisher._QUOTA_GATED and clients.SUPPORTED_PLATFORMS disagree"
)


def _mark_failure(conn, pub, config, now, error: str, terminal: bool) -> PublishOutcome:
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
        _validate(post, assets, dry_run, asset_base_url, channel["platform"])
        used_count = conn.execute(
            "SELECT COUNT(*) FROM publications WHERE post_id=? AND channel_id=? AND status='posted'",
            (pub["post_id"], pub["channel_id"]),
        ).fetchone()[0]
        caption = _select_caption(conn, post["id"], channel["platform"], used_count)
        plan = _build_plan(channel, post, assets, asset_base_url, caption)
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
    #    Instagram only — Facebook Pages expose no content_publishing_limit endpoint,
    #    and inventing a hardcoded number here would be worse than not gating.
    if _QUOTA_GATED.get(plan["platform"]):
        try:
            usage, total, duration = client.get_content_publishing_limit(ig, token)
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
