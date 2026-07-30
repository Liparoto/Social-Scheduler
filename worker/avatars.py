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

import sqlite3
from datetime import timedelta
from pathlib import Path

from .clients import SUPPORTED_PLATFORMS

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
