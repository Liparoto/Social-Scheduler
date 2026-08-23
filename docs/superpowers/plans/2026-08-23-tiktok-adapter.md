# TikTok Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver scheduled videos to a TikTok creator's inbox as a first-class channel, and
report honestly whether each one was ever published.

**Architecture:** A new `TikTokClient` (OAuth + chunked upload + status polling) plugged into the
worker's existing per-platform registries. Publishing writes `delivery_state='inbox'` rather than
pretending the post is live; a watcher promotes it to `published` when TikTok reveals a public
post id, and only then does the existing metrics machinery see the row.

**Tech Stack:** Python 3 + `requests` (worker, in `.venv`), Next.js App Router + TypeScript
(dashboard), SQLite via plain `.sql` migrations.

**Spec:** `docs/superpowers/specs/2026-08-22-tiktok-adapter-design.md` — read it first. Decisions
1–10 there are the *why* behind every task here.

## Global Constraints

- **Never hardcode secrets.** `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` come from `.env` only.
- **Never log a token.** Every TikTok secret goes through `worker/redact.py` and is covered by
  `worker/tests/test_redact.py`.
- **The schema lives in `/migrations`.** One new file, `0025_tiktok.sql`. Once applied, its
  filename is frozen — `schema_migrations` is keyed by filename, so renumbering re-runs it.
- **A failure is visible, never silent, and never contagious.** One target failing must not touch
  the post's other targets.
- **Kill switch and dry run** apply unchanged. A dry run makes no network call at all.
- **Windows is a supported platform** — no Unix-only stdlib imports at module scope in the worker.
- **Python venv:** every `pytest` / `python` command below assumes `source .venv/bin/activate`
  from the repo root first.
- **TDD:** every task writes the failing test first and runs it to watch it fail.
- **TikTok's success signal is in the body, not the status code.** Every response carries
  `{"data": ..., "error": {"code": "ok", ...}}`; `error.code != "ok"` is a failure even on HTTP
  200. Same trap as Telegram's `ok` field.

---

## File Structure

**Created**
- `migrations/0025_tiktok.sql` — platform CHECK widening + 4 new columns.
- `worker/tiktok_api.py` — `TikTokClient`: OAuth, user info, inbox init, chunked upload, status
  fetch, video query. No retry logic of its own (the publisher owns retries).
- `worker/tiktok_tokens.py` — the refresh-before-use step. Separate from the client because it
  writes to the DB, and the client never touches the DB.
- `worker/tiktok_watcher.py` — the post-delivery watcher.
- `dashboard/app/api/channels/tiktok/authorize/route.ts` — builds the authorize URL + PKCE.
- `dashboard/app/api/channels/tiktok/callback/route.ts` — code → tokens → channel row.
- `dashboard/lib/tiktok-oauth.ts` — PKCE helpers, shared by both routes.
- `docs/tiktok-setup.md` — owner-facing setup.
- Tests: `worker/tests/test_migration_0025.py`, `test_tiktok_api.py`,
  `test_tiktok_publishing.py`, `test_tiktok_tokens.py`, `test_tiktok_watcher.py`,
  `test_tiktok_metrics.py`; `dashboard/lib/platforms-tiktok.test.ts`,
  `dashboard/lib/tiktok-oauth.test.ts`.

**Modified**
- `worker/clients.py` — `SUPPORTED_PLATFORMS`, `_BASE_URLS`, `_API_VERSIONS`, `PLATFORM_CAPS`
  (+ new `supports_images` field), `_CLIENT_FACTORIES`.
- `worker/publisher.py` — `_publish_tiktok`, `_PUBLISHERS`, `_QUOTA_GATED`, `_COMMENTERS`,
  `_DELIVERS_TO_INBOX` (new registry), `_validate`'s image gate, the completion write.
- `worker/preflight.py`, `worker/metrics.py`, `worker/media_metrics.py`,
  `worker/account_metrics.py`, `worker/media_sync.py`, `worker/avatars.py` — one registry entry
  each (several are an explicit `None`).
- `worker/config.py`, `worker/redact.py`, `worker/run.py`, `.env.example`, `reference.md`.
- `dashboard/lib/platforms.ts`, `dashboard/lib/types.ts`, `dashboard/lib/queries.ts`,
  `dashboard/app/channels/page.tsx`, `dashboard/components/publication-queue.tsx`,
  `dashboard/components/post-sends-panel.tsx`.

**The 13 registries asserted against `SUPPORTED_PLATFORMS`.** Adding `'tiktok'` raises
`AssertionError` at import until all 13 have an entry — the worker will not start. They are:
`clients._BASE_URLS`, `clients._API_VERSIONS`, `clients.PLATFORM_CAPS`,
`clients._CLIENT_FACTORIES`, `publisher._PUBLISHERS`, `publisher._QUOTA_GATED`,
`publisher._COMMENTERS`, `preflight._CHECKS`, `metrics._FETCHERS`, `media_metrics._FETCHERS`,
`account_metrics._ACCOUNT_SYNCS`, `media_sync._ADAPTERS`, `avatars._URL_FETCHERS`. This is why
Task 4 is one task and not six.

---

## Task 1: Migration 0025 — schema

**Files:**
- Create: `migrations/0025_tiktok.sql`
- Test: `worker/tests/test_migration_0025.py`

**Interfaces:**
- Produces: `channels.platform` accepts `'tiktok'`; `channels.refresh_token`,
  `channels.refresh_token_expires_at`; `publications.delivery_state` (NULL |`'inbox'` |
  `'published'` | `'gave_up'`), `publications.delivery_checked_at`.

- [ ] **Step 1: Capture the CURRENT `channels` DDL — do not hand-write it**

`0009` rebuilt `channels` with 18 columns; migrations since then added more (colour, avatar,
group). A rebuild that reproduces `0009`'s column list would silently delete those columns.

```bash
cp data/socialscheduler.db /tmp/scratch-0025.db 2>/dev/null || python3 migrate.py
sqlite3 /tmp/scratch-0025.db "SELECT sql FROM sqlite_master WHERE type='table' AND name='channels';"
```

Copy that output verbatim into the migration, changing **only** the `platform` CHECK to add
`'tiktok'`. Also run `SELECT name FROM sqlite_master WHERE tbl_name='channels' AND type IN
('index','trigger','view');` — if it returns rows, they must be recreated after the rename.
(It returned none as of `0009`; verify, don't assume.)

- [ ] **Step 2: Write the failing test**

```python
# worker/tests/test_migration_0025.py
"""0025 lets a channel be TikTok, and gives publications an honest delivery state."""
from __future__ import annotations

import sqlite3

import pytest


def _channel(conn, platform="tiktok"):
    conn.execute(
        "INSERT INTO channels (platform, account_name, timezone) VALUES (?, ?, 'UTC')",
        (platform, f"{platform} test"),
    )
    conn.commit()
    return conn.execute("SELECT last_insert_rowid()").fetchone()[0]


def test_tiktok_is_an_accepted_platform(conn):
    assert _channel(conn) > 0


def test_existing_platforms_still_accepted(conn):
    for p in ("instagram", "facebook", "threads", "discord", "telegram"):
        assert _channel(conn, p) > 0


def test_unknown_platform_still_rejected(conn):
    with pytest.raises(sqlite3.IntegrityError):
        _channel(conn, "myspace")


def test_channels_keeps_every_column_the_later_migrations_added(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(channels)")}
    # The rebuild is the risk: a column list copied from 0009 would drop these.
    for col in ("color_hue", "avatar_path", "refresh_token", "refresh_token_expires_at"):
        assert col in cols, f"the channels rebuild dropped {col}"


def test_delivery_state_accepts_only_the_three_states(conn, tmp_path):
    ch = _channel(conn)
    conn.execute("INSERT INTO posts (post_type) VALUES ('reel')")
    post = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?, ?, ?)",
        (post, ch, "2026-08-23T00:00:00Z"),
    )
    pub = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    for state in ("inbox", "published", "gave_up"):
        conn.execute("UPDATE publications SET delivery_state = ? WHERE id = ?", (state, pub))
    conn.execute("UPDATE publications SET delivery_state = NULL WHERE id = ?", (pub,))
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE publications SET delivery_state = 'posted' WHERE id = ?", (pub,))


def test_delivery_state_defaults_to_null_for_every_other_platform(conn):
    ch = _channel(conn, "instagram")
    conn.execute("INSERT INTO posts (post_type) VALUES ('single')")
    post = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?, ?, ?)",
        (post, ch, "2026-08-23T00:00:00Z"),
    )
    conn.commit()
    row = conn.execute("SELECT delivery_state, delivery_checked_at FROM publications").fetchone()
    assert row[0] is None and row[1] is None
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pytest worker/tests/test_migration_0025.py -v`
Expected: FAIL — `IntegrityError` on the `'tiktok'` insert (the CHECK doesn't know it yet).

- [ ] **Step 4: Write the migration**

Structure — the `PRAGMA`/`BEGIN` dance is copied from `0009` and is not optional. `executescript()`
commits before running, which ends `migrate.py`'s transaction; `PRAGMA foreign_keys` is a silent
no-op inside an open transaction, so it must sit outside `BEGIN`. With foreign keys ON, `DROP
TABLE channels` fires `ON DELETE CASCADE` on three child tables and silently deletes their rows
while reporting success.

```sql
-- 0025_tiktok.sql
-- channels.platform gains 'tiktok'; channels gains its OAuth refresh pair; publications
-- gains a delivery state so a video waiting in a creator's inbox can never read as "posted".
--
-- The rebuild below follows 0009 exactly, INCLUDING its foreign-key trap: DROP TABLE with
-- enforcement ON performs an implicit delete that fires ON DELETE CASCADE across channels'
-- children (publications, publish_limits, post_targets), reporting success while deleting
-- them. Enforcement is therefore off for the rebuild and restored after.
--
-- The column list below was taken from sqlite_master on a migrated DB, NOT from 0009 —
-- migrations after 0009 added columns, and reusing 0009's list would drop them.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE channels_new (
    -- <<< paste the captured DDL's body here verbatim, with 'tiktok' added to the
    --     platform CHECK and nothing else changed >>>
);

INSERT INTO channels_new SELECT * FROM channels;   -- identical column order, verified in Step 1

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

COMMIT;
PRAGMA foreign_keys = ON;

-- Added AFTER the rebuild, so the rebuild's column list stays a pure copy of what exists.
-- TikTok access tokens last 24 hours and the refresh token ROTATES on every use — storing
-- the returned one is not optional, and losing it means re-authorising the channel.
ALTER TABLE channels ADD COLUMN refresh_token TEXT;
ALTER TABLE channels ADD COLUMN refresh_token_expires_at TEXT;

-- NULL means "this platform publishes on command" — every platform but TikTok. The three
-- non-NULL states are TikTok's post-delivery lifecycle. status stays 'posted' meaning "the
-- worker's job succeeded"; this column carries what actually happened afterwards.
ALTER TABLE publications ADD COLUMN delivery_state TEXT
    CHECK (delivery_state IS NULL OR delivery_state IN ('inbox', 'published', 'gave_up'));
ALTER TABLE publications ADD COLUMN delivery_checked_at TEXT;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest worker/tests/test_migration_0025.py -v`
Expected: PASS, all 6.

- [ ] **Step 6: Verify against a real copy, and verify idempotency**

```bash
cp data/socialscheduler.db /tmp/verify-0025.db
sqlite3 /tmp/verify-0025.db "SELECT COUNT(*) FROM channels; SELECT COUNT(*) FROM publications;"
DATABASE_PATH=/tmp/verify-0025.db python3 migrate.py
sqlite3 /tmp/verify-0025.db "SELECT COUNT(*) FROM channels; SELECT COUNT(*) FROM publications;"
DATABASE_PATH=/tmp/verify-0025.db python3 migrate.py   # second run must apply nothing
```

Expected: both counts identical before and after (the cascade trap would show as publications
dropping to 0), and the second run reports nothing pending.

> `migrate.py` has no argument parser — even `--help` applies migrations to whatever DB it
> finds. Always point it at a copy.

- [ ] **Step 7: Run the whole worker suite** — the session-scoped schema fixture replays every
migration, so a broken one breaks everything.

Run: `pytest worker/tests -q`
Expected: PASS (same count as before this task).

- [ ] **Step 8: Commit**

```bash
git add migrations/0025_tiktok.sql worker/tests/test_migration_0025.py
git commit -m "feat(schema): let a channel be TikTok, and a send say it is only delivered"
```

---

## Task 2: TikTokClient — OAuth and user info

**Files:**
- Create: `worker/tiktok_api.py`
- Test: `worker/tests/test_tiktok_api.py`
- Modify: `worker/redact.py`, `worker/tests/test_redact.py`

**Interfaces:**
- Produces:
  - `class TikTokAPIError(Exception)`
  - `TikTokClient(base_url="https://open.tiktokapis.com", session=None, timeout=60)`
  - `.exchange_code(client_key, client_secret, code, redirect_uri, code_verifier) -> dict`
  - `.refresh_access_token(client_key, client_secret, refresh_token) -> dict`
    — both return `{"access_token", "expires_in", "refresh_token", "refresh_expires_in", "open_id"}`
  - `.get_user_info(access_token, fields=("open_id", "display_name")) -> dict`

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/test_tiktok_api.py
"""TikTokClient: the OAuth pair and the read-only identity call.

TikTok returns HTTP 200 with {"error": {"code": "access_token_invalid"}} on failure, so the
body is the success signal, not the status code — the same trap Telegram's `ok` field sets.
"""
from __future__ import annotations

import pytest

from worker.tiktok_api import TikTokAPIError, TikTokClient


class FakeResponse:
    def __init__(self, payload, status=200, text=""):
        self._payload = payload
        self.status_code = status
        self.ok = status < 400
        self.text = text or str(payload)

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.response

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.response


TOKENS = {
    "access_token": "act.NEW",
    "expires_in": 86400,
    "refresh_token": "rft.ROTATED",
    "refresh_expires_in": 31536000,
    "open_id": "open-1",
}


def test_exchange_code_posts_form_encoded_with_pkce_verifier():
    session = FakeSession(FakeResponse(TOKENS))
    client = TikTokClient(session=session)
    out = client.exchange_code("key", "secret", "code-1", "http://localhost:3939/cb", "verifier-1")
    assert out["access_token"] == "act.NEW"
    _, url, kwargs = session.calls[0]
    assert url.endswith("/v2/oauth/token/")
    # form-encoded, NOT json — TikTok rejects a JSON body on this endpoint
    assert kwargs["data"]["grant_type"] == "authorization_code"
    assert kwargs["data"]["code_verifier"] == "verifier-1"
    assert kwargs["data"]["redirect_uri"] == "http://localhost:3939/cb"
    assert "json" not in kwargs


def test_refresh_returns_the_rotated_refresh_token():
    session = FakeSession(FakeResponse(TOKENS))
    client = TikTokClient(session=session)
    out = client.refresh_access_token("key", "secret", "rft.OLD")
    # The whole point: the NEW refresh token must come back, or the channel dies in 365 days
    # at best and on the next refresh at worst.
    assert out["refresh_token"] == "rft.ROTATED"
    assert session.calls[0][2]["data"]["grant_type"] == "refresh_token"


def test_error_body_on_http_200_still_raises():
    session = FakeSession(
        FakeResponse({"error": {"code": "invalid_grant", "message": "revoked", "log_id": "L1"}})
    )
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "secret", "rft.OLD")
    assert "invalid_grant" in str(exc.value)


def test_secrets_never_appear_in_an_error():
    session = FakeSession(FakeResponse({"error": {"code": "bad", "message": "no"}}))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "SUPERSECRET", "rft.SENSITIVE")
    assert "SUPERSECRET" not in str(exc.value)
    assert "rft.SENSITIVE" not in str(exc.value)


def test_get_user_info_sends_bearer_and_requested_fields():
    session = FakeSession(FakeResponse({"data": {"user": {"display_name": "Kelan"}},
                                        "error": {"code": "ok"}}))
    client = TikTokClient(session=session)
    user = client.get_user_info("act.TOKEN", fields=("open_id", "display_name"))
    assert user["display_name"] == "Kelan"
    _, url, kwargs = session.calls[0]
    assert kwargs["headers"]["Authorization"] == "Bearer act.TOKEN"
    assert "display_name" in kwargs["params"]["fields"]


def test_non_json_response_becomes_a_tiktok_error():
    session = FakeSession(FakeResponse(None, status=502, text="<html>bad gateway</html>"))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError):
        client.get_user_info("act.TOKEN")
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pytest worker/tests/test_tiktok_api.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.tiktok_api'`.

- [ ] **Step 3: Write the client**

```python
# worker/tiktok_api.py
"""TikTok Content Posting + Display API client.

Three things about this API drive the shape below:

1. **The body is the success signal.** Every response carries an `error` object, and a
   failure arrives as HTTP 200 with `error.code != "ok"`. Checking `resp.ok` alone silently
   treats a rejection as a success. (Telegram's `ok` field is the same trap.)
2. **The OAuth endpoint is form-encoded**, not JSON, and it is the only one that carries the
   client secret — so it is the one whose errors most need redacting.
3. **Refresh tokens rotate.** Every refresh returns a new one and invalidates the old.

Like every other client here: raise on failure, never interpolate a credential into a
message, and own no retry logic (the publisher owns retries).
"""

from __future__ import annotations

import requests

from .redact import redact

OAUTH_TOKEN_PATH = "/v2/oauth/token/"
USER_INFO_PATH = "/v2/user/info/"


class TikTokAPIError(Exception):
    """TikTok reported a failure, or the request failed at the network layer.
    Never contains a client secret, access token or refresh token."""


class TikTokClient:
    def __init__(self, base_url="https://open.tiktokapis.com", session=None, timeout=60):
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout

    # ---- plumbing -----------------------------------------------------------------
    @staticmethod
    def _body(resp, what: str) -> dict:
        try:
            body = resp.json()
        except ValueError:
            raise TikTokAPIError(
                f"{what} -> {resp.status_code}: non-JSON response: {redact(resp.text)[:200]}"
            ) from None
        error = body.get("error") or {}
        code = error.get("code", "ok")
        # "ok" is TikTok's success code. An absent error object is treated as success too,
        # since the Display endpoints omit it on some responses.
        if code != "ok" or not resp.ok:
            raise TikTokAPIError(
                f"{what} -> {resp.status_code}: {code}: "
                f"{redact(str(error.get('message', resp.text)))[:300]} "
                f"(log_id={error.get('log_id')})"
            )
        return body

    def _post_form(self, path: str, data: dict, what: str) -> dict:
        url = f"{self.base_url}{path}"
        try:
            resp = self.session.post(
                url,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            # `from None`, not `from exc`: exc's own str() can embed the request and must
            # never survive into a traceback via __cause__ — same rule as the other clients.
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what)

    # ---- OAuth --------------------------------------------------------------------
    def exchange_code(self, client_key, client_secret, code, redirect_uri, code_verifier) -> dict:
        """Authorization code -> tokens. PKCE is mandatory for Desktop-type apps."""
        return self._post_form(
            OAUTH_TOKEN_PATH,
            {
                "client_key": client_key,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
            "POST /v2/oauth/token/ (exchange)",
        )

    def refresh_access_token(self, client_key, client_secret, refresh_token) -> dict:
        """Access tokens last 24h. The returned refresh_token REPLACES the one sent —
        storing it is what keeps the channel alive."""
        return self._post_form(
            OAUTH_TOKEN_PATH,
            {
                "client_key": client_key,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            "POST /v2/oauth/token/ (refresh)",
        )

    # ---- Display ------------------------------------------------------------------
    def get_user_info(self, access_token, fields=("open_id", "display_name")) -> dict:
        """Read-only identity call. Used by preflight: proves the token works and names the
        account without posting anything."""
        url = f"{self.base_url}{USER_INFO_PATH}"
        what = "GET /v2/user/info/"
        try:
            resp = self.session.get(
                url,
                params={"fields": ",".join(fields)},
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what).get("data", {}).get("user", {})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest worker/tests/test_tiktok_api.py -v`
Expected: PASS, all 6.

- [ ] **Step 5: Teach the redactor TikTok's secret shapes**

Read `worker/redact.py` first and follow its existing pattern. TikTok tokens are prefixed
(`act.` for access, `rft.` for refresh) and the client key/secret are opaque. Add a failing test
to `worker/tests/test_redact.py` first:

```python
def test_redacts_tiktok_tokens():
    from worker.redact import redact

    assert "act.abc123DEF456" not in redact("Authorization: Bearer act.abc123DEF456")
    assert "rft.xyz789GHI012" not in redact("refresh_token=rft.xyz789GHI012")
```

Run: `pytest worker/tests/test_redact.py -v` → FAIL, then extend `redact.py`, then PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/tiktok_api.py worker/redact.py worker/tests/test_tiktok_api.py worker/tests/test_redact.py
git commit -m "feat(tiktok): add the OAuth client, and keep its secrets out of every message"
```

---

## Task 3: TikTokClient — inbox upload and status

**Files:**
- Modify: `worker/tiktok_api.py`
- Test: `worker/tests/test_tiktok_api.py`

**Interfaces:**
- Consumes: `TikTokClient`, `TikTokAPIError` from Task 2.
- Produces:
  - `.init_inbox_video(access_token, video_size, chunk_size, total_chunk_count) -> dict`
    → `{"publish_id", "upload_url"}`
  - `.upload_chunk(upload_url, chunk, *, start, end, total, mime="video/mp4") -> None`
  - `.upload_video_file(upload_url, path, *, chunk_size) -> None`
  - `.fetch_publish_status(access_token, publish_id) -> dict`
    → `{"status", "publicaly_available_post_id": [...], "fail_reason": ...}`
  - `.query_videos(access_token, video_ids, fields) -> list[dict]`
  - Module constants `MIN_CHUNK_BYTES = 5*1024*1024`, `MAX_CHUNK_BYTES = 64*1024*1024`,
    and `plan_chunks(video_size) -> tuple[int, int]` returning `(chunk_size, total_chunk_count)`.

> Note TikTok's spelling: the response field really is `publicaly_available_post_id` (their
> typo). Do not "fix" it.

- [ ] **Step 1: Write the failing test**

```python
# append to worker/tests/test_tiktok_api.py
from worker.tiktok_api import MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, plan_chunks

MB = 1024 * 1024


def test_small_file_is_one_chunk_even_below_the_5mb_minimum():
    # A whole file under 5 MB is a legal single chunk — the minimum applies to chunks of a
    # multi-chunk upload, not to a file that fits in one.
    size, count = plan_chunks(2 * MB)
    assert (size, count) == (2 * MB, 1)


def test_file_at_the_single_chunk_ceiling_is_still_one_chunk():
    size, count = plan_chunks(MAX_CHUNK_BYTES)
    assert count == 1 and size == MAX_CHUNK_BYTES


def test_large_file_splits_into_legal_chunks():
    total = 200 * MB
    size, count = plan_chunks(total)
    assert MIN_CHUNK_BYTES <= size <= MAX_CHUNK_BYTES
    assert count >= 2
    # Every chunk but the last is exactly `size`; the last carries the remainder and may be
    # up to 128 MB. What must never happen is a final chunk smaller than the 5 MB minimum.
    last = total - size * (count - 1)
    assert last >= MIN_CHUNK_BYTES, f"final chunk of {last} bytes is below TikTok's minimum"


def test_init_inbox_video_sends_the_chunk_plan():
    session = FakeSession(FakeResponse(
        {"data": {"publish_id": "pub-1", "upload_url": "https://upload.example/1"},
         "error": {"code": "ok"}}
    ))
    client = TikTokClient(session=session)
    out = client.init_inbox_video("act.T", video_size=10 * MB, chunk_size=10 * MB,
                                  total_chunk_count=1)
    assert out["publish_id"] == "pub-1"
    _, url, kwargs = session.calls[0]
    assert url.endswith("/v2/post/publish/inbox/video/init/")
    source = kwargs["json"]["source_info"]
    assert source["source"] == "FILE_UPLOAD"
    assert source["video_size"] == 10 * MB
    # There is no post_info: the inbox endpoint accepts no caption. See spec Decision 9.
    assert "post_info" not in kwargs["json"]


def test_upload_video_file_sends_every_chunk_with_a_content_range(tmp_path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"x" * (12 * MB))
    session = FakeSession(FakeResponse({}, status=201))
    client = TikTokClient(session=session)
    client.session.put = lambda url, **kw: session.calls.append(("PUT", url, kw)) or FakeResponse({}, status=201)
    client.upload_video_file("https://upload.example/1", video, chunk_size=6 * MB)
    ranges = [kw["headers"]["Content-Range"] for _, _, kw in session.calls]
    assert ranges == [
        f"bytes 0-{6 * MB - 1}/{12 * MB}",
        f"bytes {6 * MB}-{12 * MB - 1}/{12 * MB}",
    ]


def test_fetch_publish_status_returns_status_and_post_id():
    session = FakeSession(FakeResponse(
        {"data": {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": ["7123"]},
         "error": {"code": "ok"}}
    ))
    client = TikTokClient(session=session)
    out = client.fetch_publish_status("act.T", "pub-1")
    assert out["status"] == "PUBLISH_COMPLETE"
    assert out["publicaly_available_post_id"] == ["7123"]


def test_query_videos_filters_by_id():
    session = FakeSession(FakeResponse(
        {"data": {"videos": [{"id": "7123", "like_count": 5, "view_count": 100}]},
         "error": {"code": "ok"}}
    ))
    client = TikTokClient(session=session)
    videos = client.query_videos("act.T", ["7123"], ["id", "like_count", "view_count"])
    assert videos[0]["view_count"] == 100
    _, url, kwargs = session.calls[0]
    assert kwargs["json"]["filters"]["video_ids"] == ["7123"]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pytest worker/tests/test_tiktok_api.py -v -k "chunk or inbox or status or query"`
Expected: FAIL — `ImportError: cannot import name 'plan_chunks'`.

- [ ] **Step 3: Implement**

```python
# add to worker/tiktok_api.py
import math
from pathlib import Path

INBOX_INIT_PATH = "/v2/post/publish/inbox/video/init/"
STATUS_PATH = "/v2/post/publish/status/fetch/"
VIDEO_QUERY_PATH = "/v2/video/query/"

MB = 1024 * 1024
MIN_CHUNK_BYTES = 5 * MB
MAX_CHUNK_BYTES = 64 * MB


def plan_chunks(video_size: int) -> tuple[int, int]:
    """(chunk_size, total_chunk_count) for a FILE_UPLOAD.

    TikTok's rules: chunks are 5-64 MB, there may be 1-1000 of them, and the FINAL chunk
    carries the remainder (up to 128 MB). A whole file under 5 MB is a legal single chunk —
    the 5 MB floor applies to the chunks of a split upload, not to a file that fits in one.

    The remainder is folded into the last chunk rather than sent as its own, because a
    trailing chunk below the 5 MB floor is rejected — the failure mode this function exists
    to prevent.
    """
    if video_size <= MAX_CHUNK_BYTES:
        return video_size, 1
    count = math.ceil(video_size / MAX_CHUNK_BYTES)
    chunk = video_size // count
    if chunk < MIN_CHUNK_BYTES:      # only reachable for absurd counts; keep the floor honest
        chunk = MIN_CHUNK_BYTES
        count = max(1, video_size // chunk)
    return chunk, count
```

```python
    # methods on TikTokClient
    def _post_json(self, path: str, access_token: str, payload: dict, what: str) -> dict:
        url = f"{self.base_url}{path}"
        try:
            resp = self.session.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json; charset=UTF-8",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what)

    def init_inbox_video(self, access_token, video_size, chunk_size, total_chunk_count) -> dict:
        """Open an upload session. No post_info: the inbox endpoint takes no caption at all
        — the creator writes it in the TikTok app (spec Decision 9)."""
        body = self._post_json(
            INBOX_INIT_PATH,
            access_token,
            {"source_info": {
                "source": "FILE_UPLOAD",
                "video_size": video_size,
                "chunk_size": chunk_size,
                "total_chunk_count": total_chunk_count,
            }},
            "POST /v2/post/publish/inbox/video/init/",
        )
        return body.get("data", {})

    def upload_chunk(self, upload_url, chunk: bytes, *, start: int, end: int, total: int,
                     mime: str = "video/mp4") -> None:
        """One PUT. `end` is INCLUSIVE, per RFC 7233 — an off-by-one here is rejected."""
        try:
            resp = self.session.put(
                upload_url,
                data=chunk,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{total}",
                    "Content-Type": mime,
                },
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(f"PUT upload -> request failed: {redact(str(exc))}") from None
        if not resp.ok:
            # The upload URL is a signed, credential-bearing URL — never put it in a message.
            raise TikTokAPIError(f"PUT upload -> {resp.status_code}: {redact(resp.text)[:200]}")

    def upload_video_file(self, upload_url, path, *, chunk_size: int) -> None:
        """Stream the file up in sequential chunks. Reads a chunk at a time rather than the
        whole file: a 4K clip can be hundreds of MB and this runs on the owner's laptop."""
        path = Path(path)
        total = path.stat().st_size
        sent = 0
        with path.open("rb") as fh:
            while sent < total:
                remaining = total - sent
                # Fold a short trailing remainder into this chunk instead of sending it
                # alone — a final chunk under 5 MB is rejected.
                size = chunk_size if remaining - chunk_size >= chunk_size else remaining
                data = fh.read(size)
                if not data:
                    break
                self.upload_chunk(upload_url, data, start=sent, end=sent + len(data) - 1,
                                  total=total)
                sent += len(data)

    def fetch_publish_status(self, access_token, publish_id) -> dict:
        body = self._post_json(STATUS_PATH, access_token, {"publish_id": publish_id},
                               "POST /v2/post/publish/status/fetch/")
        return body.get("data", {})

    def query_videos(self, access_token, video_ids, fields) -> list[dict]:
        """Display API. Up to 20 ids per request; scope video.list."""
        url = f"{self.base_url}{VIDEO_QUERY_PATH}"
        what = "POST /v2/video/query/"
        try:
            resp = self.session.post(
                url,
                params={"fields": ",".join(fields)},
                json={"filters": {"video_ids": list(video_ids)}},
                headers={"Authorization": f"Bearer {access_token}",
                         "Content-Type": "application/json; charset=UTF-8"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise TikTokAPIError(f"{what} -> request failed: {redact(str(exc))}") from None
        return self._body(resp, what).get("data", {}).get("videos", [])
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest worker/tests/test_tiktok_api.py -v`
Expected: PASS, all 13.

- [ ] **Step 5: Commit**

```bash
git add worker/tiktok_api.py worker/tests/test_tiktok_api.py
git commit -m "feat(tiktok): upload video in legal chunks, and never send a caption we can't"
```

---

## Task 4: Register TikTok across all 13 registries

This is one task because it cannot be split: adding `'tiktok'` to `SUPPORTED_PLATFORMS` fails 13
import-time asserts at once, and the worker will not start until every one is answered.

**Files:**
- Modify: `worker/clients.py`, `worker/publisher.py`, `worker/preflight.py`, `worker/metrics.py`,
  `worker/media_metrics.py`, `worker/account_metrics.py`, `worker/media_sync.py`,
  `worker/avatars.py`
- Test: `worker/tests/test_tiktok_publishing.py`

**Interfaces:**
- Consumes: `TikTokClient` (Tasks 2–3).
- Produces: `publisher._publish_tiktok(client, plan, token, config, sleep_fn) -> str` (returns the
  `publish_id`); `publisher._DELIVERS_TO_INBOX: dict[str, bool]`;
  `clients.PlatformCaps.supports_images: bool = True`.

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/test_tiktok_publishing.py
"""Publishing to TikTok delivers to an inbox — it does not post.

The load-bearing assertion in this file is that a delivered send is NOT recorded as having a
remote_post_id. That single fact is what keeps the metrics due-query away from a video nobody
has published yet, and what keeps the queue from claiming it is live.
"""
from __future__ import annotations

import pytest

from worker import db
from worker.clients import PLATFORM_CAPS, SUPPORTED_PLATFORMS
from worker.publisher import _DELIVERS_TO_INBOX, _NonRetryable, _validate, publish_one


def test_tiktok_is_registered_everywhere():
    from worker.avatars import _URL_FETCHERS
    from worker.account_metrics import _ACCOUNT_SYNCS
    from worker.clients import _API_VERSIONS, _BASE_URLS, _CLIENT_FACTORIES
    from worker.media_metrics import _FETCHERS as MEDIA_FETCHERS
    from worker.media_sync import _ADAPTERS
    from worker.metrics import _FETCHERS
    from worker.preflight import _CHECKS
    from worker.publisher import _COMMENTERS, _PUBLISHERS, _QUOTA_GATED

    assert "tiktok" in SUPPORTED_PLATFORMS
    for registry in (_BASE_URLS, _API_VERSIONS, PLATFORM_CAPS, _CLIENT_FACTORIES, _PUBLISHERS,
                     _QUOTA_GATED, _COMMENTERS, _CHECKS, _FETCHERS, MEDIA_FETCHERS,
                     _ACCOUNT_SYNCS, _ADAPTERS, _URL_FETCHERS, _DELIVERS_TO_INBOX):
        assert "tiktok" in registry


def test_tiktok_declares_video_only():
    caps = PLATFORM_CAPS["tiktok"]
    assert caps.supports_video is True
    assert caps.supports_images is False   # photos need a verified domain — spec Gate 2
    assert caps.supports_text is False
    assert caps.uploads_media_bytes is True
    assert caps.needs_conformed_media is False


def test_every_other_platform_still_accepts_images():
    for platform in SUPPORTED_PLATFORMS:
        if platform != "tiktok":
            assert PLATFORM_CAPS[platform].supports_images is True


def test_validate_refuses_an_image_post_to_tiktok():
    post = {"post_type": "single", "first_comment": None}
    assets = [{"id": 1, "media_kind": "image", "storage_path": "a.jpg", "publish_path": None}]
    with pytest.raises(_NonRetryable) as exc:
        _validate(post, assets, True, None, "tiktok", None)
    assert "image" in str(exc.value).lower()


def test_validate_accepts_a_reel_to_tiktok():
    post = {"post_type": "reel", "first_comment": None}
    assets = [{"id": 1, "media_kind": "video", "storage_path": "a.mp4", "publish_path": None}]
    _validate(post, assets, True, None, "tiktok", None)   # must not raise


def test_delivered_send_records_the_publish_id_but_no_post_id(conn, config, tiktok_pub, fake_tiktok):
    """The whole point of Decision 6: 'delivered' is not 'posted'."""
    publish_one(conn, tiktok_pub, config, fake_tiktok, dry_run=False,
                asset_base_url=None, now=NOW, logger=None, sleep_fn=lambda _s: None)
    row = db.get_publication(conn, tiktok_pub["id"])
    assert row["status"] == "posted"              # the WORKER's job succeeded
    assert row["delivery_state"] == "inbox"       # ...but TikTok has not published anything
    assert row["remote_container_id"] == "pub-1"  # the publish_id
    assert row["remote_post_id"] is None          # nothing to fetch metrics for yet
```

> Build `tiktok_pub` and `fake_tiktok` as fixtures in this file, modelled on
> `worker/tests/test_discord_telegram_publishing.py` — read that file and copy its fixture
> style rather than inventing one. `fake_tiktok` needs `init_inbox_video`, `upload_video_file`
> and `fetch_publish_status` (returning `{"status": "SEND_TO_USER_INBOX"}`). Define `NOW` the
> way that file does.

- [ ] **Step 2: Run it and watch it fail**

Run: `pytest worker/tests/test_tiktok_publishing.py -v`
Expected: FAIL — `ImportError: cannot import name '_DELIVERS_TO_INBOX'`.

- [ ] **Step 3: Add the capability field and the TikTok caps**

In `worker/clients.py`, add to `PlatformCaps` (after `supports_video`):

```python
    # True when the platform can publish still images at all. Every platform but TikTok can,
    # which is why this defaults True — TikTok's photo endpoint accepts only PULL_FROM_URL
    # from a DNS-verified domain, and this install serves assets from an ephemeral
    # trycloudflare URL it does not own. So TikTok is video-only until a domain exists; see
    # the spec's Gate 2. Defaulting True keeps every existing platform's behaviour unchanged.
    supports_images: bool = True
```

Then the entry, and `'tiktok'` in `SUPPORTED_PLATFORMS`:

```python
    # TikTok: video only (supports_images above), uploads bytes itself (chunked FILE_UPLOAD,
    # so no tunnel and no public URL), and sends NO caption — the inbox endpoint has no
    # caption field, so caption_chars is empty rather than a number we'd be pretending to
    # enforce. needs_conformed_media=False: TikTok has its own aspect rules, and the app
    # review guidelines forbid altering the creator's content.
    "tiktok": PlatformCaps(
        supports_text=False, max_carousel=0, caption_chars={},
        uploads_media_bytes=True, supports_video=True, supports_images=False,
        uses_account_id=True, needs_conformed_media=False,
    ),
```

And the other three `clients.py` registries:

```python
_BASE_URLS["tiktok"]  = lambda _config: TIKTOK_BASE          # "https://open.tiktokapis.com"
_API_VERSIONS["tiktok"] = lambda _config: "v2"               # path-segment versioned
_CLIENT_FACTORIES["tiktok"] = lambda _version, base: TikTokClient(base_url=base)
```

(Write them as literal dict entries in the existing dicts, not as assignments after the fact —
match the file's style.)

- [ ] **Step 4: Gate images in `_validate`**

In `worker/publisher.py`'s `_validate`, immediately after the `post_type == "reel"` block:

```python
    if post_type in ("single", "carousel") and not caps.supports_images:
        raise _NonRetryable(
            f"{platform} cannot publish image posts — it accepts video only"
        )
```

- [ ] **Step 5: Write the publisher and its registries**

```python
def _publish_tiktok(client, plan, token, config, sleep_fn) -> str:
    """Deliver the video to the creator's TikTok inbox and return the publish_id.

    This does NOT publish. TikTok's inbox endpoint takes the file and nothing else — no
    caption, no privacy level — and the creator completes the post in the TikTok app. The
    returned id is an upload-session id, not a post id, which is why _DELIVERS_TO_INBOX
    routes it to remote_container_id rather than remote_post_id (spec Decision 6).
    """
    from .tiktok_api import plan_chunks

    post_type = plan["post_type"]
    if post_type != "reel":
        raise _NonRetryable(
            f"tiktok adapter has no publish path for post_type '{post_type}' — video only"
        )
    path = plan["asset_paths"][0]
    if path is None:
        raise _NonRetryable("tiktok needs the video file on disk; none resolved")
    size = Path(path).stat().st_size
    chunk_size, count = plan_chunks(size)
    session = client.init_inbox_video(token, size, chunk_size, count)
    publish_id = session["publish_id"]
    client.upload_video_file(session["upload_url"], path, chunk_size=chunk_size)
    # Confirm TikTok actually accepted it. Reuses the publisher's poll loop against TikTok's
    # own status call: SEND_TO_USER_INBOX is this platform's "FINISHED".
    _poll_until_finished(
        client, publish_id, token, config, sleep_fn,
        status_fn=lambda pid, tok: _tiktok_status(client, pid, tok),
    )
    return publish_id


def _tiktok_status(client, publish_id, token) -> str:
    """Map TikTok's status vocabulary onto the poll loop's FINISHED/ERROR/other."""
    data = client.fetch_publish_status(token, publish_id)
    status = data.get("status")
    if status == "SEND_TO_USER_INBOX":
        return "FINISHED"
    if status == "FAILED":
        # Surface TikTok's own reason rather than a generic failure — it is the only
        # explanation the owner will get for a video that vanished.
        raise RuntimeError(f"tiktok upload failed: {data.get('fail_reason', 'no reason given')}")
    return status or "PROCESSING_UPLOAD"
```

Registry entries, each with the reasoning the file's style demands:

```python
_PUBLISHERS["tiktok"] = _publish_tiktok

# TikTok exposes NO runtime publish quota. The one endpoint that reports creator limits
# (creator_info/query) requires the video.publish scope, which needs the app audit this
# install cannot obtain (spec Decision 1/8). False therefore means "genuinely nothing to
# read", not "not wired up" — and its spam_risk_too_many_posts error is treated as
# retryable in run_once, which is the quota signal arriving as an error instead of a number.
_QUOTA_GATED["tiktok"] = False

# No first-comment concept reachable here: the creator completes the post themselves, so
# there is no moment at which this worker holds a published media to comment on.
_COMMENTERS["tiktok"] = None

# Whether a platform's publish call DELIVERS rather than PUBLISHES. Declared for every
# platform, same reasoning as _QUOTA_GATED: False must mean "this platform really does
# publish on command", never "we forgot". When True, the completion write stores the
# returned id as remote_container_id, leaves remote_post_id NULL, and sets
# delivery_state='inbox' — see spec Decision 6.
_DELIVERS_TO_INBOX = {
    "instagram": False, "facebook": False, "threads": False,
    "discord": False, "telegram": False, "tiktok": True,
}

assert set(_DELIVERS_TO_INBOX) == set(SUPPORTED_PLATFORMS), (
    "publisher._DELIVERS_TO_INBOX and clients.SUPPORTED_PLATFORMS disagree"
)
```

- [ ] **Step 6: Branch the completion write in `run_once`**

Replace the single `db.update_publication(... status="posted", remote_post_id=media_id ...)` call
after a successful publish with:

```python
    if _DELIVERS_TO_INBOX[plan["platform"]]:
        # Delivered, not published. remote_post_id stays NULL on purpose: the metrics
        # due-query requires it, so this row is invisible to metrics until the watcher
        # learns the real post id (or gives up).
        db.update_publication(
            conn, pub["id"],
            status="posted", remote_container_id=media_id, delivery_state="inbox",
            published_at=_iso(now), last_error=None, next_retry_at=None,
            updated_at=_iso(now),
        )
    else:
        db.update_publication(
            conn, pub["id"],
            status="posted", remote_post_id=media_id, published_at=_iso(now),
            last_error=None, next_retry_at=None, updated_at=_iso(now),
        )
```

And make the log line tell the truth:

```python
    log(f"delivered to inbox -> {media_id}" if _DELIVERS_TO_INBOX[plan["platform"]]
        else f"published -> {media_id}")
```

- [ ] **Step 7: The remaining six registries — explicit `None` with a reason**

Follow each file's existing comment style. All six are `None`, and each needs a one-line *why*:

- `preflight._CHECKS["tiktok"] = _check_tiktok` — **not** None; write it:

```python
def _check_tiktok(client, ch, name, print_fn) -> None:
    """A read-only /v2/user/info/ call: proves the access token works and names the account
    without posting anything. Also reports how long the REFRESH token has left — that is the
    365-day cliff, and the only warning the owner gets before a channel goes dead."""
    user = client.get_user_info(ch["access_token"], fields=("open_id", "display_name"))
    display = user.get("display_name") or ch["account_name"]
    expiry = ch["refresh_token_expires_at"] or "unknown"
    print_fn(
        f"  ✓ {name}: token OK — account reachable ({display}; "
        f"no publish quota to read; refresh token valid until {expiry})"
    )
```

- `metrics._FETCHERS["tiktok"]` — a real fetcher lands in Task 11. For now register `None` with
  the comment `# post metrics land in Task 11, once R1 confirms a post id is reachable at all`.
  **This is a deliberate temporary None; Task 11 replaces it.**
- `media_metrics._FETCHERS["tiktok"] = None` — `# no remote_media mirror for TikTok (media_sync
  has no adapter), so there is nothing to attach media metrics to`
- `account_metrics._ACCOUNT_SYNCS["tiktok"] = None` — `# account-level series need
  user.info.stats scopes this install does not request; out of scope, not forgotten`
- `media_sync._ADAPTERS["tiktok"] = None` — `# mirroring the account's own video list needs
  video.list paging; out of scope for the adapter's first version`
- `avatars._URL_FETCHERS["tiktok"] = None` — `# /v2/user/info/ can return avatar_url; not
  wired up yet, deliberately, to keep the first version's scope to publishing`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pytest worker/tests/test_tiktok_publishing.py worker/tests/test_platform_dispatch.py -v`
Expected: PASS. `test_platform_dispatch.py` is the guard that all 13 registries agree.

- [ ] **Step 9: Run the whole suite — this task can break unrelated tests**

Run: `pytest worker/tests -q`
Expected: PASS. If `PlatformCaps` tests fail on the new field, they are asserting an exact
constructor signature — update them; do not remove the field's default.

- [ ] **Step 10: Prove the worker still imports and starts**

Run: `python -m worker.preflight`
Expected: it runs and reports each existing channel. An `AssertionError` here means a registry
was missed — the message names which one.

- [ ] **Step 11: Commit**

```bash
git add worker/clients.py worker/publisher.py worker/preflight.py worker/metrics.py \
        worker/media_metrics.py worker/account_metrics.py worker/media_sync.py \
        worker/avatars.py worker/tests/test_tiktok_publishing.py
git commit -m "feat(tiktok): register the platform, and record delivery as delivery"
```

---

## Task 5: Keep the access token alive

**Files:**
- Create: `worker/tiktok_tokens.py`
- Test: `worker/tests/test_tiktok_tokens.py`
- Modify: `worker/config.py`, `worker/run.py`, `.env.example`

**Interfaces:**
- Consumes: `TikTokClient.refresh_access_token` (Task 2).
- Produces: `refresh_channel_token(conn, config, client, channel, now, logger=None) -> dict`
  returning the channel row (refreshed or unchanged); `TikTokAuthRevoked(Exception)`.
- `Config` gains `tiktok_client_key: str` and `tiktok_client_secret: str`.

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/test_tiktok_tokens.py
"""Token upkeep. TikTok access tokens last 24 hours and refresh tokens ROTATE — this is the
only platform in this project that dies if the worker does nothing."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from worker import db
from worker.tiktok_api import TikTokAPIError
from worker.tiktok_tokens import TikTokAuthRevoked, refresh_channel_token

NOW = datetime(2026, 8, 23, 12, 0, tzinfo=timezone.utc)


class FakeTikTok:
    def __init__(self, result=None, error=None):
        self.result = result or {
            "access_token": "act.NEW", "expires_in": 86400,
            "refresh_token": "rft.ROTATED", "refresh_expires_in": 31536000,
        }
        self.error = error
        self.calls = 0

    def refresh_access_token(self, key, secret, refresh_token):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


def _tiktok_channel(conn, *, expires_in_hours):
    expiry = (NOW + timedelta(hours=expires_in_hours)).isoformat()
    conn.execute(
        "INSERT INTO channels (platform, account_name, timezone, access_token, "
        "token_expires_at, refresh_token, refresh_token_expires_at) "
        "VALUES ('tiktok', 'tt', 'UTC', 'act.OLD', ?, 'rft.OLD', ?)",
        (expiry, (NOW + timedelta(days=300)).isoformat()),
    )
    conn.commit()
    cid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    return db.get_channel(conn, cid)


def test_token_expiring_within_the_hour_is_refreshed(conn, config):
    ch = _tiktok_channel(conn, expires_in_hours=0.5)
    client = FakeTikTok()
    out = refresh_channel_token(conn, config, client, ch, NOW)
    assert client.calls == 1
    assert out["access_token"] == "act.NEW"
    stored = db.get_channel(conn, ch["id"])
    assert stored["access_token"] == "act.NEW"
    # The rotated refresh token MUST be stored — this is the failure that kills a channel.
    assert stored["refresh_token"] == "rft.ROTATED"


def test_healthy_token_is_left_alone(conn, config):
    ch = _tiktok_channel(conn, expires_in_hours=10)
    client = FakeTikTok()
    out = refresh_channel_token(conn, config, client, ch, NOW)
    assert client.calls == 0
    assert out["access_token"] == "act.OLD"


def test_a_revoked_grant_is_terminal_and_says_reconnect(conn, config):
    ch = _tiktok_channel(conn, expires_in_hours=0.1)
    client = FakeTikTok(error=TikTokAPIError("POST /v2/oauth/token/ -> 200: invalid_grant: no"))
    with pytest.raises(TikTokAuthRevoked) as exc:
        refresh_channel_token(conn, config, client, ch, NOW)
    assert "reconnect" in str(exc.value).lower()


def test_a_transient_failure_stays_retryable(conn, config):
    ch = _tiktok_channel(conn, expires_in_hours=0.1)
    client = FakeTikTok(error=TikTokAPIError("POST /v2/oauth/token/ -> request failed: timeout"))
    with pytest.raises(TikTokAPIError):
        refresh_channel_token(conn, config, client, ch, NOW)   # NOT TikTokAuthRevoked


def test_missing_client_credentials_fail_loudly(conn, config):
    ch = _tiktok_channel(conn, expires_in_hours=0.1)
    config = config.__class__(**{**config.__dict__, "tiktok_client_key": ""})
    with pytest.raises(TikTokAuthRevoked):
        refresh_channel_token(conn, config, FakeTikTok(), ch, NOW)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pytest worker/tests/test_tiktok_tokens.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.tiktok_tokens'`.

- [ ] **Step 3: Add the two config fields**

In `worker/config.py`, add to the dataclass and to `from_env`:

```python
    tiktok_client_key: str = ""
    tiktok_client_secret: str = ""
```
```python
            tiktok_client_key=os.environ.get("TIKTOK_CLIENT_KEY", ""),
            tiktok_client_secret=os.environ.get("TIKTOK_CLIENT_SECRET", ""),
```

And in `.env.example`, with the comment that matters:

```bash
# TikTok (per-install: register your OWN app at developers.tiktok.com — see docs/tiktok-setup.md).
# Never share these with another install; the audit and every quota attach to the app, not to you.
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```

- [ ] **Step 4: Implement**

```python
# worker/tiktok_tokens.py
"""Keep a TikTok channel's access token alive.

Every other platform here hands out a token that sits in the row and works. TikTok's lasts
24 hours, and its refresh token ROTATES: each refresh returns a new one and invalidates the
one you sent. Failing to store the new one locks the channel out permanently — so the write
is part of the refresh, not a follow-up.

The distinction that matters most is revoked-vs-transient. A network blip must be retried;
a revoked authorisation must not, because retrying it forever hides the one thing the owner
needs to know: reconnect the channel.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from . import db
from .tiktok_api import TikTokAPIError

# Refresh when the access token has less than this left. An hour is comfortably longer than
# any single publish (chunked upload + status polling) so a token cannot expire mid-flight.
REFRESH_MARGIN = timedelta(hours=1)

# TikTok's OAuth error codes that mean "this grant is dead" rather than "try again".
_REVOKED_CODES = ("invalid_grant", "invalid_request", "access_token_invalid")


class TikTokAuthRevoked(Exception):
    """The channel's authorisation is gone. Only a human reconnecting fixes this."""


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def refresh_channel_token(conn, config, client, channel, now, logger=None) -> dict:
    """Return the channel row with a usable access token, refreshing first if needed."""
    if channel["platform"] != "tiktok":
        return channel
    expires_at = _parse(channel["token_expires_at"])
    if expires_at is not None and expires_at - now > REFRESH_MARGIN:
        return channel

    if not config.tiktok_client_key or not config.tiktok_client_secret:
        raise TikTokAuthRevoked(
            "TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET are not set in .env — "
            "reconnect this channel after adding them"
        )
    if not channel["refresh_token"]:
        raise TikTokAuthRevoked(
            f"channel {channel['id']} has no refresh token — reconnect it in the dashboard"
        )

    try:
        tokens = client.refresh_access_token(
            config.tiktok_client_key, config.tiktok_client_secret, channel["refresh_token"]
        )
    except TikTokAPIError as exc:
        if any(code in str(exc) for code in _REVOKED_CODES):
            raise TikTokAuthRevoked(
                f"TikTok refused to refresh channel {channel['id']} — "
                f"reconnect it in the dashboard ({exc})"
            ) from None
        raise   # transient: the caller's normal backoff applies

    # One write, both tokens. Storing the access token without the rotated refresh token
    # would work today and lock the channel out at the next refresh.
    db.update_channel(
        conn, channel["id"],
        access_token=tokens["access_token"],
        token_expires_at=(now + timedelta(seconds=int(tokens["expires_in"]))).isoformat(),
        refresh_token=tokens["refresh_token"],
        refresh_token_expires_at=(
            now + timedelta(seconds=int(tokens["refresh_expires_in"]))
        ).isoformat(),
        updated_at=now.isoformat(),
    )
    if logger:
        logger.info("[tiktok] refreshed access token for channel %s", channel["id"])
    return db.get_channel(conn, channel["id"])
```

> If `db.update_channel` does not exist, add it beside `db.update_publication` using the same
> `**fields` pattern, and cover it in `worker/tests/test_db.py`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pytest worker/tests/test_tiktok_tokens.py -v`
Expected: PASS, all 5.

- [ ] **Step 6: Call it before publishing**

In `worker/publisher.py`'s `run_once`, immediately before the quota gate (step 3), after the
channel and client are resolved:

```python
    # TikTok's token expires every 24h — refresh before use. Placed here rather than in a
    # background job so a token can never expire between the check and the upload.
    if channel["platform"] == "tiktok":
        from .tiktok_tokens import TikTokAuthRevoked, refresh_channel_token

        try:
            channel = refresh_channel_token(conn, config, client, channel, now, logger=logger)
            token = channel["access_token"]
        except TikTokAuthRevoked as exc:
            # Terminal: no amount of retrying reconnects an account. The owner must act,
            # so this must be visible on the row rather than looping quietly.
            log(f"tiktok auth revoked: {exc}")
            return _mark_failure(conn, pub, config, now, str(exc), terminal=True)
        except Exception as exc:  # noqa: BLE001 — transient refresh failure, retry with backoff
            log(f"tiktok token refresh failed: {exc}")
            return _mark_failure(conn, pub, config, now, f"token refresh: {exc}", terminal=False)
```

- [ ] **Step 7: Run the full suite and commit**

Run: `pytest worker/tests -q`
Expected: PASS.

```bash
git add worker/tiktok_tokens.py worker/config.py worker/publisher.py .env.example \
        worker/tests/test_tiktok_tokens.py
git commit -m "fix(tiktok): refresh before publishing, and store the token that replaces it"
```

---

## Task 6: Dashboard — the platform entry and the image refusal

**Files:**
- Modify: `dashboard/lib/platforms.ts`, `dashboard/lib/types.ts`
- Test: `dashboard/lib/platforms-tiktok.test.ts`

**Interfaces:**
- Produces: `PLATFORMS` entry `"tiktok"`; `supportsImages(platform): boolean`;
  `incompatibleChannelsForPost` reason `"images"`.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/lib/platforms-tiktok.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORMS, captionLimit, incompatiblePostError, isPlatform,
  platformBadge, platformLabel, supportsImages, supportsMetrics, supportsVideo,
} from "./platforms";

test("tiktok is a known platform with its own label and badge", () => {
  assert.ok(isPlatform("tiktok"));
  assert.equal(platformLabel("tiktok"), "TikTok");
  assert.equal(platformBadge("tiktok"), "TT");
});

test("tiktok takes video and refuses images", () => {
  assert.equal(supportsVideo("tiktok"), true);
  assert.equal(supportsImages("tiktok"), false);
});

test("every other platform still accepts images", () => {
  for (const p of PLATFORMS) {
    if (p.value !== "tiktok") assert.equal(supportsImages(p.value), true);
  }
});

test("an unknown platform is assumed to accept images", () => {
  // Safe direction: an unrecognised platform must not have its image posts hidden.
  assert.equal(supportsImages("myspace"), true);
});

test("tiktok enforces no caption limit because it sends no caption", () => {
  assert.equal(captionLimit("tiktok", "reel"), null);
});

test("an image post targeted at tiktok is refused by name", () => {
  const err = incompatiblePostError("single", 1, [
    { id: 1, platform: "tiktok", account_name: "Liparoto" },
  ]);
  assert.match(err ?? "", /Liparoto \(TikTok\)/);
  assert.match(err ?? "", /video/i);
});

test("a reel targeted at tiktok is allowed", () => {
  assert.equal(
    incompatiblePostError("reel", 1, [{ id: 1, platform: "tiktok", account_name: "L" }]),
    null
  );
});

test("tiktok reports no metrics until a post id is known", () => {
  // supportsMetrics stays true — TikTok DOES have a metrics API; whether a given send has
  // numbers is a per-send question answered by delivery_state, not a platform capability.
  assert.equal(supportsMetrics("tiktok"), true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd dashboard && npx tsx --test lib/platforms-tiktok.test.ts` (or `npm test` and read the
failures)
Expected: FAIL — `isPlatform("tiktok")` is false.

- [ ] **Step 3: Implement**

Add to `PLATFORMS` in `dashboard/lib/platforms.ts`:

```ts
  {
    value: "tiktok",
    label: "TikTok",
    badge: "TT",
    accountIdLabel: "TikTok open id",
    usesLinkedPage: false,
    usesAccountId: true,
    supportsText: false,
    supportsVideo: true,
    supportsImages: false,
    supportsStory: false,
    maxCarousel: 0,
    // Empty on purpose: the inbox upload endpoint has no caption field at all, so there is
    // no limit to enforce — the creator writes the caption in the TikTok app.
    captionChars: {},
    supportsMetrics: true,
  },
```

Add `supportsImages: true` to the other five entries (the worker's copy defaults it; this copy
is explicit per file convention), then:

```ts
// Default TRUE for an unrecognised platform — the safe direction here is the opposite of
// supportsVideo's: worst case the composer offers an image post to something that refuses
// it, rather than hiding image posting from a platform that supports it (which would be
// most of them).
export function supportsImages(value: string): boolean {
  return BY_VALUE.get(value)?.supportsImages ?? true;
}
```

Extend `PostCompatReason` with `"images"`, add the check to `incompatibleChannelsForPost`
alongside the `reel` branch:

```ts
    if (postType === "single" || postType === "carousel") {
      if (!supportsImages(c.platform)) {
        out.push({ channel: c, reason: "images" });
        continue;
      }
    }
```

and the message in `incompatiblePostError`:

```ts
        : issue.reason === "images"
          ? `${describeChannel(issue.channel)} publishes video only — it can't take an image post.`
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && npm test`
Expected: PASS, and no regressions in the existing suite.

- [ ] **Step 5: Lint (this repo is at 0 errors — keep it there) and commit**

```bash
cd dashboard && npm run lint
git add dashboard/lib/platforms.ts dashboard/lib/types.ts dashboard/lib/platforms-tiktok.test.ts
git commit -m "feat(dashboard): teach the composer that TikTok takes video and nothing else"
```

---

## Task 7: Dashboard — render the delivery state honestly

**Files:**
- Modify: `dashboard/lib/queries.ts`, `dashboard/lib/types.ts`,
  `dashboard/components/publication-queue.tsx`, `dashboard/components/post-sends-panel.tsx`
- Test: `dashboard/lib/delivery-state.test.ts`

**Interfaces:**
- Consumes: `publications.delivery_state` (Task 1), written by Task 4.
- Produces: `deliveryLabel(row): string | null` in `dashboard/lib/platforms.ts` — the single
  place that turns a delivery state into words.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/lib/delivery-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryLabel } from "./platforms";

test("a delivered TikTok send never reads as posted", () => {
  const label = deliveryLabel({ platform: "tiktok", status: "posted", delivery_state: "inbox" });
  assert.match(label ?? "", /inbox/i);
  assert.doesNotMatch(label ?? "", /^posted$/i);
});

test("a published TikTok send says it is live", () => {
  assert.match(
    deliveryLabel({ platform: "tiktok", status: "posted", delivery_state: "published" }) ?? "",
    /live on tiktok/i
  );
});

test("an unconfirmed send says so rather than guessing", () => {
  const label = deliveryLabel({ platform: "tiktok", status: "posted", delivery_state: "gave_up" });
  assert.match(label ?? "", /unconfirmed/i);
});

test("every other platform is unaffected", () => {
  assert.equal(
    deliveryLabel({ platform: "instagram", status: "posted", delivery_state: null }),
    null
  );
});

test("a failed TikTok send is not relabelled as delivered", () => {
  // delivery_state is only meaningful once the worker succeeded; a failure must keep saying
  // failed rather than borrowing an inbox label from a stale column.
  assert.equal(
    deliveryLabel({ platform: "tiktok", status: "failed", delivery_state: "inbox" }),
    null
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd dashboard && npm test`
Expected: FAIL — `deliveryLabel` is not exported.

- [ ] **Step 3: Implement**

```ts
// dashboard/lib/platforms.ts
export interface DeliveryLike {
  platform: string;
  status: string;
  delivery_state: string | null;
}

// The single place that turns a delivery state into words, so the queue, the post page and
// anything added later cannot describe the same row differently.
//
// Returns null when there is nothing extra to say — every platform that publishes on
// command, and any send that did not reach 'posted'. That last case matters: delivery_state
// is only meaningful once the worker succeeded, and a failed row must keep saying failed
// rather than borrowing a label from a column left over from an earlier attempt.
export function deliveryLabel(row: DeliveryLike): string | null {
  if (row.status !== "posted" || !row.delivery_state) return null;
  switch (row.delivery_state) {
    case "inbox":
      return "In your TikTok inbox — open TikTok to publish";
    case "published":
      return "Live on TikTok";
    case "gave_up":
      return "Delivered — publication unconfirmed";
    default:
      // An unrecognised state must look wrong rather than silently read as published.
      return `Unknown delivery state: ${row.delivery_state}`;
  }
}
```

Then: add `delivery_state` and `delivery_checked_at` to the publication row type in
`dashboard/lib/types.ts`, add both columns to `getPostPublications` and the queue query in
`dashboard/lib/queries.ts`, and render `deliveryLabel(row)` in place of the plain "Posted" badge
in `publication-queue.tsx` and `post-sends-panel.tsx` whenever it returns non-null.

In `post-sends-panel.tsx`, the metrics line must stay gated on `post_metrics.fetched_at` (the
existing rule) — a TikTok send in the inbox has no metrics and must say so with the *same*
"not fetched yet" wording, not a TikTok-specific message.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && npm test && npm run lint`
Expected: PASS, lint 0 errors.

- [ ] **Step 5: Look at it in a real browser**

`renderToStaticMarkup` cannot catch layout or handlers. Point a dashboard at a scratch copy of
the DB (`sqlite3 data/socialscheduler.db ".backup /tmp/tiktok-ui.db"`, then
`DATABASE_PATH=/tmp/tiktok-ui.db npm run dev -- -p 3940`), hand-insert a TikTok channel and one
publication per delivery state, and confirm all four render correctly.
In Safari, hard-reload with Cmd+Option+R — Turbopack reuses one CSS URL and serves stale styles.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib dashboard/components
git commit -m "feat(dashboard): say a TikTok video is waiting in your inbox, not that it posted"
```

---

## Task 8: Dashboard — connect a TikTok account

**Files:**
- Create: `dashboard/lib/tiktok-oauth.ts`,
  `dashboard/app/api/channels/tiktok/authorize/route.ts`,
  `dashboard/app/api/channels/tiktok/callback/route.ts`
- Modify: `dashboard/app/channels/page.tsx`, `dashboard/app/api/channels/route.ts`
- Test: `dashboard/lib/tiktok-oauth.test.ts`

**Interfaces:**
- Produces: `createVerifier(): string`, `challengeFor(verifier: string): string` (S256, base64url,
  unpadded), `authorizeUrl({clientKey, redirectUri, state, challenge, scopes}): string`.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/lib/tiktok-oauth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, challengeFor, createVerifier } from "./tiktok-oauth";

test("the verifier is long enough and url-safe", () => {
  const v = createVerifier();
  assert.ok(v.length >= 43 && v.length <= 128);   // RFC 7636
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
});

test("the challenge is unpadded base64url of the sha256", () => {
  // RFC 7636 vector.
  const challenge = challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.doesNotMatch(challenge, /=/);
});

test("two verifiers are never the same", () => {
  assert.notEqual(createVerifier(), createVerifier());
});

test("the authorize url carries every required parameter", () => {
  const url = new URL(authorizeUrl({
    clientKey: "key", redirectUri: "http://localhost:3939/api/channels/tiktok/callback",
    state: "st", challenge: "ch", scopes: ["user.info.basic", "video.upload", "video.list"],
  }));
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("client_key"), "key");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.upload,video.list");
  // video.publish is deliberately absent — it cannot be granted without the app audit.
  assert.doesNotMatch(url.searchParams.get("scope") ?? "", /video\.publish/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd dashboard && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

```ts
// dashboard/lib/tiktok-oauth.ts
import { createHash, randomBytes } from "node:crypto";

// TikTok Desktop-type apps require PKCE and allow an http://localhost redirect (web apps are
// forced to HTTPS). That is the whole reason this tool can do OAuth at all without a domain.
export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";

// video.publish is NOT requested: it is the direct-post scope, and it cannot be granted
// without TikTok's app audit (see the spec's Gate 1). Asking for it would fail the whole
// authorisation rather than degrade.
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload", "video.list"] as const;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createVerifier(): string {
  return base64url(randomBytes(48));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function authorizeUrl(opts: {
  clientKey: string; redirectUri: string; state: string; challenge: string;
  scopes: readonly string[];
}): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("client_key", opts.clientKey);
  url.searchParams.set("scope", opts.scopes.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
```

- [ ] **Step 4: Write the two routes**

`authorize/route.ts` — generates verifier + state, stores them in httpOnly cookies (no schema
needed for a value that lives for one redirect), and 302s to TikTok. It must refuse clearly when
`TIKTOK_CLIENT_KEY` is unset rather than sending a broken URL. The redirect URI is built from
the request's own origin so it matches whatever port the dashboard is on — but it must be
registered in the TikTok portal exactly, so the setup doc names `http://localhost:3939/...`.

`callback/route.ts`:
1. Reject if `state` doesn't match the cookie (CSRF).
2. Exchange the code with `client_key`, `client_secret`, `code_verifier`, same `redirect_uri`.
   **Server-side only** — the secret must never reach the browser.
3. `createChannel({platform: "tiktok", account_name: <display_name from /v2/user/info/>,
   remote_account_id: <open_id>, access_token, token_expires_at, refresh_token,
   refresh_token_expires_at, timezone: <install default>})`.
4. Clear the cookies and redirect to `/channels` with a success flag.
5. On failure, redirect to `/channels` with an error message — never render the raw error, which
   can echo the code.

Extend `createChannel` in `dashboard/lib/queries.ts` to accept `refresh_token`,
`refresh_token_expires_at` and `token_expires_at`.

- [ ] **Step 5: Add the Connect button**

In `dashboard/app/channels/page.tsx`, when the selected platform is `tiktok`, replace the token
and account-id fields with a single **Connect TikTok account** button linking to
`/api/channels/tiktok/authorize`. TikTok is the only platform whose credentials are never typed
in — leaving the manual fields visible invites pasting a token that will expire in 24 hours.

- [ ] **Step 6: Verify the flow end to end in a browser**

With `TIKTOK_CLIENT_KEY`/`SECRET` set and the redirect registered: click Connect, approve on
TikTok, and confirm you land back on `/channels` with a new channel whose name is your TikTok
display name. Then check the row:

```bash
sqlite3 data/socialscheduler.db \
  "SELECT id, platform, account_name, remote_account_id IS NOT NULL,
          access_token IS NOT NULL, refresh_token IS NOT NULL, token_expires_at
   FROM channels WHERE platform='tiktok';"
```
Expected: all three flags `1`, and `token_expires_at` roughly 24 hours out.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/tiktok-oauth.ts dashboard/lib/tiktok-oauth.test.ts \
        dashboard/app/api/channels dashboard/app/channels/page.tsx dashboard/lib/queries.ts
git commit -m "feat(dashboard): connect a TikTok account without ever pasting a token"
```

---

## Task 9: Setup documentation

**Files:**
- Create: `docs/tiktok-setup.md`
- Modify: `reference.md`, `readme.md`

- [ ] **Step 1: Write `docs/tiktok-setup.md`**

Match `docs/other-platforms-setup.md`'s voice: numbered steps, the exact thing to click, and the
step people miss called out. It must cover:

1. **Create the app** at developers.tiktok.com → add **Login Kit** and **Content Posting API**.
2. **Set the app type to Desktop** — the step people miss. A Web app cannot use a `localhost`
   redirect, and the whole flow depends on it.
3. **Register the redirect URI** exactly: `http://localhost:3939/api/channels/tiktok/callback`
   (no query string, no fragment — TikTok rejects both).
4. **Copy the client key and secret into `.env`.**
5. **Connect** in the dashboard, then **preflight** (`python -m worker.preflight`).
6. **Publish one real video** with `DRY_RUN=0`, and what to expect: a TikTok notification, and
   the dashboard saying *"In your TikTok inbox"* — not "Posted".
7. **What TikTok will not do here, and why**, in plain terms: your caption does not travel (you
   write it in the app), photos are not supported, and the app is unaudited so direct posting is
   unavailable. Say that this is TikTok's design, not a missing feature — otherwise it reads as
   a bug forever.
8. **For a second install** (e.g. a family member): they register their own app. The audit and
   every limit attach to the app, so credentials are never shared between installs.

- [ ] **Step 2: Record the verified request shapes in `reference.md`**

Follow the existing per-platform sections. Include the endpoints, the `error.code == "ok"`
convention, the chunk rules, and TikTok's own misspelling `publicaly_available_post_id`.

- [ ] **Step 3: Commit**

```bash
git add docs/tiktok-setup.md reference.md readme.md
git commit -m "docs(tiktok): setup, and an honest account of what TikTok won't do here"
```

---

## Task 10: CHECKPOINT — one real delivery, and the R1 probe

**Stop here and do this by hand. Task 11 must not be written until this task answers R1.**

The spec's Decision 7 assumes an inbox `publish_id` eventually reports `PUBLISH_COMPLETE` with a
`publicaly_available_post_id` once the creator publishes in the app. That is inference from
TikTok's status documentation, not a documented guarantee, and the watcher and all of TikTok's
metrics rest on it.

- [ ] **Step 1: Deliver one real video**

Confirm `KILL_SWITCH=0` and `DRY_RUN=0`, compose a short video post targeting only the TikTok
channel, schedule it a minute in the past, and run one cycle:

```bash
python -m worker.run --once
```
Expected: the log says `delivered to inbox -> <publish_id>`, a notification arrives on the phone,
and the dashboard says "In your TikTok inbox".

- [ ] **Step 2: Record the publish_id**

```bash
sqlite3 data/socialscheduler.db \
  "SELECT id, remote_container_id, delivery_state, remote_post_id
   FROM publications WHERE channel_id=(SELECT id FROM channels WHERE platform='tiktok')
   ORDER BY id DESC LIMIT 1;"
```

- [ ] **Step 3: Publish it from the TikTok app**, publicly, and wait for moderation (minutes).

- [ ] **Step 4: Probe the status endpoint with that same publish_id**

Write a throwaway script under the scratchpad (not in the repo) that calls
`fetch_publish_status(access_token, publish_id)` every few minutes for an hour and prints the
raw status plus whether `publicaly_available_post_id` ever appears.

- [ ] **Step 5: Record the answer in the spec, whichever way it goes**

- **If the post id appears:** note the observed delay, then proceed to Task 11 as written.
- **If it never appears:** Decision 7 is wrong. Do **not** build the watcher as specced. Update
  the spec, and choose between the documented fallback (match the video by `create_time`
  proximity via `/v2/video/list/`) and shipping TikTok with no metrics like Discord and Telegram.
  Either way, `delivery_state` stays — knowing a video is waiting in the inbox is useful on its
  own. Bring the finding back before writing code.

```bash
git commit --allow-empty -m "test(tiktok): record what the status endpoint does after an inbox post goes live"
```

---

## Task 11: The delivery watcher

**Only if Task 10 confirmed R1.**

**Files:**
- Create: `worker/tiktok_watcher.py`
- Test: `worker/tests/test_tiktok_watcher.py`
- Modify: `worker/run.py`

**Interfaces:**
- Consumes: `TikTokClient.fetch_publish_status`, `refresh_channel_token`.
- Produces: `run_tiktok_watcher(conn, config, client, now, logger=None, client_for=None) -> int`
  (number of rows checked).

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/test_tiktok_watcher.py
"""The watcher answers one question: did the creator ever publish it?

It must never guess. A video still sitting in the inbox stays 'inbox'; one that is confirmed
live becomes 'published' and only then gets a remote_post_id, which is what admits it to the
metrics due-query.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker import db
from worker.tiktok_watcher import GIVE_UP_AFTER, run_tiktok_watcher

NOW = datetime(2026, 8, 23, 12, 0, tzinfo=timezone.utc)


class FakeTikTok:
    def __init__(self, status):
        self.status = status
        self.calls = 0

    def fetch_publish_status(self, token, publish_id):
        self.calls += 1
        return self.status


def test_still_in_inbox_stays_in_inbox(conn, config, delivered_pub):
    run_tiktok_watcher(conn, config, FakeTikTok({"status": "SEND_TO_USER_INBOX"}), NOW)
    row = db.get_publication(conn, delivered_pub["id"])
    assert row["delivery_state"] == "inbox"
    assert row["remote_post_id"] is None
    assert row["delivery_checked_at"] is not None   # the check itself is recorded


def test_published_promotes_and_records_the_post_id(conn, config, delivered_pub):
    run_tiktok_watcher(conn, config, FakeTikTok(
        {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": ["7123"]}
    ), NOW)
    row = db.get_publication(conn, delivered_pub["id"])
    assert row["delivery_state"] == "published"
    assert row["remote_post_id"] == "7123"


def test_complete_without_a_post_id_does_not_promote(conn, config, delivered_pub):
    """PUBLISH_COMPLETE alone can mean a private post, or one still in moderation. Promoting
    on it would set remote_post_id to nothing and hand metrics an empty id forever."""
    run_tiktok_watcher(conn, config, FakeTikTok({"status": "PUBLISH_COMPLETE"}), NOW)
    row = db.get_publication(conn, delivered_pub["id"])
    assert row["delivery_state"] == "inbox"
    assert row["remote_post_id"] is None


def test_gives_up_after_the_window(conn, config, delivered_pub):
    later = NOW + GIVE_UP_AFTER + timedelta(hours=1)
    run_tiktok_watcher(conn, config, FakeTikTok({"status": "SEND_TO_USER_INBOX"}), later)
    row = db.get_publication(conn, delivered_pub["id"])
    assert row["delivery_state"] == "gave_up"


def test_a_gave_up_row_is_never_polled_again(conn, config, delivered_pub):
    db.update_publication(conn, delivered_pub["id"], delivery_state="gave_up")
    client = FakeTikTok({"status": "SEND_TO_USER_INBOX"})
    run_tiktok_watcher(conn, config, client, NOW)
    assert client.calls == 0


def test_respects_the_poll_interval(conn, config, delivered_pub):
    client = FakeTikTok({"status": "SEND_TO_USER_INBOX"})
    run_tiktok_watcher(conn, config, client, NOW)
    run_tiktok_watcher(conn, config, client, NOW + timedelta(minutes=1))
    assert client.calls == 1, "a row checked a minute ago must not be re-polled"


def test_a_status_failure_does_not_change_the_state(conn, config, delivered_pub):
    class Boom:
        def fetch_publish_status(self, token, publish_id):
            raise RuntimeError("network")

    run_tiktok_watcher(conn, config, Boom(), NOW)
    row = db.get_publication(conn, delivered_pub["id"])
    assert row["delivery_state"] == "inbox"   # unchanged; a failed check is not evidence
```

> `delivered_pub` is a fixture inserting a TikTok publication with `status='posted'`,
> `delivery_state='inbox'`, `remote_container_id='pub-1'`, `published_at=NOW`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pytest worker/tests/test_tiktok_watcher.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```python
# worker/tiktok_watcher.py
"""Did the creator ever publish the video we delivered?

The worker hands a video to TikTok and the creator finishes the post themselves, so nothing
in the publish path can know whether it went live. This loop asks, on a slow cadence, until
TikTok answers or the window closes.

The rule it must never break: only a post id promotes a row. PUBLISH_COMPLETE on its own is
not proof — it also covers a private post and one still in moderation — and promoting
without an id would hand the metrics loop an empty id to chase forever.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from . import db

# Cadence: often at first (most creators publish soon after the notification), then rarely.
FAST_INTERVAL = timedelta(minutes=15)
FAST_WINDOW = timedelta(hours=6)
SLOW_INTERVAL = timedelta(hours=1)
# After a week, stop asking. The row says 'gave_up' — "we don't know", which is the truth,
# rather than a state that implies it failed or that it published.
GIVE_UP_AFTER = timedelta(days=7)


def _due(pub, now) -> bool:
    published = datetime.fromisoformat(pub["published_at"])
    checked = pub["delivery_checked_at"]
    age = now - published
    interval = FAST_INTERVAL if age <= FAST_WINDOW else SLOW_INTERVAL
    if checked is None:
        return True
    return now - datetime.fromisoformat(checked) >= interval


def run_tiktok_watcher(conn, config, client, now, logger=None, client_for=None) -> int:
    rows = conn.execute(
        """
        SELECT pub.* FROM publications pub
        JOIN channels ch ON ch.id = pub.channel_id
        WHERE ch.platform = 'tiktok'
          AND pub.status = 'posted'
          AND pub.is_dry_run = 0
          AND pub.delivery_state = 'inbox'
          AND pub.remote_container_id IS NOT NULL
        """
    ).fetchall()

    checked = 0
    for pub in rows:
        if not _due(pub, now):
            continue
        channel = db.get_channel(conn, pub["channel_id"])
        pub_client = client_for("tiktok") if client_for else client
        try:
            from .tiktok_tokens import refresh_channel_token

            channel = refresh_channel_token(conn, config, pub_client, channel, now, logger=logger)
            data = pub_client.fetch_publish_status(
                channel["access_token"], pub["remote_container_id"]
            )
        except Exception as exc:  # noqa: BLE001 — a failed check is not evidence of anything
            if logger:
                logger.warning("[tiktok watcher] pub %s check failed: %s", pub["id"], exc)
            continue
        checked += 1

        post_ids = data.get("publicaly_available_post_id") or []
        if post_ids:
            db.update_publication(
                conn, pub["id"],
                delivery_state="published", remote_post_id=str(post_ids[0]),
                delivery_checked_at=now.isoformat(), updated_at=now.isoformat(),
            )
            if logger:
                logger.info("[tiktok watcher] pub %s is live as %s", pub["id"], post_ids[0])
            continue

        published = datetime.fromisoformat(pub["published_at"])
        if now - published >= GIVE_UP_AFTER:
            db.update_publication(
                conn, pub["id"],
                delivery_state="gave_up", delivery_checked_at=now.isoformat(),
                updated_at=now.isoformat(),
            )
            if logger:
                logger.info("[tiktok watcher] pub %s unconfirmed after %s; giving up",
                            pub["id"], GIVE_UP_AFTER)
            continue

        db.update_publication(
            conn, pub["id"],
            delivery_checked_at=now.isoformat(), updated_at=now.isoformat(),
        )
    return checked
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest worker/tests/test_tiktok_watcher.py -v`
Expected: PASS, all 7.

- [ ] **Step 5: Wire it into the cycle**

In `worker/run.py`'s `run_once`, after `run_metrics` and before `run_avatars` — it is read-only,
so like avatars it runs in dry-run mode too:

```python
    # Learn whether delivered TikTok videos were ever actually published. Read-only against
    # TikTok, so it runs in dry-run mode too — it publishes nothing.
    from .tiktok_watcher import run_tiktok_watcher

    run_tiktok_watcher(conn, config, client, now, logger=logger, client_for=client_for)
```

- [ ] **Step 6: Run the full suite and commit**

Run: `pytest worker/tests -q`

```bash
git add worker/tiktok_watcher.py worker/run.py worker/tests/test_tiktok_watcher.py
git commit -m "feat(tiktok): learn whether a delivered video ever went live, and say so"
```

---

## Task 12: TikTok post metrics

**Only if Task 10 confirmed R1.**

**Files:**
- Modify: `worker/metrics.py`, `dashboard/components/post-sends-panel.tsx`,
  `dashboard/components/publication-queue.tsx`
- Test: `worker/tests/test_tiktok_metrics.py`, `dashboard/lib/delivery-state.test.ts`

**Interfaces:**
- Consumes: `TikTokClient.query_videos`; `remote_post_id` set by Task 11.
- Produces: `metrics._fetch_tiktok(client, remote_post_id, token, config, surface="feed") -> dict`
  returning `{"view_count", "like_count", "comment_count", "share_count"}`.

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/test_tiktok_metrics.py
"""TikTok's numbers, in TikTok's words.

The Threads bug this project already fixed was one platform's vocabulary standing in for
another's. TikTok has views/likes/comments/shares and NO reach and NO saves — those must come
back absent, never as zero, or a real 0 and "this platform has no such concept" become
indistinguishable.
"""
from __future__ import annotations

import pytest

from worker.metrics import _FETCHERS, _fetch_tiktok


class FakeTikTok:
    def __init__(self, videos):
        self.videos = videos
        self.asked = None

    def query_videos(self, token, video_ids, fields):
        self.asked = (list(video_ids), list(fields))
        return self.videos


def test_registered_as_a_real_fetcher():
    assert _FETCHERS["tiktok"] is not None


def test_maps_tiktok_counts(config):
    client = FakeTikTok([{"id": "7123", "view_count": 900, "like_count": 42,
                          "comment_count": 3, "share_count": 7}])
    out = _fetch_tiktok(client, "7123", "act.T", config)
    assert out["view_count"] == 900 and out["like_count"] == 42
    assert out["comment_count"] == 3 and out["share_count"] == 7


def test_reports_no_reach_and_no_saves(config):
    client = FakeTikTok([{"id": "7123", "view_count": 1}])
    out = _fetch_tiktok(client, "7123", "act.T", config)
    # Absent, not zero. TikTok has no such metric, and 0 would be a claim.
    assert "reach" not in out
    assert "saved" not in out and "saves" not in out


def test_a_missing_video_raises_rather_than_recording_zeros(config):
    client = FakeTikTok([])
    with pytest.raises(Exception):
        _fetch_tiktok(client, "7123", "act.T", config)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pytest worker/tests/test_tiktok_metrics.py -v`
Expected: FAIL — `_fetch_tiktok` does not exist and `_FETCHERS["tiktok"]` is None.

- [ ] **Step 3: Implement**

```python
# worker/metrics.py
TIKTOK_VIDEO_FIELDS = ("id", "view_count", "like_count", "comment_count", "share_count")


def _fetch_tiktok(client, remote_post_id, token, config, surface: str = "feed") -> dict:
    # surface accepted and ignored — TikTok has no Stories surface here. Same shape as the
    # other fetchers so _FETCHERS stays callable without special-casing one platform.
    """One Display API query by video id.

    Returns ONLY the four metrics TikTok reports. Reach and saves are absent rather than
    zero: TikTok has neither concept, and a zero would read as a measured value. The
    dashboard's per-platform vocabulary (post-sends-panel) is the other half of this rule.
    """
    videos = client.query_videos(token, [remote_post_id], TIKTOK_VIDEO_FIELDS)
    if not videos:
        # Never record an all-null snapshot: the caller skips this cycle and tries again,
        # which is right for a video pulled down or still in moderation.
        raise RuntimeError(f"tiktok returned no video for id {remote_post_id}")
    video = videos[0]
    return {k: video[k] for k in ("view_count", "like_count", "comment_count", "share_count")
            if k in video}
```

Then replace the temporary `None` with `"tiktok": _fetch_tiktok` in `_FETCHERS`.

- [ ] **Step 4: Give TikTok its own vocabulary in the dashboard**

In `post-sends-panel.tsx`'s `metricLine()` and `publication-queue.tsx`, add a TikTok branch:
**views / likes / comments / shares**. No reach, no saves. Keep the existing three outcomes so
"fetched, nothing reported" cannot read as "not fetched yet", and keep the gate on
`post_metrics.fetched_at`. Add a dashboard test asserting a TikTok send never renders the word
"reach" or "saves".

- [ ] **Step 5: Check autofill's ranking is not skewed**

`autofill.py` ranks candidates on reach + saves and takes MAX across group members, which is why
Threads scoring 0 there is harmless (see its line 347). Confirm the same holds for TikTok — it
reports neither metric, so it must contribute nothing rather than dragging a score down. Read
that code and add a test if the behaviour is not already covered.

- [ ] **Step 6: Run everything**

Run: `pytest worker/tests -q && cd dashboard && npm test && npm run lint`
Expected: all PASS, lint 0 errors.

- [ ] **Step 7: Commit**

```bash
git add worker/metrics.py dashboard/components worker/tests/test_tiktok_metrics.py
git commit -m "feat(tiktok): report views, likes, comments and shares — and nothing it can't"
```

---

## Task 13: Close it out

- [ ] **Step 1: Update `docs/tasks.md`**

Add TikTok to the open-work table's history in the established style: what shipped, what was
deliberately not built (direct post, photos, account-level Insights) and *why*, and R1's answer.
The next person's first question will be "why can't I post a photo to TikTok" — answer it there.

- [ ] **Step 2: Restart the worker so it runs the new code**

```bash
./Stop-SocialScheduler-Mac.command && ./Start-SocialScheduler-Mac.command
```
A live heartbeat proves the daemon is running, not that it is running current code.

- [ ] **Step 3: Full verification sweep**

```bash
pytest worker/tests -q
cd dashboard && npm test && npm run lint
python -m worker.preflight
```

- [ ] **Step 4: Commit**

```bash
git add docs/tasks.md
git commit -m "docs(tasks): record the TikTok adapter, and what it deliberately does not do"
```
