"""Shared test fixtures: a real (temp) SQLite DB built from the actual migration,
a Config pointed at it, a fake Graph client, and a helper to insert a publication.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from worker.config import Config

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"


@pytest.fixture
def db_path(tmp_path) -> Path:
    """A fresh DB built from ALL migrations in order (mirrors migrate.py — no drift)."""
    p = tmp_path / "test.db"
    conn = sqlite3.connect(str(p))
    conn.execute("PRAGMA foreign_keys = ON;")
    for sql_file in sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name):
        conn.executescript(sql_file.read_text())
    conn.commit()
    conn.close()
    return p


@pytest.fixture
def config(db_path, tmp_path) -> Config:
    return Config(
        database_path=db_path,
        asset_storage_dir=tmp_path / "assets",
        public_asset_base_url="https://assets.test",
        meta_app_id="",
        meta_app_secret="",
        graph_version="v25.0",
        graph_base="https://graph.facebook.com",
        default_timezone="UTC",
        poll_interval=1,
        max_attempts=3,
        base_backoff_seconds=60,
        rate_limit_backoff_seconds=900,
        status_poll_interval=0,
        status_poll_max_tries=5,
    )


@pytest.fixture
def conn(config):
    from worker import db as dbmod

    c = dbmod.connect(config.database_path)
    yield c
    c.close()


class FakeGraphClient:
    """Same method surface as GraphClient; records calls, no network."""

    def __init__(self, limit=(0, 50, 86400), fail_on=None, insights=None,
                 page_summary=None, page_insights=None, fail_child_index=None):
        self.calls = []
        self.limit = limit
        self.fail_on = set(fail_on or [])
        # 1-based index of the unpublished carousel child (create_page_photo(published=False)
        # call) that should fail, e.g. fail_child_index=3 fails the 3rd child upload. Lets
        # tests exercise "child N of M fails" without failing every "page_child" call.
        self.fail_child_index = fail_child_index
        self._child_n = 0
        self.insights = insights or {
            "reach": 100, "likes": 10, "comments": 2, "saved": 5, "shares": 1,
        }
        self.page_summary = page_summary if page_summary is not None else {
            "fb_reactions": 12, "fb_comments": 3, "fb_shares": 2,
        }
        self.page_insights = page_insights if page_insights is not None else {
            "post_total_media_view_unique": 40,
        }
        self._n = 0

    def get_media_insights(self, media_id, token, metrics):
        self.calls.append(("insights", media_id))
        if "insights" in self.fail_on:
            raise RuntimeError("insights boom")
        return dict(self.insights)

    def get_content_publishing_limit(self, ig_user_id, token):
        self.calls.append(("limit", ig_user_id))
        if "limit" in self.fail_on:
            raise RuntimeError("quota check boom")
        return self.limit

    def create_image_container(self, ig_user_id, image_url, token,
                               caption=None, is_carousel_item=False):
        kind = "child" if is_carousel_item else "image"
        self.calls.append((kind, image_url))
        if "create" in self.fail_on:
            raise RuntimeError("create container boom")
        self._n += 1
        return f"cont-{self._n}"

    def create_carousel_container(self, ig_user_id, children_ids, token, caption=None):
        self.calls.append(("carousel", tuple(children_ids)))
        self._n += 1
        return f"carousel-{self._n}"

    def get_container_status(self, container_id, token):
        self.calls.append(("status", container_id))
        return "FINISHED"

    def publish_container(self, ig_user_id, creation_id, token):
        self.calls.append(("publish", creation_id))
        if "publish" in self.fail_on:
            raise RuntimeError("publish boom")
        self._n += 1
        return f"media-{self._n}"

    # -- Facebook Page surface -----------------------------------------------------
    def create_page_photo(self, page_id, image_url, token, *, caption=None, published=True):
        self.calls.append(("page_photo" if published else "page_child", image_url))
        if published:
            if "page_photo" in self.fail_on:
                raise RuntimeError("page photo boom")
            self._n += 1
            return {"id": f"photo-{self._n}", "post_id": f"page_{self._n}"}
        # Unpublished path (carousel children): its own fail_on key ("page_child"), plus
        # fail_child_index to fail one specific child instead of the whole set — otherwise
        # "child 3 of 5 fails, 1-2 already uploaded" is untestable.
        self._child_n += 1
        if "page_child" in self.fail_on or self.fail_child_index == self._child_n:
            raise RuntimeError(f"page child boom (child {self._child_n})")
        self._n += 1
        return {"id": f"photo-{self._n}"}

    def create_page_feed_post(self, page_id, token, *, message=None, attached_media=None):
        self.calls.append(("page_feed", tuple(attached_media or ())))
        if "page_feed" in self.fail_on:
            raise RuntimeError("page feed boom")
        self._n += 1
        return f"page_{self._n}"

    def get_page_info(self, page_id, token):
        self.calls.append(("page_info", page_id))
        if "page_info" in self.fail_on:
            raise RuntimeError("page info boom")
        return {"id": page_id, "name": "Test FB Page"}

    def get_page_post_summary(self, post_id, token):
        self.calls.append(("page_summary", post_id))
        if "page_summary" in self.fail_on:
            raise RuntimeError("summary boom")
        return dict(self.page_summary)

    def get_page_post_insights(self, post_id, token, metrics):
        self.calls.append(("page_insights", post_id))
        if "page_insights" in self.fail_on:
            raise RuntimeError("(#100) invalid metric")
        return dict(self.page_insights)


@pytest.fixture
def fake_client():
    return FakeGraphClient()


@pytest.fixture
def make_publication(conn):
    """Factory: create a channel + post + N assets + a due publication; return its row."""

    def _make(post_type="single", n_assets=1, public_url="https://assets.test/a.jpg",
              scheduled_offset_min=-1, with_token=True, now=None,
              platform="instagram", remote_account_id=None):
        if remote_account_id is None:
            remote_account_id = "PAGE1" if platform == "facebook" else "178414"
        cur = conn.execute(
            """INSERT INTO channels (platform, account_name, remote_account_id, access_token)
               VALUES (?, ?, ?, ?)""",
            (platform,
             "Test FB Page" if platform == "facebook" else "Test IG",
             remote_account_id,
             "tok-123" if with_token else None),
        )
        channel_id = cur.lastrowid
        cur = conn.execute(
            "INSERT INTO posts (caption, post_type) VALUES ('hello world', ?)", (post_type,)
        )
        post_id = cur.lastrowid
        for i in range(n_assets):
            cur = conn.execute(
                """INSERT INTO assets (content_hash, media_kind, storage_path, public_url)
                   VALUES (?, 'image', ?, ?)""",
                (f"hash-{post_id}-{i}", f"assets/{post_id}-{i}.jpg",
                 (f"{public_url}?i={i}" if public_url else None)),
            )
            conn.execute(
                "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,?)",
                (post_id, cur.lastrowid, i),
            )
        base = now or datetime.now(timezone.utc)
        scheduled = (base + timedelta(minutes=scheduled_offset_min)).isoformat()
        cur = conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)",
            (post_id, channel_id, scheduled),
        )
        conn.commit()
        return conn.execute(
            "SELECT * FROM publications WHERE id = ?", (cur.lastrowid,)
        ).fetchone()

    return _make
