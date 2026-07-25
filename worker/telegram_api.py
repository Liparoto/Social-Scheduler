"""Telegram Bot API client for sending text, single photos, and photo albums.

The bot token lives in the URL path (`/bot<token>/<method>`), not in a header or body
field, so it is far easier to leak by accident than a normal credential — any error
message built from the request URL must have the token redacted before it can be raised.

Telegram's success signal is the `ok` field in the JSON body, not the HTTP status code:
it can return {"ok": false, "description": ...} with a 200 response, so both the status
and the body must be checked (see reference.md for the verified specifics).
"""

from __future__ import annotations

import json

import requests

from .redact import redact


class TelegramAPIError(Exception):
    """Raised when Telegram reports a failure, or the underlying request fails at the
    network layer. Never includes the bot token."""


class TelegramClient:
    def __init__(
        self,
        base_url: str = "https://api.telegram.org",
        session: requests.Session | None = None,
        timeout: int = 60,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout

    def _url(self, token: str, method: str) -> str:
        return f"{self.base_url}/bot{token}/{method}"

    def _call(self, token: str, method: str, data: dict, files: dict | None = None) -> dict:
        url = self._url(token, method)
        try:
            resp = self.session.post(url, data=data, files=files, timeout=self.timeout)
        except requests.RequestException as exc:
            # The token lives in the URL path, and exc's own str() embeds that URL (e.g.
            # a ConnectionError repeats the request URL) — redact before it's raised.
            # `from None` suppresses the chain so exc's own (unredacted) str() can't leak
            # back out via __cause__ in a traceback.
            raise TelegramAPIError(
                f"POST {redact(url)} -> request failed: {redact(str(exc))}"
            ) from None
        try:
            body = resp.json()
        except ValueError as exc:
            # A non-JSON response (e.g. an HTML 502 from an intermediary CDN) must not
            # escape as a raw JSONDecodeError — make this defensive like Discord's
            # _parse, and keep the invariant that only TelegramAPIError leaves this
            # client.
            raise TelegramAPIError(
                f"POST {redact(url)} -> {resp.status_code}: non-JSON response: "
                f"{redact(resp.text)[:200]}"
            ) from None
        if not resp.ok or not body.get("ok"):
            # A response body can, in principle, echo the token back — redact it too,
            # cheap insurance on top of always redacting the URL itself.
            description = redact(body.get("description", resp.text))
            raise TelegramAPIError(
                f"POST {redact(url)} -> {resp.status_code}: {description}"
            )
        return body.get("result")

    def get_me(self, token: str) -> dict:
        """Verify the bot token is valid. Used by preflight — read-only, no chat needed."""
        return self._call(token, "getMe", {})

    def get_chat(self, token: str, chat_id: str) -> dict:
        """Verify the bot can see `chat_id` and fetch its display name. Used by preflight
        alongside get_me — a valid token alone doesn't prove the bot is actually in the
        target chat."""
        return self._call(token, "getChat", {"chat_id": chat_id})

    def send_message(self, token: str, chat_id: str, text: str) -> dict:
        return self._call(token, "sendMessage", {"chat_id": chat_id, "text": text})

    def send_photo(
        self,
        token: str,
        chat_id: str,
        photo: tuple[str, bytes],
        caption: str | None = None,
    ) -> dict:
        data = {"chat_id": chat_id}
        if caption is not None:
            data["caption"] = caption
        return self._call(token, "sendPhoto", data, files={"photo": photo})

    def send_media_group(
        self,
        token: str,
        chat_id: str,
        photos: list[tuple[str, bytes]],
        caption: str | None = None,
    ) -> dict:
        media = []
        files = {}
        for i, photo in enumerate(photos):
            name = f"file{i}"
            item = {"type": "photo", "media": f"attach://{name}"}
            if i == 0 and caption is not None:
                item["caption"] = caption
            media.append(item)
            files[name] = photo
        data = {"chat_id": chat_id, "media": json.dumps(media)}
        return self._call(token, "sendMediaGroup", data, files=files)
