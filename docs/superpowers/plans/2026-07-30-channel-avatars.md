# Channel Profile Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each channel's real account profile photo in place of its coloured dot, everywhere a channel appears in the dashboard.

**Architecture:** The Python worker fetches each channel's profile-photo URL from its platform on a 7-day cadence (or on request), downloads the bytes into `data/assets/avatars/<channel_id>.<ext>`, and records the relative path on the `channels` row. The Next.js dashboard never calls a platform API — it serves the stored bytes from a local route and sets a request flag the worker picks up. Channels with no photo render a circle in the channel's accent colour containing the account's first initial.

**Tech Stack:** SQLite (plain `.sql` migrations), Python 3 + `requests` (worker), Next.js App Router + TypeScript + `better-sqlite3` (dashboard), `node --test` for TS tests, `pytest` for Python tests.

**Spec:** `docs/superpowers/specs/2026-07-30-channel-avatars-design.md`

## Global Constraints

- **No new dependencies.** Image validation uses magic-byte sniffing from the stdlib — the worker has only `requests==2.32.3` and Pillow is deliberately not present.
- **The dashboard never calls a platform API.** All Graph/platform calls live in the worker; the two processes communicate only through the shared SQLite file.
- **Never log or store tokens.** Any error text written to `avatar_error` or a log must pass through `worker/redact.py`'s `redact()`.
- **A failure on one channel must never affect another, and must never kill the daemon.** Failures are recorded and visible, never silent.
- **Registry parity is enforced by assertion.** `worker/clients.py` defines `SUPPORTED_PLATFORMS = ("instagram", "facebook", "threads", "discord", "telegram")`; every per-platform registry asserts its keys match that tuple exactly (see `metrics._FETCHERS`, `preflight._CHECKS`). The new avatar registry must follow suit.
- **Store bytes, never the platform URL.** Profile-photo URLs are short-lived signed CDN links.
- **Migrations are additive where possible.** `channels` has no CHECK on the new columns, so `ALTER TABLE ... ADD COLUMN` is correct — follow `0010_channel_colour.sql`, not the `0008`/`0009` table-rebuild pattern.
- **Python tests run from the repo root** with the worker venv active: `source worker/.venv/bin/activate && python -m pytest worker/tests/<file> -v`
- **TS tests only run from `lib/*.test.ts` or `test/*.test.ts`** — that is the glob in `dashboard/package.json`. A test placed anywhere else silently never runs.

---

## Phase 1 — Storage, fetch, and serving (Tasks 1-5)

End state: real photos land on disk for the owner's channels and are fetchable at `/api/channels/{id}/avatar`. Nothing visible in the UI yet.

### Task 1: Migration 0012 — avatar columns

**Files:**
- Create: `migrations/0012_channel_avatar.sql`
- Test: `worker/tests/test_migration_0012.py`

**Interfaces:**
- Consumes: nothing.
- Produces: four columns on `channels` — `avatar_path TEXT`, `avatar_fetched_at TEXT`, `avatar_refresh_requested INTEGER NOT NULL DEFAULT 0`, `avatar_error TEXT`. Every later task reads or writes these names.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_migration_0012.py`. This mirrors `test_migration_0010.py` — the additive-migration pattern, with no rebuild-specific assertions.

```python
"""0012 adds the four avatar columns to `channels` via plain ALTER TABLE statements.

Additive like 0010 (no CHECK to widen, so no table rebuild and no cascade-delete
risk). These tests prove the existing rows survive untouched, the new columns exist
with the right defaults, and a path round-trips.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"
TARGET = "0012_channel_avatar.sql"


def _migrations_before_target() -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name)
    return [f for f in files if f.name < TARGET]


@pytest.fixture
def seeded_db(tmp_path):
    """A DB at migration 0011 with one seeded channel row."""
    path = tmp_path / "pre0012.db"
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON;")
    for f in _migrations_before_target():
        conn.executescript(f.read_text())
    conn.commit()
    conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram', 'SEED CH')"
    )
    conn.commit()
    conn.close()
    return path


def _apply_target(path: Path) -> sqlite3.Connection:
    """Apply 0012 exactly the way migrate.py does: BEGIN then executescript."""
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("BEGIN;")
    conn.executescript((MIGRATIONS_DIR / TARGET).read_text())
    conn.commit()
    return conn


def test_seed_is_not_vacuous(seeded_db):
    conn = sqlite3.connect(str(seeded_db))
    count = conn.execute("SELECT COUNT(*) FROM channels").fetchone()[0]
    conn.close()
    assert count == 1, "channels was not seeded — the other assertions would be vacuous"


def test_channel_row_survives_with_values_intact(seeded_db):
    conn = sqlite3.connect(str(seeded_db))
    before = conn.execute(
        "SELECT id, platform, account_name FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()

    conn = _apply_target(seeded_db)
    after = conn.execute(
        "SELECT id, platform, account_name FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()

    assert after == before


def test_new_columns_exist_with_expected_defaults(seeded_db):
    conn = _apply_target(seeded_db)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(channels)")}
    assert {"avatar_path", "avatar_fetched_at", "avatar_refresh_requested",
            "avatar_error"} <= cols

    row = conn.execute(
        "SELECT avatar_path, avatar_fetched_at, avatar_refresh_requested, avatar_error"
        " FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()
    conn.close()
    # An existing row must read as "no photo yet, nothing requested, no error" so the
    # worker's selection rule picks it up on the next cycle rather than skipping it.
    assert row == (None, None, 0, None)


def test_avatar_path_round_trips(seeded_db):
    conn = _apply_target(seeded_db)
    conn.execute(
        "UPDATE channels SET avatar_path = 'avatars/1.jpg' WHERE account_name = 'SEED CH'"
    )
    conn.commit()
    value = conn.execute(
        "SELECT avatar_path FROM channels WHERE account_name = 'SEED CH'"
    ).fetchone()[0]
    conn.close()
    assert value == "avatars/1.jpg"


def test_foreign_keys_are_intact(seeded_db):
    conn = _apply_target(seeded_db)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_migration_0012.py -v
```

Expected: FAIL — `FileNotFoundError` / `sqlite3.OperationalError`, because `migrations/0012_channel_avatar.sql` does not exist.

- [ ] **Step 3: Write the migration**

Create `migrations/0012_channel_avatar.sql`:

```sql
-- 0012_channel_avatar.sql
-- Cache each channel's account profile photo so a channel reads as the ACCOUNT it is,
-- not just as an accent colour:
--   channels.avatar_path               (new, nullable)
--   channels.avatar_fetched_at         (new, nullable)
--   channels.avatar_refresh_requested  (new, NOT NULL DEFAULT 0)
--   channels.avatar_error              (new, nullable)
--
-- avatar_path holds a path RELATIVE to the asset store (e.g. 'avatars/3.jpg'), matching
-- how assets.storage_path works — never an absolute path, and never the platform's URL.
-- Storing the URL would not work: Instagram's profile_picture_url and the Facebook Page
-- picture URL are short-lived SIGNED CDN links. They expire, so every avatar would turn
-- into a broken image within days, and the dashboard would be issuing a request to Meta
-- on every page render.
--
-- avatar_refresh_requested is the dashboard -> worker channel for the "Refresh photo"
-- button, mirroring publications.metrics_refresh_requested_at: the dashboard sets a flag,
-- the worker clears it. The dashboard never calls a platform API itself.
--
-- avatar_error keeps a failed fetch VISIBLE on the Channels page rather than silent. It
-- is redacted before it is written (worker/redact.py) — a Graph error body can carry the
-- access token as a query parameter.
--
-- Purely additive: no CHECK is involved, so SQLite's ALTER TABLE ... ADD COLUMN is enough
-- and there is no need for the table rebuild that 0008/0009 needed (and so none of the
-- cascade-delete risk a rebuild carries). Same shape as 0010_channel_colour.sql.
--
-- Every existing row defaults to "no photo yet", which the worker's selection rule picks
-- up on its next cycle.

ALTER TABLE channels ADD COLUMN avatar_path TEXT;
ALTER TABLE channels ADD COLUMN avatar_fetched_at TEXT;
ALTER TABLE channels ADD COLUMN avatar_refresh_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN avatar_error TEXT;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_migration_0012.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Run the whole worker suite to prove nothing regressed**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests -q
```

Expected: all pass. The shared `db_path` fixture applies every migration in the directory, so a broken 0012 would fail every test file, not just this one.

- [ ] **Step 6: Commit**

```bash
git add migrations/0012_channel_avatar.sql worker/tests/test_migration_0012.py
git commit -m "feat(db): add avatar columns to channels"
```

---

### Task 2: Graph client — profile photo URL lookups

**Files:**
- Modify: `worker/graph_api.py` (add three lookups plus one download helper)
- Test: `worker/tests/test_graph_api_avatars.py`

**Interfaces:**
- Consumes: `GraphClient._get(path, params)` and `GraphClient.session` / `.timeout`, which already exist.
- Produces, all on `GraphClient`:
  - `get_instagram_profile_picture_url(ig_user_id: str, token: str) -> str | None`
  - `get_page_picture_url(page_id: str, token: str) -> str | None`
  - `get_threads_profile_picture_url(threads_user_id: str, token: str) -> str | None`
  - `download_image_bytes(url: str, max_bytes: int = 5_000_000) -> bytes`

  Each URL lookup returns `None` for "this account has no real photo" and raises `GraphAPIError` for "the request failed". Task 3 depends on that distinction.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_graph_api_avatars.py`. `FakeSession` here follows the same shape as the session doubles in `test_graph_api_facebook.py`.

```python
"""Profile-photo URL lookups and the raw-bytes download, per platform.

The key behaviour these lock down is the difference between "no photo" (returns None,
the caller falls back to the initial circle) and "the request failed" (raises, the
caller records avatar_error and keeps whatever photo it already had).
"""

from __future__ import annotations

import pytest

from worker.graph_api import GraphAPIError, GraphClient


class FakeResponse:
    def __init__(self, payload=None, *, status=200, content=b"", text=""):
        self._payload = payload if payload is not None else {}
        self.status_code = status
        self.ok = 200 <= status < 300
        self.content = content
        self.text = text
        self.headers = {}

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=8192):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i : i + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, params=None, timeout=None, stream=False):
        self.calls.append((url, params, stream))
        return self.response


def _client(response):
    session = FakeSession(response)
    return GraphClient("v25.0", session=session), session


def test_instagram_returns_the_profile_picture_url():
    client, session = _client(FakeResponse({"profile_picture_url": "https://cdn/ig.jpg"}))
    assert client.get_instagram_profile_picture_url("ig1", "tok") == "https://cdn/ig.jpg"
    _, params, _ = session.calls[0]
    assert params["fields"] == "profile_picture_url"


def test_instagram_returns_none_when_the_field_is_absent():
    client, _ = _client(FakeResponse({"id": "ig1"}))
    assert client.get_instagram_profile_picture_url("ig1", "tok") is None


def test_facebook_unwraps_the_nested_picture_payload():
    client, _ = _client(
        FakeResponse({"picture": {"data": {"url": "https://cdn/fb.jpg",
                                           "is_silhouette": False}}})
    )
    assert client.get_page_picture_url("page1", "tok") == "https://cdn/fb.jpg"


def test_facebook_treats_the_default_silhouette_as_no_photo():
    # is_silhouette means the Page never set a picture — Meta still returns a URL, to a
    # generic grey figure. Storing that is strictly worse than our initial circle, which
    # at least identifies the account.
    client, _ = _client(
        FakeResponse({"picture": {"data": {"url": "https://cdn/blank.jpg",
                                           "is_silhouette": True}}})
    )
    assert client.get_page_picture_url("page1", "tok") is None


def test_threads_returns_its_own_field_name():
    client, session = _client(
        FakeResponse({"threads_profile_picture_url": "https://cdn/th.jpg"})
    )
    assert client.get_threads_profile_picture_url("th1", "tok") == "https://cdn/th.jpg"
    _, params, _ = session.calls[0]
    assert params["fields"] == "threads_profile_picture_url"


def test_a_failed_lookup_raises_rather_than_returning_none():
    client, _ = _client(FakeResponse(status=400, text="Bad token"))
    with pytest.raises(GraphAPIError):
        client.get_instagram_profile_picture_url("ig1", "tok")


def test_download_returns_the_raw_bytes():
    client, session = _client(FakeResponse(content=b"\xff\xd8\xffhello"))
    assert client.download_image_bytes("https://cdn/ig.jpg") == b"\xff\xd8\xffhello"
    _, _, stream = session.calls[0]
    assert stream is True, "the download must stream so max_bytes can stop it early"


def test_download_refuses_a_response_larger_than_max_bytes():
    client, _ = _client(FakeResponse(content=b"x" * 5000))
    with pytest.raises(GraphAPIError, match="too large"):
        client.download_image_bytes("https://cdn/ig.jpg", max_bytes=1000)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_graph_api_avatars.py -v
```

Expected: FAIL — `AttributeError: 'GraphClient' object has no attribute 'get_instagram_profile_picture_url'`.

- [ ] **Step 3: Implement the lookups**

In `worker/graph_api.py`, add a new section at the end of the `GraphClient` class:

```python
    # -- profile photos ----------------------------------------------------------------
    # Each lookup distinguishes "no photo" (None) from "the request failed" (raises).
    # avatars.py depends on that: None is a normal state that falls back to the initial
    # circle, while an exception means keep the existing photo and record an error.

    def get_instagram_profile_picture_url(self, ig_user_id: str, token: str) -> str | None:
        data = self._get(ig_user_id, {"fields": "profile_picture_url", "access_token": token})
        return data.get("profile_picture_url") or None

    def get_page_picture_url(self, page_id: str, token: str) -> str | None:
        """Page profile picture. Nested one level deeper than IG's flat field.

        `is_silhouette` means the Page never set a picture and Meta is handing back its
        generic grey figure. That is worse than our own initial circle, which at least
        says which account it is — so it is treated as "no photo".
        """
        data = self._get(
            page_id,
            {"fields": "picture.width(320).height(320)", "access_token": token},
        )
        picture = ((data.get("picture") or {}).get("data")) or {}
        if picture.get("is_silhouette"):
            return None
        return picture.get("url") or None

    def get_threads_profile_picture_url(self, threads_user_id: str, token: str) -> str | None:
        data = self._get(
            threads_user_id,
            {"fields": "threads_profile_picture_url", "access_token": token},
        )
        return data.get("threads_profile_picture_url") or None

    def download_image_bytes(self, url: str, max_bytes: int = 5_000_000) -> bytes:
        """Fetch raw bytes from an absolute CDN URL (NOT a Graph path, so it does not go
        through _get). Streams so an unexpectedly huge or endless response is stopped at
        max_bytes rather than read into memory in full.
        """
        try:
            with self.session.get(url, timeout=self.timeout, stream=True) as resp:
                if not resp.ok:
                    raise GraphAPIError(
                        f"GET avatar -> {resp.status_code}: {redact(resp.text)}"
                    )
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_content(chunk_size=8192):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise GraphAPIError(
                            f"avatar download too large (> {max_bytes} bytes)"
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
        except requests.RequestException as exc:
            raise GraphAPIError(f"GET avatar -> request failed: {redact(str(exc))}") from None
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_graph_api_avatars.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/graph_api.py worker/tests/test_graph_api_avatars.py
git commit -m "feat(worker): look up per-platform profile photo URLs"
```

---

### Task 3: Avatar selection rule

**Files:**
- Create: `worker/avatars.py`
- Test: `worker/tests/test_avatars.py`

**Interfaces:**
- Consumes: the `conn` and `config` pytest fixtures from `worker/tests/conftest.py`; the columns from Task 1.
- Produces:
  - `AVATAR_MAX_AGE_DAYS = 7`
  - `_URL_FETCHERS: dict[str, callable | None]` — keys must equal `clients.SUPPORTED_PLATFORMS`
  - `channels_needing_avatars(conn, now, asset_dir: Path) -> list[sqlite3.Row]`

  Task 4 calls `channels_needing_avatars` and reuses `_URL_FETCHERS`.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_avatars.py`:

```python
"""Which channels the avatar job selects, and which it leaves alone."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from worker.avatars import channels_needing_avatars

NOW = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)


def _channel(conn, *, platform="instagram", name="C", token="tok", account="ig1",
             fetched_at=None, path=None, requested=0, active=1):
    cid = conn.execute(
        """INSERT INTO channels
             (platform, account_name, remote_account_id, access_token, is_active,
              avatar_path, avatar_fetched_at, avatar_refresh_requested)
           VALUES (?,?,?,?,?,?,?,?)""",
        (platform, name, account, token, active, path, fetched_at, requested),
    ).lastrowid
    conn.commit()
    return cid


def _ids(conn, asset_dir):
    return [r["id"] for r in channels_needing_avatars(conn, NOW, asset_dir)]


def test_a_channel_with_no_photo_is_selected(conn, tmp_path):
    cid = _channel(conn)
    assert _ids(conn, tmp_path) == [cid]


def test_a_recently_fetched_channel_is_skipped(conn, tmp_path):
    fetched = (NOW - timedelta(hours=1)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg")
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "1.jpg").write_bytes(b"x")
    assert _ids(conn, tmp_path) == []
    assert cid  # the row exists; it was skipped on freshness, not absence


def test_a_stale_channel_is_selected(conn, tmp_path):
    fetched = (NOW - timedelta(days=8)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg")
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "1.jpg").write_bytes(b"x")
    assert _ids(conn, tmp_path) == [cid]


def test_a_requested_refresh_beats_freshness(conn, tmp_path):
    fetched = (NOW - timedelta(hours=1)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg", requested=1)
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "1.jpg").write_bytes(b"x")
    assert _ids(conn, tmp_path) == [cid]


def test_a_missing_file_beats_freshness(conn, tmp_path):
    # The restored-backup case: avatars are deliberately not in the export bundle, so
    # after a restore the DB says "fetched an hour ago" while the disk has nothing.
    # Without this rule the avatar stays broken for a week.
    fetched = (NOW - timedelta(hours=1)).isoformat()
    cid = _channel(conn, fetched_at=fetched, path="avatars/1.jpg")
    assert _ids(conn, tmp_path) == [cid]


def test_unsupported_platforms_are_never_selected(conn, tmp_path):
    _channel(conn, platform="discord", name="D", account="hook1")
    _channel(conn, platform="telegram", name="T", account="chat1")
    assert _ids(conn, tmp_path) == []


def test_channels_without_credentials_are_skipped(conn, tmp_path):
    _channel(conn, token=None, name="NoToken")
    _channel(conn, account=None, name="NoAccount")
    assert _ids(conn, tmp_path) == []


def test_inactive_channels_are_skipped(conn, tmp_path):
    _channel(conn, active=0)
    assert _ids(conn, tmp_path) == []


def test_registry_covers_every_supported_platform():
    from worker.avatars import _URL_FETCHERS
    from worker.clients import SUPPORTED_PLATFORMS

    assert set(_URL_FETCHERS) == set(SUPPORTED_PLATFORMS)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_avatars.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'worker.avatars'`.

- [ ] **Step 3: Write the module**

Create `worker/avatars.py`:

```python
"""Channel profile-photo (avatar) fetch job.

Each channel's account has a profile photo on its platform. Caching it locally lets the
dashboard show WHICH ACCOUNT a channel is, rather than just an accent colour.

The bytes are stored, not the URL: Instagram's profile_picture_url and the Facebook Page
picture URL are short-lived SIGNED CDN links, so a stored URL would break within days and
would make the dashboard talk to Meta on every render.

Throttling: a channel is refreshed at most once every AVATAR_MAX_AGE_DAYS, unless the
dashboard has requested one or the file has gone missing from disk.
"""

from __future__ import annotations

import sqlite3
from datetime import timedelta
from pathlib import Path

from .clients import SUPPORTED_PLATFORMS

# A profile photo changes rarely, and a stale one is a cosmetic problem rather than a
# correctness one — so this is deliberately slow. The dashboard's "Refresh photo" button
# is the escape hatch when the owner changes a photo and wants it now.
AVATAR_MAX_AGE_DAYS = 7


def _instagram_url(client, channel) -> str | None:
    return client.get_instagram_profile_picture_url(
        channel["remote_account_id"], channel["access_token"]
    )


def _facebook_url(client, channel) -> str | None:
    return client.get_page_picture_url(
        channel["remote_account_id"], channel["access_token"]
    )


def _threads_url(client, channel) -> str | None:
    return client.get_threads_profile_picture_url(
        channel["remote_account_id"], channel["access_token"]
    )


_URL_FETCHERS = {
    "instagram": _instagram_url,
    "facebook": _facebook_url,
    "threads": _threads_url,
    # None means "this platform has no account avatar to fetch" — a Discord webhook and a
    # Telegram chat target have no per-channel profile photo we can read the way IG/FB/
    # Threads do. Distinct from a platform simply missing from this dict, which would mean
    # someone forgot to register it. Telegram COULD be supported later via
    # getChat -> getFile -> download; it is out of scope deliberately, not by oversight.
    "discord": None,
    "telegram": None,
}

assert set(_URL_FETCHERS) == set(SUPPORTED_PLATFORMS), (
    "avatars._URL_FETCHERS and clients.SUPPORTED_PLATFORMS disagree"
)


def channels_needing_avatars(conn, now, asset_dir: Path) -> list[sqlite3.Row]:
    """Active, credentialled channels on a platform that HAS avatars, which are either
    stale, explicitly requested, or missing their file on disk.

    Platforms with no avatar support are excluded in SQL rather than skipped later, so
    they are not reselected every cycle only to be discarded every cycle (same reasoning
    as metrics.publications_needing_metrics).
    """
    no_avatar_platforms = [p for p, fetch in _URL_FETCHERS.items() if fetch is None]
    exclude_clause = ""
    params: list = []
    if no_avatar_platforms:
        placeholders = ",".join("?" for _ in no_avatar_platforms)
        exclude_clause = f"AND platform NOT IN ({placeholders}) "
        params.extend(no_avatar_platforms)

    stale_cutoff = (now - timedelta(days=AVATAR_MAX_AGE_DAYS)).isoformat()
    params.append(stale_cutoff)

    rows = conn.execute(
        f"""
        SELECT * FROM channels
        WHERE is_active = 1
          AND remote_account_id IS NOT NULL AND remote_account_id != ''
          AND access_token IS NOT NULL AND access_token != ''
          {exclude_clause}
          AND (
                avatar_refresh_requested = 1
             OR avatar_fetched_at IS NULL
             OR avatar_fetched_at < ?
             OR avatar_path IS NOT NULL
          )
        ORDER BY id
        """,
        params,
    ).fetchall()

    # The "file is missing from disk" arm cannot be expressed in SQL, so the query above
    # over-selects (any row WITH a path) and this filter removes the ones whose file is
    # actually present and still fresh.
    selected = []
    for row in rows:
        if row["avatar_refresh_requested"] == 1:
            selected.append(row)
            continue
        fetched_at = row["avatar_fetched_at"]
        if fetched_at is None or fetched_at < stale_cutoff:
            selected.append(row)
            continue
        path = row["avatar_path"]
        if path and not (asset_dir / path).exists():
            selected.append(row)
    return selected
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_avatars.py -v
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/avatars.py worker/tests/test_avatars.py
git commit -m "feat(worker): select which channels need an avatar refresh"
```

---

### Task 4: Fetch, validate, and store the bytes

**Files:**
- Modify: `worker/avatars.py` (add `run_avatars` and the write path)
- Modify: `worker/run.py:166-170` (call it after `run_metrics`)
- Test: `worker/tests/test_avatars_run.py`

**Interfaces:**
- Consumes: `channels_needing_avatars` and `_URL_FETCHERS` from Task 3; `download_image_bytes` from Task 2; `redact()` from `worker/redact.py`.
- Produces: `run_avatars(conn, config, client, now, *, logger=None, client_for=None) -> int`, returning the number of channels refreshed. Signature deliberately mirrors `metrics.run_metrics`.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_avatars_run.py`:

```python
"""Fetching, validating and storing avatar bytes — including every failure mode."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from worker.avatars import run_avatars

NOW = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
JPEG = b"\xff\xd8\xff" + b"body-one"
JPEG_TWO = b"\xff\xd8\xff" + b"body-two"
PNG = b"\x89PNG\r\n\x1a\n" + b"body"


class FakeAvatarClient:
    """Only the two methods the avatar job uses."""

    def __init__(self, url="https://cdn/pic.jpg", payload=JPEG, fail_on=None):
        self.url = url
        self.payload = payload
        self.fail_on = set(fail_on or [])
        self.downloads = 0

    def get_instagram_profile_picture_url(self, account_id, token):
        if "url" in self.fail_on:
            raise RuntimeError("lookup boom")
        return self.url

    def download_image_bytes(self, url, max_bytes=5_000_000):
        self.downloads += 1
        if "download" in self.fail_on:
            raise RuntimeError("download boom")
        return self.payload


def _channel(conn, **kw):
    cid = conn.execute(
        """INSERT INTO channels
             (platform, account_name, remote_account_id, access_token)
           VALUES ('instagram', 'C', 'ig1', 'tok')"""
    ).lastrowid
    if kw:
        sets = ", ".join(f"{k} = ?" for k in kw)
        conn.execute(f"UPDATE channels SET {sets} WHERE id = ?", (*kw.values(), cid))
    conn.commit()
    return cid


def _row(conn, cid):
    return conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()


def test_a_successful_fetch_writes_the_file_and_records_the_path(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient()

    assert run_avatars(conn, config, client, NOW) == 1

    row = _row(conn, cid)
    assert row["avatar_path"] == f"avatars/{cid}.jpg"
    assert row["avatar_fetched_at"] == NOW.isoformat()
    assert row["avatar_error"] is None
    assert (config.asset_storage_dir / row["avatar_path"]).read_bytes() == JPEG


def test_the_extension_follows_the_actual_bytes_not_the_url(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient(url="https://cdn/pic.jpg", payload=PNG)

    run_avatars(conn, config, client, NOW)

    assert _row(conn, cid)["avatar_path"] == f"avatars/{cid}.png"


def test_a_non_image_response_is_rejected_and_nothing_is_written(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient(payload=b"<html>Sorry, an error occurred</html>")

    assert run_avatars(conn, config, client, NOW) == 0

    row = _row(conn, cid)
    assert row["avatar_path"] is None
    assert "not an image" in row["avatar_error"]
    assert not (config.asset_storage_dir / "avatars").exists() or not list(
        (config.asset_storage_dir / "avatars").iterdir()
    )


def test_a_failed_lookup_keeps_the_existing_photo(conn, config):
    cid = _channel(conn, avatar_path="avatars/existing.jpg")
    (config.asset_storage_dir / "avatars").mkdir(parents=True, exist_ok=True)
    (config.asset_storage_dir / "avatars" / "existing.jpg").write_bytes(JPEG)
    client = FakeAvatarClient(fail_on=["url"])

    run_avatars(conn, config, client, NOW)

    row = _row(conn, cid)
    assert row["avatar_path"] == "avatars/existing.jpg", "must not clear a working photo"
    assert row["avatar_error"]
    assert (config.asset_storage_dir / "avatars" / "existing.jpg").exists()


def test_a_failure_clears_the_refresh_request_so_a_click_cannot_wedge(conn, config):
    cid = _channel(conn, avatar_refresh_requested=1)
    client = FakeAvatarClient(fail_on=["download"])

    run_avatars(conn, config, client, NOW)

    assert _row(conn, cid)["avatar_refresh_requested"] == 0


def test_no_photo_on_the_account_is_recorded_without_an_error(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient(url=None)

    run_avatars(conn, config, client, NOW)

    row = _row(conn, cid)
    assert row["avatar_path"] is None
    assert row["avatar_error"] is None, "having no photo is a normal state, not a failure"
    assert row["avatar_fetched_at"] == NOW.isoformat(), "so it is not retried every cycle"


def test_an_unchanged_photo_is_not_rewritten(conn, config):
    cid = _channel(conn)
    client = FakeAvatarClient()
    run_avatars(conn, config, client, NOW)
    path = config.asset_storage_dir / _row(conn, cid)["avatar_path"]
    first_mtime = path.stat().st_mtime_ns

    later = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
    run_avatars(conn, config, client, later)

    assert path.stat().st_mtime_ns == first_mtime, "same content hash — no rewrite"
    assert _row(conn, cid)["avatar_fetched_at"] == later.isoformat()


def test_a_changed_photo_replaces_the_file(conn, config):
    cid = _channel(conn)
    run_avatars(conn, config, FakeAvatarClient(payload=JPEG), NOW)

    later = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
    run_avatars(conn, config, FakeAvatarClient(payload=JPEG_TWO), later)

    path = config.asset_storage_dir / _row(conn, cid)["avatar_path"]
    assert path.read_bytes() == JPEG_TWO


def test_one_channel_failing_does_not_stop_the_next(conn, config):
    first = _channel(conn)
    second = conn.execute(
        """INSERT INTO channels (platform, account_name, remote_account_id, access_token)
           VALUES ('instagram', 'C2', 'ig2', 'tok2')"""
    ).lastrowid
    conn.commit()

    class HalfBroken(FakeAvatarClient):
        def get_instagram_profile_picture_url(self, account_id, token):
            if account_id == "ig1":
                raise RuntimeError("lookup boom")
            return self.url

    assert run_avatars(conn, config, HalfBroken(), NOW) == 1
    assert _row(conn, first)["avatar_error"]
    assert _row(conn, second)["avatar_path"] == f"avatars/{second}.jpg"


def test_the_token_never_reaches_avatar_error(conn, config):
    cid = _channel(conn)

    class LeakyClient(FakeAvatarClient):
        def get_instagram_profile_picture_url(self, account_id, token):
            raise RuntimeError("GET failed: access_token=EAAsupersecrettokenvalue")

    run_avatars(conn, config, LeakyClient(), NOW)

    assert "EAAsupersecrettokenvalue" not in _row(conn, cid)["avatar_error"]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_avatars_run.py -v
```

Expected: FAIL — `ImportError: cannot import name 'run_avatars' from 'worker.avatars'`.

- [ ] **Step 3: Implement `run_avatars`**

Append to `worker/avatars.py` (and add `import hashlib`, `import os`, and `from .redact import redact` to the imports at the top):

```python
# Magic-byte signatures, so a Graph error page or an HTML redirect can never be written
# to disk as `avatars/3.jpg` and then served to the dashboard as an image. Sniffed rather
# than trusting Content-Type or the URL's extension, and done with the stdlib rather than
# by adding Pillow — the worker's only dependency is `requests`, and this is the whole of
# what we need image parsing for.
_IMAGE_SIGNATURES = (
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _image_extension(data: bytes) -> str | None:
    """Return the file extension for `data`, or None if it is not an image we accept."""
    for signature, ext in _IMAGE_SIGNATURES:
        if data.startswith(signature):
            return ext
    # WebP is RIFF-framed: "RIFF" + 4 size bytes + "WEBP".
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _store_avatar(asset_dir: Path, channel_id: int, data: bytes, ext: str) -> str:
    """Write `data` to avatars/<channel_id>.<ext> and return the store-relative path.

    Writes to a temp file in the same directory and renames, so a crash mid-write can
    never leave a half-written image where a valid one used to be (os.replace is atomic
    within a filesystem).
    """
    avatar_dir = asset_dir / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    final = avatar_dir / f"{channel_id}.{ext}"
    tmp = avatar_dir / f".{channel_id}.{ext}.tmp"
    tmp.write_bytes(data)
    os.replace(tmp, final)
    return f"avatars/{final.name}"


def run_avatars(conn, config, client, now, *, logger=None, client_for=None) -> int:
    """Refresh every due channel's avatar. Returns the count actually refreshed.

    Read-only against the platform — it publishes nothing — so it runs regardless of
    DRY_RUN, the same way metrics fetching is gated on the publication rather than on the
    fetch being suppressed.

    Every failure is per-channel: it is recorded on that row and the loop continues. This
    job must never raise, and must never leave a channel without the photo it already had.
    """
    now_iso = now.isoformat()
    pick_client = client_for or (lambda _platform: client)
    due = channels_needing_avatars(conn, now, Path(config.asset_storage_dir))
    refreshed = 0

    for channel in due:
        channel_id = channel["id"]
        try:
            fetch_url = _URL_FETCHERS[channel["platform"]]
            url = fetch_url(pick_client(channel["platform"]), channel)

            if not url:
                # The account genuinely has no photo (or Meta returned its default
                # silhouette). Not a failure — stamp the timestamp so this is not retried
                # every single cycle, and let the initial circle stand.
                conn.execute(
                    "UPDATE channels SET avatar_fetched_at = ?, avatar_error = NULL,"
                    " avatar_refresh_requested = 0, updated_at = ? WHERE id = ?",
                    (now_iso, now_iso, channel_id),
                )
                conn.commit()
                continue

            data = pick_client(channel["platform"]).download_image_bytes(url)
            ext = _image_extension(data)
            if ext is None:
                raise ValueError(
                    "response body is not an image we recognise "
                    "(expected JPEG, PNG, GIF or WebP)"
                )

            existing_rel = channel["avatar_path"]
            existing_abs = (
                Path(config.asset_storage_dir) / existing_rel if existing_rel else None
            )
            unchanged = (
                existing_abs is not None
                and existing_abs.exists()
                and hashlib.sha256(existing_abs.read_bytes()).hexdigest()
                == hashlib.sha256(data).hexdigest()
            )
            # Hash comparison, not filename or byte length — the project's dedup rule
            # everywhere else. Skipping the rewrite keeps the file's mtime meaningful and
            # avoids touching the disk every week for a photo that never changes.
            rel = existing_rel if unchanged else _store_avatar(
                Path(config.asset_storage_dir), channel_id, data, ext
            )

            conn.execute(
                "UPDATE channels SET avatar_path = ?, avatar_fetched_at = ?,"
                " avatar_error = NULL, avatar_refresh_requested = 0, updated_at = ?"
                " WHERE id = ?",
                (rel, now_iso, now_iso, channel_id),
            )
            conn.commit()
            refreshed += 1

        except Exception as exc:  # noqa: BLE001 — deliberately broad; never kill the daemon
            message = redact(f"avatar fetch failed: {exc}")
            if logger:
                logger.warning("[avatar ch %s] %s", channel_id, message)
            # avatar_path is deliberately NOT cleared: a working photo must survive a
            # transient failure. avatar_refresh_requested IS cleared, so a click that
            # always fails cannot wedge this channel into retrying every cycle forever.
            conn.execute(
                "UPDATE channels SET avatar_error = ?, avatar_refresh_requested = 0,"
                " updated_at = ? WHERE id = ?",
                (message, now_iso, channel_id),
            )
            conn.commit()

    return refreshed
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests/test_avatars_run.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Wire it into the worker cycle**

In `worker/run.py`, in `run_once`, extend the block that currently ends the cycle (around lines 166-170):

```python
    # Refresh metrics for already-published posts (throttled per publication).
    from .metrics import run_metrics

    run_metrics(conn, config, client, now, logger=logger, client_for=client_for)

    # Refresh channel avatars (throttled per channel, ~weekly). Read-only against the
    # platform, so it runs in dry-run mode too — it publishes nothing.
    from .avatars import run_avatars

    run_avatars(conn, config, client, now, logger=logger, client_for=client_for)
    return processed
```

- [ ] **Step 6: Run the whole worker suite**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests -q
```

Expected: all pass. `worker/tests/test_run.py` exercises `run_once`, so this proves the new call does not disturb the existing cycle.

- [ ] **Step 7: Commit**

```bash
git add worker/avatars.py worker/run.py worker/tests/test_avatars_run.py
git commit -m "feat(worker): fetch and store channel profile photos"
```

---

### Task 5: Serve the stored avatar

**Files:**
- Create: `dashboard/app/api/channels/[id]/avatar/route.ts`
- Modify: `dashboard/lib/types.ts:49` (add the four fields to `Channel`)
- Test: `dashboard/lib/avatar-files.test.ts`
- Create: `dashboard/lib/avatar-files.ts`

**Interfaces:**
- Consumes: `resolveInsideStore(base, rel)` from `dashboard/lib/asset-files.ts`; `getChannel(id)` from `dashboard/lib/queries.ts`; `config.assetStorageDir` from `dashboard/lib/config.ts`.
- Produces: `avatarContentType(rel: string): string` from `dashboard/lib/avatar-files.ts`, and the route `GET /api/channels/[id]/avatar`. Task 7 consumes the route URL.

Note on test placement: `dashboard/package.json`'s test script globs only `lib/*.test.ts` and `test/*.test.ts`. That is why the MIME logic lives in `lib/avatar-files.ts` rather than inline in the route — a test file next to the route would never be run.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/avatar-files.test.ts`:

```ts
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { avatarContentType } from "./avatar-files";

// asset-files.ts imports config.ts, which reads ASSET_STORAGE_DIR ONCE at module load —
// so it must be set before that module is imported, which is why resolveInsideStore comes
// in through a dynamic import below rather than a static one at the top. Same pattern as
// lib/asset-files.test.ts. avatar-files.ts itself imports only node:path, so it is safe to
// import statically.
const STORE = mkdtempSync(path.join(tmpdir(), "ss-avatar-"));
process.env.ASSET_STORAGE_DIR = STORE;

let resolveInsideStore: typeof import("./asset-files").resolveInsideStore;

before(async () => {
  ({ resolveInsideStore } = await import("./asset-files"));
});

describe("avatarContentType", () => {
  it("maps each stored extension to its image type", () => {
    assert.equal(avatarContentType("avatars/1.jpg"), "image/jpeg");
    assert.equal(avatarContentType("avatars/1.png"), "image/png");
    assert.equal(avatarContentType("avatars/1.webp"), "image/webp");
    assert.equal(avatarContentType("avatars/1.gif"), "image/gif");
  });

  it("falls back to a generic type rather than guessing", () => {
    assert.equal(avatarContentType("avatars/1.bin"), "application/octet-stream");
  });
});

describe("avatar path containment", () => {
  // The route resolves avatar_path the same way the media route resolves storage_path.
  // These paths come out of the database, so the containment rule is what stands between
  // a database string and reading an arbitrary file off the owner's disk.
  const base = path.resolve("/store");

  it("accepts a path inside the store", () => {
    assert.equal(resolveInsideStore(base, "avatars/3.jpg"), path.join(base, "avatars/3.jpg"));
  });

  it("rejects a traversal out of the store", () => {
    assert.equal(resolveInsideStore(base, "../../etc/passwd"), null);
  });

  it("rejects an absolute path", () => {
    assert.equal(resolveInsideStore(base, "/etc/passwd"), null);
  });

  it("rejects a sibling directory that merely shares the prefix", () => {
    assert.equal(resolveInsideStore(base, "../store-old/avatars/3.jpg"), null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard && npm test
```

Expected: FAIL — cannot resolve `./avatar-files`.

- [ ] **Step 3: Write the helper and the route**

Create `dashboard/lib/avatar-files.ts`:

```ts
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Content type for a stored avatar, derived from its extension.
 *
 * The extension is trustworthy here in a way it would not be for user uploads: the worker
 * writes it from the file's own magic bytes (worker/avatars.py `_image_extension`), never
 * from the CDN URL. Split out from the route so it can be tested — dashboard/package.json
 * only globs lib/*.test.ts and test/*.test.ts.
 */
export function avatarContentType(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
```

Create `dashboard/app/api/channels/[id]/avatar/route.ts`:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { config } from "@/lib/config";
import { getChannel } from "@/lib/queries";
import { resolveInsideStore } from "@/lib/asset-files";
import { avatarContentType } from "@/lib/avatar-files";

export const runtime = "nodejs";

/**
 * Serve a channel's cached profile photo for in-dashboard display only.
 *
 * Mirrors app/api/media/[id]/route.ts, minus the range support — an avatar is never
 * seeked. The photo is served from OUR disk rather than hotlinked from the platform
 * because the platform URLs are short-lived signed CDN links (see migration 0012).
 *
 * A missing file is a 404, not an error: the worker may not have fetched this channel
 * yet, and the UI's fallback is a normal state rather than a failure.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = getChannel(Number(id));
  if (!channel?.avatar_path) {
    return NextResponse.json({ error: "No avatar." }, { status: 404 });
  }

  const abs = resolveInsideStore(config.assetStorageDir, channel.avatar_path);
  if (!abs) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(abs);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": avatarContentType(channel.avatar_path),
        "Cache-Control": "private, max-age=3600",
        "Content-Length": String(buf.length),
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing on disk." }, { status: 404 });
  }
}
```

- [ ] **Step 4: Add the fields to the `Channel` type**

In `dashboard/lib/types.ts`, in the `Channel` interface, after `color_hue: number | null;`:

```ts
  color_hue: number | null;
  avatar_path: string | null;
  avatar_fetched_at: string | null;
  avatar_refresh_requested: number;
  avatar_error: string | null;
}
```

No query change is needed — `getChannels()`, `getActiveChannels()` and `getChannel()` all `SELECT *`, so the new columns come through as soon as the migration has run.

- [ ] **Step 5: Run the tests and the type check**

```bash
cd dashboard && npm test && npx tsc --noEmit
```

Expected: tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/avatar-files.ts dashboard/lib/avatar-files.test.ts dashboard/lib/types.ts "dashboard/app/api/channels/[id]/avatar/route.ts"
git commit -m "feat(dashboard): serve cached channel avatars"
```

---

### Phase 1 checkpoint — verify against the real install

Before starting Phase 2, prove the pipeline works end to end on the owner's actual data.

- [ ] **Step 1: Apply the migration**

```bash
python3 scripts/migrate.py
```

- [ ] **Step 2: Run one worker cycle**

```bash
source worker/.venv/bin/activate && python -m worker.run --once
```

(If `--once` is not a supported flag, start the worker normally and stop it after one cycle.)

- [ ] **Step 3: Confirm the photos landed**

```bash
sqlite3 data/socialscheduler.db "SELECT id, account_name, avatar_path, avatar_fetched_at, avatar_error FROM channels;"
```

Expected: each Instagram/Facebook/Threads channel has an `avatar_path` and a recent `avatar_fetched_at`, and `avatar_error` is NULL. Discord/Telegram rows are untouched.

- [ ] **Step 4: Confirm the files exist and the route serves them**

```bash
ls -la data/assets/avatars/
```

Then start the dashboard and open `http://localhost:3939/api/channels/1/avatar` — the photo should render in the browser.

---

## Phase 2 — Channels page (Tasks 6-7)

### Task 6: Refresh request endpoint

**Files:**
- Create: `dashboard/app/api/channels/[id]/avatar/refresh/route.ts`
- Modify: `dashboard/lib/queries.ts` (add `requestAvatarRefresh`)

**Interfaces:**
- Consumes: `getDb()` and `getChannel(id)` from `dashboard/lib/queries.ts`.
- Produces: `requestAvatarRefresh(channelId: number): void` and `POST /api/channels/[id]/avatar/refresh`, which Task 7's button calls.

- [ ] **Step 1: Add the query**

In `dashboard/lib/queries.ts`, in the Channels section (after `getChannel`, around line 36):

```ts
/**
 * Ask the worker to re-fetch this channel's profile photo on its next cycle.
 *
 * This sets a flag and nothing else — the dashboard never calls a platform API. Same
 * dashboard-to-worker handoff as metrics_refresh_requested_at on publications. The worker
 * clears the flag whether the fetch succeeds or fails, so a persistently failing channel
 * cannot wedge itself into retrying every cycle.
 */
export function requestAvatarRefresh(channelId: number): void {
  getDb()
    .prepare("UPDATE channels SET avatar_refresh_requested = 1 WHERE id = ?")
    .run(channelId);
}
```

- [ ] **Step 2: Write the route**

Create `dashboard/app/api/channels/[id]/avatar/refresh/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getChannel, requestAvatarRefresh } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * Queue an avatar refresh for a channel.
 *
 * Deliberately does no network work: the worker owns every platform call, and the DB is
 * the contract between the two. The response says "queued", never "refreshed" — the photo
 * changes when the worker next runs, which is what the UI tells the owner.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = getChannel(Number(id));
  if (!channel) {
    return NextResponse.json({ error: "Channel not found." }, { status: 404 });
  }
  if (!channel.remote_account_id || !channel.access_token) {
    return NextResponse.json(
      { error: "Add an account id and access token first." },
      { status: 400 }
    );
  }
  requestAvatarRefresh(channel.id);
  return NextResponse.json({ ok: true, queued: true });
}
```

- [ ] **Step 3: Type check**

```bash
cd dashboard && npx tsc --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add dashboard/lib/queries.ts "dashboard/app/api/channels/[id]/avatar/refresh/route.ts"
git commit -m "feat(dashboard): queue an avatar refresh for the worker"
```

---

### Task 7: `ChannelAvatar` component and the Channels page

**Files:**
- Modify: `dashboard/components/ui.tsx` (add `ChannelAvatar`)
- Create: `dashboard/components/channel-avatar-refresh.tsx`
- Modify: `dashboard/app/channels/page.tsx:47` (avatar, refresh control, error)

**Interfaces:**
- Consumes: `channelColor(id, colorHue)` from `dashboard/lib/format.ts`; the route from Task 5; the endpoint from Task 6.
- Produces: `<ChannelAvatar id name colorHue avatarPath size />`, which Task 8 uses at every call site.

- [ ] **Step 1: Add `ChannelAvatar` to `dashboard/components/ui.tsx`**

Insert above `ChannelChip` (currently line 48):

```tsx
/**
 * A channel's account profile photo, or a coloured circle with its initial.
 *
 * Both branches render at exactly `size`, so a chip never changes shape depending on
 * whether a photo has been fetched yet. The fallback uses the channel's accent colour and
 * first initial rather than a generic placeholder: two channels on the same platform are
 * told apart by the initial, which a plain dot could not do.
 *
 * Decorative — the account name is always rendered next to it — so it is hidden from
 * assistive tech rather than repeating that name.
 */
export function ChannelAvatar({
  id,
  name,
  colorHue,
  avatarPath,
  size = 14,
}: {
  id: number;
  name: string;
  colorHue?: number | null;
  avatarPath?: string | null;
  size?: number;
}) {
  const c = channelColor(id, colorHue);
  const dimensions = { width: size, height: size };

  if (avatarPath) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- next/image adds an
      // optimizer round-trip for a local file we already serve at the right size.
      <img
        src={`/api/channels/${id}/avatar`}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={dimensions}
      />
    );
  }

  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ ...dimensions, backgroundColor: c.dot, fontSize: Math.round(size * 0.55) }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
```

- [ ] **Step 2: Write the refresh control**

Create `dashboard/components/channel-avatar-refresh.tsx`, following `channel-color.tsx`'s client-component pattern:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * "Refresh photo" for a channel.
 *
 * The button queues a request rather than fetching anything — the worker owns every
 * platform call. The copy says so plainly, because a button that appears to do nothing
 * for a minute is otherwise indistinguishable from a broken one.
 */
export function ChannelAvatarRefresh({
  channelId,
  avatarError,
}: {
  channelId: number;
  avatarError: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const res = await fetch(`/api/channels/${channelId}/avatar/refresh`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not queue a refresh.");
      return;
    }
    setQueued(true);
    startTransition(() => router.refresh());
  }

  return (
    <div className="mt-2">
      <button
        onClick={refresh}
        disabled={pending}
        className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
      >
        Refresh photo
      </button>
      {queued ? (
        <p className="mt-1 text-xs text-muted">
          Queued — the worker picks this up on its next cycle. Nothing happens while the
          worker isn&rsquo;t running.
        </p>
      ) : null}
      {error ? <p className="mt-1 text-xs text-status-failed">{error}</p> : null}
      {avatarError ? (
        <p className="mt-1 text-xs text-status-failed">
          Last fetch failed: {avatarError}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Put them on the Channels page**

In `dashboard/app/channels/page.tsx`, add the imports:

```tsx
import { PageHeader, ChannelChip, ChannelAvatar, EmptyState } from "@/components/ui";
import { ChannelAvatarRefresh } from "@/components/channel-avatar-refresh";
```

Then replace the header block (currently lines 45-53) with:

```tsx
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <ChannelAvatar
                      id={c.id}
                      name={c.account_name}
                      colorHue={c.color_hue}
                      avatarPath={c.avatar_path}
                      size={40}
                    />
                    <div>
                      <ChannelChip id={c.id} platform={c.platform} name={c.account_name} colorHue={c.color_hue} />
                      {c.business_label ? (
                        <p className="mt-1.5 text-xs text-muted">{c.business_label}</p>
                      ) : null}
                      {usesAccountId(c.platform) ? (
                        <ChannelAvatarRefresh
                          channelId={c.id}
                          avatarError={c.avatar_error}
                        />
                      ) : null}
                    </div>
                  </div>
                  <span className="data text-[11px] text-faint">#{c.id}</span>
                </div>
```

`usesAccountId` is already imported on this page and is what distinguishes the platforms that have an account to read a photo from (Instagram, Facebook, Threads) from the ones that do not (Discord's webhook, Telegram's chat id) — so Discord and Telegram get the initial circle with no refresh button, which is the correct end state rather than a missing feature.

`ChannelChip` is deliberately left alone in this task — it does not yet accept an `avatarPath` prop (that arrives in Task 8), and on this page the 40px avatar sits directly beside the chip, so a second avatar inside the chip would be redundant here regardless.

- [ ] **Step 4: Verify in the browser**

Start the dev server (port 3939) and open `/channels`. Confirm:
- each Instagram/Facebook/Threads channel shows its real photo at 40px
- a channel with no photo shows its accent-coloured circle with the right initial
- Discord/Telegram channels show the initial circle and no "Refresh photo" button
- clicking "Refresh photo" shows the queued message
- toggling the theme keeps the initial legible in both light and dark

Take a screenshot for the record.

- [ ] **Step 5: Type check and lint**

```bash
cd dashboard && npx tsc --noEmit && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/ui.tsx dashboard/components/channel-avatar-refresh.tsx dashboard/app/channels/page.tsx
git commit -m "feat(dashboard): show account photos on the Channels page"
```

---

## Phase 3 — Avatars everywhere (Task 8)

### Task 8: Replace the coloured dot at every call site

**Files:**
- Modify: `dashboard/components/ui.tsx` (`ChannelChip` takes `avatarPath`)
- Modify: `dashboard/lib/queries.ts:809`, `dashboard/lib/queries.ts:967` (add `channel_avatar_path` to the two flattened selects), and the row types at `dashboard/lib/queries.ts:945` and `dashboard/lib/types.ts:134`
- Modify: `dashboard/components/publication-queue.tsx:157`, `dashboard/components/post-sends-panel.tsx:86` (pass it through `ChannelChip`)
- Modify: `dashboard/components/composer.tsx:533`, `dashboard/components/composer.tsx:729`, `dashboard/components/post-editor.tsx:281`, `dashboard/components/library-view.tsx:575`, `dashboard/components/schedule-from-library.tsx:262`, `dashboard/components/bulk-import.tsx:228`, `dashboard/components/post-sends-panel.tsx:341`, `dashboard/app/page.tsx:57`

**Interfaces:**
- Consumes: `ChannelAvatar` from Task 7.
- Produces: no new interfaces — this task is the rollout.

Two distinct groups here, and they need different treatment:

1. **Via `ChannelChip`** (`publication-queue.tsx`, `post-sends-panel.tsx:86`, `app/channels/page.tsx`) — these render channel data flattened by a JOIN, so the SQL and the row types need a new `channel_avatar_path` field before the prop can be passed.
2. **Rendering their own dot from `channelColor()`** (the rest) — these already hold a full `Channel` object, so `c.avatar_path` is available with no query change.

- [ ] **Step 1: Add the field to the two flattened queries**

In `dashboard/lib/queries.ts` around line 809:

```ts
              c.timezone AS channel_timezone, c.color_hue AS channel_color_hue,
              c.avatar_path AS channel_avatar_path
```

And around line 967:

```ts
         c.color_hue    AS channel_color_hue,
         c.avatar_path  AS channel_avatar_path,
```

Then add `channel_avatar_path: string | null;` to the row type at `queries.ts:945` and to the interface at `types.ts:134` (immediately after each `channel_color_hue` declaration).

- [ ] **Step 2: Teach `ChannelChip` to use the avatar**

In `dashboard/components/ui.tsx`, change `ChannelChip` to accept `avatarPath` and swap the 8px dot for the avatar:

```tsx
export function ChannelChip({
  id,
  platform,
  name,
  colorHue,
  avatarPath,
}: {
  id: number;
  platform: string;
  name: string;
  colorHue?: number | null;
  avatarPath?: string | null;
}) {
  const c = channelColor(id, colorHue);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ color: c.fg, backgroundColor: c.bg }}
    >
      <ChannelAvatar id={id} name={name} colorHue={colorHue} avatarPath={avatarPath} size={14} />
      {name}
      <span className="text-[10px] uppercase tracking-wide opacity-60">
        {platformBadge(platform)}
      </span>
    </span>
  );
}
```

- [ ] **Step 3: Pass it in at the two flattened call sites**

`dashboard/components/publication-queue.tsx:157` — add below `colorHue={p.channel_color_hue}`:

```tsx
                      colorHue={p.channel_color_hue}
                      avatarPath={p.channel_avatar_path}
```

`dashboard/components/post-sends-panel.tsx:86` — add below `colorHue={send.channel_color_hue}`:

```tsx
            colorHue={send.channel_color_hue}
            avatarPath={send.channel_avatar_path}
```

- [ ] **Step 4: Swap the hand-rolled dots**

Import `ChannelAvatar` from `@/components/ui` in each file touched below.

These call sites split by what their dot actually *means*, and the two groups get opposite treatment. A dot that reads as a **checkbox** (transparent with a border when off, filled when on) communicates *selected*, not *which account* — replacing it would destroy the affordance. A dot that is always filled, or that only restates a selection the button's own background already shows, is pure identity — that is what the avatar replaces.

**Group A — keep the dot, insert the avatar before the account name.** These dots are checkbox affordances:

| File | Dot line | Why it stays |
|---|---|---|
| `composer.tsx` | ~552 | `h-4 w-4 rounded` with a ✓ inside — literally a checkbox |
| `post-editor.tsx` | ~281 block | same checkbox pattern |
| `schedule-from-library.tsx` | ~262 block | same checkbox pattern |
| `bulk-import.tsx` | ~242 | `backgroundColor: on ? color.dot : "transparent"` with a border when off |
| `post-sends-panel.tsx` | ~358 | same transparent-plus-border pattern, already `aria-hidden` |

In each, insert this immediately *after* the checkbox span and *before* the account-name span:

```tsx
                  <ChannelAvatar
                    id={c.id}
                    name={c.account_name}
                    colorHue={c.color_hue}
                    avatarPath={c.avatar_path}
                    size={20}
                  />
```

**Group B — replace the dot outright with the avatar.**

`composer.tsx` ~732 — the "selected channels" summary list. The dot is always `color.dot` with no on/off state, so it is pure identity:

```tsx
                      <ChannelAvatar
                        id={c.id}
                        name={c.account_name}
                        colorHue={c.color_hue}
                        avatarPath={c.avatar_path}
                        size={14}
                      />
```

`library-view.tsx` ~592 — the filter pill's dot does vary with selection, but the button already changes its text colour, background *and* border colour on selection, so the dot is redundant reinforcement rather than the only signal. Replace it with the same `size={14}` avatar as above. Verify in the browser that a selected filter pill still reads as clearly selected after the swap.

`app/page.tsx:57` renders a `ChannelChip` rather than its own dot, so it needs only the new prop:

```tsx
                      <ChannelChip id={c.id} platform={c.platform} name={c.account_name} colorHue={c.color_hue} avatarPath={c.avatar_path} />
```

Its `borderLeft: 3px solid ${color.dot}` stays — that is the card's accent stripe, not the dot.

In every file, leave all other uses of `color` (backgrounds, borders, the selected-state `fg` pairing) exactly as they are. The comments in these files explaining why a selected label must take `color.fg` still apply and must not be removed.

- [ ] **Step 5: Type check and lint**

```bash
cd dashboard && npx tsc --noEmit && npm run lint && npm test
```

Expected: clean. A missed `channel_avatar_path` in either row type surfaces here as a type error.

- [ ] **Step 6: Verify every surface in the browser**

With the dev server on 3939, walk each page and confirm the avatar appears and nothing shifted:
- `/` — overview channel cards
- `/compose` — channel target picker (both pickers)
- `/library` — channel filters
- `/import` — bulk import channel picker
- a post's detail page — sends panel and the schedule-from-library picker
- the queue

Check both a light and a dark theme. Screenshot the composer and the queue.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/lib/types.ts dashboard/components dashboard/app
git commit -m "feat(dashboard): show account photos on every channel chip"
```

---

## Final verification

- [ ] **Full test suites**

```bash
source worker/.venv/bin/activate && python -m pytest worker/tests -q && cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

- [ ] **Kill switch unaffected** — set `KILL_SWITCH=1`, run a worker cycle, confirm no avatar fetches occur and nothing publishes.

- [ ] **Update the docs** — add a line to `docs/tasks.md` recording the phase as complete, matching the existing entries' format.

- [ ] **Run `/code-review`** before considering this finished.
