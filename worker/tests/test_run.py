"""Tests for the poll loop: due-selection, dry-run wiring, and the kill switch."""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

from worker import db
from worker.run import run_once

NOW = datetime(2026, 7, 22, 18, 0, 0, tzinfo=timezone.utc)


def test_run_once_processes_due_in_dry_run(conn, config, fake_client, make_publication, monkeypatch):
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "1")
    # Make load_env(override=True) a no-op so our monkeypatched env is authoritative.
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    n = run_once(conn, config, fake_client, now=NOW)

    assert n == 1
    assert fake_client.calls == []  # dry-run: nothing sent
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"
    assert row["is_dry_run"] == 1


def test_run_once_halts_when_kill_switch_active(conn, config, fake_client, make_publication, monkeypatch):
    monkeypatch.setenv("KILL_SWITCH", "1")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    n = run_once(conn, config, fake_client, now=NOW)

    assert n == 0
    assert fake_client.calls == []  # published nothing
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "scheduled"  # untouched


def test_run_once_skips_future_and_backed_off(conn, config, fake_client, make_publication, monkeypatch):
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "1")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    # scheduled 10 minutes in the FUTURE -> not due yet
    make_publication(post_type="single", n_assets=1, scheduled_offset_min=10, now=NOW)
    n = run_once(conn, config, fake_client, now=NOW)
    assert n == 0


def test_run_once_tunnel_unavailable_is_visible_not_fatal(conn, config, fake_client, make_publication, monkeypatch):
    """A local asset needs the tunnel; if cloudflared is missing the daemon must NOT
    crash — it records a visible reason and leaves the publication scheduled to retry."""
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    # public_url=None -> asset must be served via the tunnel; force a missing binary.
    cfg = dataclasses.replace(config, cloudflared_path="cloudflared-not-installed-xyz")
    pub = make_publication(post_type="single", n_assets=1, public_url=None, now=NOW)

    n = run_once(conn, cfg, fake_client, now=NOW)  # must not raise

    assert n == 0
    assert fake_client.calls == []  # nothing published
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "scheduled"  # still queued -> will retry
    assert "endpoint unavailable" in (row["last_error"] or "")


def test_run_once_blocked_tunnel_defers_instead_of_failing(conn, config, fake_client, make_publication, monkeypatch):
    """cloudflared INSTALLED but unable to reach Cloudflare — the real-world case.

    A filtering VPN, DNS filter, or firewall blocks trycloudflare.com, so no tunnel
    exists. Regression test: cloudflared names api.trycloudflare.com in its failure line,
    the worker mistook that for a live tunnel, published to it, and Meta rejected the
    fetch — burning every retry until the post died at 'failed'. It must defer instead.
    """
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    blocked = (
        "2026-08-09T00:05:59Z INF Requesting new quick Tunnel on trycloudflare.com...\n"
        'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": '
        "dial tcp: lookup api.trycloudflare.com: no such host\n"
    )

    class _FakeProc:
        def __init__(self) -> None:
            self.stdout = iter(blocked.splitlines(keepends=True))

        def poll(self):
            return None

        def terminate(self):
            pass

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr("worker.tunnel.resolve_binary", lambda *a, **k: "/usr/bin/fake")
    monkeypatch.setattr("worker.tunnel._doh_has_answer", lambda host: True)
    monkeypatch.setattr("worker.tunnel.subprocess.Popen", lambda *a, **k: _FakeProc())

    pub = make_publication(post_type="single", n_assets=1, public_url=None, now=NOW)

    n = run_once(conn, config, fake_client, now=NOW)  # must not raise

    assert n == 0
    assert fake_client.calls == []  # nothing reached the platform
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "scheduled"  # deferred, NOT failed
    assert row["attempt_count"] == 0  # a blocked network must not burn a retry
    # The recorded reason has to be actionable without reading any code.
    assert "trycloudflare.com" in (row["last_error"] or "")
    assert "retried" in (row["last_error"] or "")


def test_run_once_stamps_heartbeat(conn, config, fake_client, monkeypatch):
    """Every poll records the worker's liveness for the dashboard to read."""
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "1")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    assert conn.execute("SELECT COUNT(*) FROM worker_heartbeat").fetchone()[0] == 0
    run_once(conn, config, fake_client, now=NOW)

    row = conn.execute("SELECT id, last_seen_at FROM worker_heartbeat").fetchone()
    assert row["id"] == 1
    assert row["last_seen_at"] == NOW.isoformat()


def test_run_once_stamps_heartbeat_even_when_kill_switch_active(conn, config, fake_client, monkeypatch):
    """The worker is alive whenever it polls — the heartbeat updates even with the kill
    switch on (alive != publishing), so the dashboard shows it online during an e-stop."""
    monkeypatch.setenv("KILL_SWITCH", "1")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    n = run_once(conn, config, fake_client, now=NOW)
    assert n == 0  # published nothing
    row = conn.execute("SELECT last_seen_at FROM worker_heartbeat").fetchone()
    assert row["last_seen_at"] == NOW.isoformat()  # but still stamped alive


def test_run_once_external_url_publishes_without_tunnel(conn, config, fake_client, make_publication, monkeypatch):
    """An asset with an external public_url must publish even when cloudflared is absent —
    no tunnel is opened for the paste escape hatch."""
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    cfg = dataclasses.replace(config, cloudflared_path="cloudflared-not-installed-xyz")
    pub = make_publication(post_type="single", n_assets=1,
                           public_url="https://cdn.example/a.jpg", now=NOW)

    n = run_once(conn, cfg, fake_client, now=NOW)

    assert n == 1
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"


# ---- first-cycle recovery of an orphaned claim ----------------------------------------
# The kill switch is ON in these: recovery deliberately runs ABOVE that check (see
# run_once), so leaving it on isolates the recovery step from autofill, publishing and
# every metrics job.
def _orphaned_claim(conn, make_publication, claimed_at):
    """A row a previous process claimed and never finished."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    db.update_publication(conn, pub["id"], status="publishing",
                          updated_at=claimed_at.isoformat())
    return pub["id"]


def test_first_cycle_recovers_a_claim_orphaned_seconds_ago(
    conn, config, fake_client, make_publication, monkeypatch
):
    """The real failure this fixes: a worker restarted mid-send, leaving the row at
    'publishing' where fetch_due_publications never looks. The old code waited out the
    full 30-minute lease before saying so, and the send just sat there looking fine.

    A fresh process holds the exclusive single-instance lock before any cycle runs, so on
    its first cycle nothing else can own this row — it is abandoned, whatever its age.
    """
    monkeypatch.setenv("KILL_SWITCH", "1")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)
    pub_id = _orphaned_claim(conn, make_publication, NOW - timedelta(seconds=5))

    run_once(conn, config, fake_client, now=NOW, recover_all_claims=True)

    row = conn.execute("SELECT * FROM publications WHERE id=?", (pub_id,)).fetchone()
    assert row["status"] == "failed"
    assert "may or may not have reached the platform" in row["last_error"]
    # Never re-queued: the post may already be live, so a human decides.
    assert row["next_retry_at"] is None


def test_a_later_cycle_leaves_a_recent_claim_alone(
    conn, config, fake_client, make_publication, monkeypatch
):
    """The dangerous direction, and why this is first-cycle-only. Later cycles in the same
    process keep the full lease: a Reel legitimately holds 'publishing' for minutes of
    transcode polling, and sweeping it mid-send is how you publish twice."""
    monkeypatch.setenv("KILL_SWITCH", "1")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)
    pub_id = _orphaned_claim(conn, make_publication, NOW - timedelta(seconds=5))

    run_once(conn, config, fake_client, now=NOW, recover_all_claims=False)

    row = conn.execute("SELECT status FROM publications WHERE id=?", (pub_id,)).fetchone()
    assert row["status"] == "publishing"


def test_run_once_defaults_to_the_full_lease(
    conn, config, fake_client, make_publication, monkeypatch
):
    """Recovering everything is opt-in. A caller that says nothing gets the conservative
    behaviour, so only the paths that have actually proved exclusivity skip the lease."""
    monkeypatch.setenv("KILL_SWITCH", "1")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)
    pub_id = _orphaned_claim(conn, make_publication, NOW - timedelta(seconds=5))

    run_once(conn, config, fake_client, now=NOW)

    row = conn.execute("SELECT status FROM publications WHERE id=?", (pub_id,)).fetchone()
    assert row["status"] == "publishing"
