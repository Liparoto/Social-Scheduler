"""One-time setup: put a working `ffmpeg` on this install (Windows only).

Instagram refuses two things an iPhone produces by default — a `moov` atom at the end of
the file, and HEVC video — and both are fixed by re-encoding. macOS has always been fine
here: `avconvert` ships with every Mac. Windows has no equivalent, so a Windows install
could not convert at all, and the error it raised told the user to run `brew install
ffmpeg`, which does not exist there.

Unlike cloudflared_setup.py, this downloads nothing itself. `imageio-ffmpeg` is declared
in requirements.txt for Windows only, and pip has already put a suitable binary inside the
venv by the time this runs; the job here is to copy it to the one predictable place the
dashboard looks — `data/bin/`, gitignored and per-install, next to cloudflared.

That binary was checked before being adopted: it reports `--enable-gpl --enable-libx264`
and carries an HEVC decoder, which is exactly the pair of problems above.

Run it directly:  .venv/Scripts/python -m worker.ffmpeg_setup
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_VERSION_TIMEOUT = 30


class SetupError(RuntimeError):
    """ffmpeg could not be installed (no wheel for this platform, or a bad copy)."""


# ---------------------------------------------------------------- paths


def repo_root() -> Path:
    """The repo root, derived from this file's location — not the cwd."""
    return Path(__file__).resolve().parent.parent


def vendored_path(root: Path) -> Path:
    """Where this install keeps its own copy of ffmpeg."""
    name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    return root / "data" / "bin" / name


# ---------------------------------------------------------------- discovery


def _which_ffmpeg() -> str | None:
    """Like shutil.which("ffmpeg"), but only counts a hit named exactly what the
    dashboard would also accept.

    dashboard/lib/video-convert.ts's findOnPath() only ever probes for `ffmpeg.exe` (or
    bare `ffmpeg`) on Windows, and bare `ffmpeg` elsewhere. shutil.which("ffmpeg") does
    not agree: on Windows it also honours PATHEXT (.CMD, .BAT, .PS1, ...) and searches
    the current directory, so it can resolve to e.g. `ffmpeg.cmd`. If this module trusted
    that hit, find_existing() would report success, install() would return early writing
    nothing to data/bin, and the dashboard — which never looks for `ffmpeg.cmd` — would
    still find no converter. The user would be told to re-run the launcher, which would
    skip setup again for the same reason: an unfixable loop. The two lookups must agree,
    or setup silently skips work the dashboard still needs.
    """
    found = shutil.which("ffmpeg")
    if found is None:
        return found
    # os.path.basename, not pathlib — Path() picks WindowsPath vs PosixPath from os.name
    # at instantiation, and tests exercise this with os.name monkeypatched to "nt" on a
    # POSIX host, which pathlib refuses to do (same trap the vendored_path tests document
    # in test_ffmpeg_setup.py). os.path.basename has no such restriction.
    name = os.path.basename(found)
    if os.name == "nt":
        return found if name in ("ffmpeg.exe", "ffmpeg") else None
    return found if name == "ffmpeg" else None


def verify(path: Path | str) -> str:
    """Run `-version` and return its first line, or raise SetupError.

    A present-but-broken binary must count as missing so a truncated copy self-heals on
    the next start instead of being trusted forever.
    """
    try:
        proc = subprocess.run(
            [str(path), "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=_VERSION_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        # TimeoutExpired is a SubprocessError, NOT an OSError — catching only OSError
        # would let a hung binary escape as a traceback (the same trap cloudflared_setup
        # documents).
        raise SetupError(f"{path} could not be run ({exc})") from exc
    if proc.returncode != 0:
        raise SetupError(f"{path} exited {proc.returncode} when asked for its version")
    lines = (proc.stdout or proc.stderr or "").strip().splitlines()
    return lines[0] if lines else "unknown"


def find_existing(root: Path) -> Path | None:
    """An ffmpeg that is already here and actually works, or None.

    Checks this install's own copy first, then the system PATH — someone who already
    installed ffmpeg themselves keeps using theirs and we copy nothing.
    """
    local = vendored_path(root)
    if local.exists():
        try:
            verify(local)
            return local
        except SetupError:
            return None  # present but broken — caller re-copies over it
    found = _which_ffmpeg()
    if found:
        try:
            verify(found)
            return Path(found)
        except SetupError:
            return None
    return None


def bundled_binary() -> Path:
    """The ffmpeg that pip put inside this venv, via imageio-ffmpeg.

    Uses the package's own resolver rather than reconstructing its version-stamped
    filename, so its layout stays its own concern.
    """
    import imageio_ffmpeg

    return Path(imageio_ffmpeg.get_ffmpeg_exe())


# ---------------------------------------------------------------- install


def install(root: Path | None = None, log=print) -> Path | None:
    """Ensure a working ffmpeg exists for this install; return its path, or None if
    none is needed on this platform.

    Idempotent and safe to run on every start.
    """
    root = root or repo_root()

    existing = find_existing(root)
    if existing is not None:
        return existing

    if sys.platform != "win32":
        # macOS has /usr/bin/avconvert, which the dashboard prefers anyway. Nothing to do.
        return None

    source = bundled_binary()
    dest = vendored_path(root)
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Sweep any staging file orphaned by an earlier run that was killed mid-copy. Each
    # orphan is ~76 MB, and NamedTemporaryFile does not clean up after a SIGKILL.
    for orphan in dest.parent.glob("tmp*"):
        if orphan.is_file():
            orphan.unlink(missing_ok=True)

    log("First run — setting up ffmpeg (needed to convert iPhone video for Instagram)...")

    # Stage beside the destination and move into place only after the copy has proven it
    # runs, so a half-written file can never be mistaken for a working install.
    #
    # Close mkstemp's file descriptor immediately. It hands back an OPEN fd, and on Windows
    # an open handle blocks the .replace() below — the staged copy would be verified, then
    # fail to move, on the one platform this whole module exists for.
    #
    # suffix=".exe" (Windows only) so verify() below runs a file that is actually named
    # like an executable. CreateProcessW very probably runs an extension-less file fine
    # when given a full path — but "very probably" is not something to bet the whole
    # branch on for an untestable platform, and cloudflared_setup.py already sidesteps the
    # question entirely by staging under the final name. mkstemp's suffix is the cheapest
    # way to do the same here without restructuring the mkstemp/mkdtemp choice.
    suffix = ".exe" if sys.platform == "win32" else ""
    fd, staged_name = tempfile.mkstemp(dir=str(dest.parent), prefix="tmp", suffix=suffix)
    os.close(fd)
    staged = Path(staged_name)
    try:
        shutil.copyfile(source, staged)
        staged.chmod(0o755)
        version = verify(staged)
        staged.replace(dest)
    except BaseException:
        staged.unlink(missing_ok=True)
        raise

    log(f"          Installed {version} into {dest.parent}")
    return dest


def main(argv: list[str] | None = None) -> int:
    """Launcher entry point. Never raises — prints plainly and returns an exit code."""
    root = repo_root()
    try:
        install(root)
        return 0
    except KeyboardInterrupt:
        # KeyboardInterrupt subclasses BaseException, not Exception, so `except Exception`
        # below does not catch it — install()'s ~76 MB copy is squarely long enough for
        # someone to Ctrl-C it, and this module's whole contract is "never a traceback".
        print("[!] ffmpeg setup cancelled.", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        # Deliberately broad, for the same reason cloudflared_setup is: the whole point of
        # this module is that a non-developer never has to think about ffmpeg, so ANY
        # failure must arrive as the sentences below rather than a traceback mid-startup.
        print(f"[!] Couldn't set up ffmpeg automatically: {exc}", file=sys.stderr)
        print(
            "    Without it, iPhone video (HEVC, or with its index at the end of the "
            "file) can't be\n"
            "    converted for Instagram. Photos and carousels are unaffected.\n"
            "    You can install ffmpeg yourself from https://ffmpeg.org/download.html "
            "and make sure\n"
            "    it is on your PATH, then run Start again.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
