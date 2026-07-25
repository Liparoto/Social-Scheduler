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
import re

import requests


class TelegramAPIError(Exception):
    """Raised when Telegram reports a failure. Never includes the bot token."""


_TOKEN_PATTERN = re.compile(r"/bot[^/]+/")


def _redact(url: str) -> str:
    """Replace the token segment of a Telegram API URL with a placeholder so it is safe
    to include in an exception message."""
    return _TOKEN_PATTERN.sub("/bot<redacted>/", url)


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
        resp = self.session.post(url, data=data, files=files, timeout=self.timeout)
        body = resp.json()
        if not resp.ok or not body.get("ok"):
            description = body.get("description", resp.text)
            raise TelegramAPIError(
                f"POST {_redact(url)} -> {resp.status_code}: {description}"
            )
        return body.get("result")

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
