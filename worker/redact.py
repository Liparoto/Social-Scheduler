"""Shared credential redaction for text that might end up in an exception message, a
stored `publications.last_error`, or a rendered error banner in the dashboard.

Most clients in this worker embed their credential directly in the request URL: Meta's
`access_token` query parameter, Telegram's bot token in the URL path, Discord's webhook
URL which IS the credential. A network-layer failure (DNS failure, ConnectionError,
Timeout) raises an exception whose own `str()` embeds that URL verbatim — nothing in the
client code put it there on purpose, so nothing in the client code can be trusted to
catch every place it might leak back out. This module gives every client, and the
publisher's failure-recording path as defence in depth, one place to scrub known
credential shapes out of arbitrary text.

Two clients are the exception, carrying their token in a header or body instead of the
URL — see below.

Patterns handled:
  * access_token=<value>          (Meta Graph API query parameter)
  * EAA<value>                    (Meta access token, bare — the header-borne case below)
  * OAuth <value>                 (Meta Reels upload Authorization header, by prefix)
  * /bot<token>/                  (Telegram bot token, in the URL path)
  * .../webhooks/<id>/<token>     (Discord webhook URL — id kept, token redacted)
  * act.<value> / rft.<value>     (TikTok access and refresh tokens, by their prefix)
  * client_secret=/refresh_token= (TikTok credentials named in a form body or dict repr)

TikTok and the Meta Reels upload (worker/graph_api.py's `_post_rupload`) are the odd ones
out: their tokens travel in an Authorization header (and, for TikTok, a form body too)
rather than in the URL, so the URL-shaped patterns above never see them. TikTok's are
matched by their own `act.` / `rft.` prefixes, and by key name where the value carries no
recognisable shape at all — which is the case for the client secret, the one credential
that is the same for every channel on the install. Meta's Reels upload token is matched
by the `OAuth ` prefix its header uses, and independently by its own `EAA` prefix (Meta's
own marker for a User/Page access token) in case it ever turns up without that prefix —
e.g. echoed back inside a Meta error body.

Robust to the match being embedded inside a longer sentence (e.g. an exception message
like "ConnectionError: HTTPSConnectionPool(host=... url=/bot123:ABC/sendMessage ...)").
Safe on None/empty input — returns "" for falsy input.
"""

from __future__ import annotations

import re

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Meta: access_token=AAABBB... up to the next query-string separator, whitespace, or
    # closing quote/paren/bracket (so it doesn't eat trailing sentence punctuation).
    (re.compile(r"access_token=[^&\s\"')\]]+"), "access_token=<redacted>"),
    # Meta: the Reels upload phase (_post_rupload) sends the token in an
    # `Authorization: OAuth <token>` header rather than the URL. If a Meta error body
    # ever echoed that header back, this catches it by the "OAuth " prefix — kept in the
    # output for context, same as the Discord id is kept below.
    (re.compile(r"\bOAuth\s+\S{20,}"), "OAuth <redacted>"),
    # Meta: a bare access token by its own shape. EAA is Meta's own prefix for a
    # User/Page access token, so this catches one anywhere it turns up outside the
    # access_token= query param or an OAuth header — e.g. alone in a dict repr. The
    # 20-char floor keeps this from firing on short, unrelated strings that merely start
    # with EAA.
    (re.compile(r"\bEAA[A-Za-z0-9]{20,}"), "<redacted>"),
    # Telegram: the /bot<token>/ path segment. Token itself never contains a slash.
    (re.compile(r"/bot[^/\s]+/"), "/bot<redacted>/"),
    # Discord: .../webhooks/<id>/<token> — keep the id (harmless, useful for support),
    # redact only the token that follows it.
    (
        re.compile(r"(webhooks/\d+/)[^/\s\"'?)\]]+", re.IGNORECASE),
        r"\1<redacted>",
    ),
    # TikTok: prefixed tokens — act.* is an access token, rft.* a refresh token. The
    # {6,} floor on the body is what keeps ordinary prose from matching: "the worker
    # will act. Then it stops." has the prefix but no token after it. Six rather than
    # a longer floor because over-redacting a short token costs nothing, while
    # under-redacting one leaks it.
    (re.compile(r"\b(?:act|rft)\.[A-Za-z0-9_\-]{6,}"), "<redacted>"),
    # TikTok: credentials identified by KEY NAME rather than by the shape of the value,
    # for the ones that have no recognisable shape. client_secret is the reason this
    # exists — it is install-wide rather than per-channel, so leaking it is worse than
    # leaking any single token. Handles both `client_secret=value` (form body) and
    # `'client_secret': 'value'` (a dict repr in an exception message).
    (
        re.compile(
            r"(client_secret|refresh_token)(['\"]?\s*[:=]\s*['\"]?)[^&\s,\"')\]}]+",
            re.IGNORECASE,
        ),
        r"\1\2<redacted>",
    ),
]


def redact(text: str | None) -> str:
    """Scrub known credential shapes out of `text`. Safe on None/empty input."""
    if not text:
        return ""
    out = str(text)
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out
