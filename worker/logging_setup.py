"""Logging for the worker.

IMPORTANT (per project debugging rules): a script that logs to a file must NOT let
unhandled crashes vanish. Python sends uncaught tracebacks to stderr, so if we only
capture stdout the log can cut off with no error. Here we install a sys.excepthook
that routes uncaught exceptions (including their full traceback) into the same log,
so a crash is always recorded, not silently swallowed.
"""

from __future__ import annotations

import logging
import sys
import traceback
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOGGER_NAME = "socialscheduler"


def configure_logging(log_dir: Path, level: int = logging.INFO) -> logging.Logger:
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(level)
    logger.handlers.clear()

    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")

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
            "".join(traceback.format_exception(exc_type, exc, tb)),
        )

    sys.excepthook = _excepthook
    return logger
