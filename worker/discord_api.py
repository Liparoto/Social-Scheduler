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


class DiscordAPIError(Exception):
    """Raised when Discord returns a non-OK response. Never includes the webhook URL."""


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
        in the message — only the status code and response text are safe to surface."""
        raise DiscordAPIError(f"Discord request failed -> {resp.status_code}: {resp.text}")

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

        if files:
            data = {"payload_json": json.dumps(payload)}
            file_parts = {f"files[{i}]": f for i, f in enumerate(files)}
            resp = self.session.post(
                webhook_url, data=data, files=file_parts, timeout=self.timeout
            )
        else:
            resp = self.session.post(webhook_url, json=payload, timeout=self.timeout)

        if not resp.ok:
            self._fail(resp)
        return self._parse(resp)

    def get_webhook(self, webhook_url: str) -> dict:
        resp = self.session.get(webhook_url, timeout=self.timeout)
        if not resp.ok:
            self._fail(resp)
        return self._parse(resp)
