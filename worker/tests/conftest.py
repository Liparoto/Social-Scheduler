"""Shared test fixtures: a real (temp) SQLite DB built from the actual migration,
a Config pointed at it, a fake Graph client, and a helper to insert a publication.
"""

from __future__ import annotations

import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from worker.config import Config

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"


@pytest.fixture(scope="session")
def _schema_template(tmp_path_factory) -> Path:
    """Build the schema ONCE per session, from all migrations in order.

    Every test needs a fresh database, and the obvious way to get one is to replay every
    migration per test. That is O(migrations x tests), and it stopped being free: at 20
    migrations it cost ~2.7s of setup for EACH test — about 13 minutes across the suite,
    almost all of it re-running identical DDL.

    Building the template once and copying the file per test keeps each test's database
    genuinely fresh and identical to migrate.py's output (still no drift — the same
    scripts in the same order), while paying for it a single time.
    """
    path = tmp_path_factory.mktemp("schema") / "template.db"
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON;")
    for sql_file in sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name):
        conn.executescript(sql_file.read_text())
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def db_path(tmp_path, _schema_template) -> Path:
    """A fresh DB for one test: a byte copy of the session's migrated schema.

    A copy, never a shared handle — tests write, and sharing one file would let them see
    each other's rows.
    """
    p = tmp_path / "test.db"
    shutil.copyfile(_schema_template, p)
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
                 page_summary=None, page_insights=None, fail_child_index=None,
                 threads_limit=(0, 250, 86400), threads_insights=None):
        self.calls = []
        self.requested_metrics = []
        self.topic_tags = []
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
        self.threads_limit = threads_limit
        self.threads_insights = threads_insights if threads_insights is not None else {
            "views": 500, "likes": 12, "replies": 3, "reposts": 2, "quotes": 1,
        }
        self._n = 0

    def get_media_insights(self, media_id, token, metrics):
        # Record the metric LIST too: story media rejects the feed list outright, so which
        # names were asked for is the thing under test, not just that a call happened.
        self.calls.append(("insights", media_id))
        self.requested_metrics.append(list(metrics))
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

    def create_story_container(self, ig_user_id, token, image_url=None, video_url=None):
        # Records which MEDIA FIELD was used, so a test can prove a video story didn't
        # get sent as image_url. Note there is no caption parameter at all — Stories
        # have no caption field (see GraphClient.create_story_container).
        kind = "story_video" if video_url else "story_image"
        self.calls.append((kind, video_url or image_url))
        if "create" in self.fail_on:
            raise RuntimeError("create container boom")
        self._n += 1
        return f"story-cont-{self._n}"

    def get_container_status(self, container_id, token):
        self.calls.append(("status", container_id))
        return "FINISHED"

    def publish_container(self, ig_user_id, creation_id, token):
        self.calls.append(("publish", creation_id))
        if "publish" in self.fail_on:
            raise RuntimeError("publish boom")
        self._n += 1
        return f"media-{self._n}"

    def create_comment(self, media_id, message, token):
        # Records the MESSAGE, not just that a call happened: the whole point of the
        # first comment is the text (hashtags), so a test must be able to prove the
        # right body reached the API rather than an empty or truncated one.
        self.calls.append(("comment", media_id, message))
        if "comment" in self.fail_on:
            raise RuntimeError("comment boom")
        self._n += 1
        return f"comment-{self._n}"

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

    # -- Threads surface -------------------------------------------------------------
    def create_threads_container(self, threads_user_id, token, *, media_type,
                                  text=None, image_url=None, is_carousel_item=False,
                                  children=None, reply_to_id=None, topic_tag=None):
        # Recorded separately from `calls` so the existing call-shape assertions across
        # the Threads tests keep working unchanged while topic-tag tests can still see
        # what was sent — including the None case, which is the point of several.
        self.topic_tags.append(topic_tag)
        if reply_to_id is not None:
            # A Threads first comment is a self-REPLY, not a comment edge. Its own kind
            # so a test can tell a reply apart from an ordinary TEXT post, and can prove
            # which published thread it was attached to.
            kind = "threads_reply"
            value = (reply_to_id, text)
        elif media_type == "CAROUSEL":
            kind = "threads_carousel"
            value = tuple(children or ())
        elif is_carousel_item:
            kind = "threads_child"
            value = image_url
        elif media_type == "TEXT":
            kind = "threads_text"
            value = text
        else:
            kind = "threads_image"
            value = image_url
        self.calls.append((kind, value))
        if kind in self.fail_on:
            raise RuntimeError("threads create container boom")
        self._n += 1
        return f"threads-cont-{self._n}"

    def get_threads_container_status(self, container_id, token):
        self.calls.append(("threads_status", container_id))
        return "FINISHED"

    def publish_threads_container(self, threads_user_id, creation_id, token):
        self.calls.append(("threads_publish", creation_id))
        if "threads_publish" in self.fail_on:
            raise RuntimeError("threads publish boom")
        self._n += 1
        return f"threads-media-{self._n}"

    def get_threads_publishing_limit(self, threads_user_id, token):
        self.calls.append(("threads_limit", threads_user_id))
        if "threads_limit" in self.fail_on:
            raise RuntimeError("threads quota check boom")
        return self.threads_limit

    def get_threads_insights(self, media_id, token, metrics):
        self.calls.append(("threads_insights", media_id))
        if "threads_insights" in self.fail_on:
            raise RuntimeError("threads insights boom")
        return dict(self.threads_insights)


class FakeDiscordClient:
    """Same method surface as DiscordClient; records calls, no network."""

    def __init__(self, fail_on=None, webhook_info=None):
        self.calls = []
        self.fail_on = set(fail_on or [])
        self.webhook_info = webhook_info if webhook_info is not None else {
            "id": "wh-1", "name": "Test Webhook", "channel_id": "chan-1",
        }
        self._n = 0

    def send_message(self, webhook_url, *, content=None, files=None):
        kind = "discord_files" if files else "discord_text"
        self.calls.append((kind, content, list(files) if files else None))
        if kind in self.fail_on or "discord_send" in self.fail_on:
            raise RuntimeError("discord send boom")
        self._n += 1
        return {"id": f"discord-msg-{self._n}"}

    def get_webhook(self, webhook_url):
        self.calls.append(("discord_webhook", webhook_url))
        if "discord_webhook" in self.fail_on:
            raise RuntimeError(f"discord webhook boom: {webhook_url}")
        return dict(self.webhook_info)

    def get_webhook_limit(self, webhook_url):
        """Discord has no real publish-quota endpoint — this exists only so a test can
        prove the publisher never calls it. Records the call before returning/raising so
        a future regression that wires Discord into quota-gating shows up here instead
        of silently vanishing into publish_one's swallowed exception handling."""
        self.calls.append(("discord_limit", webhook_url))
        if "discord_limit" in self.fail_on:
            raise RuntimeError("discord has no quota endpoint")
        return (0, 0, 0)


class FakeTelegramClient:
    """Same method surface as TelegramClient; records calls, no network."""

    def __init__(self, fail_on=None, chat_info=None):
        self.calls = []
        self.fail_on = set(fail_on or [])
        self.chat_info = chat_info if chat_info is not None else {
            "id": -100123, "title": "Test Channel",
        }
        self._n = 0

    def send_message(self, token, chat_id, text):
        self.calls.append(("tg_message", chat_id, text))
        if "tg_message" in self.fail_on:
            raise RuntimeError("telegram message boom")
        self._n += 1
        return {"message_id": self._n}

    def send_photo(self, token, chat_id, photo, caption=None):
        self.calls.append(("tg_photo", chat_id, photo))
        if "tg_photo" in self.fail_on:
            raise RuntimeError("telegram photo boom")
        self._n += 1
        return {"message_id": self._n}

    def send_media_group(self, token, chat_id, photos, caption=None):
        self.calls.append(("tg_media_group", chat_id, list(photos)))
        if "tg_media_group" in self.fail_on:
            raise RuntimeError("telegram media group boom")
        first = self._n + 1
        self._n += len(photos)
        return [{"message_id": first + i} for i in range(len(photos))]

    def get_me(self, token):
        self.calls.append(("tg_getme", None))
        if "tg_getme" in self.fail_on:
            raise RuntimeError("telegram getMe boom")
        return {"id": 999, "is_bot": True, "username": "testbot"}

    def get_chat(self, token, chat_id):
        self.calls.append(("tg_getchat", chat_id))
        if "tg_getchat" in self.fail_on:
            # Shaped like the real client's exception text (the token embedded in the
            # request URL path, e.g. from a raised ConnectionError/HTTPError) rather than
            # a string that could never contain the credential — this is what proves
            # redact() is actually doing something for this test.
            raise RuntimeError(
                f"telegram getChat boom: url=https://api.telegram.org/bot{token}/getChat"
            )
        return dict(self.chat_info)

    def get_bot_limit(self, token):
        """Telegram's Bot API has no real publish-quota endpoint — this exists only so a
        test can prove the publisher never calls it. Records the call before returning/
        raising so a future regression that wires Telegram into quota-gating shows up
        here instead of silently vanishing into publish_one's swallowed exception
        handling."""
        self.calls.append(("tg_limit", token))
        if "tg_limit" in self.fail_on:
            raise RuntimeError("telegram has no quota endpoint")
        return (0, 0, 0)


@pytest.fixture
def fake_client():
    return FakeGraphClient()


@pytest.fixture
def fake_discord_client():
    return FakeDiscordClient()


@pytest.fixture
def fake_telegram_client():
    return FakeTelegramClient()


@pytest.fixture
def make_publication(conn):
    """Factory: create a channel + post + N assets + a due publication; return its row."""

    def _make(post_type="single", n_assets=1, public_url="https://assets.test/a.jpg",
              scheduled_offset_min=-1, with_token=True, now=None,
              platform="instagram", remote_account_id=None, media_kind="image",
              surface="feed", story_slide=0, first_comment=None):
        # Discord has no account id at all (the webhook URL is both address and secret),
        # so its remote_account_id stays None even when the caller doesn't pass one —
        # every other platform gets a sensible per-platform default.
        if remote_account_id is None and platform != "discord":
            if platform == "facebook":
                remote_account_id = "PAGE1"
            elif platform == "threads":
                remote_account_id = "THREADS1"
            elif platform == "telegram":
                remote_account_id = "@testchannel"
            else:
                remote_account_id = "178414"
        if platform == "facebook":
            account_name = "Test FB Page"
        elif platform == "threads":
            account_name = "Test Threads"
        elif platform == "discord":
            account_name = "Test Discord"
        elif platform == "telegram":
            account_name = "Test Telegram"
        else:
            account_name = "Test IG"
        if not with_token:
            access_token = None
        elif platform == "discord":
            # A fake webhook URL — Discord's credential IS the address, not a separate token.
            access_token = "https://discord.com/api/webhooks/12345/faketoken"
        else:
            access_token = "tok-123"
        cur = conn.execute(
            """INSERT INTO channels (platform, account_name, remote_account_id, access_token)
               VALUES (?, ?, ?, ?)""",
            (platform, account_name, remote_account_id, access_token),
        )
        channel_id = cur.lastrowid
        cur = conn.execute(
            "INSERT INTO posts (caption, first_comment, post_type) "
            "VALUES ('hello world', ?, ?)",
            (first_comment, post_type),
        )
        post_id = cur.lastrowid
        asset_ids = []
        for i in range(n_assets):
            cur = conn.execute(
                """INSERT INTO assets (content_hash, media_kind, storage_path, public_url)
                   VALUES (?, ?, ?, ?)""",
                (f"hash-{post_id}-{i}", media_kind, f"assets/{post_id}-{i}.jpg",
                 (f"{public_url}?i={i}" if public_url else None)),
            )
            asset_ids.append(cur.lastrowid)
            conn.execute(
                "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,?)",
                (post_id, cur.lastrowid, i),
            )
        base = now or datetime.now(timezone.utc)
        scheduled = (base + timedelta(minutes=scheduled_offset_min)).isoformat()
        # A story publication targets exactly ONE slide (the fan-out into one row per slide
        # happens at scheduling time), so it carries that slide's asset_id. A feed
        # publication leaves asset_id NULL, meaning "all of the post's assets, in order".
        story_asset_id = (
            asset_ids[story_slide] if surface == "story" and asset_ids else None
        )
        cur = conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, surface, asset_id) "
            "VALUES (?,?,?,?,?)",
            (post_id, channel_id, scheduled, surface, story_asset_id),
        )
        conn.commit()
        return conn.execute(
            "SELECT * FROM publications WHERE id = ?", (cur.lastrowid,)
        ).fetchone()

    return _make
