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

# Hosts under trycloudflare.com that are Cloudflare's own control plane and never a
# tunnel. This matters because cloudflared prints https://api.trycloudflare.com/tunnel
# INSIDE its failure message, which a bare hostname regex happily matches — so a tunnel
# that never came up looked like one that did, and Meta was handed a URL serving an API
# response instead of an image ("Only photo or video can be accepted as media type").
_NOT_A_TUNNEL = frozenset({"api.trycloudflare.com"})

# cloudflared's wording when it cannot reach Cloudflare to create the tunnel at all.
_FAILURE_RE = re.compile(r"failed to (?:request|create|serve|start)\b.*tunnel", re.I)


# A name that won't resolve and a host that won't accept a connection are different
# problems with different fixes, and cloudflared says which one it hit. Splitting them
# is what stops the message sending someone to check a firewall when their DNS is the
# thing at fault.
_DNS_FAILURE_RE = re.compile(
    r"no such host|lookup\s+\S+|name resolution|server misbehaving|\bdns\b", re.I
)


def _unavailable(detail: str, probe=None) -> str:
    """Explain a missing tunnel in terms of what it means for the post.

    The cause is DIAGNOSED, not guessed. Every plausible cause — offline laptop, a VPN or
    mesh-network client owning the resolver, a school/corporate filter, a firewall, a
    Cloudflare outage — produces the same "no tunnel" symptom, and cloudflared's own text
    only distinguishes a failed name lookup from a failed connection. So on the DNS path
    we additionally ask a public resolver (1.1.1.1, reached by literal IP, so it needs no
    working DNS itself) whether the name resolves out in the world:

      * we can't reach 1.1.1.1 at all  -> this machine is offline; blame nothing else
      * 1.1.1.1 HAS the record          -> the name is fine publicly and broken here, so
                                          something local is overriding DNS
      * 1.1.1.1 lacks the record        -> it's genuinely unresolvable; Cloudflare's end

    That middle branch is the one worth the network call: it turns "maybe a VPN?" into a
    fact. Saying "your VPN" without it gets truthfully dismissed by anyone whose VPN is
    off — including someone running a mesh-network client (NordVPN Meshnet, Tailscale and
    friends), which takes over the system resolver while never being "connected" to any
    VPN server. That exact wording sent a real person looking in the wrong place.

    Front-loaded on purpose: the dashboard clamps this to two lines, so the meaning — and
    the fact that nothing was lost — has to land before the raw cloudflared text.
    """
    # Looked up at call time, not bound as a default, so a test (or a caller) can swap
    # the probe and this never reaches the network unless it is genuinely meant to.
    probe = probe or _doh_has_answer
    try:
        publicly_resolvable = probe("api.trycloudflare.com")
    except Exception:  # noqa: BLE001 — can't even reach a public resolver by IP
        publicly_resolvable = None

    if publicly_resolvable is None:
        cause = (
            "This computer looks offline — it couldn't reach the internet at all, and "
            "publishing needs to reach trycloudflare.com to give Meta a public image URL."
        )
    elif not _DNS_FAILURE_RE.search(detail):
        cause = (
            "Can't reach trycloudflare.com, which publishing needs in order to give Meta "
            "a public image URL — commonly a firewall, a proxy, or captive-portal wifi."
        )
    elif publicly_resolvable:
        cause = (
            "Can't look up trycloudflare.com, which publishing needs in order to give "
            "Meta a public image URL — though a public resolver can see it fine, so "
            "something on this computer is overriding DNS: usually a VPN or "
            "mesh-network app (which can do this even when it isn't connected to a VPN "
            "server), or a network-level filter."
        )
    else:
        cause = (
            "trycloudflare.com isn't resolving publicly either, so this is Cloudflare's "
            "end rather than anything on this computer. Usually temporary."
        )
    return f"Not posted — will be retried automatically. {cause} cloudflared said: {detail}"

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

    Scans line by line so a URL quoted inside a FAILURE line can be skipped: a failed
    tunnel must yield None, so the caller takes the retry path instead of publishing to
    an address that was never a tunnel. Plain function so it's unit-testable against
    captured sample output.
    """
    for line in text.splitlines():
        if _FAILURE_RE.search(line):
            continue
        for match in _URL_RE.finditer(line):
            if urlparse(match.group(0)).hostname not in _NOT_A_TUNNEL:
                return match.group(0)
    return None


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
        failures: list[str] = []

        def _reader() -> None:
            assert self._proc and self._proc.stdout
            for line in self._proc.stdout:
                if self.base_url is None:
                    if _FAILURE_RE.search(line):
                        # Recorded as the likely reason, but deliberately NOT treated as
                        # fatal on its own: cloudflared also logs transient trouble
                        # ("failed to serve tunnel connection") and then recovers, and
                        # aborting on those would break tunnels that were going to work.
                        # A genuinely fatal failure makes cloudflared exit, which closes
                        # stdout and ends this loop — that is what wakes the caller.
                        failures.append(line.strip())
                        continue
                    url = parse_tunnel_url(line)
                    if url:
                        self.base_url = url
                        found.set()
                        return
            # Output ended without a URL: the process died. Wake the caller now rather
            # than making every publish cycle sit out the full startup timeout.
            found.set()

        threading.Thread(target=_reader, daemon=True).start()

        found.wait(timeout=self.timeout)
        if self.base_url is None:
            self.stop()
            raise TunnelError(_unavailable(
                failures[-1] if failures  # the last one is the one it died on
                else f"cloudflared reported no public URL within {self.timeout}s"
            ))
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
