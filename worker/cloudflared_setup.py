"""One-time setup: put a working `cloudflared` on this install.

Meta downloads media from a public URL, so a real publish needs a Cloudflare quick
tunnel (see tunnel.py). That needs the `cloudflared` binary — and until now getting it
was homework: `brew install cloudflared` on macOS (which assumes Homebrew is even
installed) and a hunt through Cloudflare's download page on Windows. Worse, the launcher
only *warned* about it when DRY_RUN=0, and a fresh clone ships DRY_RUN=1 — so a new
install got no warning at all and only discovered the problem when its first real
publish failed.

This module removes that homework. It downloads the official binary straight from
Cloudflare's GitHub releases into `data/bin/`, which is per-install and gitignored, the
same as the database and the asset store. No package manager, no admin password, no
PATH surprises, and the worker gets an ABSOLUTE path — which also sidesteps launchd's
minimal PATH, where a bare `cloudflared` is not found at all.

Stdlib-only apart from one optional import of certifi (see _ssl_context). The launcher
runs this with the worker's own venv Python, which has certifi, but the module still
works under a bare interpreter that doesn't.

Run it directly:  .venv/bin/python -m worker.cloudflared_setup
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

_RELEASE_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
_TIMEOUT = 30
_USER_AGENT = "SocialScheduler-setup"


class SetupError(RuntimeError):
    """cloudflared could not be installed (unsupported platform, network, bad download)."""


# ---------------------------------------------------------------- paths


def repo_root() -> Path:
    """The repo root, derived from this file's location — not the cwd."""
    return Path(__file__).resolve().parent.parent


def vendored_path(root: Path) -> Path:
    """Where this install keeps its own copy of cloudflared."""
    name = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    return root / "data" / "bin" / name


# ---------------------------------------------------------------- platform


def asset_name(system: str, machine: str) -> str:
    """Map (platform.system(), platform.machine()) to Cloudflare's release asset name.

    Pure function so every branch is testable without downloading anything. Windows on
    ARM maps to the amd64 build on purpose: Cloudflare publishes no windows-arm64 asset,
    and Windows runs x64 binaries under emulation.
    """
    system = system.lower()
    machine = machine.lower()

    if machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("x86_64", "amd64"):
        arch = "amd64"
    elif machine in ("i386", "i686", "x86"):
        arch = "386"
    else:
        raise SetupError(f"unsupported processor type '{machine}'")

    if system == "darwin":
        if arch == "386":
            raise SetupError("32-bit macOS is not supported by cloudflared")
        return f"cloudflared-darwin-{arch}.tgz"
    if system == "windows":
        # No windows-arm64 build exists; x64 runs fine under emulation.
        return f"cloudflared-windows-{'amd64' if arch == 'arm64' else arch}.exe"
    if system == "linux":
        return f"cloudflared-linux-{arch}"
    raise SetupError(f"unsupported operating system '{system}'")


# ---------------------------------------------------------------- download


def _ssl_context() -> ssl.SSLContext:
    """A verifying TLS context that works on python.org's macOS build.

    That build ships no CA store of its own — it relies on a separate "Install
    Certificates.command" that most people never run — so ssl's default context cannot
    verify github.com there and every download dies with CERTIFICATE_VERIFY_FAILED.
    `requests` sidesteps this by bundling certifi; we use certifi the same way when it
    is importable, and fall back to the system store elsewhere (Homebrew Python, Linux,
    Windows).

    Verification is never disabled. This downloads an executable that then gets run —
    an unverified TLS connection here would be the weakest link in the whole install.
    """
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def _open(url: str):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": _USER_AGENT}),
        timeout=_TIMEOUT,
        context=_ssl_context(),
    )


def latest_asset_url(name: str, fetch=None) -> str:
    """The browser_download_url for asset `name` in cloudflared's latest release.

    `fetch` is injectable so tests never touch the network.
    """
    if fetch is None:
        def fetch() -> dict:
            with _open(_RELEASE_API) as r:
                return json.load(r)

    release = fetch()
    for asset in release.get("assets", []):
        if asset.get("name") == name:
            return asset["browser_download_url"]
    tag = release.get("tag_name", "?")
    raise SetupError(f"cloudflare's latest release ({tag}) has no asset named {name}")


def _download(url: str, dest: Path, log=print) -> None:
    """Stream `url` to `dest`, printing a coarse percentage as it goes."""
    with _open(url) as response:
        # urllib follows redirects across schemes, so an https URL can quietly land on a
        # plaintext one. We execute what we download, so refuse rather than trust it.
        if not response.geturl().lower().startswith("https://"):
            raise SetupError("the download was redirected to an insecure (non-HTTPS) address")
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        shown = -1
        with dest.open("wb") as out:
            while chunk := response.read(64 * 1024):
                out.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    if pct >= shown + 10:  # every ~10%, so logs stay readable
                        shown = pct - pct % 10
                        log(f"          {shown}%")
    if total and done < total:
        raise SetupError(f"download ended early ({done} of {total} bytes)")


def _extract_from_tgz(archive: Path, dest: Path) -> None:
    """Pull the single `cloudflared` member out of a .tgz.

    Extracted member-by-member rather than with extractall(): we write the bytes to a
    path we chose ourselves, so a malicious archive has no way to place a file outside
    data/bin (the classic tar path-traversal), regardless of Python version.
    """
    with tarfile.open(archive, "r:gz") as tar:
        member = next(
            (m for m in tar.getmembers() if m.isfile() and Path(m.name).name == "cloudflared"),
            None,
        )
        if member is None:
            raise SetupError("the downloaded archive contained no cloudflared binary")
        src = tar.extractfile(member)
        if src is None:
            raise SetupError("could not read cloudflared out of the downloaded archive")
        with src, dest.open("wb") as out:
            shutil.copyfileobj(src, out)


# ---------------------------------------------------------------- verify


def verify(path: Path | str) -> str:
    """Return cloudflared's version string, or raise. Proof it actually runs."""
    try:
        proc = subprocess.run(
            [str(path), "--version"], capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        # TimeoutExpired is a SubprocessError, NOT an OSError — catching only OSError let a
        # hung binary escape as a traceback instead of a sentence someone can act on.
        raise SetupError(f"{path} could not be run ({exc})") from exc
    if proc.returncode != 0:
        raise SetupError(f"{path} exited {proc.returncode} when asked for its version")
    lines = (proc.stdout or proc.stderr or "").strip().splitlines()
    return lines[0] if lines else "unknown"


def find_existing(root: Path) -> Path | None:
    """A cloudflared that is already here and actually works, or None.

    Checks this install's own copy first, then the system PATH — someone who already ran
    `brew install cloudflared` keeps using theirs and downloads nothing.
    """
    local = vendored_path(root)
    if local.exists():
        try:
            verify(local)
            return local
        except SetupError:
            return None  # present but broken — caller re-downloads over it
    found = shutil.which("cloudflared")
    if found:
        try:
            verify(found)
            return Path(found)
        except SetupError:
            return None
    return None


# ---------------------------------------------------------------- install


def install(root: Path | None = None, log=print) -> Path:
    """Ensure a working cloudflared exists for this install; return its path.

    Idempotent and safe to run on every start: if one is already here it returns
    immediately without touching the network.
    """
    root = root or repo_root()

    existing = find_existing(root)
    if existing is not None:
        return existing

    name = asset_name(platform.system(), platform.machine())
    dest = vendored_path(root)
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Sweep any staging directory orphaned by an earlier run that was killed mid-download.
    # TemporaryDirectory cleans up after an exception but not after SIGKILL or a power cut,
    # and each orphan is ~40 MB.
    for orphan in dest.parent.glob("tmp*"):
        if orphan.is_dir():
            shutil.rmtree(orphan, ignore_errors=True)

    log("First run — downloading cloudflared (needed to deliver your media to Meta)...")
    try:
        url = latest_asset_url(name)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise SetupError(f"could not reach Cloudflare's download list ({exc})") from exc

    # Stage in a temp file next to the destination, then move into place only after the
    # binary has proven it runs — so a half-finished download can never be mistaken for
    # a working install on the next start.
    with tempfile.TemporaryDirectory(dir=str(dest.parent)) as tmpdir:
        staged = Path(tmpdir) / "download"
        try:
            _download(url, staged, log=log)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            # ValueError covers http.client.IncompleteRead, which is neither a URLError nor
            # an OSError — a connection dropped mid-download surfaced as a raw traceback.
            raise SetupError(f"the download failed ({exc})") from exc

        binary = Path(tmpdir) / dest.name
        if name.endswith(".tgz"):
            try:
                _extract_from_tgz(staged, binary)
            except tarfile.TarError as exc:
                raise SetupError(
                    f"the download wasn't a usable archive ({exc}) — if you are on wifi "
                    "with a sign-in page, connect properly and run Start again"
                ) from exc
        else:
            staged.replace(binary)

        binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        version = verify(binary)
        binary.replace(dest)

    log(f"          Installed {version} into {dest.parent}")
    return dest


def main(argv: list[str] | None = None) -> int:
    """Launcher entry point. Never raises — prints plainly and returns an exit code."""
    root = repo_root()
    try:
        existing = find_existing(root)
        if existing is not None:
            return 0
        install(root)
        return 0
    except Exception as exc:  # noqa: BLE001
        # Deliberately broad. The whole point of this module is that a non-developer never
        # has to think about cloudflared, so ANY failure must arrive as the sentence below
        # rather than a traceback. A captive-portal wifi that serves an HTML page instead of
        # the .tgz raises tarfile.ReadError, which is not an OSError and not a SetupError —
        # that alone used to escape and print a stack trace mid-startup.
        print(f"[!] Couldn't set up cloudflared automatically: {exc}", file=sys.stderr)
        print(
            "    Real publishing needs it. You can install it yourself with "
            "`brew install cloudflared` (macOS), or download it from\n"
            "    https://github.com/cloudflare/cloudflared/releases/latest\n"
            "    Composing and dry runs work fine without it.",
            file=sys.stderr,
        )
        if "CERTIFICATE_VERIFY" in str(exc):
            print(
                "    (That specific error means this Mac's Python has no certificate "
                "store. Open Applications >\n"
                "     Python 3.x and double-click 'Install Certificates.command', then "
                "run Start again.)",
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
