"""Keep a TikTok channel's access token alive.

Every other platform in this project hands out a credential that sits in the channel row
and keeps working — Meta's long-lived tokens last 60 days and are replaced by hand, a
Discord webhook URL and a Telegram bot token never expire at all. TikTok's access token
lasts 24 hours, and its refresh token ROTATES: every refresh returns a new one and
invalidates the one you sent.

Two consequences shape this module:

1. **Storing the new refresh token is part of the refresh, not a follow-up.** Writing the
   access token without it produces a channel that works today and is locked out at the
   next refresh, with no way back except re-authorising in a browser.
2. **Revoked must be told apart from transient.** A network blip has to be retried; a
   revoked authorisation must not be, because retrying it forever buries the one thing the
   owner needs to be told — reconnect the channel.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from . import db
from .tiktok_api import TikTokAPIError

# Refresh when the access token has less than this left. An hour is comfortably longer than
# any single publish (a chunked upload plus status polling), so a token cannot expire
# between the check and the last byte.
REFRESH_MARGIN = timedelta(hours=1)

# TikTok's OAuth error codes that mean "this grant is dead", not "try again". Matched as
# substrings of the client's message, which carries TikTok's own error code verbatim.
_REVOKED_CODES = ("invalid_grant", "invalid_request", "access_token_invalid")


class TikTokAuthRevoked(Exception):
    """The channel's authorisation is gone. Only a human reconnecting fixes this, so it
    must never be retried quietly."""


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def refresh_channel_token(conn, config, client, channel, now, logger=None):
    """Return the channel row with a usable access token, refreshing first if needed.

    Raises TikTokAuthRevoked when only re-authorisation can help, and TikTokAPIError for
    anything the caller should retry.
    """
    if channel["platform"] != "tiktok":
        return channel

    expires_at = _parse(channel["token_expires_at"])
    # An unknown expiry refreshes rather than gambling: one extra call costs nothing, and
    # assuming a token is fine costs a failed publish.
    if expires_at is not None and expires_at - now > REFRESH_MARGIN:
        return channel

    if not config.tiktok_client_key or not config.tiktok_client_secret:
        raise TikTokAuthRevoked(
            "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set in .env — "
            "add them (see docs/tiktok-setup.md) and reconnect this channel"
        )
    if not channel["refresh_token"]:
        raise TikTokAuthRevoked(
            f"channel {channel['id']} has no refresh token — reconnect it in the dashboard"
        )

    try:
        tokens = client.refresh_access_token(
            config.tiktok_client_key, config.tiktok_client_secret, channel["refresh_token"]
        )
    except TikTokAPIError as exc:
        if any(code in str(exc) for code in _REVOKED_CODES):
            # `from None`: the original message already reached this one, and suppressing
            # the chain keeps a credential-bearing traceback from forming behind it.
            raise TikTokAuthRevoked(
                f"TikTok refused to refresh channel {channel['id']} — "
                f"reconnect it in the dashboard ({exc})"
            ) from None
        raise   # transient — the caller's normal backoff applies

    # ONE write, both tokens. Splitting this would leave a window in which the access token
    # is current and the refresh token is the dead one TikTok just replaced.
    db.update_channel(
        conn, channel["id"],
        access_token=tokens["access_token"],
        token_expires_at=(now + timedelta(seconds=int(tokens["expires_in"]))).isoformat(),
        refresh_token=tokens["refresh_token"],
        refresh_token_expires_at=(
            now + timedelta(seconds=int(tokens["refresh_expires_in"]))
        ).isoformat(),
        updated_at=now.isoformat(),
    )
    if logger:
        # The channel id, never the token.
        logger.info("[tiktok] refreshed the access token for channel %s", channel["id"])
    return db.get_channel(conn, channel["id"])
