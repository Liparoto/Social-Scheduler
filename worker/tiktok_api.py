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

import requests

from .redact import redact

OAUTH_TOKEN_PATH = "/v2/oauth/token/"
USER_INFO_PATH = "/v2/user/info/"


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
