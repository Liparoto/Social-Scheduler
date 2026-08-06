"""Caching leaderboard thumbnails to local disk.

Meta's thumbnail URLs are signed CDN links with an expiry, so hotlinking them works on
sync day and rots afterwards — and for a post this install did not publish there is no
local original to fall back on. The worker keeps a copy, exactly as it already does for
avatars.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from worker.thumbnails import media_needing_thumbnails, run_thumbnails, store_thumbnail

NOW = datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc)
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64          # valid JPEG magic bytes
NOT_AN_IMAGE = b"<html>link expired</html>"


class FakeImageClient:
    def __init__(self, payload=JPEG, fail=False):
        self.payload = payload
        self.fail = fail
        self.requested: list[str] = []
        self.last_usage_pct = None
        self.retry_after_seconds = 0

    def download_image_bytes(self, url, max_bytes=5_000_000):
        self.requested.append(url)
        if self.fail:
            raise RuntimeError("410 Gone")
        return self.payload


def _channel(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('instagram','A','acct1','tok')"
    ).lastrowid
    conn.commit()
    return cid


def _media(conn, channel_id, remote_id, *, url="https://cdn.test/a.jpg", deleted=0):
    mid = conn.execute(
        "INSERT INTO remote_media (channel_id, remote_post_id, thumbnail_url, "
        "published_at, is_deleted) VALUES (?,?,?,?,?)",
        (channel_id, remote_id, url, NOW.isoformat(), deleted),
    ).lastrowid
    conn.commit()
    return mid


def _row(conn, media_id):
    return conn.execute(
        "SELECT thumbnail_path, thumbnail_fetched_at FROM remote_media WHERE id=?",
        (media_id,),
    ).fetchone()


# -- selection -----------------------------------------------------------------------

def test_a_post_with_a_url_and_no_attempt_is_due(conn):
    cid = _channel(conn)
    _media(conn, cid, "a")
    assert len(media_needing_thumbnails(conn, cid, 10)) == 1


def test_a_post_with_no_url_is_never_due(conn):
    """Threads text posts carry no thumbnail at all."""
    cid = _channel(conn)
    _media(conn, cid, "a", url=None)
    assert media_needing_thumbnails(conn, cid, 10) == []


def test_deleted_posts_are_skipped(conn):
    cid = _channel(conn)
    _media(conn, cid, "gone", deleted=1)
    assert media_needing_thumbnails(conn, cid, 10) == []


def test_an_attempt_that_produced_nothing_is_not_retried_forever(conn, config):
    """The trap this job could easily fall into. A link that expired before we reached it
    yields no file, so keying selection on thumbnail_path IS NULL would re-download that
    post every cycle for the life of the install. Recording the ATTEMPT is what makes
    'tried and got nothing' terminal."""
    cid = _channel(conn)
    media_id = _media(conn, cid, "expired")
    client = FakeImageClient(fail=True)

    run_thumbnails(conn, config, now=NOW, client_for=lambda p: client)
    row = _row(conn, media_id)
    assert row["thumbnail_path"] is None
    assert row["thumbnail_fetched_at"] is not None

    client2 = FakeImageClient(fail=True)
    run_thumbnails(conn, config, now=NOW, client_for=lambda p: client2)
    assert client2.requested == [], "a failed post must not be retried every cycle"


# -- storing -------------------------------------------------------------------------

def test_a_downloaded_thumbnail_is_written_and_recorded(conn, config):
    cid = _channel(conn)
    media_id = _media(conn, cid, "a")

    stored = run_thumbnails(conn, config, now=NOW, client_for=lambda p: FakeImageClient())

    assert stored == 1
    row = _row(conn, media_id)
    assert row["thumbnail_path"] == f"thumbnails/{media_id}.jpg"
    assert (Path(config.asset_storage_dir) / row["thumbnail_path"]).read_bytes() == JPEG


def test_bytes_that_are_not_an_image_are_not_stored(conn, config):
    """An expired signed link often returns an error page with HTTP 200. Writing that to
    disk as a .jpg would render as a broken image instead of the clean fallback."""
    cid = _channel(conn)
    media_id = _media(conn, cid, "a")

    stored = run_thumbnails(
        conn, config, now=NOW, client_for=lambda p: FakeImageClient(payload=NOT_AN_IMAGE)
    )

    assert stored == 0
    assert _row(conn, media_id)["thumbnail_path"] is None


def test_store_writes_atomically_and_leaves_no_temp_file(config):
    path = store_thumbnail(Path(config.asset_storage_dir), 42, JPEG, "jpg")
    thumb_dir = Path(config.asset_storage_dir) / "thumbnails"
    assert path == "thumbnails/42.jpg"
    assert [p.name for p in thumb_dir.iterdir()] == ["42.jpg"], "no .tmp left behind"


def test_a_failure_on_one_post_does_not_stop_the_others(conn, config):
    cid = _channel(conn)
    good = _media(conn, cid, "good")
    bad = _media(conn, cid, "bad", url="https://cdn.test/bad.jpg")

    class Selective(FakeImageClient):
        def download_image_bytes(self, url, max_bytes=5_000_000):
            self.requested.append(url)
            if "bad" in url:
                raise RuntimeError("410 Gone")
            return JPEG

    run_thumbnails(conn, config, now=NOW, client_for=lambda p: Selective())

    assert _row(conn, good)["thumbnail_path"] is not None
    assert _row(conn, bad)["thumbnail_path"] is None
    assert _row(conn, bad)["thumbnail_fetched_at"] is not None


def test_the_per_cycle_cap_bounds_a_first_sync(conn, config):
    """A fresh account has hundreds of posts; downloading them all in one cycle would
    stall everything else the worker does."""
    cid = _channel(conn)
    for i in range(10):
        _media(conn, cid, f"p{i}")
    config.thumbnail_max_per_cycle = 3

    assert run_thumbnails(conn, config, now=NOW, client_for=lambda p: FakeImageClient()) == 3


def test_a_second_run_only_fetches_what_is_left(conn, config):
    cid = _channel(conn)
    for i in range(4):
        _media(conn, cid, f"p{i}")
    config.thumbnail_max_per_cycle = 2

    run_thumbnails(conn, config, now=NOW, client_for=lambda p: FakeImageClient())
    client = FakeImageClient()
    run_thumbnails(conn, config, now=NOW, client_for=lambda p: client)

    assert len(client.requested) == 2
    remaining = conn.execute(
        "SELECT COUNT(*) c FROM remote_media WHERE thumbnail_fetched_at IS NULL"
    ).fetchone()["c"]
    assert remaining == 0


# -- size -----------------------------------------------------------------------------

def test_a_stored_thumbnail_is_downscaled(config):
    """Meta's `thumbnail_url` is often the FULL-SIZE image, and for a photo post the sync
    falls back to media_url, which always is. Storing those as-is produced 115 MB for 118
    images on the first real run — on a tool whose entire storage story is a folder on
    someone's Mac."""
    import subprocess
    from pathlib import Path as P

    from worker.thumbnails import SIPS, THUMBNAIL_MAX_PIXELS

    if not P(SIPS).exists():
        return  # not macOS; downscaling is best-effort by design

    # A real 1200x1200 JPEG, made with the same system tool that resizes them.
    src = P(config.asset_storage_dir) / "big.png"
    src.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["/usr/bin/sips", "-s", "format", "jpeg", "-z", "1200", "1200",
         "/System/Library/CoreServices/DefaultDesktop.heic", "--out", str(src)],
        capture_output=True, check=False,
    )
    if not src.exists():
        return  # no stock image on this macOS version; nothing to assert against

    rel = store_thumbnail(P(config.asset_storage_dir), 99, src.read_bytes(), "jpg")
    out = P(config.asset_storage_dir) / rel

    dims = subprocess.run(
        ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", str(out)],
        capture_output=True, text=True, check=True,
    ).stdout
    longest = max(int(t.split(":")[1]) for t in dims.splitlines() if ":" in t and t.strip().startswith("pixel"))
    assert longest <= THUMBNAIL_MAX_PIXELS


def test_downscaling_failure_still_leaves_a_usable_image(config, monkeypatch):
    """Best-effort: a full-size thumbnail costs disk but still displays. Losing the image
    because the resize failed would be the worse trade."""
    from pathlib import Path as P

    import worker.thumbnails as t

    monkeypatch.setattr(t, "SIPS", "/nonexistent/sips")
    rel = t.store_thumbnail(P(config.asset_storage_dir), 77, JPEG, "jpg")

    assert (P(config.asset_storage_dir) / rel).read_bytes() == JPEG
