"""A credential must never survive into anything the worker logs — not the exception
message (already covered by test_redact.py and each client's own tests), and not the
exception CHAIN. Every client does `raise XAPIError(redact(...)) from exc`, and `exc`
(a real `requests` exception) embeds the raw credential in its own str(). Logging that
exception with `logger.exception(...)` (as run.py does) or letting it reach
`sys.excepthook` (as logging_setup.py installs) formats the WHOLE chain, traceback
included, into the log file — so the message alone being clean is not enough.

These tests exercise the real client -> real requests.ConnectionError -> real logger ->
real log file path, with no mocking of the redaction itself, so they only pass if the
fix is structural (a formatter/filter applied to every handler) rather than incidental.
"""

from __future__ import annotations

import logging

import pytest
import requests

from worker.discord_api import DiscordClient
from worker.logging_setup import configure_logging
from worker.telegram_api import TelegramClient
from worker.graph_api import GraphClient

DISCORD_SECRET = "super-secret-webhook-token-999"
TELEGRAM_SECRET = "111222333:AA-telegram-bot-secret-XYZ"
META_SECRET = "META-ACCESS-TOKEN-ABC123"


class _RaisingSession:
    """A requests.Session stand-in whose post/get always raise a real
    requests.ConnectionError, exactly like a DNS failure or refused connection would,
    with the request URL embedded in the exception's own str() — this is what actually
    happens with real `requests`, not a simulation of it."""

    def request(self, method, url, **kwargs):
        raise requests.ConnectionError(
            f"HTTPSConnectionPool: Max retries exceeded with url: {url} "
            f"(Caused by NewConnectionError('...'))"
        )

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)


@pytest.fixture
def worker_logger(tmp_path):
    logger = configure_logging(tmp_path / "logs", level=logging.DEBUG)
    yield logger, tmp_path / "logs" / "worker.log"


def _log_file_text(log_path) -> str:
    return log_path.read_text()


def test_discord_webhook_secret_never_reaches_log_via_exception_chain(worker_logger):
    logger, log_path = worker_logger
    client = DiscordClient(session=_RaisingSession())
    webhook_url = f"https://discord.com/api/webhooks/123456/{DISCORD_SECRET}"
    try:
        client.send_message(webhook_url, content="hi")
    except Exception:
        logger.exception("publish failed")

    text = _log_file_text(log_path)
    assert DISCORD_SECRET not in text, (
        "Discord webhook token leaked into the log via the exception chain"
    )


def test_telegram_bot_token_never_reaches_log_via_exception_chain(worker_logger):
    logger, log_path = worker_logger
    client = TelegramClient(session=_RaisingSession())
    try:
        client.get_me(TELEGRAM_SECRET)
    except Exception:
        logger.exception("preflight failed")

    text = _log_file_text(log_path)
    assert TELEGRAM_SECRET not in text, (
        "Telegram bot token leaked into the log via the exception chain"
    )


def test_meta_access_token_never_reaches_log_via_exception_chain(worker_logger):
    logger, log_path = worker_logger
    client = GraphClient(graph_version="v25.0", session=_RaisingSession())
    try:
        client.create_image_container("123", "https://example.com/a.jpg", META_SECRET)
    except Exception:
        logger.exception("publish failed")

    text = _log_file_text(log_path)
    assert META_SECRET not in text, (
        "Meta access_token leaked into the log via the exception chain"
    )


def test_excepthook_output_is_redacted(worker_logger, capsys):
    """sys.excepthook is the OTHER path a chained exception's traceback can reach the
    log through (an uncaught exception at the top of the daemon loop), and it must be
    scrubbed too, not just the logger.exception() path."""
    import sys

    logger, log_path = worker_logger
    client = TelegramClient(session=_RaisingSession())
    try:
        client.get_me(TELEGRAM_SECRET)
    except Exception:
        exc_type, exc, tb = sys.exc_info()
        sys.excepthook(exc_type, exc, tb)

    text = _log_file_text(log_path)
    assert TELEGRAM_SECRET not in text, (
        "Telegram bot token leaked into the log via sys.excepthook"
    )
