"""Keep Instagram and Threads tokens alive, and say so plainly when that is impossible.

Meta's long-lived Instagram and Threads tokens last about 60 days. They can be renewed for
another 60 at any point while still valid (and at least 24 hours old) — but an EXPIRED
token can never be renewed, only replaced by a human reconnecting. Before this module
nothing renewed them and nothing tracked the date, so the first sign of an expiry was a
failed post (Threads, 2026-09-22).

What happens per channel, at most every CHECK_EVERY:
  - Threads: ask debug_token for the expiry; renew once inside RENEW_WITHIN.
  - Instagram via Instagram Login: there is no expiry lookup, so renew when the expiry is
    unknown or inside RENEW_WITHIN — the renewal response is what tells us the date.
  - Facebook Pages, and Instagram via Facebook Login: check only. Page tokens do not
    expire; the check exists so a revoked one is flagged before a post fails on it.
  - TikTok is not here: worker/tiktok_tokens.py owns its 24-hour rotation.

Three rules shape the code:
  1. A token is written only when Meta has just handed us a new one. A failed renewal
     leaves the stored token untouched — it may still have weeks left.
  2. `token_error` is for things a human must fix. A network blip is not one: it is
     retried in RETRY_AFTER and never shown.
  3. No token reaches a log or `token_error`. Messages are built from Meta's error text or
     an exception's class name, never from a request URL.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import requests

from . import db
from .clients import FACEBOOK_BASE, THREADS_BASE
from .redact import redact

# Renew with two weeks to spare: a Mac that is off for a week, or a Meta outage, still
# leaves a week of retries before the cliff.
RENEW_WITHIN = timedelta(days=14)
CHECK_EVERY = timedelta(hours=12)
RETRY_AFTER = timedelta(hours=1)

_PLATFORMS = ("instagram", "threads", "facebook")

RECONNECT = "Reconnect it: Channels → Credentials → Edit, paste a new token."


class _Transient(Exception):
    """No answer from Meta (network, timeout, 5xx). Retry later; tell nobody."""


class _MetaError(Exception):
    """Meta answered and said no. Carries Meta's own code so callers can tell an
    invalid token (190) from anything else."""

    def __init__(self, message: str, code: int | None) -> None:
        super().__init__(message)
        self.code = code


def _get(session, url: str, params: dict, timeout: int = 30) -> dict:
    try:
        resp = session.get(url, params=params, timeout=timeout)
    except requests.RequestException as exc:
        # The class name only: str(exc) embeds the request URL, token and all.
        raise _Transient(type(exc).__name__) from None
    try:
        body = resp.json()
    except ValueError:
        body = {}
    if resp.status_code >= 500:
        raise _Transient(f"HTTP {resp.status_code}")
    if not resp.ok or "error" in body:
        error = body.get("error") if isinstance(body.get("error"), dict) else {}
        message = redact(str(error.get("message") or f"HTTP {resp.status_code}"))
        code = error.get("code") if isinstance(error.get("code"), int) else None
        raise _MetaError(message, code)
    return body


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        parsed = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _from_epoch(value) -> datetime | None:
    """Meta's expires_at: epoch seconds, where 0 means 'never expires'."""
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc)


def _uses_instagram_login(config) -> bool:
    return "graph.instagram.com" in (config.graph_base or "")


# -- per-platform steps ------------------------------------------------------------------
# Each returns the columns to write. None for token_expires_at means "never expires" only
# where a step says so; otherwise the key is simply left out.

def _renew(session, url: str, grant: str, token: str, now: datetime) -> dict:
    body = _get(session, url, {"grant_type": grant, "access_token": token})
    new_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not new_token or not isinstance(expires_in, (int, float)):
        raise _MetaError("renewal answered without a token", None)
    return {
        "access_token": new_token,
        "token_expires_at": (now + timedelta(seconds=int(expires_in))).isoformat(),
        "token_error": None,
    }


def _debug_token(session, url: str, token: str, app_token: str) -> dict:
    data = _get(session, url, {"input_token": token, "access_token": app_token}).get("data")
    if not isinstance(data, dict):
        raise _MetaError("debug_token answered without data", None)
    return data


def _check_threads(session, config, channel, now: datetime) -> dict:
    token = channel["access_token"]
    info = _debug_token(
        session, f"{THREADS_BASE}/{config.threads_api_version}/debug_token", token, token
    )
    if not info.get("is_valid"):
        return {"token_error": f"Meta says this Threads token is no longer valid. {RECONNECT}"}
    expires = _from_epoch(info.get("expires_at"))
    update = {"token_expires_at": expires.isoformat() if expires else None, "token_error": None}
    if expires and expires - now <= RENEW_WITHIN:
        try:
            update.update(_renew(
                session, f"{THREADS_BASE}/refresh_access_token", "th_refresh_token", token, now
            ))
        except _MetaError as exc:
            # Keep the expiry we just learned — the card's countdown is the warning.
            update["token_error"] = f"Automatic renewal failed: {exc}. {RECONNECT}"
    return update


def _check_instagram_login(session, config, channel, now: datetime) -> dict:
    token = channel["access_token"]
    expires = _parse(channel["token_expires_at"])
    if expires and expires - now > RENEW_WITHIN:
        return {}
    base = config.graph_base.rstrip("/")
    try:
        return _renew(session, f"{base}/refresh_access_token", "ig_refresh_token", token, now)
    except _MetaError:
        if expires is not None:
            raise    # we KNOW it is close to dying and renewal failed: that is the news
        # Unknown expiry and Meta would not renew. A token under 24 hours old is refused,
        # and that is the normal state right after a reconnect — so ask whether the token
        # works at all before alarming anyone.
        _get(session, f"{base}/{config.graph_version}/me",
             {"fields": "user_id", "access_token": token})
        return {"token_error": None}


def _check_via_app_token(session, config, channel, now: datetime) -> dict:
    if not (config.meta_app_id and config.meta_app_secret):
        return {}   # nothing to check with; publishing still reports a dead token
    info = _debug_token(
        session,
        f"{FACEBOOK_BASE}/{config.graph_version}/debug_token",
        channel["access_token"],
        f"{config.meta_app_id}|{config.meta_app_secret}",
    )
    if not info.get("is_valid"):
        return {"token_error": f"Meta says this token is no longer valid. {RECONNECT}"}
    expires = _from_epoch(info.get("expires_at"))
    update = {"token_expires_at": expires.isoformat() if expires else None, "token_error": None}
    if expires and expires - now <= RENEW_WITHIN:
        # No automatic renewal exists for these; the owner needs the warning early.
        update["token_error"] = (
            # %b plus .day, not %-d: that flag does not exist on Windows.
            f"This token expires {expires:%b} {expires.day} and can't be renewed "
            f"automatically. "
            f"{RECONNECT}"
        )
    return update


def _step_for(platform: str, config):
    if platform == "threads":
        return _check_threads
    if platform == "instagram" and _uses_instagram_login(config):
        return _check_instagram_login
    return _check_via_app_token


# -- the cycle ---------------------------------------------------------------------------

def check_channel(conn, config, channel, now: datetime, session=None, logger=None) -> str:
    """Check (and if due, renew) one channel's token. Returns what happened, for logs and
    tests: 'renewed', 'ok', 'error', or 'retry'. Never raises for an API problem."""
    session = session or requests.Session()
    step = _step_for(channel["platform"], config)
    label = f"[token] channel {channel['id']} ({channel['platform']})"
    try:
        update = step(session, config, channel, now)
    except _Transient as exc:
        if logger:
            logger.warning("%s: no answer from Meta (%s) — retrying in an hour", label, exc)
        db.update_channel(conn, channel["id"],
                          token_next_check_at=(now + RETRY_AFTER).isoformat())
        return "retry"
    except _MetaError as exc:
        if exc.code == 190:
            message = f"Meta says this token is no longer valid ({exc}). {RECONNECT}"
        else:
            message = f"Automatic renewal failed: {exc}. {RECONNECT}"
        update = {"token_error": message}

    update["token_next_check_at"] = (now + CHECK_EVERY).isoformat()
    db.update_channel(conn, channel["id"], **update)

    if update.get("token_error"):
        if logger:
            logger.warning("%s: %s", label, update["token_error"])
        return "error"
    # Instagram can hand back the same string with a later date — still a renewal.
    if "access_token" in update:
        if logger:
            logger.info("%s: token renewed, now good until %s", label,
                        update.get("token_expires_at"))
        return "renewed"
    return "ok"


def run_token_upkeep(conn, config, now: datetime, logger=None, session=None) -> int:
    """Check every due Instagram / Threads / Facebook channel. Returns how many tokens were
    renewed. Never raises: one broken channel must not stop the others, or the cycle."""
    due = conn.execute(
        f"SELECT * FROM channels WHERE is_active = 1 "
        f"AND platform IN ({','.join('?' * len(_PLATFORMS))}) "
        f"AND access_token IS NOT NULL AND access_token != '' "
        f"AND (token_next_check_at IS NULL OR token_next_check_at <= ?)",
        (*_PLATFORMS, now.isoformat()),
    ).fetchall()
    session = session or requests.Session()
    renewed = 0
    for channel in due:
        try:
            if check_channel(conn, config, channel, now, session=session,
                             logger=logger) == "renewed":
                renewed += 1
        except Exception as exc:  # noqa: BLE001 — a bug here must not stop publishing
            if logger:
                logger.error("[token] channel %s: upkeep crashed (%s)", channel["id"],
                             type(exc).__name__)
    return renewed
