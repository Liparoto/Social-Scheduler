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

from . import db, single_instance
from .clients import PLATFORM_CAPS, ClientRegistry, UnknownPlatform
from .config import Config, dry_run_active, kill_switch_active, load_env
from .logging_setup import configure_logging
from .redact import redact

# Imported eagerly, not lazily, so publisher's registry-vs-SUPPORTED_PLATFORMS asserts run
# at startup. Imported inside run_once instead, a mismatch surfaces only once the first
# batch runs, where run_forever's catch-all swallows it — the daemon then looks healthy
# while silently publishing nothing.
from . import publisher as _publisher_registry_check  # noqa: F401

_stop = False


def _request_stop(signum, _frame):
    global _stop
    _stop = True


def run_once(conn, config: Config, client, *, client_for=None, now=None, logger=None,
             sleep_fn=time.sleep, recover_all_claims: bool = False) -> int:
    """Process one batch of due publications. Returns how many were acted on.

    Respects the live kill switch (checked here AND between items, so flipping it
    mid-batch stops further publishing promptly).

    `recover_all_claims` skips the claim lease for this cycle — see the recovery block
    below. Opt-in, and False by default, so only a caller that has actually proved no
    other worker exists can turn it on.
    """
    # A channel's platform decides which Graph host to use (see clients.base_url_for).
    # Without a resolver (tests, --once with a single client) everything uses `client`.
    pick_client = client_for or (lambda _platform: client)

    load_env(override=True)  # pick up live edits to the switches

    now = now or datetime.now(timezone.utc)

    # Liveness first — the worker is "alive" whenever it polls, even if the kill switch is on
    # (alive != publishing). The dashboard reads this to know a queued refresh will be picked up.
    db.write_heartbeat(conn, now.isoformat())

    # Recover anything a previous worker claimed and never finished, BEFORE the kill
    # switch can return early. This writes no posts — it only moves an abandoned row out
    # of 'publishing', where nothing would ever look at it again. Running it above the
    # switch is deliberate: flipping the kill switch mid-send is one of the ways a row
    # gets stranded, so that is precisely when the operator needs to be told.
    #
    # On the first cycle of a fresh process the lease is skipped entirely. main() takes
    # the exclusive single-instance lock before any cycle runs, and the kernel releases
    # that lock when the holder dies however it dies — so a row still at 'publishing'
    # here provably belongs to no live worker, whatever its age. Waiting out the full
    # 30 minutes only kept a dead send looking healthy for another half hour, which is
    # exactly how a restart mid-send read as "stuck" with nothing to act on.
    #
    # Later cycles in the same process keep the lease, because then the row may genuinely
    # be in flight: a Reel holds 'publishing' through minutes of transcode polling, and
    # sweeping that one mid-send is how you publish twice.
    lease = 0 if recover_all_claims else config.publish_claim_lease_seconds
    stale = db.recover_stale_claims(conn, now.isoformat(), lease)
    if stale and logger:
        # WARNING, not info: each of these is a scheduled post that did not go out, and
        # may or may not be live on the platform. It should never scroll past unnoticed.
        for row in stale:
            logger.warning(
                "[publication %s] recovered from an abandoned publish and marked FAILED "
                "— check channel %s on the platform before retrying; it may already be live.",
                row["id"], row["channel_id"],
            )

    if kill_switch_active():
        if logger:
            logger.warning("KILL_SWITCH active — publishing nothing this cycle.")
        return 0

    dry_run = dry_run_active()

    # Keep channel queues topped up before publishing this cycle's due work.
    from .autofill import run_autofill

    run_autofill(conn, config, now, logger=logger)

    due = db.fetch_due_publications(conn, now.isoformat())
    if logger and due:
        logger.info("%d due publication(s)%s", len(due), " [DRY-RUN]" if dry_run else "")

    from .publisher import publish_one  # local import to keep module load light

    # Real publishes need a public URL Meta can download from, so open a short-lived
    # tunnel around the batch — but ONLY for the publications whose assets actually need
    # local serving. Assets that already carry an external public_url (the paste escape
    # hatch) publish with no tunnel at all. Dry-runs and idle cycles never open one.
    from contextlib import ExitStack

    from .tunnel import publish_endpoint

    def _pub_needs_tunnel(pub) -> bool:
        channel = db.get_channel(conn, pub["channel_id"])
        caps = PLATFORM_CAPS.get(channel["platform"]) if channel else None
        # Platforms that upload the file themselves never need a public URL — without this a
        # Discord image post would drag a cloudflared tunnel up for the whole batch.
        if caps is not None and caps.uploads_media_bytes:
            return False
        return any(
            not a["public_url"] for a in db.get_ordered_assets(conn, pub["post_id"])
        )

    tunnel_needed_ids = (
        {pub["id"] for pub in due if _pub_needs_tunnel(pub)} if not dry_run else set()
    )

    processed = 0
    with ExitStack() as stack:
        asset_base_url = None
        if tunnel_needed_ids:
            # Any failure here — cloudflared missing, port in use, subprocess spawn error —
            # must be VISIBLE and NON-FATAL. Flag only the publications that needed the
            # tunnel (leaving them scheduled to retry) and drop them from this batch; the
            # rest (external URL) still publish normally below.
            try:
                asset_base_url = stack.enter_context(publish_endpoint(config, logger=logger))
                logger and logger.info("publish endpoint up: %s", asset_base_url)
            except Exception as exc:  # noqa: BLE001 — deliberately broad; never crash the daemon
                if logger:
                    logger.error("publish endpoint unavailable: %s", exc)
                for pub in due:
                    if pub["id"] in tunnel_needed_ids:
                        db.update_publication(
                            conn, pub["id"],
                            last_error=redact(f"publish endpoint unavailable: {exc}"),
                            updated_at=now.isoformat(),
                        )
                due = [pub for pub in due if pub["id"] not in tunnel_needed_ids]

        for pub in due:
            load_env(override=True)
            if kill_switch_active():
                if logger:
                    logger.warning("KILL_SWITCH flipped mid-batch — stopping.")
                break
            channel = db.get_channel(conn, pub["channel_id"])
            try:
                pub_client = pick_client(channel["platform"]) if channel else client
            except UnknownPlatform:
                platform = channel["platform"] if channel else None
                from .publisher import _PUBLISHERS  # local import: keep module load light

                if platform in _PUBLISHERS:
                    # clients._BASE_URLS and publisher._PUBLISHERS disagree about this
                    # platform — that's a programming error (someone added the platform to
                    # one registry but not the other), NOT an unsupported channel. Falling
                    # back to `client` here would silently publish through whatever
                    # platform `client` happens to be built for (see main()), so fail this
                    # one publication loudly instead of guessing.
                    error = (
                        f"platform '{platform}' has a publisher but no base URL "
                        f"(clients._BASE_URLS and publisher._PUBLISHERS disagree) — "
                        f"fix the registries, this is a bug, not a missing adapter"
                    )
                    if logger:
                        logger.error("[pub %s] %s", pub["id"], error)
                    db.update_publication(
                        conn, pub["id"],
                        status="failed", attempt_count=pub["attempt_count"] + 1,
                        last_error=error, next_retry_at=None,
                        updated_at=now.isoformat(),
                    )
                    processed += 1
                    continue
                # No adapter for this platform at all. Hand it to publish_one anyway: it
                # validates the platform and marks this ONE publication terminally
                # failed, so the rest of the batch still goes out.
                pub_client = client
            publish_one(conn, pub, config, pub_client, dry_run=dry_run,
                        asset_base_url=asset_base_url, now=now,
                        logger=logger, sleep_fn=sleep_fn)
            processed += 1

    # Re-attempt first comments a human explicitly asked to retry from the dashboard.
    # AFTER the publish batch (a retry is never more urgent than getting posts out) and
    # inside the kill-switch guard above, since it posts to a live account.
    from .publisher import run_first_comment_retries

    run_first_comment_retries(
        conn, config, client, now, logger=logger, client_for=client_for,
        dry_run=dry_run, sleep_fn=sleep_fn,
    )

    # Refresh metrics for already-published posts (throttled per publication).
    from .metrics import run_metrics

    run_metrics(conn, config, client, now, logger=logger, client_for=client_for)

    # Learn whether delivered TikTok videos were ever actually published, and pick up the
    # public post id that admits them to the metrics loop above. Read-only against TikTok,
    # so like avatars it runs in dry-run mode too. Placed AFTER run_metrics so a post id
    # recorded here is acted on by the next cycle rather than the same one — metrics are
    # never so urgent that they justify reasoning about ordering within a cycle.
    from .tiktok_watcher import run_tiktok_watcher

    run_tiktok_watcher(conn, config, client, now, logger=logger, client_for=client_for)

    # Refresh channel avatars (throttled per channel, ~weekly). Read-only against the
    # platform, so it runs in dry-run mode too — it publishes nothing.
    from .avatars import run_avatars

    run_avatars(conn, config, client, now, logger=logger, client_for=client_for)

    # Mirror each account's own post list into remote_media, so the Insights hub covers
    # everything on the account rather than only what this tool published. Read-only, so
    # like avatars it runs in dry-run mode too, and it goes LAST: publishing this cycle's
    # due work always matters more than metrics freshness, and this job is the one that
    # can spend a large number of API calls.
    from .media_sync import run_media_sync

    run_media_sync(conn, config, client, now, logger=logger, client_for=client_for)

    # Then the account-level series and per-post insights that hang off what it found.
    # Order matters: a post has to exist in remote_media before it can be given metrics.
    from .account_metrics import run_account_metrics
    from .media_metrics import run_media_metrics

    run_account_metrics(conn, config, client, now, logger=logger, client_for=client_for)
    run_media_metrics(conn, config, client, now, logger=logger, client_for=client_for)

    # Cache leaderboard thumbnails last: it is the least important job here, and the one
    # whose failure matters least — a missing thumbnail is decoration, a missing metric
    # is data.
    from .thumbnails import run_thumbnails

    run_thumbnails(conn, config, client, now, logger=logger, client_for=client_for)
    return processed


def run_forever(config: Config, client, logger, *, client_for=None) -> None:
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)
    conn = db.connect(config.database_path)
    logger.info("Worker started. DB=%s poll=%ss", config.database_path, config.poll_interval)
    # The first cycle of this process recovers claims abandoned by a previous one without
    # waiting out the lease — see run_once. Cleared after the first attempt whether or not
    # it raised: the recovery step runs before anything that can throw, so a cycle that
    # failed later has still done it, and repeating it would apply lease-free recovery to
    # a row this process may legitimately have in flight.
    first_cycle = True
    try:
        while not _stop:
            # Defense in depth: a bug or unexpected error in one cycle must never take the
            # daemon down. Log it and keep polling — the kill switch is the only stop.
            try:
                run_once(conn, config, client, client_for=client_for, logger=logger,
                         recover_all_claims=first_cycle)
            except Exception:  # noqa: BLE001
                logger.exception("run_once failed; continuing to next cycle")
            first_cycle = False
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

    # One worker per install, before anything else touches the database or the network.
    # Applies to --once as well as the daemon: a cron'd --once alongside a running daemon
    # is the same two-worker situation, just harder to notice.
    lock_path = config.database_path.parent / "run" / "worker.lock"
    try:
        single_instance.acquire(lock_path)
    except single_instance.AlreadyRunning as exc:
        # Exit 0, deliberately. The autostart agent restarts on a NON-zero exit, so
        # failing here with an error code would spin: launchd would keep relaunching a
        # worker that keeps correctly refusing to run. "Another worker is already
        # running" is a success condition for the guard — the install ends up with
        # exactly one worker, which is the point.
        logger.warning("Not starting: %s. This install already has a worker.", exc)
        return 0

    registry = ClientRegistry(config)
    # Fallback for code paths that don't know a platform yet; every publication and
    # metrics fetch re-resolves its own client from the channel's platform below.
    client = registry.for_platform("instagram")

    if "--once" in sys.argv:
        conn = db.connect(config.database_path)
        try:
            # A --once run is its own fresh process holding the same exclusive lock (the
            # guard above already refused to start alongside a daemon), so it is a first
            # cycle in exactly the sense run_once means.
            n = run_once(conn, config, client, client_for=registry.for_platform,
                         logger=logger, recover_all_claims=True)
            logger.info("Processed %d publication(s).", n)
        finally:
            conn.close()
        return 0

    run_forever(config, client, logger, client_for=registry.for_platform)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
