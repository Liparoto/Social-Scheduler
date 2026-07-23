"""Worker daemon: poll the DB for due publications and publish them.

    python3 -m worker.run           # run forever, polling every WORKER_POLL_INTERVAL
    python3 -m worker.run --once    # process one batch and exit (handy for testing/cron)

Safety:
  * KILL_SWITCH=1 (checked live every iteration) -> publish nothing, keep looping idle.
  * DRY_RUN=1 (checked live) -> log intended posts, publish nothing.
  * SIGINT/SIGTERM -> finish the current publication, then exit cleanly.
"""

from __future__ import annotations

import signal
import sys
import time
from datetime import datetime, timezone

from . import db
from .config import Config, dry_run_active, kill_switch_active, load_env
from .graph_api import GraphClient
from .logging_setup import configure_logging

_stop = False


def _request_stop(signum, _frame):
    global _stop
    _stop = True


def run_once(conn, config: Config, client, *, now=None, logger=None, sleep_fn=time.sleep) -> int:
    """Process one batch of due publications. Returns how many were acted on.

    Respects the live kill switch (checked here AND between items, so flipping it
    mid-batch stops further publishing promptly).
    """
    load_env(override=True)  # pick up live edits to the switches
    if kill_switch_active():
        if logger:
            logger.warning("KILL_SWITCH active — publishing nothing this cycle.")
        return 0

    now = now or datetime.now(timezone.utc)
    dry_run = dry_run_active()

    # Keep channel queues topped up before publishing this cycle's due work.
    from .autofill import run_autofill

    run_autofill(conn, config, now, logger=logger)

    due = db.fetch_due_publications(conn, now.isoformat())
    if logger and due:
        logger.info("%d due publication(s)%s", len(due), " [DRY-RUN]" if dry_run else "")

    from .publisher import publish_one  # local import to keep module load light

    processed = 0
    for pub in due:
        load_env(override=True)
        if kill_switch_active():
            if logger:
                logger.warning("KILL_SWITCH flipped mid-batch — stopping.")
            break
        publish_one(conn, pub, config, client, dry_run=dry_run, now=now,
                    logger=logger, sleep_fn=sleep_fn)
        processed += 1

    # Refresh metrics for already-published posts (throttled per publication).
    from .metrics import run_metrics

    run_metrics(conn, config, client, now, logger=logger)
    return processed


def run_forever(config: Config, client, logger) -> None:
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)
    conn = db.connect(config.database_path)
    logger.info("Worker started. DB=%s poll=%ss", config.database_path, config.poll_interval)
    try:
        while not _stop:
            run_once(conn, config, client, logger=logger)
            for _ in range(config.poll_interval):
                if _stop:
                    break
                time.sleep(1)
    finally:
        conn.close()
        logger.info("Worker stopped.")


def main() -> int:
    config = Config.from_env()
    logger = configure_logging(config.database_path.parent / "logs")
    client = GraphClient(config.graph_version)

    if "--once" in sys.argv:
        conn = db.connect(config.database_path)
        try:
            n = run_once(conn, config, client, logger=logger)
            logger.info("Processed %d publication(s).", n)
        finally:
            conn.close()
        return 0

    run_forever(config, client, logger)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
