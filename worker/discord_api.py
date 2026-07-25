"""Discord webhook client for posting text and image messages.

Discord webhooks are a single POST endpoint per channel — the webhook URL itself is the
credential (there is no separate token parameter). That means the URL must never be
interpolated into an exception message or log line, since doing so would leak the
credential anywhere that message ends up (logs, dashboards, error trackers).

Request shape (see reference.md for the verified specifics):
  * text-only: POST the webhook URL with JSON body {"content": ...}
  * with files: switch to multipart/form-data — a `payload_json` part carrying the same
    JSON payload, plus `files[0]`, `files[1]`, ... for each attachment
  * a request must carry at least one of content or files
  * GET on the webhook URL returns the webhook object (id, name, channel_id) — used as
    the preflight check
  * Discord can reply with an empty-body 204, so response parsing must be defensive
    rather than assuming a JSON body is always present
"""

from __future__ import annotations

import json

import requests

from .redact import redact


class DiscordAPIError(Exception):
    """Raised when Discord returns a non-OK response, or the underlying request fails
    at the network layer. Never includes the webhook URL (the credential)."""


class DiscordClient:
    def __init__(
        self,
        base_url: str = "https://discord.com/api/v10",
        session: requests.Session | None = None,
        timeout: int = 60,
    ) -> None:
        # base_url is currently unused by webhook calls (they target the webhook URL
        # directly, which already embeds its own host/version) but is kept for interface
        # symmetry with GraphClient and for any future non-webhook Discord calls.
        self.base_url = base_url
        self.session = session or requests.Session()
        self.timeout = timeout

    @staticmethod
    def _parse(resp) -> dict:
        """Parse a response body defensively: Discord may reply with an empty 204 body,
        which has no JSON to decode."""
        try:
            return resp.json() or {}
        except ValueError:
            return {}

    @staticmethod
    def _fail(resp) -> None:
        """Raise DiscordAPIError without ever including the webhook URL (the credential)
        in the message — only the status code and response text are safe to surface, and
        the text is run through the redactor too, cheap insurance in case Discord ever
        echoes the URL back in an error body."""
        raise DiscordAPIError(f"Discord request failed -> {resp.status_code}: {redact(resp.text)}")

    @staticmethod
    def _with_wait_true(webhook_url: str) -> str:
        """Append `wait=true` so Discord returns the created message object instead of
        an empty 204 body. Without it, every send_message's remote_post_id would be the
        literal fallback marker "posted" (see publisher._publish_discord), never a real
        message id — Discord's default `?wait=false` behavior. Appends with `&` when the
        URL already carries a query string, `?` otherwise, so this never breaks a
        webhook URL that already has one."""
        sep = "&" if "?" in webhook_url else "?"
        return f"{webhook_url}{sep}wait=true"

    def send_message(
        self,
        webhook_url: str,
        *,
        content: str | None = None,
        files: list[tuple[str, bytes]] | None = None,
    ) -> dict:
        if content is None and not files:
            raise ValueError("send_message requires content or files")

        payload: dict = {}
        if content is not None:
            payload["content"] = content

        url = self._with_wait_true(webhook_url)
        try:
            if files:
                data = {"payload_json": json.dumps(payload)}
                file_parts = {f"files[{i}]": f for i, f in enumerate(files)}
                resp = self.session.post(
                    url, data=data, files=file_parts, timeout=self.timeout
                )
            else:
                resp = self.session.post(url, json=payload, timeout=self.timeout)
        except requests.RequestException as exc:
            # The webhook URL IS the credential, and it lives inside exc's own str() (e.g.
            # a ConnectionError embeds the request URL) — never let that reach the message.
            # `from None` (not `from exc`) suppresses the chain: the redacted message
            # already carries everything useful, and exc's own str() (still holding the
            # raw URL) must never survive into a traceback via __cause__.
            raise DiscordAPIError(f"Discord request failed: {redact(str(exc))}") from None

        if not resp.ok:
            self._fail(resp)
        return self._parse(resp)

    def get_webhook(self, webhook_url: str) -> dict:
        try:
            resp = self.session.get(webhook_url, timeout=self.timeout)
        except requests.RequestException as exc:
            raise DiscordAPIError(f"Discord request failed: {redact(str(exc))}") from None
        if not resp.ok:
            self._fail(resp)
        return self._parse(resp)
