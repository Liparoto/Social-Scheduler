"""Unit tests for the shared credential redactor.

Each client embeds its credential in the request URL (Meta's access_token query param,
Telegram's bot token in the URL path, Discord's webhook URL itself), so a network-layer
exception's own str() can leak it verbatim. worker.redact.redact() is the one place that
scrubs those shapes back out before the text is raised, stored, or displayed.
"""

from worker.redact import redact


def test_none_is_safe():
    assert redact(None) == ""


def test_empty_string_is_safe():
    assert redact("") == ""


def test_meta_access_token_query_param_is_redacted():
    text = "GET https://graph.facebook.com/v25.0/123/media?access_token=EAABsbCS1iHgBO up to here"
    out = redact(text)
    assert "EAABsbCS1iHgBO" not in out
    assert "access_token=<redacted>" in out


def test_meta_access_token_stops_at_next_query_param():
    text = "...?fields=status_code&access_token=SECRET123&extra=1"
    out = redact(text)
    assert "SECRET123" not in out
    assert "&extra=1" in out


def test_telegram_bot_token_path_segment_is_redacted():
    text = "POST https://api.telegram.org/bot123456:ABC-DEF-super-secret-token/sendMessage -> 200"
    out = redact(text)
    assert "123456:ABC-DEF-super-secret-token" not in out
    assert "/bot<redacted>/sendMessage" in out


def test_discord_webhook_token_is_redacted_but_id_kept():
    text = "ConnectionError calling https://discord.com/api/webhooks/998877/super-secret-token"
    out = redact(text)
    assert "super-secret-token" not in out
    assert "998877" in out  # id kept — harmless, useful for support
    assert "webhooks/998877/<redacted>" in out


def test_useful_context_around_match_survives():
    text = "ConnectionError: failed to reach Telegram API at /bot123:ABC/sendMessage"
    out = redact(text)
    assert "ConnectionError" in out
    assert "Telegram API" in out
    assert "123:ABC" not in out


def test_multiple_credential_shapes_in_one_string_are_all_redacted():
    text = (
        "batch failure: "
        "https://graph.facebook.com/v25.0/x?access_token=METASECRET, "
        "https://api.telegram.org/bot111:TGSECRET/sendMessage, "
        "https://discord.com/api/webhooks/5555/DISCSECRET"
    )
    out = redact(text)
    assert "METASECRET" not in out
    assert "TGSECRET" not in out
    assert "DISCSECRET" not in out
    assert "access_token=<redacted>" in out
    assert "/bot<redacted>/sendMessage" in out
    assert "webhooks/5555/<redacted>" in out


# ---- Meta: header-borne token (Reels upload, _post_rupload) ---------------------------
# _post_rupload sends the token in an `Authorization: OAuth <token>` header rather than
# the URL, so the access_token=<value> pattern above never sees it. If a Meta error body
# ever echoed that header back, these two patterns are the backstop.


def test_redacts_meta_oauth_authorization_header():
    out = redact("headers={'Authorization': 'OAuth EAAAbCdEfGh1234567890XYZsecret'}")
    assert "EAAAbCdEfGh1234567890XYZsecret" not in out
    assert "OAuth <redacted>" in out


def test_redacts_a_bare_meta_access_token():
    # No "access_token=" or "OAuth " in front of it at all — just the token by its own
    # EAA prefix, the way it might turn up alone in a dict repr or an echoed body.
    out = redact("caught raw body: token EAAAbCdEfGh1234567890XYZsecret here")
    assert "EAAAbCdEfGh1234567890XYZsecret" not in out
    assert "<redacted>" in out


def test_meta_bare_token_pattern_does_not_eat_ordinary_prose():
    # "EAA" alone, not followed by 20+ more token characters, must survive untouched.
    text = "the EAA meeting is at 3pm"
    assert redact(text) == text


def test_oauth_header_redaction_stops_before_json_closing_delimiters():
    # The token sits hard against the JSON string's closing quote and the dict's closing
    # brace, with no whitespace in between. A bare \S{20,} body would swallow both,
    # corrupting the redacted output; the delimiters must survive untouched.
    out = redact('headers={"Authorization": "OAuth EAAAbCdEfGh1234567890XYZsecret"}')
    assert "EAAAbCdEfGh1234567890XYZsecret" not in out
    assert 'OAuth <redacted>"}' in out


def test_oauth_prose_mention_is_not_redacted():
    # "OAuth " followed by ordinary prose, not a token, must survive untouched — the
    # pattern requires a plausible Facebook token (EAA-prefixed) after the prefix.
    text = "see the OAuth 2.0-authorization-code-flow docs"
    assert redact(text) == text


# ---- TikTok ---------------------------------------------------------------------------
# TikTok's tokens are prefixed (act.* / rft.*) and travel in an Authorization header or a
# form body rather than the URL, so they leak through a different door than Meta's — but
# the same door an exception message opens.


def test_redacts_a_tiktok_access_token_in_a_bearer_header():
    out = redact("headers={'Authorization': 'Bearer act.abc123DEF456ghi'}")
    assert "act.abc123DEF456ghi" not in out
    assert "<redacted>" in out


def test_redacts_a_tiktok_refresh_token_in_a_form_body():
    out = redact("data={'grant_type': 'refresh_token', 'refresh_token': 'rft.xyz789GHI012'}")
    assert "rft.xyz789GHI012" not in out


def test_redacts_a_tiktok_client_secret_by_key_name():
    out = redact("client_secret=aBcDeF123456 &grant_type=refresh_token")
    assert "aBcDeF123456" not in out


def test_tiktok_redaction_keeps_the_surrounding_sentence_readable():
    out = redact(
        "POST /v2/oauth/token/ -> 200: invalid_grant: token rft.7hK2mQ9xTz is revoked"
    )
    assert "invalid_grant" in out
    assert "rft.7hK2mQ9xTz" not in out


def test_tiktok_patterns_do_not_eat_ordinary_prose():
    # "act." at the start of a word is common English ("act. Then..."); the pattern must
    # require a token-shaped body, not just the prefix.
    assert redact("the worker will act. Then it stops.") == "the worker will act. Then it stops."
