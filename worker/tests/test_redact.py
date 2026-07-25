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
