"""Short-lived public tunnel for publish delivery.

Meta downloads images from a public URL. We can't expose localhost directly, so at
publish time we run a Cloudflare Quick Tunnel (`cloudflared tunnel --url ...`), which
returns a temporary https://<random>.trycloudflare.com address — no account, no domain,
free. The tunnel points ONLY at the read-only asset server (see asset_server.py), and is
torn down as soon as the publish cycle finishes.

Because the URL is captured fresh each cycle, the fact that quick-tunnel URLs change on
every run never matters — we never persist or reuse one.

Stdlib only (subprocess + threading + re). See docs/design-publish-delivery.md.
"""

from __future__ import annotations

import json
import re
import shutil
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

from .asset_server import AssetServer
from .cloudflared_setup import repo_root, vendored_path
from .config import Config

_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# Readiness is checked with a public resolver (not this host's system resolver), because
# that's what Meta uses to fetch the image — and some networks' system DNS filters fresh
# *.trycloudflare.com subdomains even though public resolvers serve them. We query 1.1.1.1
# by its literal IP (no DNS needed) over DNS-over-HTTPS. Cert unverified: we're only asking
# "does a public resolver have an A record yet", not moving data.
_PROBE_CTX = ssl.create_default_context()
_PROBE_CTX.check_hostname = False
_PROBE_CTX.verify_mode = ssl.CERT_NONE


class TunnelError(RuntimeError):
    """The tunnel could not be established (missing binary, timeout, crash)."""


def resolve_binary(configured: str, root: Path | None = None) -> str | None:
    """Find a cloudflared to run, or None. Absolute path where possible.

    Order: whatever CLOUDFLARED_PATH names (on PATH or as a literal path), then this
    install's own copy under data/bin, which the launcher downloads on first run. The
    fallback is what lets a fresh clone publish with no manual install — and returning
    an absolute path is what lets the launchd-managed worker find it at all, since
    launchd's minimal PATH does not include Homebrew.
    """
    exe = shutil.which(configured)
    if exe:
        return exe
    # is_file, not exists: CLOUDFLARED_PATH pointing at the *folder* cloudflared lives in
    # is an easy mistake, and exists() would accept it and then fail inside Popen with
    # IsADirectoryError instead of the readable TunnelError below. Path("") is "." too.
    if configured and Path(configured).is_file():
        return configured
    local = vendored_path(root or repo_root())
    return str(local) if local.exists() else None


def parse_tunnel_url(text: str) -> str | None:
    """Extract the trycloudflare URL from cloudflared's output, or None.

    Plain function so it's unit-testable against captured sample output.
    """
    m = _URL_RE.search(text)
    return m.group(0) if m else None


def _doh_has_answer(host: str) -> bool:
    """True if a public resolver (Cloudflare DoH, 1.1.1.1) has an A record for host.

    Real network call. Connecting to the literal IP 1.1.1.1 needs no DNS, so this works
    even where the system resolver filters the name.
    """
    req = urllib.request.Request(
        f"https://1.1.1.1/dns-query?name={host}&type=A",
        headers={"accept": "application/dns-json"},
    )
    with urllib.request.urlopen(req, timeout=5, context=_PROBE_CTX) as r:
        return bool(json.load(r).get("Answer"))


def wait_until_resolvable(base_url: str, timeout: int, sleep_fn=time.sleep,
                          interval: int = 2, resolver=_doh_has_answer) -> bool:
    """Poll a public resolver until it has an A record for the tunnel host. Best-effort.

    This mirrors how Meta will resolve the URL. Returns False if it never appears within
    ~timeout (or the resolver itself is unreachable) — the caller proceeds anyway. `resolver`
    is injectable so tests need no network. Attempt-based so stubbing sleep is deterministic.
    """
    host = urlparse(base_url).hostname or ""
    attempts = max(1, timeout // interval)
    for _ in range(attempts):
        try:
            if resolver(host):
                return True
        except Exception:  # noqa: BLE001 — resolver/network hiccup -> just retry
            pass
        sleep_fn(interval)
    return False


class CloudflaredTunnel:
    """Manage a `cloudflared` quick-tunnel subprocess pointing at a local port."""

    def __init__(self, port: int, config: Config) -> None:
        self.port = port
        self.binary = config.cloudflared_path
        self.timeout = config.tunnel_startup_timeout
        self._proc: subprocess.Popen | None = None
        self.base_url: str | None = None

    def start(self) -> str:
        exe = resolve_binary(self.binary)
        if exe is None:
            raise TunnelError(
                f"'{self.binary}' not found. It normally installs itself the first time "
                "you run Start-SocialScheduler — run that again, or install it yourself "
                "with `brew install cloudflared` (macOS) or from "
                "https://github.com/cloudflare/cloudflared/releases/latest"
            )

        self._proc = subprocess.Popen(
            [exe, "tunnel", "--url", f"http://127.0.0.1:{self.port}", "--no-autoupdate"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        found = threading.Event()

        def _reader() -> None:
            assert self._proc and self._proc.stdout
            for line in self._proc.stdout:
                if self.base_url is None:
                    url = parse_tunnel_url(line)
                    if url:
                        self.base_url = url
                        found.set()

        threading.Thread(target=_reader, daemon=True).start()

        if not found.wait(timeout=self.timeout):
            self.stop()
            raise TunnelError(
                f"cloudflared did not report a public URL within {self.timeout}s "
                "(check your network connection)."
            )
        assert self.base_url is not None
        return self.base_url

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)  # reap it so no zombie is left behind
        self._proc = None


@contextmanager
def publish_endpoint(config: Config, logger=None):
    """Bring up the asset server + tunnel, yield the public base URL, tear both down.

    Waits (best-effort) for the tunnel to actually be reachable before yielding, so the
    first publish doesn't race a cold tunnel. Used by the worker around a batch of real
    (non-dry-run) publications. Always cleans up, even on error — nothing stays exposed.
    """
    server = AssetServer(config.asset_storage_dir, config.asset_port).start()
    tunnel = CloudflaredTunnel(server.port, config)
    try:
        base_url = tunnel.start()
        if wait_until_resolvable(base_url, config.tunnel_ready_timeout):
            logger and logger.info("tunnel is live: %s", base_url)
        else:
            # Couldn't confirm from here (e.g. local DNS filtering); Meta may still reach
            # it. Proceed rather than block publishing on an unverifiable local probe.
            logger and logger.warning(
                "could not confirm tunnel reachability locally after %ss; proceeding",
                config.tunnel_ready_timeout,
            )
        yield base_url
    finally:
        tunnel.stop()
        server.stop()
