"""Cache the Insights leaderboard's thumbnails on local disk.

`remote_media.thumbnail_url` is a signed CDN link with an expiry. Hotlinking it works on
the day a post is synced and then quietly rots — and for a post this install did not
publish there is no local original to fall back on, because the asset store only holds
media we uploaded ourselves. Within weeks the top-content table would be a grid of broken
images with no obvious cause.

The same problem was already solved once for profile photos (worker/avatars.py, migration
0012), so this follows that shape deliberately: download, verify the bytes really are an
image, write atomically, record a store-relative path.

Read-only against the platform, so it runs under DRY_RUN like the other Insights jobs.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .avatars import _image_extension  # magic-byte sniffing, shared on purpose
from .redact import redact

# Ceiling on what we will download at all. Deliberately generous, because Meta's
# "thumbnail_url" is frequently the FULL-SIZE image (and for a plain photo post the sync
# falls back to media_url, which always is) — refusing those outright would leave most of
# the leaderboard blank. They get downscaled immediately after landing; see below.
MAX_THUMBNAIL_BYTES = 8_000_000

# Longest edge we keep. The leaderboard draws these at 40px, so 400 covers a 3x display
# and any larger preview we might add later, at roughly 1/50th the bytes.
#
# This matters more than it looks: the first pass stored Meta's originals and produced
# 115 MB for 118 images, on a tool whose whole storage story is "a folder on your Mac".
# Multiply that by a second account and a few years of posts and the cache outgrows the
# media it describes.
THUMBNAIL_MAX_PIXELS = 400

# macOS ships `sips`; this project is macOS-only and already shells out to avconvert for
# video conversion, so resizing this way adds no dependency (Pillow is not installed, and
# pulling it in to shrink decorative images would not earn its place).
SIPS = "/usr/bin/sips"


def media_needing_thumbnails(conn, channel_id: int, limit: int):
    """Posts with a CDN url we have never tried to download.

    `thumbnail_fetched_at IS NULL` is the gate, NOT `thumbnail_path IS NULL`. They differ
    for a post whose link had already expired before we reached it: the path stays NULL
    forever, and keying on it would retry that post every cycle for the life of the
    install. Recording the attempt is what makes "we tried and got nothing" a terminal
    state.

    Newest first — those are the posts most likely to be looked at, and the ones whose
    CDN links are least likely to have expired already.
    """
    return conn.execute(
        """
        SELECT id, remote_post_id, thumbnail_url FROM remote_media
        WHERE channel_id = ?
          AND is_deleted = 0
          AND thumbnail_url IS NOT NULL
          AND thumbnail_fetched_at IS NULL
        ORDER BY published_at DESC
        LIMIT ?
        """,
        (channel_id, limit),
    ).fetchall()


def _downscale(path: Path, max_pixels: int = THUMBNAIL_MAX_PIXELS) -> None:
    """Shrink `path` in place so its longest edge is at most `max_pixels`.

    Best-effort by design. A thumbnail that stays full-size still displays correctly — it
    just costs disk — so a missing or failing `sips` must not lose the image. Silence on
    failure is the right behaviour here precisely because the fallback is harmless.
    """
    if not Path(SIPS).exists():
        return
    try:
        subprocess.run(
            [SIPS, "-Z", str(max_pixels), str(path)],
            check=True, capture_output=True, timeout=30,
        )
    except (subprocess.SubprocessError, OSError):
        return


def store_thumbnail(asset_dir: Path, media_id: int, data: bytes, ext: str) -> str:
    """Write to thumbnails/<remote_media_id>.<ext>; return the store-relative path.

    Temp file, then downscale, then os.replace — in that order. Resizing the TEMP file
    means a failed or half-written resize can never leave a corrupt image where a valid
    one used to be, and the rename stays atomic (os.replace within one filesystem).
    """
    thumb_dir = asset_dir / "thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)
    final = thumb_dir / f"{media_id}.{ext}"
    tmp = thumb_dir / f".{media_id}.{ext}.tmp"
    try:
        tmp.write_bytes(data)
        _downscale(tmp)
        os.replace(tmp, final)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return f"thumbnails/{final.name}"


def run_thumbnails(conn, config, client=None, now=None, logger=None,
                   client_for=None) -> int:
    """Fetch missing thumbnails for every active channel. Returns the count stored."""
    from .media_sync import CallBudget

    pick_client = client_for or (lambda _platform: client)
    budget = CallBudget(config.thumbnail_max_per_cycle, config.insights_usage_pct_ceiling)
    asset_dir = Path(config.asset_storage_dir)
    now_iso = (now.isoformat() if now else None)
    stored = 0

    for channel in conn.execute("SELECT * FROM channels WHERE is_active = 1").fetchall():
        due = media_needing_thumbnails(conn, channel["id"], max(budget.remaining, 0))
        if not due:
            continue
        try:
            http = pick_client(channel["platform"])
        except Exception as exc:  # noqa: BLE001 — one bad channel must not stop the rest
            # UnknownPlatform when a channel's platform is missing from the client
            # registries. A thumbnail is decoration; losing every OTHER channel's
            # thumbnails over one misconfigured row is not a trade worth making.
            if logger:
                logger.debug("[thumbnails ch %s] no client: %s", channel["id"], exc)
            continue
        if http is None:
            continue

        for media in due:
            if budget.remaining <= 0:
                break
            budget.spend()
            path = None
            try:
                data = http.download_image_bytes(
                    media["thumbnail_url"], max_bytes=MAX_THUMBNAIL_BYTES
                )
                ext = _image_extension(data)
                if ext:
                    path = store_thumbnail(asset_dir, media["id"], data, ext)
                    stored += 1
                elif logger:
                    # Meta serving non-image bytes usually means the signed link expired
                    # and we got an error document. Not worth a warning per post.
                    logger.debug(
                        "[thumbnails] media %s: not an image, skipping", media["id"]
                    )
            except Exception as exc:  # noqa: BLE001 — a thumbnail is decoration
                # An expired link is the normal failure here and must never be loud, nor
                # stop the rest. The row is still marked as attempted below so it does
                # not come back every cycle.
                if logger:
                    logger.debug(
                        "[thumbnails] media %s failed: %s", media["id"], redact(str(exc))
                    )
            # Written whether or not a file was produced — see media_needing_thumbnails.
            conn.execute(
                "UPDATE remote_media SET thumbnail_path = COALESCE(?, thumbnail_path), "
                "thumbnail_fetched_at = ? WHERE id = ?",
                (path, now_iso, media["id"]),
            )
        conn.commit()

    if logger and stored:
        logger.info("[thumbnails] cached %d thumbnail(s)", stored)
    return stored
