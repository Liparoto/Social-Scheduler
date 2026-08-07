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


def test_which_ffmpeg_rejects_a_cmd_shim_on_windows(monkeypatch):
    """Regression guard for the unfixable loop this fix closes.

    shutil.which("ffmpeg") on Windows honours PATHEXT and happily resolves a `ffmpeg.cmd`
    shim. dashboard/lib/video-convert.ts's findOnPath() never looks for one — only
    `ffmpeg.exe` or bare `ffmpeg` — so trusting the .cmd hit here would make find_existing()
    report success, install() return early writing nothing to data/bin, and the dashboard
    still find no converter. Without this guard, the user is told to re-run
    Start-SocialScheduler-Windows.bat, which skips setup again for the same reason: the
    exact same 422, forever.

    Exercises _which_ffmpeg() directly rather than find_existing(): the latter's own
    `Path(found)` call is not safe to hit with os.name monkeypatched to "nt" on a POSIX
    test host (pathlib picks WindowsPath vs PosixPath at instantiation, same trap
    test_vendored_path_uses_exe_on_windows works around above).
    """
    monkeypatch.setattr(fs.os, "name", "nt")
    monkeypatch.setattr(fs.shutil, "which", lambda name: "C:/Users/x/scoop/shims/ffmpeg.cmd")
    assert fs._which_ffmpeg() is None


def test_which_ffmpeg_accepts_a_bare_ffmpeg_hit_on_windows(monkeypatch):
    """The dashboard's findOnPath() also accepts an extension-less `ffmpeg` as a fallback
    on Windows, so this module must agree and accept it too."""
    monkeypatch.setattr(fs.os, "name", "nt")
    monkeypatch.setattr(fs.shutil, "which", lambda name: "C:/tools/ffmpeg")
    assert fs._which_ffmpeg() == "C:/tools/ffmpeg"


def test_which_ffmpeg_accepts_an_exe_hit_on_windows(monkeypatch):
    monkeypatch.setattr(fs.os, "name", "nt")
    monkeypatch.setattr(fs.shutil, "which", lambda name: "C:/tools/ffmpeg.exe")
    assert fs._which_ffmpeg() == "C:/tools/ffmpeg.exe"


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


def test_install_stages_with_an_exe_suffix_on_windows(tmp_path, monkeypatch):
    """Insurance, not a fix for an observed bug: verify() runs the staged file before the
    final rename, and a bare extension-less temp name very probably still runs under
    Windows' CreateProcessW when given a full path — but that "very probably" is not
    worth betting the whole branch on for a platform nobody here can test against."""
    monkeypatch.setattr(fs.sys, "platform", "win32")
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    source = _fake_binary(tmp_path / "site-packages" / "ffmpeg.exe")
    monkeypatch.setattr(fs, "bundled_binary", lambda: source)

    staged_names = []

    def spying_verify(path):
        staged_names.append(Path(path).name)
        return "ffmpeg version 7.1"

    monkeypatch.setattr(fs, "verify", spying_verify)

    fs.install(tmp_path, log=lambda *a: None)
    assert len(staged_names) == 1
    assert staged_names[0].endswith(".exe"), staged_names[0]


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


def test_main_reports_a_ctrl_c_without_a_traceback(tmp_path, monkeypatch, capsys):
    """The ~76 MB copy in install() is squarely long enough for someone to Ctrl-C it.
    KeyboardInterrupt subclasses BaseException, not Exception, so `except Exception` in
    main() does not catch it on its own — this module's whole contract is "never a
    traceback", same as any other failure."""
    monkeypatch.setattr(fs, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(
        fs, "install", lambda root, log=print: (_ for _ in ()).throw(KeyboardInterrupt())
    )

    assert fs.main([]) == 1
    err = capsys.readouterr().err
    assert "Traceback" not in err
    assert "cancel" in err.lower()
