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

import re
import shutil
import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path

from .asset_server import AssetServer
from .config import Config

_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


class TunnelError(RuntimeError):
    """The tunnel could not be established (missing binary, timeout, crash)."""


def parse_tunnel_url(text: str) -> str | None:
    """Extract the trycloudflare URL from cloudflared's output, or None.

    Plain function so it's unit-testable against captured sample output.
    """
    m = _URL_RE.search(text)
    return m.group(0) if m else None


class CloudflaredTunnel:
    """Manage a `cloudflared` quick-tunnel subprocess pointing at a local port."""

    def __init__(self, port: int, config: Config) -> None:
        self.port = port
        self.binary = config.cloudflared_path
        self.timeout = config.tunnel_startup_timeout
        self._proc: subprocess.Popen | None = None
        self.base_url: str | None = None

    def start(self) -> str:
        exe = shutil.which(self.binary) or (self.binary if Path(self.binary).exists() else None)
        if exe is None:
            raise TunnelError(
                f"'{self.binary}' not found. Install it once: `brew install cloudflared` "
                "(macOS) or download from "
                "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
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
        self._proc = None


@contextmanager
def publish_endpoint(config: Config):
    """Bring up the asset server + tunnel, yield the public base URL, tear both down.

    Used by the worker around a batch of real (non-dry-run) publications. Always cleans
    up, even on error — nothing stays exposed after the cycle.
    """
    server = AssetServer(config.asset_storage_dir, config.asset_port).start()
    tunnel = CloudflaredTunnel(server.port, config)
    try:
        base_url = tunnel.start()
        yield base_url
    finally:
        tunnel.stop()
        server.stop()
