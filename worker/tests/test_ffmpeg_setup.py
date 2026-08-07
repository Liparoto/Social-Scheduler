"""Tests for the automatic ffmpeg install (worker/ffmpeg_setup.py).

Nothing here touches the network or runs a real ffmpeg: `verify` is monkeypatched, and
the "binary" is a text file. The point is the decision logic, not the codec.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from worker import ffmpeg_setup as fs


def _fake_binary(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not really ffmpeg")
    return path


def test_vendored_path_uses_exe_on_windows(monkeypatch):
    # Construct the Path BEFORE patching os.name. pathlib picks WindowsPath vs PosixPath
    # from os.name at instantiation, and Python 3.11 refuses to instantiate WindowsPath on
    # a POSIX host — patching first makes this line raise, which aborts the whole suite.
    root = Path("/repo")
    monkeypatch.setattr(fs.os, "name", "nt")
    assert fs.vendored_path(root).name == "ffmpeg.exe"


def test_vendored_path_is_bare_elsewhere(monkeypatch):
    monkeypatch.setattr(fs.os, "name", "posix")
    assert fs.vendored_path(Path("/repo")).name == "ffmpeg"


def test_find_existing_returns_the_vendored_copy(tmp_path, monkeypatch):
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    dest = _fake_binary(fs.vendored_path(tmp_path))
    assert fs.find_existing(tmp_path) == dest


def test_a_broken_vendored_copy_counts_as_missing(tmp_path, monkeypatch):
    """A truncated copy must self-heal on the next start, not be trusted forever."""
    def boom(path):
        raise fs.SetupError("exited 1")
    monkeypatch.setattr(fs, "verify", boom)
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    _fake_binary(fs.vendored_path(tmp_path))
    assert fs.find_existing(tmp_path) is None


def test_find_existing_falls_back_to_path(tmp_path, monkeypatch):
    """Someone who installed ffmpeg themselves keeps using theirs and downloads nothing."""
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    monkeypatch.setattr(fs.shutil, "which", lambda name: "/usr/local/bin/ffmpeg")
    assert fs.find_existing(tmp_path) == Path("/usr/local/bin/ffmpeg")


def test_install_is_a_no_op_off_windows(tmp_path, monkeypatch):
    """macOS has avconvert; nothing should be copied there."""
    monkeypatch.setattr(fs.sys, "platform", "darwin")
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    assert fs.install(tmp_path, log=lambda *a: None) is None
    assert not fs.vendored_path(tmp_path).exists()


def test_install_copies_the_bundled_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(fs.sys, "platform", "win32")
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    source = _fake_binary(tmp_path / "site-packages" / "ffmpeg-win-x86_64-v7.1.exe")
    monkeypatch.setattr(fs, "bundled_binary", lambda: source)

    dest = fs.install(tmp_path, log=lambda *a: None)
    assert dest == fs.vendored_path(tmp_path)
    assert dest.exists()
    assert dest.read_text() == "not really ffmpeg"


def test_install_leaves_nothing_behind_when_the_copy_is_unusable(tmp_path, monkeypatch):
    """A binary that will not run must never be left where the next start trusts it."""
    monkeypatch.setattr(fs.sys, "platform", "win32")
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "verify", lambda p: (_ for _ in ()).throw(fs.SetupError("bad")))
    monkeypatch.setattr(fs, "bundled_binary",
                        lambda: _fake_binary(tmp_path / "src" / "ffmpeg.exe"))

    with pytest.raises(fs.SetupError):
        fs.install(tmp_path, log=lambda *a: None)
    assert not fs.vendored_path(tmp_path).exists()
    assert list(fs.vendored_path(tmp_path).parent.glob("tmp*")) == []


def test_main_never_raises_when_the_package_is_missing(tmp_path, monkeypatch, capsys):
    """Windows-on-ARM has no wheel. That must be a sentence, never a traceback."""
    monkeypatch.setattr(fs.sys, "platform", "win32")
    monkeypatch.setattr(fs, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "bundled_binary",
                        lambda: (_ for _ in ()).throw(ImportError("no imageio_ffmpeg")))

    assert fs.main([]) == 1
    err = capsys.readouterr().err
    assert "Traceback" not in err
    assert "ffmpeg" in err
