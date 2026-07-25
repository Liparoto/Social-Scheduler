"""Discord and Telegram: publish, preflight, and (deliberately absent) metrics.

Both platforms upload bytes themselves (no tunnel, no public_url) and expose no publish
quota and no metrics endpoint at all — this file pins all three of those "different from
Meta" behaviours, mirroring the equivalent Instagram/Facebook/Threads coverage rather than
duplicating it wholesale.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

from worker.clients import ClientRegistry
from worker.metrics import run_metrics
from worker.preflight import check_channels
from worker.publisher import publish_one
from worker.run import run_once

NOW = datetime(2026, 7, 22, 18, 0, 0, tzinfo=timezone.utc)


def _write_local_files(config, conn, post_id):
    """Uploads_media_bytes platforms need a real file on disk — write one per asset,
    named so file order is easy to assert on."""
    rows = conn.execute(
        """SELECT a.storage_path FROM assets a
           JOIN post_assets pa ON pa.asset_id = a.id
           WHERE pa.post_id = ?
           ORDER BY pa.sort_order""",
        (post_id,),
    ).fetchall()
    for i, row in enumerate(rows):
        path = config.asset_storage_dir / row["storage_path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"bytes-{i}".encode())


def _write_original_and_conformed_files(config, conn, post_id):
    """Give each asset a publish_path distinct from storage_path, with different bytes at
    each, so a test can prove which file a platform actually received rather than merely
    which path was chosen."""
    rows = conn.execute(
        """SELECT a.id, a.storage_path FROM assets a
           JOIN post_assets pa ON pa.asset_id = a.id
           WHERE pa.post_id = ?
           ORDER BY pa.sort_order""",
        (post_id,),
    ).fetchall()
    for i, row in enumerate(rows):
        original = config.asset_storage_dir / row["storage_path"]
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(f"original-{i}".encode())

        conformed_rel = f"conformed/{post_id}-{i}.jpg"
        conformed = config.asset_storage_dir / conformed_rel
        conformed.parent.mkdir(parents=True, exist_ok=True)
        conformed.write_bytes(f"conformed-{i}".encode())

        conn.execute(
            "UPDATE assets SET publish_path = ? WHERE id = ?", (conformed_rel, row["id"])
        )
    conn.commit()


# ---------------------------------------------------------------------------------------
# Discord
# ---------------------------------------------------------------------------------------


def test_discord_text_post_publishes_and_stores_remote_post_id(
    conn, config, fake_discord_client, make_publication
):
    pub = make_publication(platform="discord", post_type="text", n_assets=0)

    out = publish_one(conn, pub, config, fake_discord_client, dry_run=False)

    assert out.result == "posted"
    assert fake_discord_client.calls == [("discord_text", "hello world", None)]
    row = conn.execute(
        "SELECT remote_post_id FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()
    assert row["remote_post_id"] == "discord-msg-1"


def test_discord_single_image_uploads_bytes_from_the_asset_store(
    conn, config, fake_discord_client, make_publication
):
    pub = make_publication(platform="discord", post_type="single", n_assets=1, public_url=None)
    _write_local_files(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_discord_client, dry_run=False)

    assert out.result == "posted"
    assert len(fake_discord_client.calls) == 1
    kind, content, files = fake_discord_client.calls[0]
    assert kind == "discord_files"
    assert content == "hello world"
    assert len(files) == 1
    assert files[0][1] == b"bytes-0"


def test_discord_single_image_uploads_the_original_not_the_conformed_derivative(
    conn, config, fake_discord_client, make_publication
):
    """Discord has no aspect-ratio rules, so it must receive assets.storage_path (the
    untouched original) rather than the Instagram-conformed publish_path."""
    pub = make_publication(platform="discord", post_type="single", n_assets=1, public_url=None)
    _write_original_and_conformed_files(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_discord_client, dry_run=False)

    assert out.result == "posted"
    _, _, files = fake_discord_client.calls[0]
    assert files[0][1] == b"original-0"


def test_discord_album_of_three_sends_one_call_in_asset_order(
    conn, config, fake_discord_client, make_publication
):
    pub = make_publication(platform="discord", post_type="carousel", n_assets=3, public_url=None)
    _write_local_files(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_discord_client, dry_run=False)

    assert out.result == "posted"
    assert len(fake_discord_client.calls) == 1
    _, _, files = fake_discord_client.calls[0]
    assert [f[1] for f in files] == [b"bytes-0", b"bytes-1", b"bytes-2"]


def test_discord_publishes_with_no_tunnel_even_when_cloudflared_is_broken(
    conn, config, fake_discord_client, make_publication, monkeypatch
):
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    cfg = dataclasses.replace(config, cloudflared_path="cloudflared-not-installed-xyz")
    pub = make_publication(
        platform="discord", post_type="single", n_assets=1, public_url=None, now=NOW
    )
    _write_local_files(cfg, conn, pub["post_id"])

    n = run_once(conn, cfg, fake_discord_client, now=NOW)

    assert n == 1
    row = conn.execute("SELECT status FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"


def test_discord_rejects_caption_over_2000_on_any_post_type(
    conn, config, fake_discord_client, make_publication
):
    pub = make_publication(platform="discord", post_type="text", n_assets=0)
    conn.execute("UPDATE posts SET caption = ? WHERE id = ?", ("x" * 2001, pub["post_id"]))
    conn.commit()

    out = publish_one(conn, pub, config, fake_discord_client, dry_run=False)

    assert out.result == "failed"
    assert fake_discord_client.calls == []


def test_discord_never_makes_a_quota_call(conn, config, fake_discord_client, make_publication):
    pub = make_publication(platform="discord", post_type="text", n_assets=0)

    publish_one(conn, pub, config, fake_discord_client, dry_run=False)

    kinds = {kind for kind, *_ in fake_discord_client.calls}
    assert "limit" not in kinds and "discord_limit" not in kinds


def test_discord_preflight_reports_ok_via_read_only_check(
    config, fake_discord_client, make_publication
):
    pub = make_publication(platform="discord")
    channel = {
        "id": pub["channel_id"], "account_name": "Test Discord", "platform": "discord",
        "access_token": "https://discord.com/api/webhooks/12345/faketoken",
        "remote_account_id": None,
    }
    registry = ClientRegistry(config, factory=lambda version, base: fake_discord_client)
    lines = []

    ok = check_channels([channel], registry, print_fn=lines.append)

    assert ok is True
    assert fake_discord_client.calls == [
        ("discord_webhook", "https://discord.com/api/webhooks/12345/faketoken")
    ]
    assert any("Test Webhook" in line for line in lines)


def test_discord_preflight_failure_reports_without_leaking_the_webhook_url(
    config, fake_discord_client
):
    fake_discord_client.fail_on.add("discord_webhook")
    secret_url = "https://discord.com/api/webhooks/12345/super-secret-token"
    channel = {
        "id": 9, "account_name": "Broken Discord", "platform": "discord",
        "access_token": secret_url, "remote_account_id": None,
    }
    registry = ClientRegistry(config, factory=lambda version, base: fake_discord_client)
    lines = []

    ok = check_channels([channel], registry, print_fn=lines.append)

    assert ok is False
    assert any("✗" in line for line in lines)
    assert not any(secret_url in line for line in lines)
    assert not any("super-secret-token" in line for line in lines)


def test_discord_metrics_are_skipped_but_other_publications_still_process(
    conn, config, fake_client, fake_discord_client
):
    ig_channel = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('instagram','IG','ig1','tok')"
    ).lastrowid
    dc_channel = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('discord','Disc',NULL,'https://discord.com/api/webhooks/1/tok')"
    ).lastrowid

    ig_post = conn.execute("INSERT INTO posts (post_type) VALUES ('single')").lastrowid
    dc_post = conn.execute("INSERT INTO posts (post_type) VALUES ('single')").lastrowid
    published_at = NOW.isoformat()
    ig_pub = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, published_at, remote_post_id, is_dry_run)
           VALUES (?,?,?, 'posted', ?, 'media-1', 0)""",
        (ig_post, ig_channel, published_at, published_at),
    ).lastrowid
    dc_pub = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, published_at, remote_post_id, is_dry_run)
           VALUES (?,?,?, 'posted', ?, 'discord-msg-1', 0)""",
        (dc_post, dc_channel, published_at, published_at),
    ).lastrowid
    conn.commit()

    def client_for(platform):
        return fake_client if platform == "instagram" else fake_discord_client

    fetched = run_metrics(conn, config, fake_client, NOW, client_for=client_for)

    assert fetched == 1  # only the Instagram publication
    assert fake_discord_client.calls == []
    ig_rows = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (ig_pub,)
    ).fetchall()
    dc_rows = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (dc_pub,)
    ).fetchall()
    assert len(ig_rows) == 1
    assert len(dc_rows) == 0


def test_discord_manual_refresh_flag_is_cleared_after_one_skipped_attempt(
    conn, config, fake_client, fake_discord_client
):
    """A manually-flagged Discord publication must still be selected once (so the flag
    clears), even though Discord has no metrics endpoint and gets skipped every cycle
    when picked up automatically. Before the fix, the platform exclusion in
    publications_needing_metrics applied to the manual arm too, so this row was never
    selected at all, the flag was never cleared, and 'Refresh all metrics' would
    re-flag + re-skip it forever (violating docs/design-metrics-refresh.md's
    one-attempt-then-clear contract)."""
    dc_channel = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('discord','Disc',NULL,'https://discord.com/api/webhooks/1/tok')"
    ).lastrowid
    dc_post = conn.execute("INSERT INTO posts (post_type) VALUES ('single')").lastrowid
    published_at = NOW.isoformat()
    dc_pub = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, published_at, remote_post_id,
              is_dry_run, metrics_refresh_requested_at)
           VALUES (?,?,?, 'posted', ?, 'discord-msg-1', 0, ?)""",
        (dc_post, dc_channel, published_at, published_at, published_at),
    ).lastrowid
    conn.commit()

    def client_for(platform):
        return fake_discord_client

    fetched = run_metrics(conn, config, fake_client, NOW, client_for=client_for)

    assert fetched == 0
    assert fake_discord_client.calls == []
    row = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id = ?", (dc_pub,)
    ).fetchone()
    assert row["metrics_refresh_requested_at"] is None
    rows = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (dc_pub,)
    ).fetchall()
    assert len(rows) == 0

    # Run again — the flag is already clear, so it must NOT be re-selected.
    fetched2 = run_metrics(conn, config, fake_client, NOW, client_for=client_for)
    assert fetched2 == 0


def test_discord_dry_run_makes_zero_calls(conn, config, fake_discord_client, make_publication):
    pub = make_publication(platform="discord", post_type="text", n_assets=0)

    out = publish_one(conn, pub, config, fake_discord_client, dry_run=True)

    assert out.result == "dry_run"
    assert fake_discord_client.calls == []


# ---------------------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------------------


def test_telegram_text_post_publishes_and_stores_remote_post_id(
    conn, config, fake_telegram_client, make_publication
):
    pub = make_publication(platform="telegram", post_type="text", n_assets=0)

    out = publish_one(conn, pub, config, fake_telegram_client, dry_run=False)

    assert out.result == "posted"
    assert fake_telegram_client.calls == [("tg_message", "@testchannel", "hello world")]
    row = conn.execute(
        "SELECT remote_post_id FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()
    assert row["remote_post_id"] == "1"


def test_telegram_single_image_uploads_bytes_from_the_asset_store(
    conn, config, fake_telegram_client, make_publication
):
    pub = make_publication(platform="telegram", post_type="single", n_assets=1, public_url=None)
    _write_local_files(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_telegram_client, dry_run=False)

    assert out.result == "posted"
    assert len(fake_telegram_client.calls) == 1
    kind, chat_id, photo = fake_telegram_client.calls[0]
    assert kind == "tg_photo"
    assert chat_id == "@testchannel"
    assert photo[1] == b"bytes-0"


def test_telegram_single_image_uploads_the_original_not_the_conformed_derivative(
    conn, config, fake_telegram_client, make_publication
):
    """Telegram has no aspect-ratio rules, so it must receive assets.storage_path (the
    untouched original) rather than the Instagram-conformed publish_path."""
    pub = make_publication(platform="telegram", post_type="single", n_assets=1, public_url=None)
    _write_original_and_conformed_files(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_telegram_client, dry_run=False)

    assert out.result == "posted"
    _, _, photo = fake_telegram_client.calls[0]
    assert photo[1] == b"original-0"


def test_telegram_album_of_three_sends_one_call_in_asset_order(
    conn, config, fake_telegram_client, make_publication
):
    pub = make_publication(platform="telegram", post_type="carousel", n_assets=3, public_url=None)
    _write_local_files(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_telegram_client, dry_run=False)

    assert out.result == "posted"
    assert len(fake_telegram_client.calls) == 1
    _, _, photos = fake_telegram_client.calls[0]
    assert [p[1] for p in photos] == [b"bytes-0", b"bytes-1", b"bytes-2"]


def test_telegram_publishes_with_no_tunnel_even_when_cloudflared_is_broken(
    conn, config, fake_telegram_client, make_publication, monkeypatch
):
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    cfg = dataclasses.replace(config, cloudflared_path="cloudflared-not-installed-xyz")
    pub = make_publication(
        platform="telegram", post_type="single", n_assets=1, public_url=None, now=NOW
    )
    _write_local_files(cfg, conn, pub["post_id"])

    n = run_once(conn, cfg, fake_telegram_client, now=NOW)

    assert n == 1
    row = conn.execute("SELECT status FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"


def test_telegram_accepts_4096_char_text_but_rejects_it_on_a_single_image_post(
    conn, config, fake_telegram_client, make_publication
):
    long_caption = "x" * 4096

    text_pub = make_publication(platform="telegram", post_type="text", n_assets=0)
    conn.execute("UPDATE posts SET caption = ? WHERE id = ?", (long_caption, text_pub["post_id"]))
    conn.commit()
    out = publish_one(conn, text_pub, config, fake_telegram_client, dry_run=False)
    assert out.result == "posted"

    single_pub = make_publication(
        platform="telegram", post_type="single", n_assets=1, public_url=None
    )
    _write_local_files(config, conn, single_pub["post_id"])
    conn.execute(
        "UPDATE posts SET caption = ? WHERE id = ?", (long_caption, single_pub["post_id"])
    )
    conn.commit()
    calls_before = len(fake_telegram_client.calls)

    out2 = publish_one(conn, single_pub, config, fake_telegram_client, dry_run=False)

    assert out2.result == "failed"
    assert len(fake_telegram_client.calls) == calls_before  # no API call made


def test_telegram_never_makes_a_quota_call(conn, config, fake_telegram_client, make_publication):
    pub = make_publication(platform="telegram", post_type="text", n_assets=0)

    publish_one(conn, pub, config, fake_telegram_client, dry_run=False)

    kinds = {kind for kind, *_ in fake_telegram_client.calls}
    assert "limit" not in kinds and "tg_limit" not in kinds


def test_telegram_preflight_reports_ok_via_getme_then_getchat(
    config, fake_telegram_client, make_publication
):
    pub = make_publication(platform="telegram")
    channel = {
        "id": pub["channel_id"], "account_name": "Test Telegram", "platform": "telegram",
        "access_token": "123:ABC-fake-bot-token", "remote_account_id": "@testchannel",
    }
    registry = ClientRegistry(config, factory=lambda version, base: fake_telegram_client)
    lines = []

    ok = check_channels([channel], registry, print_fn=lines.append)

    assert ok is True
    kinds = [k for k, *_ in fake_telegram_client.calls]
    assert kinds == ["tg_getme", "tg_getchat"]
    assert any("Test Channel" in line for line in lines)


def test_telegram_preflight_failure_reports_without_leaking_the_bot_token(
    config, fake_telegram_client
):
    fake_telegram_client.fail_on.add("tg_getchat")
    secret_token = "123:ABC-super-secret-bot-token"
    channel = {
        "id": 10, "account_name": "Broken Telegram", "platform": "telegram",
        "access_token": secret_token, "remote_account_id": "@testchannel",
    }
    registry = ClientRegistry(config, factory=lambda version, base: fake_telegram_client)
    lines = []

    ok = check_channels([channel], registry, print_fn=lines.append)

    assert ok is False
    assert any("✗" in line for line in lines)
    assert not any(secret_token in line for line in lines)


def test_telegram_metrics_are_skipped_but_other_publications_still_process(
    conn, config, fake_client, fake_telegram_client
):
    ig_channel = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('instagram','IG','ig1','tok')"
    ).lastrowid
    tg_channel = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('telegram','Tg','@testchannel','123:ABC')"
    ).lastrowid

    ig_post = conn.execute("INSERT INTO posts (post_type) VALUES ('single')").lastrowid
    tg_post = conn.execute("INSERT INTO posts (post_type) VALUES ('single')").lastrowid
    published_at = NOW.isoformat()
    ig_pub = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, published_at, remote_post_id, is_dry_run)
           VALUES (?,?,?, 'posted', ?, 'media-1', 0)""",
        (ig_post, ig_channel, published_at, published_at),
    ).lastrowid
    tg_pub = conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, published_at, remote_post_id, is_dry_run)
           VALUES (?,?,?, 'posted', ?, '42', 0)""",
        (tg_post, tg_channel, published_at, published_at),
    ).lastrowid
    conn.commit()

    def client_for(platform):
        return fake_client if platform == "instagram" else fake_telegram_client

    fetched = run_metrics(conn, config, fake_client, NOW, client_for=client_for)

    assert fetched == 1  # only the Instagram publication
    assert fake_telegram_client.calls == []
    ig_rows = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (ig_pub,)
    ).fetchall()
    tg_rows = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (tg_pub,)
    ).fetchall()
    assert len(ig_rows) == 1
    assert len(tg_rows) == 0


def test_telegram_dry_run_makes_zero_calls(conn, config, fake_telegram_client, make_publication):
    pub = make_publication(platform="telegram", post_type="text", n_assets=0)

    out = publish_one(conn, pub, config, fake_telegram_client, dry_run=True)

    assert out.result == "dry_run"
    assert fake_telegram_client.calls == []


def test_instagram_still_resolves_the_conformed_derivative_not_the_original(
    conn, config, fake_client, make_publication
):
    """Regression guard for the working Meta platforms: Instagram constrains aspect ratio,
    so the local path the publisher builds (used for validation/dry-run bookkeeping) must
    keep pointing at the Instagram-conformed publish_path, never the untouched original."""
    pub = make_publication(platform="instagram", post_type="single", n_assets=1)
    _write_original_and_conformed_files(config, conn, pub["post_id"])

    out = publish_one(conn, pub, config, fake_client, dry_run=True)

    assert out.result == "dry_run"
    path = out.plan["asset_paths"][0]
    assert path is not None
    assert path.read_bytes() == b"conformed-0"
