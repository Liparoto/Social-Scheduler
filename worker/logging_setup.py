"""Logging for the worker.

IMPORTANT (per project debugging rules): a script that logs to a file must NOT let
unhandled crashes vanish. Python sends uncaught tracebacks to stderr, so if we only
capture stdout the log can cut off with no error. Here we install a sys.excepthook
that routes uncaught exceptions (including their full traceback) into the same log,
so a crash is always recorded, not silently swallowed.

Credential safety: every API client's raised errors carry a clean, already-redacted
message, but the exception CHAIN (``__cause__``/``__context__``) can still hold the
original `requests` exception, whose own str() embeds the request URL — the credential
itself for Discord (webhook URL) and Telegram (bot token in the path), and the
access_token query param for Meta. `logger.exception(...)` and this module's
`sys.excepthook` both format that whole chain into a traceback string and write it to
disk, so relying on every call site to remember to pre-redact is not durable — a single
handler installed here, applied to every formatted record (message AND traceback), is
the one place that can make the guarantee hold regardless of which code path logged it.
"""

from __future__ import annotations

import logging
import sys
import traceback
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .redact import redact

LOGGER_NAME = "socialscheduler"


class _RedactingFormatter(logging.Formatter):
    """Scrubs credential shapes out of both the formatted message and the traceback.

    A logging.Filter can rewrite `record.msg`/`record.args`, but `record.exc_text` (the
    cached, pre-rendered traceback string) is populated by Formatter.format() itself —
    a filter runs before that and would never see it. Subclassing the formatter instead
    means we scrub the fully-assembled string (message + traceback) right before it
    leaves this process, which is the only point both pieces are guaranteed present.
    """

    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


def configure_logging(log_dir: Path, level: int = logging.INFO) -> logging.Logger:
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(level)
    logger.handlers.clear()

    fmt = _RedactingFormatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")

    file_handler = RotatingFileHandler(
        log_dir / "worker.log", maxBytes=2_000_000, backupCount=5
    )
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    logger.addHandler(console)

    def _excepthook(exc_type, exc, tb):
        logger.critical(
            "Uncaught exception:\n%s",
            redact("".join(traceback.format_exception(exc_type, exc, tb))),
        )

    sys.excepthook = _excepthook
    return logger
