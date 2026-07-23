"""Tests for the poll loop: due-selection, dry-run wiring, and the kill switch."""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

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
