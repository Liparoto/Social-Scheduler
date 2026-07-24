"""Publish-delivery tests: the read-only asset server, the tunnel URL parsing / missing
binary handling, and the publisher building image URLs from a live tunnel base.

No real network and no real cloudflared — parsing and URL-building are pulled into plain
functions so they're testable, and the asset server is exercised over real localhost HTTP.
"""

from __future__ import annotations

import dataclasses
import urllib.error
import urllib.request

import pytest

from worker.asset_server import AssetServer, resolve_within
from worker.publisher import _build_plan, _resolve_url, publish_one
from worker.tunnel import (
    CloudflaredTunnel,
    TunnelError,
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
