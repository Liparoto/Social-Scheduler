"""Tests for the automatic cloudflared install (worker/cloudflared_setup.py).

Nothing here touches the network: the release lookup takes an injected fetch function,
and the archive tests build a real .tgz on disk in tmp_path.
"""

from __future__ import annotations

import os
import tarfile
from pathlib import Path

import pytest

from worker import cloudflared_setup as cs


# ---------------------------------------------------------------- asset_name


@pytest.mark.parametrize(
    "system,machine,expected",
    [
        ("Darwin", "arm64", "cloudflared-darwin-arm64.tgz"),
        ("Darwin", "x86_64", "cloudflared-darwin-amd64.tgz"),
        ("Windows", "AMD64", "cloudflared-windows-amd64.exe"),
        ("Windows", "x86", "cloudflared-windows-386.exe"),
        ("Linux", "x86_64", "cloudflared-linux-amd64"),
        ("Linux", "aarch64", "cloudflared-linux-arm64"),
    ],
)
def test_asset_name_maps_each_platform(system, machine, expected):
    assert cs.asset_name(system, machine) == expected


def test_windows_on_arm_gets_the_amd64_build():
    """Cloudflare publishes no windows-arm64 asset; x64 runs under emulation."""
    assert cs.asset_name("Windows", "ARM64") == "cloudflared-windows-amd64.exe"


@pytest.mark.parametrize(
    "system,machine",
    [("Darwin", "i386"), ("Solaris", "x86_64"), ("Linux", "sparc")],
)
def test_asset_name_rejects_what_cloudflare_does_not_ship(system, machine):
    with pytest.raises(cs.SetupError):
        cs.asset_name(system, machine)


# ---------------------------------------------------------------- release lookup


def _release(*names):
    return {
        "tag_name": "2026.7.3",
        "assets": [
            {"name": n, "browser_download_url": f"https://example.invalid/{n}"} for n in names
        ],
    }


def test_latest_asset_url_picks_the_matching_asset():
    url = cs.latest_asset_url(
        "cloudflared-darwin-arm64.tgz",
        fetch=lambda: _release("cloudflared-linux-amd64", "cloudflared-darwin-arm64.tgz"),
    )
    assert url == "https://example.invalid/cloudflared-darwin-arm64.tgz"


def test_latest_asset_url_names_the_release_when_the_asset_is_gone():
    """If Cloudflare renames an asset, the error should say which release we looked in."""
    with pytest.raises(cs.SetupError, match="2026.7.3"):
        cs.latest_asset_url("cloudflared-darwin-arm64.tgz", fetch=lambda: _release("other"))


# ---------------------------------------------------------------- archive handling


def _make_tgz(path: Path, members: dict[str, bytes]) -> None:
    with tarfile.open(path, "w:gz") as tar:
        for name, data in members.items():
            blob = path.parent / Path(name).name
            blob.write_bytes(data)
            tar.add(blob, arcname=name)
            blob.unlink()


def test_extract_pulls_the_binary_out_of_the_archive(tmp_path):
    archive = tmp_path / "cloudflared.tgz"
    _make_tgz(archive, {"cloudflared": b"\x7fELF-pretend-binary"})
    dest = tmp_path / "out"

    cs._extract_from_tgz(archive, dest)

    assert dest.read_bytes() == b"\x7fELF-pretend-binary"


def test_extract_ignores_path_games_in_the_archive(tmp_path):
    """A member named ../../evil must land at our chosen path, never escape it."""
    archive = tmp_path / "cloudflared.tgz"
    _make_tgz(archive, {"../../cloudflared": b"payload"})
    dest = tmp_path / "nested" / "out"
    dest.parent.mkdir()

    cs._extract_from_tgz(archive, dest)

    assert dest.read_bytes() == b"payload"
    assert not (tmp_path.parent.parent / "cloudflared").exists()


def test_extract_reports_an_archive_with_no_binary(tmp_path):
    archive = tmp_path / "cloudflared.tgz"
    _make_tgz(archive, {"README.md": b"nope"})

    with pytest.raises(cs.SetupError, match="no cloudflared"):
        cs._extract_from_tgz(archive, tmp_path / "out")


# ---------------------------------------------------------------- verify / find


def _fake_binary(path: Path, exit_code: int = 0, output: str = "cloudflared version 2026.7.3") -> Path:
    """A tiny executable shell script standing in for the real binary."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'#!/bin/sh\necho "{output}"\nexit {exit_code}\n')
    path.chmod(0o755)
    return path


@pytest.mark.skipif(os.name == "nt", reason="shell-script stand-in is POSIX-only")
def test_verify_returns_the_version_string(tmp_path):
    exe = _fake_binary(tmp_path / "cloudflared")
    assert "2026.7.3" in cs.verify(exe)


@pytest.mark.skipif(os.name == "nt", reason="shell-script stand-in is POSIX-only")
def test_verify_rejects_a_binary_that_fails_to_run(tmp_path):
    exe = _fake_binary(tmp_path / "cloudflared", exit_code=1)
    with pytest.raises(cs.SetupError):
        cs.verify(exe)


def test_verify_rejects_something_that_is_not_executable(tmp_path):
    junk = tmp_path / "cloudflared"
    junk.write_text("half a download")
    junk.chmod(0o644)
    with pytest.raises(cs.SetupError):
        cs.verify(junk)


@pytest.mark.skipif(os.name == "nt", reason="shell-script stand-in is POSIX-only")
def test_find_existing_uses_this_installs_own_copy(tmp_path):
    _fake_binary(cs.vendored_path(tmp_path))
    assert cs.find_existing(tmp_path) == cs.vendored_path(tmp_path)


def test_find_existing_treats_a_broken_local_copy_as_missing(tmp_path, monkeypatch):
    """A truncated download must not be mistaken for a working install."""
    broken = cs.vendored_path(tmp_path)
    broken.parent.mkdir(parents=True)
    broken.write_text("truncated")
    broken.chmod(0o644)
    monkeypatch.setattr(cs.shutil, "which", lambda _: None)

    assert cs.find_existing(tmp_path) is None


@pytest.mark.skipif(os.name == "nt", reason="shell-script stand-in is POSIX-only")
def test_find_existing_falls_back_to_a_system_install(tmp_path, monkeypatch):
    """Someone who already ran `brew install cloudflared` should download nothing."""
    system_copy = _fake_binary(tmp_path / "usr" / "cloudflared")
    monkeypatch.setattr(cs.shutil, "which", lambda _: str(system_copy))

    assert cs.find_existing(tmp_path) == system_copy


@pytest.mark.skipif(os.name == "nt", reason="shell-script stand-in is POSIX-only")
def test_install_is_a_no_op_when_one_is_already_here(tmp_path, monkeypatch):
    """Idempotence: safe to run on every single start, never re-downloads."""
    _fake_binary(cs.vendored_path(tmp_path))

    def explode():
        raise AssertionError("install() hit the network when a binary was already present")

    monkeypatch.setattr(cs, "latest_asset_url", lambda *a, **k: explode())

    assert cs.install(tmp_path, log=lambda *_: None) == cs.vendored_path(tmp_path)


def test_vendored_path_lives_under_the_gitignored_data_dir(tmp_path):
    """data/ is per-install and gitignored — the binary must never be committable."""
    assert cs.vendored_path(tmp_path).parent == tmp_path / "data" / "bin"


@pytest.mark.skipif(os.name == "nt", reason="shell-script stand-in is POSIX-only")
def test_verify_survives_a_binary_that_prints_nothing(tmp_path):
    """Whitespace-only output used to IndexError out of splitlines()[0]."""
    exe = _fake_binary(tmp_path / "cloudflared", output="")
    assert cs.verify(exe) == "unknown"


# ---------------------------------------------------------------- failure reporting


def test_main_never_lets_a_traceback_reach_the_user(tmp_path, monkeypatch, capsys):
    """A captive-portal wifi serving HTML instead of a .tgz raises tarfile.ReadError.

    That is neither an OSError nor a SetupError, so it used to escape main() and print a
    stack trace mid-startup — burying the one message a non-developer can act on.
    """
    monkeypatch.setattr(cs, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(cs, "find_existing", lambda _: None)

    def boom(*_args, **_kwargs):
        raise tarfile.ReadError("not a gzip file")

    monkeypatch.setattr(cs, "install", boom)

    assert cs.main() == 1
    err = capsys.readouterr().err
    assert "Couldn't set up cloudflared" in err
    assert "brew install cloudflared" in err


def test_main_explains_the_macos_certificate_trap(tmp_path, monkeypatch, capsys):
    """python.org's Python trusts nothing until you run Install Certificates.command."""
    monkeypatch.setattr(cs, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(cs, "find_existing", lambda _: None)

    def boom(*_args, **_kwargs):
        raise cs.SetupError("CERTIFICATE_VERIFY_FAILED: unable to get local issuer")

    monkeypatch.setattr(cs, "install", boom)

    assert cs.main() == 1
    assert "Install Certificates.command" in capsys.readouterr().err


def test_install_clears_orphaned_staging_dirs(tmp_path, monkeypatch):
    """A run killed mid-download leaves ~40MB behind; retries must not accumulate."""
    orphan = cs.vendored_path(tmp_path).parent / "tmpleftover"
    orphan.mkdir(parents=True)
    (orphan / "download").write_bytes(b"partial")

    monkeypatch.setattr(cs, "find_existing", lambda _: None)
    monkeypatch.setattr(
        cs, "latest_asset_url", lambda *a, **k: (_ for _ in ()).throw(cs.SetupError("stop here"))
    )

    with pytest.raises(cs.SetupError):
        cs.install(tmp_path, log=lambda *_: None)

    assert not orphan.exists()
