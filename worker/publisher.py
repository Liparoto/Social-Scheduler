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

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import db, media_limits
from .caption_length import caption_length
from .clients import PLATFORM_CAPS, SUPPORTED_PLATFORMS, PlatformCaps, UnknownPlatform
from .config import Config
from .logging_setup import LOGGER_NAME
from .redact import redact

MIN_CAROUSEL = 2
SUPPORTED_POST_TYPES = ("single", "carousel", "text", "video")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


@dataclass
class PublishOutcome:
    # 'skipped' means the row was not claimable — another worker won it, or it was held
    # or deleted between the due-fetch and the claim. Nothing was sent.
    result: str  # 'posted' | 'dry_run' | 'retry_scheduled' | 'failed' | 'rate_limited'
                 # | 'skipped'
    detail: str
    plan: dict = field(default_factory=dict)


class _NonRetryable(Exception):
    """A problem that retrying won't fix (bad config/data) -> terminal failure."""


def _surface(pub) -> str:
    """A publication's destination surface, defaulting to 'feed'.

    The .keys() guard mirrors the existing idiom for publish_path/cover_frame_ms: many
    tests build publication fixtures as plain dicts without this column, and a bare
    pub["surface"] would KeyError on every one of them.
    """
    return pub["surface"] if "surface" in pub.keys() else "feed"


def _maybe_retire_one_time(conn, post_id: int, now: datetime) -> bool:
    """Retire a one-time post once EVERY targeted (channel, SURFACE) has posted it.

    Surface matters: a post aimed at both a channel's feed AND its story is not spent
    when only the feed send succeeds. Comparing channels alone would retire the post the
    moment the feed landed, stranding the Story that had not gone out yet.

    Returns True if retired.
    """
    targets = conn.execute(
        "SELECT channel_id, surface FROM post_targets WHERE post_id = ?", (post_id,)
    ).fetchall()
    if not targets:
        return False
    for t in targets:
        done = conn.execute(
            "SELECT 1 FROM publications WHERE post_id = ? AND channel_id = ? "
            "AND surface = ? AND status = 'posted' AND is_dry_run = 0 LIMIT 1",
            (post_id, t["channel_id"], t["surface"]),
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
    if _surface(pub) == "story":
        # A story send is ONE slide. The fan-out into one publication per slide happened
        # at scheduling time; here we only resolve which slide this row is for. Narrowing
        # it now means _validate and _build_plan both see exactly one asset, so neither
        # needs to know about surfaces.
        asset_id = pub["asset_id"] if "asset_id" in pub.keys() else None
        if asset_id is None:
            raise _NonRetryable("story publication has no asset_id (nothing to post)")
        assets = [a for a in assets if a["id"] == asset_id]
        if not assets:
            raise _NonRetryable(
                f"story asset {asset_id} is not on post {pub['post_id']}"
            )
    return channel, post, assets


def _asset_media_kind(asset) -> str | None:
    """asset['media_kind'], .keys()-guarded — plain-dict fixtures across many existing
    tests don't all carry this column."""
    return asset["media_kind"] if "media_kind" in asset.keys() else None


def _needs_conformed(caps: PlatformCaps, surface: str, media_kind: str | None) -> bool:
    """Whether this send should get the Instagram-shaped derivative.

    Conformance is a per-SURFACE question, not only a per-platform one. A video headed for
    a feed that accepts any aspect ratio (Facebook's /videos edge) should arrive untouched;
    the same clip headed for Reels gets the 9:16 derivative. Images are unaffected and keep
    the platform-wide answer (caps.needs_conformed_media), which is what every existing
    caller already relies on.
    """
    if media_kind == "video" and surface == "feed" and not caps.feed_video_is_constrained:
        return False
    return caps.needs_conformed_media


def _resolve_rel(asset, surface: str = "feed", needs_conformed: bool = True) -> str | None:
    """Which stored file this SURFACE should publish, relative to the asset store.

      * feed/reel — needs_conformed=True: the Meta-conformed derivative at publish_path,
                else the original. needs_conformed=False (a Facebook feed video, whose
                endpoint accepts any aspect ratio): the untouched original, falling back to
                the conformed copy only if the original is somehow missing. The caller
                decides needs_conformed via _needs_conformed — this function is about file
                precedence only, not policy.
      * story — the 9:16 canvas at story_path, else the UNTOUCHED original. story_path
                exists only when the source was not already story-shaped (migration 0015);
                NULL means the original is already the right shape. The conformed copy is
                never right here: conformance targets the FEED's 4:5..1.91:1 range
                (dashboard/lib/conform.ts) and a story is 9:16.
      * cover — a Reel's cover image: ALWAYS the original, never the feed derivative.
                storage_path already holds the cover-conformed bytes (sRGB JPEG <=8MB with
                the aspect ratio deliberately untouched, dashboard/lib/conform-cover.ts).
                publish_path, if the row has one, is a FEED conform cropped into
                4:5..1.91:1 — using it would silently mangle the framing the owner chose,
                which is the exact failure the cover conform exists to prevent. A cover row
                normally has publish_path NULL, but content-hash dedup can hand back a row
                that was also uploaded as a feed image, so this must not rely on that.

    Split out so _resolve_url and the dry-run marker in _build_plan cannot disagree about
    what would be sent — they did, and the dry run quietly showed the original for a story
    that would really have published its canvas.
    """
    # keys() guard: legacy rows / some test fixtures may not carry these columns.
    has_publish_path = "publish_path" in asset.keys() and asset["publish_path"]
    conformed = asset["publish_path"] if has_publish_path else None
    has_story_path = "story_path" in asset.keys() and asset["story_path"]
    canvas = asset["story_path"] if has_story_path else None
    original = asset["storage_path"]
    if surface == "story":
        return canvas or original or conformed
    if surface == "cover":
        return original
    if needs_conformed:
        return conformed or original
    return original or conformed


def _resolve_url(asset, asset_base_url: str | None, surface: str = "feed",
                  caps: PlatformCaps | None = None) -> str | None:
    """The public URL Meta will download from.

    An explicit external public_url (the manual/paste escape hatch) always wins; otherwise
    the surface (and, for video, the platform's caps) decides which stored file to serve —
    see _resolve_rel and _needs_conformed. None means the asset can't currently be served
    publicly.

    caps is optional because one caller (the cover-image resolution in _build_plan) always
    passes surface="cover", whose answer never depends on needs_conformed — see
    _resolve_rel. Every other caller should pass its platform's caps.
    """
    external = asset["public_url"]
    if external:
        return external
    if asset_base_url:
        needs_conformed = (
            _needs_conformed(caps, surface, _asset_media_kind(asset))
            if caps is not None else True
        )
        rel = _resolve_rel(asset, surface, needs_conformed)
        if rel:
            return f"{asset_base_url.rstrip('/')}/{rel}"
    return None


def _resolve_local_path(asset, caps: PlatformCaps, config, surface: str = "feed") -> Path | None:
    """The on-disk file to upload, for platforms that send bytes rather than a URL.

    Precedence depends on the platform's caps AND the surface. A STORY always prefers the
    untouched original, whatever the platform: conformance targets the FEED's 4:5..1.91:1
    range and a story is 9:16, outside it, so the conformed derivative is the wrong image
    for that surface — the same rule _resolve_url applies.

    Otherwise it depends on _needs_conformed(caps, surface, media_kind) — the same policy
    _resolve_url and _resolve_rel use, kept in one place. When True (Meta platforms, which
    constrain aspect ratio), prefer the Meta-conformed derivative at publish_path, falling
    back to the original. When False (Discord, Telegram — no aspect-ratio rules at all, or
    a Facebook feed video, whose endpoint accepts any ratio), prefer the untouched original
    at storage_path, falling back to publish_path only if the original is missing. The
    fallback is existence-aware — it checks the file is actually on disk, not just that the
    DB column is non-empty — since storage_path is always populated at upload time and
    would otherwise make the fallback unreachable. Returns None when neither candidate
    exists, so validation can fail loudly instead of the publish blowing up mid-request.

    No byte-upload platform has a Stories surface today, so the story branch changes no
    real publish. It exists so the DRY-RUN plan doesn't advertise the cropped derivative
    for a story — the plan's job is to be legible — and so this can't quietly become a
    real bug if one ever does. Likewise, no byte-upload platform has a constrained-feed
    exception today (only Facebook, which publishes by URL, does) — the helper is shared
    anyway so there is exactly one rule, not two that could drift.
    """

    def _candidate(rel) -> Path | None:
        if not rel:
            return None
        path = Path(rel)
        if not path.is_absolute():
            path = config.asset_storage_dir / path
        return path if path.exists() else None

    has_publish_path = "publish_path" in asset.keys() and asset["publish_path"]
    has_story_path = "story_path" in asset.keys() and asset["story_path"]
    original = _candidate(asset["storage_path"])
    conformed = _candidate(asset["publish_path"] if has_publish_path else None)
    canvas = _candidate(asset["story_path"] if has_story_path else None)
    if surface == "story":
        return canvas or original or conformed
    if _needs_conformed(caps, surface, _asset_media_kind(asset)):
        return conformed or original
    return original or conformed


def _check_media_limits(assets, platform: str, surface: str) -> None:
    """Refuse a publish whose media breaks this platform+surface's recorded limits, per
    dashboard/media-limits.json (worker/media_limits.py) — the SAME file the composer's
    destinationDisabledReason reads, so the two cannot silently drift apart.

    This is the BACKSTOP, not the first line of defense: the composer greys the
    destination out before scheduling ever gets here. It still matters, because it
    catches post_targets rows the UI can no longer reach (a stale row, a direct API
    call, an asset swapped after scheduling) — the same reasoning as the reel/post_type
    guard just above. ABSENT MEANS NOT ENFORCED: check() returns [] for any
    platform/surface this file has no entry for yet, and only "refuse" severity blocks
    the send — a "warn" (a limit that varies by account) is left for the platform itself
    to enforce.

    Checked against assets[0] only, same as the picker. That was once safe by
    construction — every gated surface (Facebook Reels, then Instagram Story) was
    single-asset (a video post is exactly one asset; a story row is narrowed to one slide
    by _load_targets) — but it no longer is: instagram.feed.image, added after that
    reasoning was first written, can be a 10-slide carousel, and this checks slide 1
    only. Slides 2-10 are simply UNCHECKED here, same as every slide was before this gate
    existed at all — not a regression, and not something this pass fixes; checking every
    slide is future work.
    """
    if not assets:
        return
    for violation in media_limits.check(platform, surface, assets[0]):
        if violation.severity == "refuse":
            raise _NonRetryable(
                f"{platform} {surface} cannot publish this media: {violation.message}"
            )


def _validate(post, assets, dry_run: bool, asset_base_url: str | None, platform: str,
              caption: str | None = None, config=None, surface: str = "feed") -> None:
    if platform not in _PUBLISHERS:
        raise _NonRetryable(
            f"unsupported platform '{platform}' — this worker has no adapter for it"
        )
    caps = PLATFORM_CAPS[platform]
    post_type = post["post_type"]
    if post_type not in SUPPORTED_POST_TYPES:
        raise _NonRetryable(
            f"post_type '{post_type}' is not a publishable content shape "
            "(note: Stories are a target SURFACE, not a post_type)"
        )
    if surface == "reel" and (post_type != "video" or "reel" not in caps.video_surfaces):
        # A stale/malformed post_targets row (e.g. the video that funded a reel target
        # got swapped for an image in the composer, which only hides the Reel chip —
        # it does not prune the row) must not reach the create call. Without this, a
        # non-video post targeted at 'reel' would publish whatever asset it does have
        # to the wrong Facebook surface, or double-post if the same row also carries a
        # feed target. Checked here, terminally, so a stale row the UI can no longer
        # reach still can't publish.
        raise _NonRetryable(
            f"a reel surface needs a video post on a platform with a Reels surface, "
            f"got post_type='{post_type}' on {platform}"
        )
    if surface == "story":
        # A Story is one media regardless of the post's content shape, so the post_type
        # checks below (which describe the SOURCE) don't apply. _load_targets has already
        # narrowed `assets` to this row's single slide.
        if platform != "instagram":
            raise _NonRetryable(f"{platform} has no Stories surface in this worker")
        if len(assets) != 1:
            raise _NonRetryable(f"a story needs exactly 1 asset, has {len(assets)}")
        if assets[0]["media_kind"] not in ("image", "video"):
            raise _NonRetryable(
                f"a story needs an image or video, got '{assets[0]['media_kind']}'"
            )
        # No caption-limit check: a story sends no caption at all.
        _check_media_limits(assets, platform, surface)
        _validate_media_available(assets, dry_run, asset_base_url, caps, config, surface)
        return
    if post_type == "single" and len(assets) != 1:
        raise _NonRetryable(f"single post needs exactly 1 asset, has {len(assets)}")
    if post_type == "video":
        if len(assets) != 1:
            raise _NonRetryable(f"a video post needs exactly 1 asset, has {len(assets)}")
        if assets[0]["media_kind"] != "video":
            raise _NonRetryable(
                f"a video post needs a video asset, got media_kind='{assets[0]['media_kind']}'"
            )
    # Video-only platforms. Caught here rather than left to the adapter for the same
    # reason as the video and carousel rules below: an unpublishable combination that gets
    # scheduled first dies terminally later, long after the composer could have said so.
    if post_type in ("single", "carousel") and not caps.supports_images:
        raise _NonRetryable(f"{platform} cannot publish image posts — it is video only")
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
    # caption_length, not len(): the platforms count UTF-16 code units, so every emoji is
    # 2. Plain len() counts code points and under-counts, which let an over-length caption
    # past this gate to be refused by the platform itself — a terminal failure after the
    # post already read "scheduled". See worker/caption_length.py.
    if limit is not None and caption is not None and caption_length(caption) > limit:
        raise _NonRetryable(
            f"caption is {caption_length(caption)} characters; {platform} allows {limit} "
            f"for a {post_type} post"
        )
    # Media limits, per platform AND surface, from the shared media-limits.json that the
    # dashboard reads too (worker/media_limits.py). Checked here rather than left to the
    # platform: an out-of-spec clip comes back as a generic API error that says nothing
    # about duration, and by then the send has already read "scheduled" to the owner.
    # This covers feed and reel (the story surface returns above before reaching here).
    _check_media_limits(assets, platform, surface)
    _validate_media_available(assets, dry_run, asset_base_url, caps, config, surface)


def _validate_media_available(assets, dry_run: bool, asset_base_url: str | None,
                              caps: PlatformCaps, config, surface: str = "feed") -> None:
    """Every asset must be reachable the way this platform expects, or fail loudly here
    rather than mid-publish. Shared by the feed and story paths so the two cannot drift.
    """
    if dry_run:
        return
    if caps.uploads_media_bytes:
        missing = [
            a["id"] for a in assets
            if _resolve_local_path(a, caps, config, surface) is None
        ]
        if missing:
            raise _NonRetryable(f"asset files missing from the local store: {missing}")
    else:
        missing = [
            a["id"] for a in assets if not _resolve_url(a, asset_base_url, surface, caps)
        ]
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


# A Threads topic tag: the word after a '#', minus the characters Meta rejects.
# Per Meta's docs a tag is 1-50 characters and may not contain a period or an ampersand;
# whitespace and a further '#' obviously end it too.
_TOPIC_TAG_RE = re.compile(r"#([^\s#.&]{1,50})(?=\s|$)")


def _topic_tag_for(text: str | None) -> str | None:
    """The topic tag to send explicitly for a Threads post, or None.

    Threads allows exactly ONE topic tag per post. If you don't name it, Threads picks
    the first valid hashtag out of your text — and REWRITES the body, dropping that
    tag's '#' (verified live 2026-08-06: sending "#NationalParks #Waterfall ..." stored
    topic_tag="NationalParks" and text="NationalParks #Waterfall ...").

    Meta documents the in-text form as "not preferred but kept for backwards
    compatibility" and the `topic_tag` parameter as the current way. Naming the tag
    explicitly is therefore both the documented path and our best shot at the body
    surviving intact, since the post's one tag slot is already filled by the parameter.

    Returns the tag WITHOUT its '#', since that is the form the API takes.

    Only a cleanly-matching tag is returned: on Threads the first hashtag is the only
    functional one anyway, so there is nothing to gain from trying to rescue a tag with
    a period or an ampersand in it, and passing one Meta rejects would fail a publish
    that works fine today.
    """
    if not text:
        return None
    match = _TOPIC_TAG_RE.search(text)
    return match.group(1) if match else None


def _threads_container(client, **kwargs) -> str:
    """create_threads_container, with the topic tag downgraded to best-effort.

    Meta validates the tag when the container is created and refuses tags it does not
    permit — verified live: `topic_tag=bad.tag` comes back "Topic Tag Not Permitted"
    (code 100, subcode 4279071). The permitted set is not published anywhere and covers
    more than punctuation (Threads blocks whole topics), so no amount of local validation
    can guarantee a tag is acceptable.

    That turns a cosmetic nicety into a publishing hazard: without this fallback, one
    unlucky hashtag in a caption would fail the whole post — strictly worse than the
    missing '#' this feature set out to fix. So a rejected tag is retried once with no
    tag at all, which is exactly the behaviour that shipped before topic tags existed.
    """
    try:
        return client.create_threads_container(**kwargs)
    except Exception as exc:  # noqa: BLE001 — narrow retry below; anything else re-raises
        if kwargs.get("topic_tag") is None or "topic tag" not in str(exc).lower():
            raise
        # Logged through the shared worker logger rather than publish_one's `log`
        # closure: the publish functions are called by signature from _PUBLISHERS and
        # don't receive it, and widening every adapter's signature to carry a logger for
        # one fallback would be a worse trade than naming the logger here.
        logging.getLogger(LOGGER_NAME).info(
            "topic tag %r refused by Threads, posting without it: %s",
            kwargs["topic_tag"], exc,
        )
        return client.create_threads_container(**{**kwargs, "topic_tag": None})


def _normalise_comment(raw: str | None) -> str | None:
    """"" / "   " / None all mean 'no first comment'. One definition, used everywhere."""
    if raw is None:
        return None
    trimmed = raw.strip()
    return trimmed or None


def _build_plan(channel, post, assets, asset_base_url: str | None, caption: str | None,
                 config=None, surface: str = "feed", conn=None) -> dict:
    caps = PLATFORM_CAPS[channel["platform"]]
    # For real publishes every asset resolves (validated above). In dry-run there is no
    # tunnel, so show a readable local marker instead of a live URL. The marker must use
    # the SAME needs_conformed decision as _resolve_url, computed the same way (via
    # _needs_conformed), or the dry run can show a different file than a real publish
    # would send — this already happened once for stories (see _resolve_rel).
    asset_urls = [
        # The marker names the file a REAL publish would send, not just the original —
        # a dry run that shows the wrong file is worse than no dry run.
        _resolve_url(a, asset_base_url, surface, caps)
        or f"(local:{_resolve_rel(a, surface, _needs_conformed(caps, surface, _asset_media_kind(a))) or a['storage_path']})"
        for a in assets
    ]
    # Local on-disk paths, for byte-upload platforms (Discord/Telegram). None entries are
    # expected in dry-run or when the platform doesn't use them.
    asset_paths = [
        _resolve_local_path(a, caps, config, surface) if config is not None else None
        for a in assets
    ]
    # The chosen cover frame travels with the plan so dry-run shows it too. It lives
    # on the ASSET, so a recycled evergreen video reuses the same choice.
    #
    # The `in .keys()` guard mirrors _resolve_url's handling of publish_path: many
    # existing tests build asset fixtures as plain dicts without this column, and a
    # bare assets[0]["cover_frame_ms"] would KeyError on every one of them.
    cover_frame_ms = (
        assets[0]["cover_frame_ms"]
        if assets and "cover_frame_ms" in assets[0].keys()
        else None
    )
    # A custom cover image overrides the frame choice — Meta's documented precedence is
    # "cover_url wins, thumb_offset is ignored", but we resolve that explicitly here
    # rather than sending both and leaning on Meta's behaviour, since the dry-run plan
    # is one of this project's main debugging surfaces and must show what will actually
    # happen. Same `.keys()` guard as cover_frame_ms, for the same reason (plain-dict
    # fixtures across dozens of existing tests don't carry this column).
    cover_url = None
    if (
        assets
        and conn is not None
        and "cover_asset_id" in assets[0].keys()
        and assets[0]["cover_asset_id"] is not None
    ):
        cover_asset = db.get_asset(conn, assets[0]["cover_asset_id"])
        # A dangling cover_asset_id (the referenced row was deleted) falls back to the
        # frame offset rather than raising — a missing cover is cosmetic, refusing to
        # publish over it would be far worse. cover_frame_ms is left as resolved above.
        if cover_asset is not None:
            # surface="cover", NOT the caller's surface and not the "feed" default: a
            # cover must resolve to the cover-conformed original, never to a feed
            # derivative cropped into 4:5..1.91:1. See _resolve_rel.
            cover_url = _resolve_url(cover_asset, asset_base_url, "cover") or (
                f"(local:{_resolve_rel(cover_asset, 'cover')})"
            )
            cover_frame_ms = None
    return {
        "platform": channel["platform"],
        "account": channel["account_name"],
        # IG user id, or FB Page id — whichever this channel's platform uses.
        "account_id": channel["remote_account_id"],
        "post_type": post["post_type"],
        # Resolved above: exactly one of these is ever set, never both.
        "cover_frame_ms": cover_frame_ms,
        "cover_url": cover_url,
        "surface": surface,
        # Stories have no caption field. Nulled in the PLAN, not merely skipped at the
        # call site, so dry-run output shows the truth about what would be sent.
        "caption": None if surface == "story" else caption,
        # Same treatment as the caption, for the same reason: a Story has no comment
        # edge, so the comment is nulled in the PLAN rather than skipped at the call
        # site, and dry-run output shows the truth about what would be sent.
        #
        # Whitespace normalises to None here too — an empty composer textarea arrives as
        # "" or "\n", and "there is a first comment" must mean the same thing everywhere
        # downstream rather than each caller re-deciding what counts as blank.
        "first_comment": _normalise_comment(
            None if surface == "story" else post["first_comment"]
        ),
        "asset_urls": asset_urls,
        "asset_paths": asset_paths,
        # Which media field a story container should use. Feed paths branch on post_type
        # instead, so this is only read by _publish_story. Same `in .keys()` guard as
        # cover_frame_ms above — plain-dict asset fixtures don't all carry media_kind.
        "media_kind": (
            assets[0]["media_kind"]
            if assets and "media_kind" in assets[0].keys()
            else None
        ),
    }


def _poll_until_finished(client, container_id, token, config, sleep_fn, status_fn=None,
                         interval=None, max_tries=None) -> None:
    """Poll a container's status_code until FINISHED. Small images are usually ready
    immediately; carousels/video need this. ERROR/EXPIRED are terminal failures.

    status_fn lets other platforms reuse this same poll loop against their own status
    call (e.g. Threads' get_threads_container_status, whose field is named `status`
    rather than Instagram's `status_code`) without duplicating the loop.

    interval/max_tries let Reels poll on their own, longer budget without a second loop.
    """
    status_fn = status_fn or client.get_container_status
    interval = config.status_poll_interval if interval is None else interval
    max_tries = config.status_poll_max_tries if max_tries is None else max_tries
    for _ in range(max_tries):
        status = status_fn(container_id, token)
        if status == "FINISHED":
            return
        if status in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"container {container_id} status={status}")
        sleep_fn(interval)
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


def _publish_reel(client, plan, token, config, sleep_fn) -> str:
    """Reels use the same container -> poll -> publish shape as an image, with two
    differences: media_type=REELS with a video_url, and a much longer poll budget
    because Meta transcodes the video server-side before the container is publishable.

    The plan already resolves cover_url vs. thumb_offset to exactly one (never both —
    see _build_plan), so only one is ever passed through to the client here too.
    """
    ig = plan["account_id"]
    cover_url = plan.get("cover_url")
    cover_kwargs = (
        {"cover_url": cover_url}
        if cover_url is not None
        else {"thumb_offset": plan.get("cover_frame_ms")}
    )
    container = client.create_video_container(
        ig,
        plan["asset_urls"][0],
        token,
        caption=plan["caption"],
        **cover_kwargs,
    )
    _poll_until_finished(
        client, container, token, config, sleep_fn,
        interval=config.reels_status_poll_interval,
        max_tries=config.reels_status_poll_max_tries,
    )
    return client.publish_container(ig, container, token)


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


def _publish_story(client, plan, token, config, sleep_fn) -> str:
    """One media, no caption: container -> poll -> publish.

    We poll even for images, where the container is usually ready immediately. Never
    skipping the status check is a project rule and the cost is one cheap request. Video
    gets the longer Reels poll budget, since Meta transcodes it server-side.
    """
    ig = plan["account_id"]
    url = plan["asset_urls"][0]
    is_video = plan.get("media_kind") == "video"
    container = client.create_story_container(
        ig,
        token,
        video_url=url if is_video else None,
        image_url=None if is_video else url,
    )
    _poll_until_finished(
        client, container, token, config, sleep_fn,
        interval=config.reels_status_poll_interval if is_video else None,
        max_tries=config.reels_status_poll_max_tries if is_video else None,
    )
    return client.publish_container(ig, container, token)


def _publish_instagram(client, plan, token, config, sleep_fn) -> str:
    # Surface first: a Story is ONE media regardless of the post's content shape, so
    # post_type ('single'/'carousel') describes the SOURCE here, not what gets published.
    if plan.get("surface") == "story":
        return _publish_story(client, plan, token, config, sleep_fn)
    post_type = plan["post_type"]
    if post_type == "single":
        return _publish_single(client, plan, token, config, sleep_fn)
    elif post_type == "carousel":
        return _publish_carousel(client, plan, token, config, sleep_fn)
    elif post_type == "video":
        return _publish_reel(client, plan, token, config, sleep_fn)
    else:
        raise _NonRetryable(f"instagram adapter has no publish path for post_type '{post_type}'")


def _resolve_fb_post_id(client, response, video_id, token) -> str:
    """Prefer the FEED POST id metrics actually read against; never lose the id.

    Three-step fallback, best (cheapest, most trustworthy) source first:
      1. `post_id` already present in the publish response dict — free, no extra
         request, and Meta returned it directly rather than us inferring it.
      2. otherwise GET /{video-id}?fields=post_id via the client — wrapped in
         try/except. get_page_video_post_id's underlying _get RAISES GraphAPIError
         on any non-2xx response or network error; it only returns None when Meta's
         response is otherwise successful but simply omits the field. By the time
         this runs the video is ALREADY LIVE (create_page_video/create_page_reel
         already returned), so letting that exception escape here would mark the
         whole publish retryable — and publish_one's retry would call
         create_page_video/create_page_reel AGAIN against a Page where the video
         is already published. A metrics-id lookup failing must never re-publish
         a post that already succeeded.
      3. otherwise the video id itself. A publish that actually succeeded must
         never be recorded as failed just because its metrics id could not be
         resolved — a video id still lets a human find the post.
    """
    post_id = response.get("post_id")
    if post_id:
        return post_id
    try:
        post_id = client.get_page_video_post_id(video_id, token)
    except Exception as exc:  # noqa: BLE001 — see docstring: the post is live, never re-publish over this
        logging.getLogger(LOGGER_NAME).warning(
            "facebook post-id lookup failed for video %s, falling back to the video "
            "id (post is live and unaffected): %s", video_id, redact(str(exc)),
        )
        return video_id
    return post_id or video_id


def _poll_fb_video(client, video_id, token, config, sleep_fn) -> bool:
    """Poll a Facebook Page video's transcode status until FINISHED or the Reels
    budget runs out. Returns True once Meta confirms FINISHED, False otherwise —
    never raises except for a definitive processing failure. See the governing
    principle in _publish_fb_video's docstring for why this is NOT built on the
    shared _poll_until_finished (which is never modified, per project rule): that
    loop raises on both a definitive failure AND on budget exhaustion, and here
    those two cases must be handled completely differently.

      - status ERROR/EXPIRED: the video genuinely failed processing and never
        went live. Raise — a retry is correct and safe, because nothing was
        published.
      - budget exhausted (still processing/uploading after max_tries): the video
        IS live, Meta is just slow. Return False rather than raising, so the
        caller can still record the publication as posted.
      - status_fn itself raises (network error, malformed response): we know the
        video was published but not its processing state. Treat exactly like
        budget exhaustion, never like ERROR — return False, never re-raise.
    """
    interval = config.reels_status_poll_interval
    max_tries = config.reels_status_poll_max_tries
    for _ in range(max_tries):
        try:
            status = client.get_page_video_status(video_id, token)
        except Exception as exc:  # noqa: BLE001 — unknown state, not a failure; see docstring
            logging.getLogger(LOGGER_NAME).warning(
                "facebook video %s status check failed, treating processing state "
                "as unconfirmed (post is live and unaffected): %s",
                video_id, redact(str(exc)),
            )
            return False
        if status == "FINISHED":
            return True
        if status in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"facebook video {video_id} status={status}")
        sleep_fn(interval)
    logging.getLogger(LOGGER_NAME).warning(
        "facebook video %s still processing after %d polls (post is live); "
        "recording as posted with its processing state unconfirmed",
        video_id, max_tries,
    )
    return False


def _publish_fb_video(client, plan, token, config, sleep_fn, *, as_reel: bool) -> str:
    """Publish a Page video, to the feed or to Reels, and return the FEED POST id.

    GOVERNING PRINCIPLE: once the create call below returns successfully, the
    post EXISTS on Facebook — video/reel creation publishes immediately; polling
    afterwards only confirms Meta finished transcoding it, it does not gate
    publication. This is the opposite of Instagram, whose container flow polls
    BEFORE publish_container and can safely raise/retry on any poll outcome,
    because nothing has been published yet there. Here, nothing after the create
    call may cause a re-publish. Only a DEFINITIVE "processing failed" signal
    (_poll_fb_video raising on ERROR/EXPIRED) is allowed to fail the send; budget
    exhaustion and unexpected poll exceptions both fall through to a normal
    'posted' result instead, with a visible (non-fatal) warning logged.
    """
    page = plan["account_id"]
    url = plan["asset_urls"][0]
    create = client.create_page_reel if as_reel else client.create_page_video
    response = create(page, url, token, description=plan["caption"])
    # create_page_reel guarantees video_id; create_page_video only has id (the
    # video node, same convention as create_page_photo before it). Guarded rather
    # than response["id"] outright: an unhandled KeyError here would be caught as
    # a generic retryable failure by publish_one, and the video is already live.
    video_id = response.get("video_id") or response.get("id")
    if not video_id:
        # _NonRetryable, not RuntimeError: this happens AFTER the create call, so the
        # video is already live on the Page. A generic RuntimeError would be caught by
        # publish_one's normal retry path and re-run the create call against a Page
        # where the video already exists — the exact double-post the governing
        # principle at the top of this function forbids. Recording this as a terminal
        # failure is honest (something IS wrong — we can't confirm the post id) and
        # visible; retrying it would silently double-post.
        raise _NonRetryable(
            f"facebook {'reel' if as_reel else 'video'} publish response had no "
            f"id: {redact(str(response))}"
        )

    _poll_fb_video(client, video_id, token, config, sleep_fn)

    return _resolve_fb_post_id(client, response, video_id, token)


def _publish_facebook(client, plan, token, config, sleep_fn) -> str:
    post_type = plan["post_type"]
    if post_type == "video":
        surface = plan.get("surface", "feed")
        if surface == "feed":
            return _publish_fb_video(client, plan, token, config, sleep_fn, as_reel=False)
        if surface == "reel":
            return _publish_fb_video(client, plan, token, config, sleep_fn, as_reel=True)
        raise _NonRetryable(
            f"facebook has no video publish path for surface '{surface}'"
        )
    elif post_type == "single":
        return _publish_fb_single(client, plan, token)
    elif post_type == "carousel":
        return _publish_fb_multi(client, plan, token)
    else:
        raise _NonRetryable(f"facebook adapter has no publish path for post_type '{post_type}'")


def _publish_threads(client, plan, token, config, sleep_fn) -> str:
    """Container -> publish, like Instagram, but text posts need no media at all."""
    user = plan["account_id"]
    post_type = plan["post_type"]
    # Name the topic tag rather than letting Threads pick it out of the caption, which
    # rewrites the caption. Applies to the POST as much as to the first comment — any
    # Threads text containing hashtags loses the first one's '#'. See _topic_tag_for.
    topic_tag = _topic_tag_for(plan["caption"])

    if post_type == "text":
        container = _threads_container(
            client, threads_user_id=user, token=token,
            media_type="TEXT", text=plan["caption"], topic_tag=topic_tag,
        )
    elif post_type == "single":
        container = _threads_container(
            client, threads_user_id=user, token=token, media_type="IMAGE",
            image_url=plan["asset_urls"][0], text=plan["caption"],
            topic_tag=topic_tag,
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
        container = _threads_container(
            client, threads_user_id=user, token=token, media_type="CAROUSEL",
            children=children, text=plan["caption"], topic_tag=topic_tag,
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


def _tiktok_status(client, publish_id, token) -> str:
    """Map TikTok's status vocabulary onto the poll loop's FINISHED/ERROR/other.

    SEND_TO_USER_INBOX is this platform's FINISHED: the video is on the creator's phone,
    which is as far as this worker can take it. FAILED raises with TikTok's own reason
    because that string is the only explanation the owner will ever get for a video that
    silently did not arrive.
    """
    data = client.fetch_publish_status(token, publish_id)
    status = data.get("status")
    if status == "SEND_TO_USER_INBOX":
        return "FINISHED"
    if status == "FAILED":
        raise RuntimeError(
            f"tiktok upload failed: {data.get('fail_reason', 'no reason given')}"
        )
    return status or "PROCESSING_UPLOAD"


def _publish_tiktok(client, plan, token, config, sleep_fn) -> str:
    """Deliver the video to the creator's TikTok inbox and return the publish_id.

    This does NOT publish. TikTok's inbox endpoint takes the file and nothing else — no
    caption, no privacy level — and the creator finishes the post inside the TikTok app.
    The returned id is an upload-session id, not a post id, which is why
    _DELIVERS_TO_INBOX routes it to remote_container_id and leaves remote_post_id NULL.

    Direct posting, which WOULD carry the caption, needs the video.publish scope and the
    app audit this install cannot obtain — see docs/superpowers/specs/2026-08-22.
    """
    from .tiktok_api import plan_chunks

    post_type = plan["post_type"]
    if post_type != "video":
        raise _NonRetryable(
            f"tiktok adapter has no publish path for post_type '{post_type}' — video only"
        )
    path = plan["asset_paths"][0]
    if path is None:
        raise _NonRetryable("tiktok needs the video file on disk; none resolved")
    size = Path(path).stat().st_size
    chunk_size, count = plan_chunks(size)
    session = client.init_inbox_video(token, size, chunk_size, count)
    publish_id = session["publish_id"]
    client.upload_video_file(session["upload_url"], path, chunk_size=chunk_size)
    # Confirm TikTok actually accepted it rather than assuming the PUTs landed. Reuses the
    # publisher's own poll loop against TikTok's status call, the same seam Threads uses.
    _poll_until_finished(
        client, publish_id, token, config, sleep_fn,
        status_fn=lambda pid, tok: _tiktok_status(client, pid, tok),
    )
    return publish_id


# Commenters take the three facts they need (account, message, published media id)
# rather than a plan: a retry has no plan to build — the assets may since have been
# deleted, and re-resolving them to post a text comment would be pure risk.
def _comment_instagram(client, account_id, message, media_id, token, config,
                       sleep_fn) -> str:
    """One call against the published media's comment edge. No container, no polling."""
    return client.create_comment(media_id, message, token)


def _comment_threads(client, account_id, message, media_id, token, config,
                     sleep_fn) -> str:
    """Threads has no comment edge — the first comment is a self-reply, which is an
    ordinary text post carrying reply_to_id. So it needs the full container -> poll ->
    publish dance, reusing the same poll loop the publish path uses."""
    container = _threads_container(
        client, threads_user_id=account_id, token=token, media_type="TEXT",
        text=message, reply_to_id=media_id, topic_tag=_topic_tag_for(message),
    )
    _poll_until_finished(
        client, container, token, config, sleep_fn,
        status_fn=client.get_threads_container_status,
    )
    return client.publish_threads_container(account_id, container, token)


def _comment_facebook(client, account_id, message, media_id, token, config,
                      sleep_fn) -> str:
    """A Page post's comment edge. Requires `pages_manage_engagement` on the Page token —
    a different scope from publishing, so this can fail on a token that posts fine.

    VERIFIED against a live Page on 2026-08-23: publication 70 published post
    269462483652949_1503535688485860 and its comment 1503535688485860_38452879274296258,
    with first_comment_status reaching 'posted'. The shape does match Instagram's comment
    edge, which is what it was written on the assumption of — that assumption held.
    """
    return client.create_comment(media_id, message, token)


# Publish entry point per platform. Uniform signature so the dispatch below is a lookup,
# not a chain of ifs whose final `else` silently means "Instagram".
_PUBLISHERS = {
    "instagram": _publish_instagram,
    "facebook": _publish_facebook,
    "threads": _publish_threads,
    "discord": _publish_discord,
    "telegram": _publish_telegram,
    "tiktok": _publish_tiktok,
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
#   * tiktok    — no runtime quota endpoint exists. TikTok documents roughly 15 posts per
#                 day per creator, but the only endpoint reporting creator limits
#                 (creator_info/query) requires the video.publish scope, which needs the
#                 app audit this install cannot obtain. Its spam_risk_too_many_posts error
#                 is handled as a retryable failure instead — the quota signal arriving as
#                 an error rather than as a number.
_QUOTA_GATED = {
    "instagram": True,
    "facebook": False,
    "threads": True,
    "discord": False,
    "telegram": False,
    "tiktok": False,
}

# The quota-reading call differs per gated platform (Instagram and Threads expose the same
# (usage, total, duration) shape but through different endpoints/methods), so the gate looks
# up which method to call here rather than hardcoding Instagram's. Only platforms that are
# actually gated belong here — see the assertion below.
_QUOTA_READERS = {
    "instagram": lambda c, acct, tok: c.get_content_publishing_limit(acct, tok),
    "threads": lambda c, acct, tok: c.get_threads_publishing_limit(acct, tok),
}

# How each platform posts a first comment after publishing, or None where the platform
# has no equivalent. Every supported platform declares a choice, same reasoning as
# _QUOTA_GATED: None must mean "this platform genuinely has no first-comment concept",
# never "not wired up yet".
#   * instagram — comment edge on the published media.
#   * facebook  — comment edge on the published Page post (see _comment_facebook's note).
#   * threads   — no comment edge; a self-reply carrying reply_to_id.
#   * discord   — a webhook posts messages, not comments. A follow-up message would be a
#                 different feature with different semantics, not this one.
#   * telegram  — same: a second message to the channel is not a comment on the first.
#   * tiktok    — the creator completes the post themselves, so there is no moment at which
#                 this worker holds a published video to comment on. Not a gap: there is
#                 nothing here to comment on.
_COMMENTERS = {
    "instagram": _comment_instagram,
    "facebook": _comment_facebook,
    "threads": _comment_threads,
    "discord": None,
    "telegram": None,
    "tiktok": None,
}

# Whether a platform's publish call DELIVERS rather than PUBLISHES. Declared for every
# platform, same reasoning as _QUOTA_GATED: False must mean "this platform really does
# publish on command", never "we forgot to think about it".
#
# When True, the completion write stores the returned id as remote_container_id, leaves
# remote_post_id NULL, and sets delivery_state='inbox'. Leaving remote_post_id NULL is
# load-bearing rather than tidy: the metrics due-query requires it, so a video nobody has
# published yet is invisible to metrics without metrics needing to know TikTok exists.
_DELIVERS_TO_INBOX = {
    "instagram": False,
    "facebook": False,
    "threads": False,
    "discord": False,
    "telegram": False,
    "tiktok": True,
}

assert set(_PUBLISHERS) == set(SUPPORTED_PLATFORMS), (
    "publisher._PUBLISHERS and clients.SUPPORTED_PLATFORMS disagree"
)
assert set(_COMMENTERS) == set(SUPPORTED_PLATFORMS), (
    "publisher._COMMENTERS and clients.SUPPORTED_PLATFORMS disagree"
)
assert set(_QUOTA_GATED) == set(SUPPORTED_PLATFORMS), (
    "publisher._QUOTA_GATED and clients.SUPPORTED_PLATFORMS disagree"
)
assert set(_DELIVERS_TO_INBOX) == set(SUPPORTED_PLATFORMS), (
    "publisher._DELIVERS_TO_INBOX and clients.SUPPORTED_PLATFORMS disagree"
)
assert set(_QUOTA_READERS) == {p for p, gated in _QUOTA_GATED.items() if gated}, (
    "publisher._QUOTA_READERS must have exactly the platforms _QUOTA_GATED marks True"
)


def _post_first_comment(conn, pub, client, *, platform, account_id, message, media_id,
                        token, config, sleep_fn, now, log) -> None:
    """Post the first comment on an ALREADY-PUBLISHED media. Never raises.

    Three rules hold this together, and all three exist because the post is already live
    by the time this runs:

    1. It cannot fail the publication. There is no way to unpublish, so turning a live
       post into a 'failed' row would be a lie about what happened.
    2. It cannot be retried automatically. The publication is 'posted', so the normal
       backoff machinery no longer applies to it — and a blind retry risks a SECOND
       comment on a live post, which is worse than a missing one. It fails once,
       visibly, and waits for a human.
    3. It must not be silent. 'failed' plus the reason lands on the row, per the
       project's failures-are-visible rule.

    'pending' is written BEFORE the attempt so a worker that dies mid-call leaves a
    visibly stuck row rather than a 'none' that looks like there was no work to do.
    """
    commenter = _COMMENTERS[platform]
    # Nothing to say, or a platform with no first-comment concept. Both leave the status
    # at its 'none' default — 'failed' here would cry wolf on every Discord post.
    if not message or commenter is None:
        return

    db.update_publication(
        conn, pub["id"], first_comment_status="pending", updated_at=_iso(now)
    )
    try:
        comment_id = commenter(
            client, account_id, message, media_id, token, config, sleep_fn
        )
    except Exception as exc:  # noqa: BLE001 — a comment failure must never escape
        # redact() for the same reason _mark_failure does it: this text is rendered
        # straight into the dashboard, and an exception string can carry a token.
        db.update_publication(
            conn, pub["id"],
            first_comment_status="failed", first_comment_error=redact(str(exc)),
            updated_at=_iso(now),
        )
        log(f"first comment FAILED (post is live and unaffected): {redact(str(exc))}")
        return
    db.update_publication(
        conn, pub["id"],
        first_comment_status="posted", first_comment_remote_id=comment_id,
        first_comment_error=None, updated_at=_iso(now),
    )
    log(f"first comment -> {comment_id}")


def run_first_comment_retries(conn, config, client, now, *, logger=None,
                              client_for=None, dry_run=False, sleep_fn=time.sleep) -> int:
    """Re-attempt first comments a human explicitly asked to retry. Returns the count.

    Only rows carrying first_comment_retry_requested=1 are touched — never a 'failed'
    row on its own. That flag is the whole safety property: the media is live, so
    "retry" has to be a decision someone made, not something the poll loop concludes.

    The flag is cleared whether the retry succeeds or fails, exactly like the avatar
    refresh handshake: a click means one more attempt, not a permanent retry loop.
    """
    rows = conn.execute(
        """SELECT p.*, po.first_comment AS post_first_comment
             FROM publications p
             JOIN posts po ON po.id = p.post_id
            WHERE p.first_comment_retry_requested = 1
              AND p.status = 'posted'
              AND p.is_dry_run = 0
              AND p.remote_post_id IS NOT NULL"""
    ).fetchall()
    if not rows:
        return 0
    if dry_run:
        # A retry posts to a live account, so it must not run in dry-run. The request is
        # LEFT SET rather than cleared, so it happens once dry-run is switched off
        # instead of being silently swallowed.
        if logger:
            logger.info("DRY-RUN: %d first-comment retry request(s) left queued", len(rows))
        return 0

    pick_client = client_for or (lambda _platform: client)
    done = 0
    for pub in rows:
        channel = db.get_channel(conn, pub["channel_id"])
        if channel is None:
            continue

        def log(msg, pub_id=pub["id"]):
            if logger:
                logger.info("[pub %s] %s", pub_id, msg)

        # Clear the request FIRST. If the attempt then crashes the process, the retry
        # does not silently repeat on the next cycle — which, on a live post, could
        # leave two identical comments.
        db.update_publication(
            conn, pub["id"], first_comment_retry_requested=0, updated_at=_iso(now)
        )
        try:
            pub_client = pick_client(channel["platform"])
        except UnknownPlatform:
            continue
        _post_first_comment(
            conn, pub, pub_client,
            platform=channel["platform"],
            account_id=channel["remote_account_id"],
            message=_normalise_comment(pub["post_first_comment"]),
            media_id=pub["remote_post_id"],
            token=channel["access_token"],
            config=config, sleep_fn=sleep_fn, now=now, log=log,
        )
        done += 1
    return done


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

    # 0. Claim the row BEFORE any other work — see db.claim_publication for why the
    #    ordering is the whole fix. A dry run publishes nothing and must not take the
    #    claim: it would leave a real row parked at 'publishing' for a send that never
    #    happened.
    if not dry_run and not db.claim_publication(conn, pub["id"], _iso(now)):
        log("skipped: no longer claimable — another worker won it, or it was held/deleted")
        return PublishOutcome("skipped", "not claimable: already claimed, held, or gone")

    # 1. Load + validate. Bad data/config is a terminal (non-retryable) failure.
    try:
        channel, post, assets = _load_targets(conn, pub)
        used_count = conn.execute(
            "SELECT COUNT(*) FROM publications WHERE post_id=? AND channel_id=? AND status='posted'",
            (pub["post_id"], pub["channel_id"]),
        ).fetchone()[0]
        caption = _select_caption(conn, post["id"], channel["platform"], used_count)
        surface = _surface(pub)
        _validate(post, assets, dry_run, asset_base_url, channel["platform"], caption,
                  config, surface)
        plan = _build_plan(channel, post, assets, asset_base_url, caption, config,
                           surface, conn)
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

    # 2b. TikTok's access token expires every 24 hours. Refreshed HERE, in the publish
    #     path, rather than in a background job: a token refreshed by some other loop an
    #     hour ago can still die between then and the last byte of a chunked upload.
    if channel["platform"] == "tiktok":
        from .tiktok_tokens import TikTokAuthRevoked, refresh_channel_token

        try:
            channel = refresh_channel_token(conn, config, client, channel, now, logger=logger)
            token = channel["access_token"]
        except TikTokAuthRevoked as exc:
            # Terminal. No amount of retrying re-authorises an account, and a quiet retry
            # loop would bury the one instruction the owner needs: reconnect the channel.
            log(f"tiktok auth revoked: {exc}")
            return _mark_failure(conn, pub, config, now, str(exc), terminal=True)
        except Exception as exc:  # noqa: BLE001 — transient refresh failure; retry with backoff
            log(f"tiktok token refresh failed: {exc}")
            return _mark_failure(conn, pub, config, now, f"token refresh: {exc}", terminal=False)

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

    # 4. Publish for real. The row is ALREADY 'publishing' — step 0 claimed it. Writing
    #    it again here would be redundant, and re-adding that write would quietly
    #    re-open the race by making step 0 look optional.
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

    if _DELIVERS_TO_INBOX[plan["platform"]]:
        # Delivered, not published. remote_post_id stays NULL ON PURPOSE: the metrics
        # due-query requires it, so this row stays invisible to metrics until the watcher
        # learns the real post id — or until it gives up. Writing the publish_id there
        # instead would hand metrics an upload-session id to chase forever.
        db.update_publication(
            conn, pub["id"],
            status="posted", remote_container_id=media_id, delivery_state="inbox",
            published_at=_iso(now), last_error=None, next_retry_at=None,
            updated_at=_iso(now),
        )
    else:
        db.update_publication(
            conn, pub["id"],
            status="posted", remote_post_id=media_id, published_at=_iso(now),
            last_error=None, next_retry_at=None, updated_at=_iso(now),
        )
    # 5. First comment — AFTER the row says 'posted', and deliberately outside every
    #    failure path above. The media is live and cannot be unpublished, so a comment
    #    failure is recorded on its own columns and changes nothing else.
    _post_first_comment(
        conn, pub, client,
        platform=plan["platform"], account_id=plan["account_id"],
        message=plan["first_comment"], media_id=media_id, token=token,
        config=config, sleep_fn=sleep_fn, now=now, log=log,
    )
    if post["content_kind"] == "one_time":
        _maybe_retire_one_time(conn, post["id"], now)
    log(
        f"delivered to inbox -> {media_id}"
        if _DELIVERS_TO_INBOX[plan["platform"]]
        else f"published -> {media_id}"
    )
    return PublishOutcome("posted", media_id, plan)
