"""Tests for how the worker locates cloudflared at publish time.

The fallback to this install's own copy under data/bin is what lets a fresh clone
publish without anyone installing anything by hand — and returning an ABSOLUTE path is
what lets the launchd-managed worker find it at all, since launchd runs the worker with
a minimal PATH that excludes Homebrew.
"""

from __future__ import annotations

from pathlib import Path

from worker.cloudflared_setup import vendored_path

from worker.tunnel import resolve_binary


def test_configured_name_on_the_path_wins(tmp_path, monkeypatch):
    """An existing system install keeps being used — we don't override someone's setup."""
    monkeypatch.setattr("worker.tunnel.shutil.which", lambda name: "/opt/homebrew/bin/cloudflared")

    assert resolve_binary("cloudflared", tmp_path) == "/opt/homebrew/bin/cloudflared"


def test_an_explicit_path_is_honored_even_when_not_on_the_path(tmp_path, monkeypatch):
    """CLOUDFLARED_PATH pointing at a literal file must still work."""
    monkeypatch.setattr("worker.tunnel.shutil.which", lambda name: None)
    custom = tmp_path / "somewhere" / "cloudflared"
    custom.parent.mkdir()
    custom.touch()

    assert resolve_binary(str(custom), tmp_path) == str(custom)


def test_falls_back_to_this_installs_own_copy(tmp_path, monkeypatch):
    """The whole point: nothing on PATH, but data/bin has one, so publishing works."""
    monkeypatch.setattr("worker.tunnel.shutil.which", lambda name: None)
    # vendored_path, not a hand-built name: production looks for cloudflared.EXE on
    # Windows, so a hardcoded POSIX name made these fail there against correct code.
    local = vendored_path(tmp_path)
    local.parent.mkdir(parents=True)
    local.touch()

    assert resolve_binary("cloudflared", tmp_path) == str(local)


def test_returns_an_absolute_path_for_the_local_copy(tmp_path, monkeypatch):
    """launchd's PATH excludes Homebrew, so a bare name would never resolve there."""
    monkeypatch.setattr("worker.tunnel.shutil.which", lambda name: None)
    # vendored_path, not a hand-built name: production looks for cloudflared.EXE on
    # Windows, so a hardcoded POSIX name made these fail there against correct code.
    local = vendored_path(tmp_path)
    local.parent.mkdir(parents=True)
    local.touch()

    assert Path(resolve_binary("cloudflared", tmp_path)).is_absolute()


def test_returns_none_when_there_is_genuinely_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr("worker.tunnel.shutil.which", lambda name: None)

    assert resolve_binary("cloudflared", tmp_path) is None
