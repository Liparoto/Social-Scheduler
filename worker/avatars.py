"""Channel profile-photo (avatar) fetch job.

Each channel's account has a profile photo on its platform. Caching it locally lets the
dashboard show WHICH ACCOUNT a channel is, rather than just an accent colour.

The bytes are stored, not the URL: Instagram's profile_picture_url and the Facebook Page
picture URL are short-lived SIGNED CDN links, so a stored URL would break within days and
would make the dashboard talk to Meta on every render.

Throttling: a channel is refreshed at most once every AVATAR_MAX_AGE_DAYS, unless the
dashboard has requested one or the file has gone missing from disk.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
from datetime import timedelta
from pathlib import Path

from .clients import SUPPORTED_PLATFORMS
from .redact import redact

# A profile photo changes rarely, and a stale one is a cosmetic problem rather than a
# correctness one — so this is deliberately slow. The dashboard's "Refresh photo" button
# is the escape hatch when the owner changes a photo and wants it now.
AVATAR_MAX_AGE_DAYS = 7


def _instagram_url(client, channel) -> str | None:
    return client.get_instagram_profile_picture_url(
        channel["remote_account_id"], channel["access_token"]
    )


def _facebook_url(client, channel) -> str | None:
    return client.get_page_picture_url(
        channel["remote_account_id"], channel["access_token"]
    )


def _threads_url(client, channel) -> str | None:
    return client.get_threads_profile_picture_url(
        channel["remote_account_id"], channel["access_token"]
    )


_URL_FETCHERS = {
    "instagram": _instagram_url,
    "facebook": _facebook_url,
    "threads": _threads_url,
    # None means "this platform has no account avatar to fetch" — a Discord webhook and a
    # Telegram chat target have no per-channel profile photo we can read the way IG/FB/
    # Threads do. Distinct from a platform simply missing from this dict, which would mean
    # someone forgot to register it. Telegram COULD be supported later via
    # getChat -> getFile -> download; it is out of scope deliberately, not by oversight.
    "discord": None,
    "telegram": None,
}

assert set(_URL_FETCHERS) == set(SUPPORTED_PLATFORMS), (
    "avatars._URL_FETCHERS and clients.SUPPORTED_PLATFORMS disagree"
)


def channels_needing_avatars(conn, now, asset_dir: Path) -> list[sqlite3.Row]:
    """Active, credentialled channels on a platform that HAS avatars, which are either
    stale, explicitly requested, or missing their file on disk.

    Platforms with no avatar support are excluded in SQL rather than skipped later, so
    they are not reselected every cycle only to be discarded every cycle (same reasoning
    as metrics.publications_needing_metrics).
    """
    no_avatar_platforms = [p for p, fetch in _URL_FETCHERS.items() if fetch is None]
    exclude_clause = ""
    params: list = []
    if no_avatar_platforms:
        placeholders = ",".join("?" for _ in no_avatar_platforms)
        exclude_clause = f"AND platform NOT IN ({placeholders}) "
        params.extend(no_avatar_platforms)

    stale_cutoff = (now - timedelta(days=AVATAR_MAX_AGE_DAYS)).isoformat()
    params.append(stale_cutoff)

    rows = conn.execute(
        f"""
        SELECT * FROM channels
        WHERE is_active = 1
          AND remote_account_id IS NOT NULL AND remote_account_id != ''
          AND access_token IS NOT NULL AND access_token != ''
          {exclude_clause}
          AND (
                avatar_refresh_requested = 1
             OR avatar_fetched_at IS NULL
             OR avatar_fetched_at < ?
             OR avatar_path IS NOT NULL
          )
        ORDER BY id
        """,
        params,
    ).fetchall()

    # The "file is missing from disk" arm cannot be expressed in SQL, so the query above
    # over-selects (any row WITH a path) and this filter removes the ones whose file is
    # actually present and still fresh.
    selected = []
    for row in rows:
        if row["avatar_refresh_requested"] == 1:
            selected.append(row)
            continue
        fetched_at = row["avatar_fetched_at"]
        if fetched_at is None or fetched_at < stale_cutoff:
            selected.append(row)
            continue
        path = row["avatar_path"]
        if path and not (asset_dir / path).exists():
            selected.append(row)
    return selected


# Magic-byte signatures, so a Graph error page or an HTML redirect can never be written
# to disk as `avatars/3.jpg` and then served to the dashboard as an image. Sniffed rather
# than trusting Content-Type or the URL's extension, and done with the stdlib rather than
# by adding Pillow — the worker's only dependency is `requests`, and this is the whole of
# what we need image parsing for.
_IMAGE_SIGNATURES = (
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _image_extension(data: bytes) -> str | None:
    """Return the file extension for `data`, or None if it is not an image we accept."""
    for signature, ext in _IMAGE_SIGNATURES:
        if data.startswith(signature):
            return ext
    # WebP is RIFF-framed: "RIFF" + 4 size bytes + "WEBP".
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _store_avatar(asset_dir: Path, channel_id: int, data: bytes, ext: str) -> str:
    """Write `data` to avatars/<channel_id>.<ext> and return the store-relative path.

    Writes to a temp file in the same directory and renames, so a crash mid-write can
    never leave a half-written image where a valid one used to be (os.replace is atomic
    within a filesystem).
    """
    avatar_dir = asset_dir / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    final = avatar_dir / f"{channel_id}.{ext}"
    tmp = avatar_dir / f".{channel_id}.{ext}.tmp"
    try:
        tmp.write_bytes(data)
        os.replace(tmp, final)
    except Exception:
        # A failed write or replace (disk full, permissions) must not leave a stray temp
        # file behind — this runs every cycle, so an unlinked orphan would accumulate.
        tmp.unlink(missing_ok=True)
        raise
    return f"avatars/{final.name}"


def run_avatars(conn, config, client, now, *, logger=None, client_for=None) -> int:
    """Refresh every due channel's avatar. Returns the count actually refreshed.

    Read-only against the platform — it publishes nothing — so it runs regardless of
    DRY_RUN, the same way metrics fetching is gated on the publication rather than on the
    fetch being suppressed.

    Every failure is per-channel: it is recorded on that row and the loop continues. This
    job must never raise, and must never leave a channel without the photo it already had.
    """
    now_iso = now.isoformat()
    pick_client = client_for or (lambda _platform: client)
    try:
        due = channels_needing_avatars(conn, now, Path(config.asset_storage_dir))
    except Exception as exc:  # noqa: BLE001 — selection itself must never kill the daemon
        # E.g. "database is locked" — the dashboard is a concurrent writer against the
        # same SQLite file. No channel to attach the error to, so just log and bail for
        # this cycle; the per-channel handling below is unreachable if selection failed.
        if logger:
            logger.warning("[avatar] selection failed: %s", redact(str(exc)))
        return 0
    refreshed = 0

    for channel in due:
        channel_id = channel["id"]
        try:
            fetch_url = _URL_FETCHERS[channel["platform"]]
            url = fetch_url(pick_client(channel["platform"]), channel)

            if not url:
                # The account genuinely has no photo (or Meta returned its default
                # silhouette). Not a failure — stamp the timestamp so this is not retried
                # every single cycle, and let the initial circle stand.
                conn.execute(
                    "UPDATE channels SET avatar_fetched_at = ?, avatar_error = NULL,"
                    " avatar_refresh_requested = 0, updated_at = ? WHERE id = ?",
                    (now_iso, now_iso, channel_id),
                )
                conn.commit()
                continue

            data = pick_client(channel["platform"]).download_image_bytes(url)
            ext = _image_extension(data)
            if ext is None:
                raise ValueError(
                    "response body is not an image we recognise "
                    "(expected JPEG, PNG, GIF or WebP)"
                )

            existing_rel = channel["avatar_path"]
            existing_abs = (
                Path(config.asset_storage_dir) / existing_rel if existing_rel else None
            )
            unchanged = (
                existing_abs is not None
                and existing_abs.exists()
                and hashlib.sha256(existing_abs.read_bytes()).hexdigest()
                == hashlib.sha256(data).hexdigest()
            )
            # Hash comparison, not filename or byte length — the project's dedup rule
            # everywhere else. Skipping the rewrite keeps the file's mtime meaningful and
            # avoids touching the disk every week for a photo that never changes.
            rel = existing_rel if unchanged else _store_avatar(
                Path(config.asset_storage_dir), channel_id, data, ext
            )

            conn.execute(
                "UPDATE channels SET avatar_path = ?, avatar_fetched_at = ?,"
                " avatar_error = NULL, avatar_refresh_requested = 0, updated_at = ?"
                " WHERE id = ?",
                (rel, now_iso, now_iso, channel_id),
            )
            conn.commit()
            refreshed += 1

        except Exception as exc:  # noqa: BLE001 — deliberately broad; never kill the daemon
            message = redact(f"avatar fetch failed: {exc}")
            if logger:
                logger.warning("[avatar ch %s] %s", channel_id, message)
            # avatar_path is deliberately NOT cleared: a working photo must survive a
            # transient failure. avatar_refresh_requested IS cleared, so a click that
            # always fails cannot wedge this channel into retrying every cycle forever.
            conn.execute(
                "UPDATE channels SET avatar_error = ?, avatar_refresh_requested = 0,"
                " updated_at = ? WHERE id = ?",
                (message, now_iso, channel_id),
            )
            conn.commit()

    return refreshed
