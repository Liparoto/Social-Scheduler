"""load_env precedence: a variable set at launch outranks .env, forever.

Regression test for a trap that cost real API calls on 2026-08-05. run.py reloads .env
with override=True on every loop so the safety switches can be toggled live, and that
reload used to clobber variables the caller had deliberately set, so

    DRY_RUN=1 .venv/bin/python -m worker.run --once

silently became a LIVE run against .env's DRY_RUN=0 — it opened a tunnel and created a
real Meta container. DATABASE_PATH=<scratch> protected the data; nothing protected the
network.

The fix must hold BOTH ways: an explicit launch-time value must survive the reload, and
a value that only ever came from .env must still be re-read so live toggling works.
"""

from __future__ import annotations

import os

import pytest

from worker import config


@pytest.fixture
def env_file(tmp_path, monkeypatch):
    """Point load_env at a scratch .env — never the install's real one."""
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)
    return lambda text: (tmp_path / ".env").write_text(text)


def test_dry_run_set_at_launch_survives_an_override_reload(env_file, monkeypatch):
    """The exact bug: DRY_RUN=1 on the command line vs DRY_RUN=0 in .env."""
    env_file("DRY_RUN=0\n")
    monkeypatch.setenv("DRY_RUN", "1")
    monkeypatch.setattr(config, "_LAUNCH_ENV_KEYS", frozenset({"DRY_RUN"}))

    config.load_env(override=True)

    assert os.environ["DRY_RUN"] == "1"
    assert config.dry_run_active() is True


def test_kill_switch_set_at_launch_survives_too(env_file, monkeypatch):
    """The other safety switch takes the same path, so it gets the same guarantee."""
    env_file("KILL_SWITCH=0\n")
    monkeypatch.setenv("KILL_SWITCH", "1")
    monkeypatch.setattr(config, "_LAUNCH_ENV_KEYS", frozenset({"KILL_SWITCH"}))

    config.load_env(override=True)

    assert config.kill_switch_active() is True


def test_repeated_reloads_do_not_erode_the_launch_value(env_file, monkeypatch):
    """The daemon reloads every loop — the guarantee has to survive all of them, not
    just the first, which is what made the original bug so easy to miss in a --once run."""
    env_file("DRY_RUN=0\n")
    monkeypatch.setenv("DRY_RUN", "1")
    monkeypatch.setattr(config, "_LAUNCH_ENV_KEYS", frozenset({"DRY_RUN"}))

    for _ in range(5):
        config.load_env(override=True)

    assert os.environ["DRY_RUN"] == "1"


def test_env_file_still_wins_when_the_variable_was_not_set_at_launch(env_file, monkeypatch):
    """Live toggling must keep working. Nothing was explicit at launch here, so the value
    in the environment came from a PREVIOUS load_env and .env is still authoritative."""
    env_file("DRY_RUN=0\n")
    monkeypatch.setenv("DRY_RUN", "1")
    monkeypatch.setattr(config, "_LAUNCH_ENV_KEYS", frozenset())

    config.load_env(override=True)

    assert os.environ["DRY_RUN"] == "0"
    assert config.dry_run_active() is False


def test_load_env_still_fills_in_a_variable_absent_from_the_environment(env_file, monkeypatch):
    env_file("SOME_UNSET_KEY=hello\n")
    monkeypatch.delenv("SOME_UNSET_KEY", raising=False)
    monkeypatch.setattr(config, "_LAUNCH_ENV_KEYS", frozenset())

    config.load_env()

    assert os.environ["SOME_UNSET_KEY"] == "hello"


def test_launch_env_keys_is_captured_from_the_real_environment():
    """A frozenset snapshot taken at import — if this ever became a live view of
    os.environ, every key load_env set would look 'explicit at launch' and .env would
    stop being re-read at all."""
    assert isinstance(config._LAUNCH_ENV_KEYS, frozenset)
    assert "PATH" in config._LAUNCH_ENV_KEYS
