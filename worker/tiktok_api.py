"""TikTok Content Posting + Display API client.

Three properties of this API drive the shape below:

1. **The body is the success signal.** Every response carries an `error` object, and a
   failure arrives as HTTP 200 with `error.code != "ok"`. Checking `resp.ok` alone silently
   treats a rejection as a success — the same trap Telegram's `ok` field sets.
2. **The OAuth endpoint is form-encoded**, not JSON, and it is the only call that carries
   the client secret, so it is the one whose errors most need redacting.
3. **Refresh tokens rotate.** Every refresh returns a new one and invalidates the old.

Conventions shared with every other client here: raise on failure, never interpolate a
credential into a message, and own no retry logic — the publisher owns retries.
"""

from __future__ import annotations

import math
from pathlib import Path

import requests

from .redact import redact

OAUTH_TOKEN_PATH = "/v2/oauth/token/"
USER_INFO_PATH = "/v2/user/info/"
INBOX_INIT_PATH = "/v2/post/publish/inbox/video/init/"
STATUS_PATH = "/v2/post/publish/status/fetch/"
VIDEO_QUERY_PATH = "/v2/video/query/"

MB = 1024 * 1024
MIN_CHUNK_BYTES = 5 * MB
MAX_CHUNK_BYTES = 64 * MB
MAX_FINAL_CHUNK_BYTES = 128 * MB


def plan_chunks(video_size: int) -> tuple[int, int]:
    """(chunk_size, total_chunk_count) for a FILE_UPLOAD.

    TikTok's rules: a chunk is 5-64 MB, there may be 1-1000 of them, and the FINAL chunk
    carries the remainder (up to 128 MB). A whole file under 5 MB is a legal single chunk —
    the 5 MB floor governs the chunks of a split upload, not a file that fits in one.

    The remainder is folded into the last chunk rather than sent as a chunk of its own,
    because a trailing chunk below the 5 MB floor is rejected. That is the failure this
    function exists to prevent, and it is why the count is derived here rather than by the
    upload loop: TikTok is told total_chunk_count up front and refuses an upload that then
    sends a different number.
    """
    if video_size <= MAX_CHUNK_BYTES:
        return video_size, 1
    count = math.ceil(video_size / MAX_CHUNK_BYTES)
    chunk = video_size // count
    if chunk < MIN_CHUNK_BYTES:
        # Unreachable for any real file (it would need over 1000 chunks), but the floor is
        # a TikTok rule rather than an assumption, so it is enforced rather than trusted.
        chunk = MIN_CHUNK_BYTES
        count = max(1, video_size // chunk)
    return chunk, count


class TikTokAPIError(Exception):
    """TikTok reported a failure, or the request failed at the network layer.
    Never contains a client secret, access token or refresh token."""


class TikTokClient:
    def __init__(
        self,
        base_url: str = "https://open.tiktokapis.com",
        session: requests.Session | None = None,
        timeout: int = 60,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout

    # ---- plumbing -------------------------------------------------------------------
    @staticmethod
    def _body(resp, what: str) -> dict:
        """Parse and validate a response. `what` names the call WITHOUT its credentials."""
        try:
            body = resp.json()
        except ValueError:
            # A non-JSON response (an HTML 502 from an intermediary, say) must not escape
            # as a raw JSONDecodeError — the invariant is that only TikTokAPIError leaves
            # this client.
            raise TikTokAPIError(
                f"{what} -> {resp.status_code}: non-JSON response: {redact(resp.text)[:200]}"
            ) from None
        error = body.get("error") or {}
        # "ok" is TikTok's success code. An absent error object is treated as success too:
        # some Display responses omit it entirely.
        code = error.get("code", "ok")
        if code != "ok" or not resp.ok:
            raise TikTokAPIError(
                f"{what} -> {resp.status_code}: {code}: "
                f"{redact(str(error.get('message', resp.text)))[:300]} "
                f"(log_id={error.get('log_id')})"
            )
        return body

    def _post_form(self, path: str, data: dict, what: str) -> dict:
        url = f"{self.base_url}{path}"
        try:
            resp = self.session.post(
                url,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            # `from None`, not `from exc`: the redacted message already carries everything
            # useful, and exc's own str() must never survive into a traceback via
            # __cause__ where it could carry the request back out. Same rule as the
            # Discord and Telegram clients.
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what)

    def _post_json(self, path: str, access_token: str, payload: dict, what: str) -> dict:
        url = f"{self.base_url}{path}"
        try:
            resp = self.session.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json; charset=UTF-8",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what)

    # ---- OAuth ----------------------------------------------------------------------
    def exchange_code(
        self, client_key: str, client_secret: str, code: str, redirect_uri: str,
        code_verifier: str,
    ) -> dict:
        """Authorization code -> tokens. PKCE is mandatory for Desktop-type apps, which is
        the app type this project registers (it is what allows an http://localhost
        redirect at all)."""
        return self._post_form(
            OAUTH_TOKEN_PATH,
            {
                "client_key": client_key,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
            "POST /v2/oauth/token/ (exchange)",
        )

    def refresh_access_token(
        self, client_key: str, client_secret: str, refresh_token: str
    ) -> dict:
        """Access tokens last 24h. The returned refresh_token REPLACES the one sent —
        storing it is what keeps the channel alive."""
        return self._post_form(
            OAUTH_TOKEN_PATH,
            {
                "client_key": client_key,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            "POST /v2/oauth/token/ (refresh)",
        )

    # ---- Display --------------------------------------------------------------------
    def get_user_info(self, access_token: str, fields=("open_id", "display_name")) -> dict:
        """Read-only identity call. Used by preflight: proves the token works and names the
        account without posting anything."""
        url = f"{self.base_url}{USER_INFO_PATH}"
        what = "GET /v2/user/info/"
        try:
            resp = self.session.get(
                url,
                params={"fields": ",".join(fields)},
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what).get("data", {}).get("user", {})

    # ---- Content Posting: inbox delivery --------------------------------------------
    def init_inbox_video(
        self, access_token: str, video_size: int, chunk_size: int, total_chunk_count: int
    ) -> dict:
        """Open an upload session and get back a publish_id and a signed upload URL.

        There is no post_info here. The inbox endpoint accepts the file and nothing else —
        no caption, no privacy level — because the creator completes the post inside the
        TikTok app and writes the caption there. See the spec's Decision 9.
        """
        body = self._post_json(
            INBOX_INIT_PATH,
            access_token,
            {
                "source_info": {
                    "source": "FILE_UPLOAD",
                    "video_size": video_size,
                    "chunk_size": chunk_size,
                    "total_chunk_count": total_chunk_count,
                }
            },
            "POST /v2/post/publish/inbox/video/init/",
        )
        return body.get("data", {})

    def upload_chunk(
        self, upload_url: str, chunk: bytes, *, start: int, end: int, total: int,
        mime: str = "video/mp4",
    ) -> None:
        """One PUT. `end` is INCLUSIVE, per RFC 7233 — an off-by-one is rejected."""
        try:
            resp = self.session.put(
                upload_url,
                data=chunk,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{total}",
                    "Content-Type": mime,
                },
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(
                f"PUT upload chunk {start}-{end} -> request failed: {redact(str(exc))}"
            ) from None
        if not resp.ok:
            # The upload URL is a SIGNED url — anyone holding it can PUT to this session,
            # so it is a credential and never belongs in a message. Same rule as Discord's
            # webhook URL.
            raise TikTokAPIError(
                f"PUT upload chunk {start}-{end} -> {resp.status_code}: "
                f"{redact(resp.text)[:200]}"
            )

    def upload_video_file(self, upload_url: str, path, *, chunk_size: int) -> None:
        """Stream the file up in sequential chunks.

        Reads one chunk at a time rather than the whole file: a converted 4K clip can be
        several hundred MB, and this runs on the owner's laptop alongside everything else.

        The chunking here must agree with plan_chunks — a short remainder is folded into
        the final chunk rather than sent alone, or TikTok rejects both the undersized chunk
        and the mismatched count.
        """
        path = Path(path)
        total = path.stat().st_size
        sent = 0
        with path.open("rb") as fh:
            while sent < total:
                remaining = total - sent
                size = chunk_size if remaining - chunk_size >= chunk_size else remaining
                data = fh.read(size)
                if not data:
                    break
                self.upload_chunk(
                    upload_url, data, start=sent, end=sent + len(data) - 1, total=total
                )
                sent += len(data)

    def fetch_publish_status(self, access_token: str, publish_id: str) -> dict:
        """Where an upload got to. Statuses seen here: PROCESSING_UPLOAD /
        PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX (delivered — this platform's "done"),
        PUBLISH_COMPLETE, FAILED.

        `publicaly_available_post_id` (TikTok's own misspelling — do not "fix" it) appears
        only once a post is public AND through moderation, which is what makes its arrival
        proof that the creator published the video.
        """
        body = self._post_json(
            STATUS_PATH, access_token, {"publish_id": publish_id},
            "POST /v2/post/publish/status/fetch/",
        )
        return body.get("data", {})

    # ---- Display: metrics ------------------------------------------------------------
    def query_videos(self, access_token: str, video_ids, fields) -> list[dict]:
        """Metadata for specific videos. Up to 20 ids per request; needs the video.list
        scope."""
        url = f"{self.base_url}{VIDEO_QUERY_PATH}"
        what = "POST /v2/video/query/"
        try:
            resp = self.session.post(
                url,
                params={"fields": ",".join(fields)},
                json={"filters": {"video_ids": list(video_ids)}},
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json; charset=UTF-8",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what).get("data", {}).get("videos", [])
