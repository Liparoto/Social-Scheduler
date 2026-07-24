# Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adding a social platform safe and mechanical — widen two enum `CHECK` constraints without destroying data, and replace every silent platform fallthrough with explicit dispatch that fails loudly.

**Architecture:** Three independent pieces. (1) One migration rebuilds `channels` and `posts` with widened enums, using SQLite's table-rebuild procedure with foreign keys disabled — plus the regression test that makes that safe forever. (2) The worker gains one list of supported platforms and three explicit registries (publish / preflight / metrics) that fail loudly on anything else. (3) The dashboard gains one `platforms.ts` source of truth that nine hardcoded sites read from.

**Tech Stack:** Python 3.11 in the repo `.venv`, pytest; Next.js App Router + TypeScript.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-platform-foundation-design.md`. Read it before Task 1.
- **Nothing user-visible may change.** No new platform in the UI, no new feature. Instagram and Facebook must behave and render **exactly** as they do today.
- **Never log tokens, PII, or full API responses.**
- **Failures must be visible and per-item**: an unsupported platform must fail that one publication terminally, never crash the worker, never affect another publication.
- No new dependencies (stdlib + `requests`; no new npm packages).
- Worker tests: `.venv/bin/python -m pytest worker/tests -q` — **currently 186 passing, takes ~110s; let it finish, it has not hung.**
- Dashboard typecheck: `cd dashboard && npx tsc --noEmit`
- Commit after each task.
- Correction to the spec's wording: the cascading children are **9 foreign-key edges across 7 distinct tables** (`post_assets`, `publications`, `post_tags`, `publish_limits`, `post_periods`, `post_targets`, `caption_variants`). Use 7 tables / 9 edges as the accurate figure.

---

### Task 1: Migration 0008 — widen both enums without data loss

**Files:**
- Create: `migrations/0008_platform_foundation.sql`
- Create: `worker/tests/test_migration_0008.py`

**Interfaces:**
- Consumes: the existing schema as of `0007` (definitions below are copied from the live database's `sqlite_master`, so they are exact — including the three columns `0002` appended to `posts`).
- Produces: `channels.platform` accepts `'threads'`; `posts.post_type` accepts `'text'`. Nothing writes either value yet. Later tasks and Part 2 depend only on this.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_migration_0008.py`:

```python
"""0008 rebuilds `channels` and `posts` to widen two enum CHECKs.

SQLite cannot ALTER a CHECK, so the tables must be rebuilt — and DROP TABLE with foreign
keys ENABLED performs an implicit delete that fires ON DELETE CASCADE. A naive rebuild
therefore reports success while silently deleting every dependent row (measured: a seeded
publications row went 1 -> 0). These tests exist to make sure that never ships.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"
TARGET = "0008_platform_foundation.sql"

# Every table with a cascading FK onto channels or posts (9 edges, 7 tables).
CHILD_TABLES = [
    "post_assets",
    "publications",
    "post_tags",
    "publish_limits",
    "post_periods",
    "post_targets",
    "caption_variants",
]


def _migrations_before_target() -> list[Path]:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name)
    return [f for f in files if f.name < TARGET]


def _counts(conn) -> dict[str, int]:
    return {
        t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in CHILD_TABLES + ["channels", "posts"]
    }


@pytest.fixture
def seeded_db(tmp_path):
    """A DB at migration 0007 with one row in every cascading child table.

    Seeding is deliberately verified (see test_seed_is_not_vacuous) so this fixture
    can't quietly produce an empty DB and make the real assertions meaningless.
    """
    path = tmp_path / "pre0008.db"
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON;")
    for f in _migrations_before_target():
        conn.executescript(f.read_text())
    conn.commit()

    # IMPLEMENTER: fill in the INSERTs below by reading migrations/0001_init.sql and
    # migrations/0002_content_model.sql for each table's required (NOT NULL, no-default)
    # columns. Insert exactly one row into: channels, posts, assets, post_assets,
    # publications, tags, post_tags, publish_limits, periods, post_periods, post_targets,
    # caption_variants. Use recognisable values (e.g. account_name='SEED CH') so a
    # surviving row is identifiable.
    _seed(conn)

    conn.commit()
    conn.close()
    return path


def _apply_target(path: Path) -> sqlite3.Connection:
    """Apply 0008 exactly the way migrate.py does: BEGIN then executescript."""
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("BEGIN;")
    conn.executescript((MIGRATIONS_DIR / TARGET).read_text())
    conn.commit()
    return conn


def test_seed_is_not_vacuous(seeded_db):
    # If this fails, every other test here is meaningless.
    conn = sqlite3.connect(str(seeded_db))
    before = _counts(conn)
    conn.close()
    for table, n in before.items():
        assert n >= 1, f"{table} was not seeded — the other assertions would be vacuous"


def test_every_child_row_survives_the_rebuild(seeded_db):
    conn = sqlite3.connect(str(seeded_db))
    before = _counts(conn)
    conn.close()

    conn = _apply_target(seeded_db)
    after = _counts(conn)
    conn.close()

    assert after == before, (
        "the rebuild changed row counts — a cascade fired. "
        f"before={before} after={after}"
    )


def test_foreign_keys_are_intact_and_re_enabled(seeded_db):
    conn = _apply_target(seeded_db)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    # Enforcement genuinely works afterwards, not just the flag.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (99999, 99999, '2026-01-01T00:00:00Z')"
        )
    conn.close()


def test_the_widened_values_are_accepted(seeded_db):
    conn = _apply_target(seeded_db)
    conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('threads', 'T')"
    )
    conn.execute("INSERT INTO posts (post_type) VALUES ('text')")
    conn.commit()
    conn.close()


def test_bogus_values_are_still_rejected(seeded_db):
    conn = _apply_target(seeded_db)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO channels (platform, account_name) VALUES ('mastodon', 'M')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type) VALUES ('bogus')")
    conn.close()


def test_the_other_constraints_and_defaults_survive(seeded_db):
    """The rebuild must change ONLY the two target enums."""
    conn = _apply_target(seeded_db)
    # Other CHECKs still enforced.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type, status) VALUES ('single', 'bogus')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type, content_kind) VALUES ('single', 'bogus')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO posts (post_type, content_status) VALUES ('single', 'bogus')")
    # Defaults still applied.
    cur = conn.execute("INSERT INTO channels (platform, account_name) VALUES ('instagram', 'D')")
    row = conn.execute(
        "SELECT timezone, requires_approval, reuse_min_age_days, is_active, created_at FROM channels WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    assert row[0] == "UTC"
    assert row[1] == 0
    assert row[2] == 180
    assert row[3] == 1
    assert row[4] is not None
    p = conn.execute("INSERT INTO posts (post_type) VALUES ('single')")
    prow = conn.execute(
        "SELECT status, content_kind, content_status, cooldown_days FROM posts WHERE id = ?",
        (p.lastrowid,),
    ).fetchone()
    assert prow == ("draft", "evergreen", "draft", None)
    conn.close()


def test_column_sets_are_unchanged(seeded_db):
    """No column added, removed, renamed or reordered."""
    conn = sqlite3.connect(str(seeded_db))
    before = {
        t: [r[1] for r in conn.execute(f"PRAGMA table_info({t})")]
        for t in ("channels", "posts")
    }
    conn.close()
    conn = _apply_target(seeded_db)
    after = {
        t: [r[1] for r in conn.execute(f"PRAGMA table_info({t})")]
        for t in ("channels", "posts")
    }
    conn.close()
    assert after == before


def test_no_leftover_scratch_tables(seeded_db):
    conn = _apply_target(seeded_db)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "channels_new" not in names
    assert "posts_new" not in names
    conn.close()
```

You must also write the `_seed(conn)` helper the fixture calls, above the fixture. Read `migrations/0001_init.sql` and `migrations/0002_content_model.sql` to get each table's required columns right. `test_seed_is_not_vacuous` is what proves you got it right.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0008.py -q`
Expected: FAIL — `migrations/0008_platform_foundation.sql` does not exist yet (`FileNotFoundError`). `test_seed_is_not_vacuous` should PASS once your `_seed` is right; get that one green first, since everything else depends on it.

- [ ] **Step 3: Write the migration**

Create `migrations/0008_platform_foundation.sql`:

```sql
-- 0008_platform_foundation.sql
-- Widen two enum CHECKs so a third platform, and text-only posts, become possible:
--   channels.platform  += 'threads'
--   posts.post_type    += 'text'
--
-- SQLite cannot ALTER a CHECK, so each table is rebuilt. DROP TABLE with foreign keys
-- ENABLED performs an implicit delete that FIRES ON DELETE CASCADE — a naive rebuild
-- reports success while silently deleting every dependent row (channels has 3 cascading
-- children, posts has 6). Enforcement is therefore disabled for the rebuild and restored
-- at the end. Python's executescript() commits before running, which ends migrate.py's
-- BEGIN and is why these PRAGMAs take effect.
--
-- These tables have no indexes, triggers or views, so there is nothing else to recreate.
-- Column sets, defaults and all OTHER CHECKs are reproduced verbatim: widening the two
-- target enums is the only semantic change.

PRAGMA foreign_keys = OFF;

-- ---- channels: platform gains 'threads' -------------------------------------------
CREATE TABLE channels_new (
    id                  INTEGER PRIMARY KEY,
    platform            TEXT    NOT NULL CHECK (platform IN ('instagram', 'facebook', 'threads')),
    account_name        TEXT    NOT NULL,
    business_label      TEXT,
    timezone            TEXT    NOT NULL DEFAULT 'UTC',

    -- Per-channel credentials. Stored in the LOCAL, gitignored DB only.
    remote_account_id   TEXT,                        -- IG user id, FB Page id, or Threads user id
    linked_page_id      TEXT,                        -- FB Page id when publishing IG via a linked Page
    access_token        TEXT,                        -- per-channel long-lived token (NEVER logged)
    token_expires_at    TEXT,

    requires_approval   INTEGER NOT NULL DEFAULT 0,

    autofill_enabled    INTEGER NOT NULL DEFAULT 0,
    cadence_config      TEXT,
    min_queue_depth     INTEGER NOT NULL DEFAULT 0,
    target_queue_depth  INTEGER NOT NULL DEFAULT 0,
    reuse_min_age_days  INTEGER NOT NULL DEFAULT 180,

    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT
);

INSERT INTO channels_new (
    id, platform, account_name, business_label, timezone, remote_account_id,
    linked_page_id, access_token, token_expires_at, requires_approval,
    autofill_enabled, cadence_config, min_queue_depth, target_queue_depth,
    reuse_min_age_days, is_active, created_at, updated_at
)
SELECT
    id, platform, account_name, business_label, timezone, remote_account_id,
    linked_page_id, access_token, token_expires_at, requires_approval,
    autofill_enabled, cadence_config, min_queue_depth, target_queue_depth,
    reuse_min_age_days, is_active, created_at, updated_at
FROM channels;

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

-- ---- posts: post_type gains 'text' ------------------------------------------------
CREATE TABLE posts_new (
    id             INTEGER PRIMARY KEY,
    caption        TEXT,
    first_comment  TEXT,
    post_type      TEXT    NOT NULL
                           CHECK (post_type IN ('single', 'carousel', 'reel', 'story', 'text')),
    status         TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'scheduled', 'posted', 'failed')),
    created_by     TEXT,                             -- free-text label for shared installs (NOT auth)
    created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT,
    content_kind   TEXT    NOT NULL DEFAULT 'evergreen'
                           CHECK (content_kind IN ('one_time', 'evergreen')),
    content_status TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (content_status IN ('draft', 'ready', 'retired')),
    cooldown_days  INTEGER                           -- NULL = use channel.reuse_min_age_days
);

INSERT INTO posts_new (
    id, caption, first_comment, post_type, status, created_by, created_at,
    updated_at, content_kind, content_status, cooldown_days
)
SELECT
    id, caption, first_comment, post_type, status, created_by, created_at,
    updated_at, content_kind, content_status, cooldown_days
FROM posts;

DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;

PRAGMA foreign_keys = ON;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0008.py -q`
Expected: PASS (8 tests). If `test_every_child_row_survives_the_rebuild` fails with lower counts, the `PRAGMA foreign_keys = OFF` is not taking effect — do not "fix" it by deleting the assertion.

- [ ] **Step 5: Verify against a COPY of the real database**

Never run this against `data/socialscheduler.db` itself.

```bash
cp data/socialscheduler.db /tmp/ss-0008-check.db
.venv/bin/python - <<'PY'
import sqlite3
from pathlib import Path
SRC = "/tmp/ss-0008-check.db"
TABLES = ["channels","posts","post_assets","publications","post_tags",
          "publish_limits","post_periods","post_targets","caption_variants"]
def counts(c): return {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}
c = sqlite3.connect(SRC); c.execute("PRAGMA foreign_keys=ON")
before = counts(c); c.close()
c = sqlite3.connect(SRC)
c.execute("PRAGMA journal_mode = WAL;"); c.execute("PRAGMA foreign_keys = ON;")
c.execute("BEGIN;")
c.executescript(Path("migrations/0008_platform_foundation.sql").read_text())
c.commit()
after = counts(c)
print("before:", before)
print("after :", after)
print("identical:", before == after)
print("fk_check:", c.execute("PRAGMA foreign_key_check").fetchall())
print("platform CHECK now:", "threads" in c.execute(
    "SELECT sql FROM sqlite_master WHERE name='channels'").fetchone()[0])
c.close()
PY
rm -f /tmp/ss-0008-check.db
```
Expected: `identical: True`, `fk_check: []`, `platform CHECK now: True`.

- [ ] **Step 6: Verify the runner is still idempotent**

Run: `.venv/bin/python migrate.py --status`
Expected: lists `0008_platform_foundation.sql` as pending (the real DB is untouched — you only migrated a copy).

Then apply it for real and confirm re-running is a no-op:
```bash
.venv/bin/python migrate.py && .venv/bin/python migrate.py
```
Expected: the first applies 1 migration; the second prints "Nothing to do — schema is up to date."

- [ ] **Step 7: Run the full suite and commit**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS — 186 pre-existing plus your 8.

```bash
git add migrations/0008_platform_foundation.sql worker/tests/test_migration_0008.py
git commit -m "feat(schema): widen platform and post_type enums without data loss"
```

---

### Task 2: Explicit platform dispatch in the worker

**Files:**
- Modify: `worker/clients.py`, `worker/publisher.py`, `worker/preflight.py`, `worker/metrics.py`, `worker/run.py`
- Modify: `worker/tests/test_clients.py` (one existing test changes behavior — see Step 1)
- Create: `worker/tests/test_platform_dispatch.py`

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces, for Part 2 (the Threads adapter) — adding a platform means adding it to `SUPPORTED_PLATFORMS` and to all three registries, and the coverage test will fail until every registry is updated:
  - `worker/clients.py`: `SUPPORTED_PLATFORMS: tuple[str, ...]`, `class UnknownPlatform(Exception)`, `base_url_for(platform, config)` raising `UnknownPlatform`.
  - `worker/publisher.py`: `_PUBLISHERS: dict[str, Callable]` keyed by platform, each `(client, plan, token, config, sleep_fn) -> str`.
  - `worker/preflight.py`: `_CHECKS: dict[str, Callable]` keyed by platform.
  - `worker/metrics.py`: `_FETCHERS` (already exists) stays keyed by platform.

- [ ] **Step 1: Update the one existing test whose behavior intentionally changes**

`worker/tests/test_clients.py` currently contains `test_unknown_platform_falls_back_to_the_installs_base`, asserting that an unrecognised platform silently gets the install's base URL. That fallback is the bug this task removes. Replace that single test with:

```python
def test_unknown_platform_raises_instead_of_guessing_a_host(config):
    # Silently returning the install's base URL is how a new platform ends up talking to
    # Instagram's API — the failure this task exists to prevent.
    from worker.clients import UnknownPlatform

    with pytest.raises(UnknownPlatform):
        base_url_for("mastodon", config)
```

Add `import pytest` to that file if it isn't already imported. Leave the other three tests in the file untouched.

- [ ] **Step 2: Write the failing tests**

Create `worker/tests/test_platform_dispatch.py`:

```python
"""An unrecognised platform must fail LOUDLY and locally.

Before this, platform branching used two-way ternaries and bare `else`, so a channel on a
new platform inherited Instagram's behavior: it would be published through Instagram's
container flow and preflighted against Instagram's quota endpoint. These tests pin the
replacement — explicit registries, per-item terminal failure, no collateral damage.
"""

from __future__ import annotations

import pytest

from worker.clients import SUPPORTED_PLATFORMS
from worker.publisher import publish_one


def _force_platform(conn, channel_id: int, platform: str) -> None:
    """Bypass the CHECK constraint to simulate a stale/unknown platform value in the DB."""
    conn.execute("PRAGMA writable_schema = ON")
    conn.execute(
        "UPDATE sqlite_master SET sql = replace(sql, \"'instagram', 'facebook', 'threads'\", \"'instagram', 'facebook', 'threads', 'mastodon'\") WHERE name = 'channels'"
    )
    conn.execute("PRAGMA writable_schema = OFF")
    conn.commit()
    conn.execute("UPDATE channels SET platform = ? WHERE id = ?", (platform, channel_id))
    conn.commit()


def test_all_three_registries_cover_exactly_the_supported_platforms():
    """The guard that makes adding a platform mechanical: miss a registry, fail here."""
    from worker.metrics import _FETCHERS
    from worker.preflight import _CHECKS
    from worker.publisher import _PUBLISHERS

    assert set(_PUBLISHERS) == set(SUPPORTED_PLATFORMS), "publisher registry out of sync"
    assert set(_CHECKS) == set(SUPPORTED_PLATFORMS), "preflight registry out of sync"
    assert set(_FETCHERS) == set(SUPPORTED_PLATFORMS), "metrics registry out of sync"


def test_an_unsupported_platform_fails_terminally_and_visibly(
    conn, config, fake_client, make_publication
):
    pub = make_publication()
    _force_platform(conn, pub["channel_id"], "mastodon")

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "failed"          # terminal: retrying can't add an adapter
    assert row["next_retry_at"] is None
    assert "mastodon" in row["last_error"]
    assert fake_client.calls == []            # nothing was attempted against any API


def test_one_unsupported_channel_does_not_affect_another_publication(
    conn, config, fake_client, make_publication
):
    bad = make_publication()
    good = make_publication()
    _force_platform(conn, bad["channel_id"], "mastodon")

    publish_one(conn, bad, config, fake_client, dry_run=False)
    out = publish_one(conn, good, config, fake_client, dry_run=False)

    assert out.result == "posted"
    good_row = conn.execute("SELECT status FROM publications WHERE id = ?", (good["id"],)).fetchone()
    bad_row = conn.execute("SELECT status FROM publications WHERE id = ?", (bad["id"],)).fetchone()
    assert good_row["status"] == "posted"
    assert bad_row["status"] == "failed"


def test_preflight_reports_an_unsupported_platform_without_calling_any_api(conn, fake_client):
    from worker.preflight import check_channels

    class Registry:
        def __init__(self):
            self.asked = []

        def for_platform(self, platform):
            self.asked.append(platform)
            return fake_client

    rows = [
        {
            "id": 7,
            "account_name": "Someplace",
            "platform": "mastodon",
            "access_token": "tok",
            "remote_account_id": "abc",
        }
    ]
    lines = []
    registry = Registry()
    ok = check_channels(rows, registry, print_fn=lines.append)

    assert ok is False
    assert any("mastodon" in line for line in lines)
    assert fake_client.calls == []       # must NOT fall through to Instagram's quota call
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_platform_dispatch.py worker/tests/test_clients.py -q`
Expected: FAIL — `SUPPORTED_PLATFORMS` / `UnknownPlatform` / `_PUBLISHERS` / `_CHECKS` don't exist yet.

- [ ] **Step 4: Make the host lookup explicit**

In `worker/clients.py`, add the exception and the platform list, and replace `base_url_for`:

```python
FACEBOOK_BASE = "https://graph.facebook.com"

# Every platform this worker has an adapter for. Adding one here without also adding it to
# publisher._PUBLISHERS, preflight._CHECKS and metrics._FETCHERS fails
# test_platform_dispatch.py — which is the point.
SUPPORTED_PLATFORMS = ("instagram", "facebook")


class UnknownPlatform(Exception):
    """A channel names a platform this worker has no adapter for."""


def base_url_for(platform: str, config: Config) -> str:
    """The Graph API base URL to use for a channel on `platform`.

    Raises UnknownPlatform rather than guessing. Falling back to the install's configured
    base is how an unrecognised platform ends up quietly talking to Instagram's API.
    """
    if platform == "facebook":
        return FACEBOOK_BASE
    if platform == "instagram":
        return config.graph_base
    raise UnknownPlatform(platform)
```

- [ ] **Step 5: Make the publish dispatch explicit**

In `worker/publisher.py`:

**(a)** Import the platform list — add next to the existing relative imports:
```python
from .clients import SUPPORTED_PLATFORMS
```

**(b)** Replace the two IG helpers' call sites with per-platform entry points. Add these immediately after `_publish_fb_multi`:

```python
def _publish_instagram(client, plan, token, config, sleep_fn) -> str:
    if plan["post_type"] == "single":
        return _publish_single(client, plan, token, config, sleep_fn)
    return _publish_carousel(client, plan, token, config, sleep_fn)


def _publish_facebook(client, plan, token, config, sleep_fn) -> str:
    if plan["post_type"] == "single":
        return _publish_fb_single(client, plan, token)
    return _publish_fb_multi(client, plan, token)


# Publish entry point per platform. Uniform signature so the dispatch below is a lookup,
# not a chain of ifs whose final `else` silently means "Instagram".
_PUBLISHERS = {
    "instagram": _publish_instagram,
    "facebook": _publish_facebook,
}

# Platforms exposing a runtime publish quota to read before posting. Facebook Pages have
# no content_publishing_limit endpoint; never substitute a hardcoded number.
_QUOTA_GATED = ("instagram",)
```

**(c)** Validate the platform. Change `_validate`'s signature to take it, and reject unknowns first:

```python
def _validate(post, assets, dry_run: bool, asset_base_url: str | None, platform: str) -> None:
    if platform not in _PUBLISHERS:
        raise _NonRetryable(
            f"unsupported platform '{platform}' — this worker has no adapter for it"
        )
    post_type = post["post_type"]
```
(the rest of `_validate` is unchanged)

**(d)** Update its caller inside `publish_one` — the `_validate(...)` call becomes:
```python
        _validate(post, assets, dry_run, asset_base_url, channel["platform"])
```

**(e)** Make the quota gate list-driven — change `if plan["platform"] == "instagram":` to:
```python
    if plan["platform"] in _QUOTA_GATED:
```

**(f)** Replace the publish dispatch (the `if plan["platform"] == "facebook": … elif … else …` chain) with:
```python
    try:
        media_id = _PUBLISHERS[plan["platform"]](client, plan, token, config, sleep_fn)
    except Exception as exc:  # noqa: BLE001 — transient publish error, retry with backoff
        log(f"publish failed: {exc}")
        return _mark_failure(conn, pub, config, now, f"publish: {exc}", terminal=False)
```
Keep the surrounding `db.update_publication(... status="publishing" ...)` and the success write-back exactly as they are.

**(g)** Sanity-check the two lists agree — add directly below `_QUOTA_GATED`:
```python
assert set(_PUBLISHERS) == set(SUPPORTED_PLATFORMS), (
    "publisher._PUBLISHERS and clients.SUPPORTED_PLATFORMS disagree"
)
```

- [ ] **Step 6: Make the preflight dispatch explicit**

In `worker/preflight.py`, extract the two branches into functions and dispatch on a registry. Replace the `try:` block inside `check_channels`'s loop (the `if ch["platform"] == "facebook": … else: …`) so the function reads:

```python
def _check_facebook(client, ch, name, print_fn) -> None:
    info = client.get_page_info(ch["remote_account_id"], ch["access_token"])
    page_name = info.get("name", ch["account_name"])
    print_fn(
        f"  ✓ {name}: token OK — Page reachable "
        f"({page_name}; Pages have no publish quota)"
    )


def _check_instagram(client, ch, name, print_fn) -> None:
    usage, total, duration = client.get_content_publishing_limit(
        ch["remote_account_id"], ch["access_token"]
    )
    hours = (duration or 0) // 3600
    print_fn(
        f"  ✓ {name}: token OK — published {usage}/{total} in the last {hours}h window"
    )


# One check per platform. A bare `else` here is how a Facebook Page got preflighted
# against Instagram's quota endpoint; an unknown platform must be reported, not guessed.
_CHECKS = {
    "instagram": _check_instagram,
    "facebook": _check_facebook,
}
```

and inside the loop, replacing the client lookup and try block:

```python
        check = _CHECKS.get(ch["platform"])
        if check is None:
            print_fn(
                f"  ✗ {name}: no preflight check for platform '{ch['platform']}' "
                f"— this worker has no adapter for it"
            )
            all_ok = False
            continue
        try:
            check(registry.for_platform(ch["platform"]), ch, name, print_fn)
        except GraphAPIError as exc:
            print_fn(f"  ✗ {name}: {exc}")
            all_ok = False
        except Exception as exc:  # noqa: BLE001
            print_fn(f"  ✗ {name}: {exc}")
            all_ok = False
```

Keep the `access_token` / `remote_account_id` guards above it exactly as they are, and update the module docstring's platform list to mention that an unrecognised platform is reported rather than checked.

- [ ] **Step 6b: Stop a raising host lookup from killing the whole batch**

`base_url_for` now raises, and `run_once` resolves a client **per publication** with
`pick_client(channel["platform"])`. An unhandled `UnknownPlatform` there would escape `run_once`,
get caught by `run_forever`'s catch-all, and abort **every remaining publication in the batch** —
violating the rule that one publication's failure never affects another. Defer to `publish_one`,
which now rejects the platform terminally and visibly.

In `worker/run.py`, add the import:
```python
from .clients import ClientRegistry, UnknownPlatform
```
and wrap the resolution in the publish loop:
```python
            channel = db.get_channel(conn, pub["channel_id"])
            try:
                pub_client = pick_client(channel["platform"]) if channel else client
            except UnknownPlatform:
                # No adapter for this platform. Hand it to publish_one anyway: it validates
                # the platform and marks this ONE publication terminally failed, so the rest
                # of the batch still goes out.
                pub_client = client
```

Add this test to `worker/tests/test_platform_dispatch.py`:

```python
def test_an_unknown_platform_does_not_abort_the_rest_of_the_batch(
    conn, config, fake_client, make_publication, monkeypatch
):
    """run_once resolves a client per publication; a raising lookup must not kill the batch.

    This has to go through run_once, not publish_one — run_once is the only place
    base_url_for is called, so it's the only place the raise can escape.
    """
    from datetime import datetime, timezone

    from worker.clients import ClientRegistry
    from worker.run import run_once

    now = datetime(2026, 7, 22, 18, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setenv("KILL_SWITCH", "0")
    monkeypatch.setenv("DRY_RUN", "0")
    monkeypatch.setattr("worker.run.load_env", lambda override=False: None)

    bad = make_publication(post_type="single", n_assets=1, now=now)
    good = make_publication(post_type="single", n_assets=1, now=now)
    _force_platform(conn, bad["channel_id"], "mastodon")

    # A real registry, so base_url_for actually raises for 'mastodon' — but handing back
    # the fake client for the platforms it does know.
    registry = ClientRegistry(config, factory=lambda version, base_url: fake_client)

    n = run_once(conn, config, fake_client, client_for=registry.for_platform, now=now)

    bad_row = conn.execute(
        "SELECT status, last_error FROM publications WHERE id = ?", (bad["id"],)
    ).fetchone()
    good_row = conn.execute(
        "SELECT status FROM publications WHERE id = ?", (good["id"],)
    ).fetchone()

    assert bad_row["status"] == "failed"
    assert "mastodon" in bad_row["last_error"]
    assert good_row["status"] == "posted"   # the batch carried on
    assert n == 2                           # both were processed, not abandoned
```

Confirm this test fails **before** Step 6b's `try/except` (the `UnknownPlatform` escapes
`run_once`, so `good` never publishes) and passes after.

Note: `make_publication` seeds assets with a `public_url`, so no tunnel is needed and
`DRY_RUN=0` is safe here — nothing reaches the network because the fake client stands in
for every platform the registry recognises.

- [ ] **Step 7: Keep metrics in sync and document the default client**

In `worker/metrics.py`, add below `_FETCHERS`:
```python
from .clients import SUPPORTED_PLATFORMS  # noqa: E402 — placed here to keep the registry adjacent

assert set(_FETCHERS) == set(SUPPORTED_PLATFORMS), (
    "metrics._FETCHERS and clients.SUPPORTED_PLATFORMS disagree"
)
```
If that import placement trips the linter or a circular import, put the import at the top of the file with the others and leave only the `assert` next to `_FETCHERS`.

In `worker/run.py`, the `client = registry.for_platform("instagram")` line in `main()` gets a comment making its role explicit:
```python
    # Fallback for code paths that don't know a platform yet; every publication and
    # metrics fetch re-resolves its own client from the channel's platform below.
    client = registry.for_platform("instagram")
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS — everything, including your new file and the amended `test_clients.py`. Instagram and Facebook publish/preflight/metrics tests must pass **unchanged**; if you had to edit one of those to accommodate a refactor, that's a signal the refactor changed behavior — stop and reconsider.

- [ ] **Step 9: Commit**

```bash
git add worker/clients.py worker/publisher.py worker/preflight.py worker/metrics.py worker/run.py worker/tests/
git commit -m "refactor(worker): explicit per-platform registries that fail loudly"
```

---

### Task 3: One source of truth for platforms in the dashboard

**Files:**
- Create: `dashboard/lib/platforms.ts`
- Modify: `dashboard/lib/types.ts`, `dashboard/lib/queries.ts`, `dashboard/app/api/channels/route.ts`
- Modify: `dashboard/components/ui.tsx`, `channel-form.tsx`, `channel-credentials.tsx`, `composer.tsx`, `publication-queue.tsx`, `library-view.tsx`, `caption-variants-editor.tsx`
- Modify: `dashboard/app/channels/page.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (independent).
- Produces, for Part 2: adding Threads to the dashboard becomes a single entry in `PLATFORMS`.

**This is a pure refactor. Instagram and Facebook must render byte-identically to today.** Do not add Threads to the list — the schema permits it but there is no adapter yet, and offering it would let someone create a channel that can never publish.

- [ ] **Step 1: Create the single source of truth**

Create `dashboard/lib/platforms.ts`:

```ts
// The one place that knows which platforms exist and how to name them. Everything that
// renders or validates a platform reads from here, so adding one is a single edit
// instead of nine — and an unrecognised value degrades visibly rather than silently
// reading as Instagram or Facebook.

export const PLATFORMS = [
  {
    value: "instagram",
    label: "Instagram",
    badge: "IG",
    accountIdLabel: "IG user id",
    // Instagram published via a linked Facebook Page stores that Page id separately.
    usesLinkedPage: true,
  },
  {
    value: "facebook",
    label: "Facebook Page",
    badge: "FB",
    accountIdLabel: "Page id",
    usesLinkedPage: false,
  },
] as const;

export type Platform = (typeof PLATFORMS)[number]["value"];

const BY_VALUE = new Map(PLATFORMS.map((p) => [p.value as string, p]));

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && BY_VALUE.has(value);
}

// Fallbacks below are deliberately conspicuous: an unknown platform should look wrong,
// not quietly borrow another platform's label.
export function platformLabel(value: string): string {
  return BY_VALUE.get(value)?.label ?? value;
}

export function platformBadge(value: string): string {
  return BY_VALUE.get(value)?.badge ?? value.slice(0, 2).toUpperCase();
}

export function accountIdLabel(value: string): string {
  return BY_VALUE.get(value)?.accountIdLabel ?? "Account id";
}

export function usesLinkedPage(value: string): boolean {
  return BY_VALUE.get(value)?.usesLinkedPage ?? false;
}
```

- [ ] **Step 2: Point the types and validation at it**

In `dashboard/lib/types.ts`, replace the local declaration on line 4:
```ts
export type { Platform } from "./platforms";
```

In `dashboard/lib/queries.ts`, the `CreateChannelInput.platform` field (currently the inline union `"instagram" | "facebook"`) becomes `Platform`, imported from `@/lib/platforms`.

In `dashboard/app/api/channels/route.ts`, replace the hardcoded guard:
```ts
  if (!isPlatform(platform)) {
    return NextResponse.json(
      { error: `Platform must be one of: ${PLATFORMS.map((p) => p.value).join(", ")}.` },
      { status: 400 }
    );
  }
```
importing `isPlatform` and `PLATFORMS` from `@/lib/platforms`.

- [ ] **Step 3: Replace every hardcoded site**

Each of these currently hardcodes Instagram/Facebook. Replace with the helper, preserving **identical** rendered output for both existing platforms:

| File:line | Now | Becomes |
|---|---|---|
| `components/ui.tsx:69` | `{platform === "instagram" ? "IG" : "FB"}` | `{platformBadge(platform)}` |
| `components/channel-form.tsx:81-82` | two hardcoded `<option>`s | `PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)` |
| `components/channel-form.tsx:114` | `{form.platform === "instagram" ? "IG user id" : "Page id"}` | `{accountIdLabel(form.platform)}` |
| `components/channel-form.tsx:123` | `{form.platform === "instagram" ? (` … linked-page field … `) : null}` | `{usesLinkedPage(form.platform) ? (` … same field … `) : null}` |
| `components/channel-credentials.tsx:63` | `{platform === "instagram" ? "Instagram user id" : "Page id"}` | `{accountIdLabel(platform)}` — **note** this one currently reads "Instagram user id" where the form reads "IG user id"; unify on `accountIdLabel` ("IG user id") and say so in your report |
| `components/composer.tsx:391` | `{c.platform === "instagram" ? "Instagram" : "Facebook"}` | `{platformLabel(c.platform)}` — **note** this renders "Facebook Page" instead of today's "Facebook"; flag it in your report as an intentional consequence of one label source |
| `components/publication-queue.tsx:33,61` | `"all" \| "instagram" \| "facebook"` | `"all" \| Platform` |
| `components/publication-queue.tsx:63-65` | three hardcoded `<option>`s | keep the "All platforms" option, generate the rest from `PLATFORMS` |
| `components/library-view.tsx:229` | `(["instagram", "facebook"] as const).map((plat) =>` | `PLATFORMS.map((p) =>` — adapt the body to use `p.value` (and `p.label` if it renders a name) |
| `components/caption-variants-editor.tsx:47-48` | two hardcoded `<option>`s | keep the `""` generic option, generate the rest from `PLATFORMS` |
| `app/channels/page.tsx:55` | `c.platform === "instagram" ? "IG user id" : "Page id"` | `accountIdLabel(c.platform)` |

**Leave alone:** `publication-queue.tsx:162`'s metrics fork (`channel_platform === "facebook" ? … : …`) — that is per-platform *behavior*, not a label, and Part 2 handles it. Also leave the prose copy in `app/channels/page.tsx:27` and `app/page.tsx:84`, and the `{c.platform}` raw renders in `bulk-import.tsx:215`, `schedule-from-library.tsx:179`, `post-editor.tsx:202`, `post-sends-panel.tsx:277`.

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: exit 0, no output. Fix any type errors from the `Platform` re-export before continuing.

- [ ] **Step 5: Verify the UI is unchanged in the browser**

The dev server runs on port **3939**. Load it and confirm, for the existing Instagram channel:
- **Overview** — the channel chip still reads the account name plus the `IG` badge; the queue's platform filter still offers All platforms / Instagram / Facebook and still filters correctly.
- **Channels** — the existing channel still shows its `IG` badge and an "IG user id" row; the Add-channel form's platform dropdown still offers Instagram and "Facebook Page", and selecting Instagram still reveals the linked-Page field while Facebook hides it.

Take a screenshot of Overview and Channels for your report. Note in the report the two intentional copy changes flagged in Step 3.

- [ ] **Step 6: Commit**

```bash
git add dashboard/
git commit -m "refactor(dashboard): one source of truth for platform labels and validation"
```

---

## Definition of done

- Full worker suite green (186 pre-existing + ~13 new), `npx tsc --noEmit` clean.
- The 0008 migration verified against a **copy** of the real database with all 9 counts identical and `PRAGMA foreign_key_check` empty; `migrate.py` idempotent afterwards.
- An unsupported platform fails that publication terminally and visibly, calls no API, and leaves other publications untouched.
- All three worker registries provably cover exactly `SUPPORTED_PLATFORMS`.
- Instagram and Facebook render as before, apart from the two flagged label unifications.
- No Threads anywhere in the UI, no text-post behavior — those are Part 2.
