"""Publish-delivery tests: the read-only asset server, the tunnel URL parsing / missing
binary handling, and the publisher building image URLs from a live tunnel base.

No real network and no real cloudflared — parsing and URL-building are pulled into plain
functions so they're testable, and the asset server is exercised over real localhost HTTP.
"""

from __future__ import annotations

import dataclasses
import time
import urllib.error
import urllib.request

import pytest

from worker.asset_server import AssetServer, resolve_within
from worker.publisher import _build_plan, _resolve_url, publish_one
from worker.tunnel import (
    CloudflaredTunnel,
    TunnelError,
    _unavailable,
    parse_tunnel_url,
    wait_until_resolvable,
)


# ---- asset server: path safety ------------------------------------------------------
def test_resolve_within_serves_real_file(tmp_path):
    (tmp_path / "abc123.jpg").write_bytes(b"jpegbytes")
    got = resolve_within(tmp_path, "/abc123.jpg")
    assert got == (tmp_path / "abc123.jpg").resolve()


def test_resolve_within_rejects_traversal_and_missing(tmp_path):
    (tmp_path / "secret").mkdir()
    (tmp_path.parent / "outside.txt").write_bytes(b"nope")
    assert resolve_within(tmp_path, "/../outside.txt") is None  # escape attempt
    assert resolve_within(tmp_path, "/") is None                # no listing
    assert resolve_within(tmp_path, "/does-not-exist.jpg") is None
    assert resolve_within(tmp_path, "/secret") is None          # a dir, not a file


# ---- asset server: real HTTP over localhost -----------------------------------------
def test_asset_server_serves_bytes_and_blocks_traversal(tmp_path):
    (tmp_path / "hash.jpg").write_bytes(b"\xff\xd8\xff real jpeg-ish")
    server = AssetServer(tmp_path, port=0).start()  # port 0 -> OS picks a free port
    try:
        base = f"http://127.0.0.1:{server.port}"
        with urllib.request.urlopen(f"{base}/hash.jpg") as resp:
            assert resp.status == 200
            assert resp.headers["Content-Type"] == "image/jpeg"
            assert resp.read() == b"\xff\xd8\xff real jpeg-ish"

        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(f"{base}/nope.jpg")
        assert exc.value.code == 404
    finally:
        server.stop()


def test_asset_server_serves_mov_as_quicktime(tmp_path):
    """An in-spec .mov (no conversion needed, so storage_path stays <hash>.mov and
    publish_path is NULL) must be served with a real video content type — falling
    through to application/octet-stream is what Meta refuses at publish time. The
    dashboard's own media route already maps mov -> video/quicktime; this server must
    agree."""
    (tmp_path / "hash.mov").write_bytes(b"\x00\x00\x00\x14ftypqt  fake-mov-bytes")
    server = AssetServer(tmp_path, port=0).start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        with urllib.request.urlopen(f"{base}/hash.mov") as resp:
            assert resp.status == 200
            assert resp.headers["Content-Type"] == "video/quicktime"
    finally:
        server.stop()


# ---- tunnel: URL parsing + missing binary -------------------------------------------
def test_parse_tunnel_url_from_sample_output():
    sample = (
        "2026-07-22 INF Thank you for trying Cloudflare Tunnel.\n"
        "2026-07-22 INF +------------------------------------------------------+\n"
        "2026-07-22 INF |  https://calm-river-1234.trycloudflare.com           |\n"
        "2026-07-22 INF +------------------------------------------------------+\n"
    )
    assert parse_tunnel_url(sample) == "https://calm-river-1234.trycloudflare.com"


def test_parse_tunnel_url_none_when_absent():
    assert parse_tunnel_url("no url here yet\nstarting...\n") is None


# Verbatim output from a cloudflared that could not reach Cloudflare (captured
# 2026-08-08). The failure line contains a trycloudflare.com URL, and a bare hostname
# regex matches it — so the worker believed it had a tunnel, published, and handed Meta
# a URL serving an API response instead of an image. Meta answered "Only photo or video
# can be accepted as media type" and the post burned every retry and died at 'failed'.
_CLOUDFLARED_FAILURE = (
    "2026-08-09T00:05:59Z INF Thank you for trying Cloudflare Tunnel.\n"
    "2026-08-09T00:05:59Z INF Requesting new quick Tunnel on trycloudflare.com...\n"
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": '
    "dial tcp: lookup api.trycloudflare.com: no such host\n"
)


def test_parse_tunnel_url_rejects_the_url_inside_a_failure_message():
    """A failed tunnel must yield NO url, so the caller takes the retry path."""
    assert parse_tunnel_url(_CLOUDFLARED_FAILURE) is None


def test_parse_tunnel_url_never_returns_the_control_plane_host():
    """api.trycloudflare.com is Cloudflare's API, never a tunnel — on any line."""
    assert parse_tunnel_url("INF contacting https://api.trycloudflare.com now\n") is None


def test_parse_tunnel_url_still_finds_a_real_url_after_noise():
    """Rejecting the bad host must not stop us seeing a genuine tunnel that follows."""
    text = _CLOUDFLARED_FAILURE + "INF |  https://calm-river-1234.trycloudflare.com  |\n"
    assert parse_tunnel_url(text) == "https://calm-river-1234.trycloudflare.com"


class _FakeProc:
    """Stands in for a cloudflared subprocess emitting fixed output, then exiting."""

    def __init__(self, output: str) -> None:
        self.stdout = iter(output.splitlines(keepends=True))
        self.terminated = False

    def poll(self):
        return None if not self.terminated else 0

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.terminated = True
        return 0


def test_tunnel_start_fails_fast_and_explains_the_cause(config, monkeypatch):
    """The owner's real failure: no tunnel, so say WHY and that it will be retried."""
    monkeypatch.setattr("worker.tunnel.resolve_binary", lambda *a, **k: "/usr/bin/fake")
    monkeypatch.setattr("worker.tunnel._doh_has_answer", lambda host: True)
    monkeypatch.setattr(
        "worker.tunnel.subprocess.Popen",
        lambda *a, **k: _FakeProc(_CLOUDFLARED_FAILURE),
    )
    cfg = dataclasses.replace(config, tunnel_startup_timeout=30)

    with pytest.raises(TunnelError) as exc:
        CloudflaredTunnel(port=1234, config=cfg).start()

    message = str(exc.value)
    # Names the blocked dependency and the usual culprits, without assuming any one
    # person's setup — a corporate DNS filter must read as plausibly as a VPN.
    assert "trycloudflare.com" in message
    assert "VPN" in message
    # And is explicit that nothing was lost, which is the whole point of the retry path.
    assert "retried" in message


_DNS_DETAIL = (
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": '
    "dial tcp: lookup api.trycloudflare.com: no such host"
)
_CONN_DETAIL = "failed to request quick Tunnel: dial tcp 104.16.230.132:443: i/o timeout"


def _offline(_host):
    raise OSError("network is unreachable")


def test_dns_failure_does_not_blame_a_disconnected_vpn():
    """The wording that actually misled a real person, pinned down.

    A mesh-network client owns the system resolver while its VPN is genuinely switched
    off. Saying "your VPN" gets truthfully dismissed as not applicable, and the real
    cause goes unfound — so the message must cover the not-connected case explicitly.
    """
    message = _unavailable(_DNS_DETAIL, probe=lambda host: True)

    assert "mesh" in message.lower()
    assert "isn't connected" in message
    assert "DNS" in message
    # A name that won't resolve is not a blocked port — don't send them to a firewall.
    assert "firewall" not in message


def test_offline_machine_is_not_blamed_on_a_vpn_that_isnt_there():
    """The false positive worth guarding: a dropped wifi ALSO fails DNS.

    Without the probe this reads as "something is overriding your DNS", sending someone
    hunting a VPN they never installed — the same wrong-place mistake in reverse.
    """
    message = _unavailable(_DNS_DETAIL, probe=_offline)

    assert "offline" in message.lower()
    assert "VPN" not in message
    assert "mesh" not in message.lower()


def test_cloudflare_side_outage_is_not_blamed_on_the_user():
    """A public resolver can't see it either — nothing local is at fault."""
    message = _unavailable(_DNS_DETAIL, probe=lambda host: False)

    assert "Cloudflare" in message
    assert "VPN" not in message
    assert "firewall" not in message


def test_connection_failure_points_at_the_network_not_dns():
    """The other half: the name resolved fine, the connection didn't happen."""
    message = _unavailable(_CONN_DETAIL, probe=lambda host: True)

    assert "firewall" in message
    assert "mesh" not in message.lower()  # nothing here implicates the resolver


def test_every_diagnosis_leads_with_the_outcome():
    """Whatever the cause, the clamped first line has to say nothing was lost."""
    for detail in (_DNS_DETAIL, _CONN_DETAIL):
        for probe in (lambda host: True, lambda host: False, _offline):
            assert _unavailable(detail, probe=probe).startswith(
                "Not posted — will be retried automatically."
            )


def test_tunnel_start_survives_a_transient_failure_line(config, monkeypatch):
    """cloudflared logs recoverable trouble too — that must not abort a good tunnel.

    Guards the fail-fast path from overreaching: only a cloudflared that actually DIES
    is a failure, so someone on a flaky connection still publishes.
    """
    monkeypatch.setattr("worker.tunnel.resolve_binary", lambda *a, **k: "/usr/bin/fake")
    monkeypatch.setattr("worker.tunnel._doh_has_answer", lambda host: True)
    monkeypatch.setattr(
        "worker.tunnel.subprocess.Popen",
        lambda *a, **k: _FakeProc(
            "ERR failed to serve tunnel connection error=\"connection reset\"\n"
            "INF Retrying connection in up to 2s\n"
            "INF |  https://calm-river-1234.trycloudflare.com  |\n"
        ),
    )

    got = CloudflaredTunnel(port=1234, config=config).start()
    assert got == "https://calm-river-1234.trycloudflare.com"


def test_tunnel_start_does_not_wait_out_the_timeout_on_failure(config, monkeypatch):
    """Fail-fast matters: a dead tunnel shouldn't stall every publish cycle."""
    monkeypatch.setattr("worker.tunnel.resolve_binary", lambda *a, **k: "/usr/bin/fake")
    monkeypatch.setattr("worker.tunnel._doh_has_answer", lambda host: True)
    monkeypatch.setattr(
        "worker.tunnel.subprocess.Popen",
        lambda *a, **k: _FakeProc(_CLOUDFLARED_FAILURE),
    )
    # A timeout long enough that waiting it out would hang the test suite visibly.
    cfg = dataclasses.replace(config, tunnel_startup_timeout=600)

    start = time.monotonic()
    with pytest.raises(TunnelError):
        CloudflaredTunnel(port=1234, config=cfg).start()

    assert time.monotonic() - start < 10


def test_wait_until_resolvable_true_when_public_resolver_has_record():
    # Inject a resolver that reports an A record on the 2nd poll -> becomes live.
    calls = {"n": 0}

    def resolver(host):
        calls["n"] += 1
        return calls["n"] >= 2

    slept = []
    assert wait_until_resolvable("https://x.trycloudflare.com", timeout=10,
                                 sleep_fn=slept.append, resolver=resolver) is True


def test_wait_until_resolvable_false_and_backs_off():
    slept = []
    # Resolver never finds a record -> False after attempts, having backed off each time.
    ok = wait_until_resolvable("https://x.trycloudflare.com", timeout=6,
                               sleep_fn=slept.append, resolver=lambda host: False)
    assert ok is False
    assert slept  # backed off between attempts rather than hammering


def test_tunnel_missing_binary_raises_with_guidance(config):
    cfg = dataclasses.replace(config, cloudflared_path="cloudflared-not-installed-xyz")
    t = CloudflaredTunnel(port=1234, config=cfg)
    with pytest.raises(TunnelError) as exc:
        t.start()
    assert "brew install cloudflared" in str(exc.value)


# ---- publisher: URL resolution precedence -------------------------------------------
def _asset(public_url=None, storage_path="assets/x.jpg", **extra):
    return {"public_url": public_url, "storage_path": storage_path, "id": 1, **extra}


def test_resolve_url_prefers_external_then_tunnel_then_none():
    ext = _asset(public_url="https://cdn.example/x.jpg")
    assert _resolve_url(ext, "https://t.trycloudflare.com") == "https://cdn.example/x.jpg"

    local = _asset(public_url=None, storage_path="assets/hash.jpg")
    assert _resolve_url(local, "https://t.trycloudflare.com/") == \
        "https://t.trycloudflare.com/assets/hash.jpg"

    assert _resolve_url(local, None) is None  # no external url, no tunnel


def test_resolve_url_prefers_publish_path_over_storage_path():
    asset = _asset(public_url=None, storage_path="abc.png", publish_path="pub/abc.jpg")
    assert _resolve_url(asset, "https://t.example") == "https://t.example/pub/abc.jpg"


def test_resolve_url_falls_back_to_storage_path_when_no_publish_path():
    asset = _asset(public_url=None, storage_path="abc.png", publish_path=None)
    assert _resolve_url(asset, "https://t.example") == "https://t.example/abc.png"


def test_resolve_url_legacy_row_without_publish_path_key_falls_back():
    # Legacy rows / older fixtures may not carry the publish_path key at all.
    asset = {"public_url": None, "storage_path": "abc.png", "id": 1}
    assert _resolve_url(asset, "https://t.example") == "https://t.example/abc.png"


def test_resolve_url_external_public_url_still_wins_over_publish_path():
    asset = _asset(public_url="https://cdn.example/real.jpg", publish_path="pub/abc.jpg")
    assert _resolve_url(asset, "https://t.example") == "https://cdn.example/real.jpg"


def test_build_plan_uses_tunnel_urls():
    channel = {"platform": "instagram", "account_name": "IG", "remote_account_id": "1"}
    post = {"post_type": "single", "caption": "hi", "first_comment": None}
    assets = [_asset(public_url=None, storage_path="assets/h.jpg")]
    plan = _build_plan(channel, post, assets, "https://t.trycloudflare.com", post["caption"])
    assert plan["asset_urls"] == ["https://t.trycloudflare.com/assets/h.jpg"]


# ---- publisher: end-to-end, tunnel URL reaches the graph client ---------------------
def test_publish_builds_tunnel_url_for_local_asset(conn, config, make_publication):
    from worker.tests.conftest import FakeGraphClient

    # A local-only asset (no stored public_url) — the tunnel must supply the URL.
    pub = make_publication(public_url=None)
    client = FakeGraphClient()
    out = publish_one(
        conn, pub, config, client,
        dry_run=False, asset_base_url="https://calm-river.trycloudflare.com",
    )
    assert out.result == "posted"
    # The image container was created with the tunnel-built URL.
    image_calls = [url for kind, url in client.calls if kind == "image"]
    assert image_calls == [f"https://calm-river.trycloudflare.com/assets/{pub['post_id']}-0.jpg"]


def test_publish_fails_visibly_when_no_public_url_and_no_tunnel(conn, config, make_publication):
    from worker.tests.conftest import FakeGraphClient

    pub = make_publication(public_url=None)
    out = publish_one(conn, pub, config, FakeGraphClient(), dry_run=False, asset_base_url=None)
    assert out.result == "failed"
    assert "no public URL" in out.detail
