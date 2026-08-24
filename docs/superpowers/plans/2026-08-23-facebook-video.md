# Facebook Page Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish video to a Facebook Page — both as an ordinary feed video and as a Reel — by separating what a post *is* (`post_type='video'`) from where it *goes* (`surface`).

**Architecture:** `post_type='reel'` becomes `post_type='video'`, and `surface` (already on `post_targets` and `publications`) gains `'reel'` alongside `feed`/`story`. `PlatformCaps.supports_video` (a bool) becomes `video_surfaces` (a set), so a platform can declare *which* video destinations it has. `_publish_facebook` then dispatches on surface: `feed` → `POST /{page}/videos`, `reel` → the three-phase `POST /{page}/video_reels`. Both poll to completion through the existing poll loop, reached via a status function that normalizes Facebook's vocabulary into Instagram's.

**Tech Stack:** Python 3.11 worker (`venv`, pytest), Next.js/TypeScript dashboard (`node --test`), SQLite 3.51 with WAL, Meta Graph API v25.0.

**Spec:** `docs/superpowers/specs/2026-08-23-facebook-video-design.md`

## Global Constraints

- **Never hardcode a publishing rate limit.** Meta documents 30 API-published Reels/24 h; Pages expose no `content_publishing_limit` endpoint. Record it in `reference.md`; do not gate on it.
- **Never skip the container/status check** before treating a publish as done.
- **Never log tokens or full API responses.** All error paths go through `worker/redact.py`.
- **Failed publishes must be visibly failed.** Each channel target is an independent `publication`; one failure must not roll back or block the others.
- **Poll-budget exhaustion is retryable, never terminal.**
- **Migrations are keyed by filename in `schema_migrations`.** Never renumber an applied migration. Next free number is `0027`.
- **`worker/migrate.py` has no argument parser** — even `--help` applies migrations to the live DB. Every migration trial runs against a scratch copy.
- **Restart the worker after code changes.** A live heartbeat proves the daemon runs, not that it runs current code.
- Worker tests: `cd worker && ../.venv/bin/python -m pytest tests/ -v` (adjust to the venv actually present; run from repo root as `.venv/bin/python -m pytest worker/tests/ -v`).
- Dashboard tests: `cd dashboard && npm test`. Lint is at **0 errors** — keep it there (`npm run lint`).

---

# Phase 1 — Schema and capability model

## Task 1: Migration 0027 — post_type='video' and the 'reel' surface

**This is the most dangerous task in the plan.** Three tables are rebuilt, two of which have cascading children:

| Table | Why rebuilt | Children at risk |
|---|---|---|
| `posts` | `post_type` CHECK must accept `'video'` | `post_assets`, `publications`, `post_tags`, `post_periods`, `caption_variants`, `post_targets` |
| `post_targets` | `surface` CHECK must accept `'reel'` | none |
| `publications` | `surface` CHECK must accept `'reel'` | `post_metrics` (**2,925 rows**), `remote_media` |

SQLite cannot alter a CHECK in place. `DROP TABLE` with foreign keys **enabled** performs an implicit delete that fires `ON DELETE CASCADE`, which would destroy those children — so enforcement is disabled around the rebuild, exactly as migrations `0008` and `0014` do. The `PRAGMA` statements must sit **outside** the transaction: `PRAGMA foreign_keys` is a silent no-op while a transaction is open.

Note that migration `0014` deliberately did *not* rebuild `publications`, citing this exact risk. We are accepting it now because widening the CHECK leaves no alternative — and paying for it once, with `('feed','story','reel')` covering Facebook Stories too, so no later surface needs another rebuild.

**Files:**
- Create: `migrations/0027_video_surface.sql`
- Test: `worker/tests/test_migration_0027.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `posts.post_type` accepts `'video'`; `post_targets.surface` and `publications.surface` accept `'reel'`. Every later task depends on these.

- [ ] **Step 1: Back up the live database before writing anything**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler"
sqlite3 data/socialscheduler.db ".backup 'data/pre-0027-backup.db'"
sqlite3 -readonly data/pre-0027-backup.db "SELECT COUNT(*) FROM publications;"
```

Expected: `68`. Never `cp` a database in WAL mode — `.backup` is the only safe copy.

- [ ] **Step 2: Write the migration**

Create `migrations/0027_video_surface.sql`. Column lists must match the live schema exactly — verify with `sqlite3 -readonly data/socialscheduler.db ".schema posts"` before trusting this file.

```sql
-- 0027_video_surface.sql
-- Facebook can publish one clip three ways (feed video, Reels, Stories), so post_type
-- cannot name the destination the way 'reel' tried to. post_type says what a post IS;
-- surface says where it LANDS. Same split 0014 made for Stories, now applied to video.
--
-- THREE rebuilds, because SQLite cannot alter a CHECK in place. 0014's header explains
-- why it avoided rebuilding publications: it carries indexes and cascading children
-- (post_metrics, remote_media). That risk is real and is accepted here only because
-- widening the CHECK leaves no alternative. It is paid ONCE: the new surface set
-- ('feed','story','reel') already covers Facebook Stories, which reuses 'story'.
--
-- DROP TABLE with foreign keys ENABLED fires ON DELETE CASCADE and would delete every
-- child row. Enforcement is disabled for the rebuild and restored at the end. The PRAGMAs
-- stay OUTSIDE the transaction: PRAGMA foreign_keys is a silent no-op while one is open.

PRAGMA foreign_keys = OFF;
BEGIN;

-- posts: post_type CHECK gains 'video'. 'story' stays listed but remains VESTIGIAL
-- (see 0014) — nothing creates it and publisher._validate refuses it.
CREATE TABLE posts_new (
    id             INTEGER PRIMARY KEY,
    caption        TEXT,
    first_comment  TEXT,
    post_type      TEXT    NOT NULL
                           CHECK (post_type IN ('single', 'carousel', 'video', 'reel', 'story', 'text')),
    status         TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'scheduled', 'posted', 'failed')),
    created_by     TEXT,
    created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT,
    content_kind   TEXT    NOT NULL DEFAULT 'evergreen'
                           CHECK (content_kind IN ('one_time', 'evergreen')),
    content_status TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (content_status IN ('draft', 'ready', 'retired')),
    cooldown_days  INTEGER,
    is_bpp         INTEGER NOT NULL DEFAULT 0,
    bpp_marked_at  TEXT,
    archived_at    TEXT
);

INSERT INTO posts_new
    SELECT id, caption, first_comment, post_type, status, created_by, created_at,
           updated_at, content_kind, content_status, cooldown_days, is_bpp,
           bpp_marked_at, archived_at
      FROM posts;

DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;
CREATE INDEX idx_posts_archived_at ON posts(archived_at) WHERE archived_at IS NOT NULL;

-- The rename itself. 'reel' is kept in the CHECK above only so this UPDATE is legal
-- within the same transaction; nothing writes it afterwards.
UPDATE posts SET post_type = 'video' WHERE post_type = 'reel';

-- post_targets: surface CHECK gains 'reel'.
CREATE TABLE post_targets_new (
    post_id    INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- 'feed'  = the normal post for that platform
    -- 'story' = Instagram Story today, Facebook Page Story when that adapter lands
    -- 'reel'  = Facebook Reels. FACEBOOK-ONLY BY DESIGN: all Instagram feed video is
    --           already Reels, so a separate IG value would mean the same as 'feed'.
    surface    TEXT    NOT NULL DEFAULT 'feed'
                       CHECK (surface IN ('feed', 'story', 'reel')),
    PRIMARY KEY (post_id, channel_id, surface)
);

INSERT INTO post_targets_new (post_id, channel_id, surface)
    SELECT post_id, channel_id, surface FROM post_targets;

DROP TABLE post_targets;
ALTER TABLE post_targets_new RENAME TO post_targets;
CREATE INDEX idx_post_targets_channel ON post_targets (channel_id);

-- publications: surface CHECK gains 'reel'. Every column and index below must survive.
CREATE TABLE publications_new (
    id                      INTEGER PRIMARY KEY,
    post_id                 INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id              INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    scheduled_at            TEXT    NOT NULL,
    status                  TEXT    NOT NULL DEFAULT 'scheduled'
                                    CHECK (status IN ('scheduled', 'pending_approval', 'publishing',
                                                      'posted', 'failed', 'canceled')),
    published_at            TEXT,
    remote_container_id     TEXT,
    remote_post_id          TEXT,
    attempt_count           INTEGER NOT NULL DEFAULT 0,
    next_retry_at           TEXT,
    last_error              TEXT,
    first_comment_status    TEXT    NOT NULL DEFAULT 'none'
                                    CHECK (first_comment_status IN ('none', 'pending', 'posted', 'failed')),
    first_comment_remote_id TEXT,
    is_dry_run              INTEGER NOT NULL DEFAULT 0,
    created_by              TEXT,
    created_at              TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT,
    metrics_refresh_requested_at TEXT,
    is_held                 INTEGER NOT NULL DEFAULT 0,
    surface                 TEXT    NOT NULL DEFAULT 'feed'
                                    CHECK (surface IN ('feed', 'story', 'reel')),
    asset_id                INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
    first_comment_error     TEXT,
    first_comment_retry_requested INTEGER NOT NULL DEFAULT 0,
    is_recycled             INTEGER NOT NULL DEFAULT 0,
    remote_missing_at       TEXT,
    remote_missing_reason   TEXT,
    metrics_failure_streak  INTEGER NOT NULL DEFAULT 0,
    delivery_state          TEXT    CHECK (delivery_state IS NULL OR
                                           delivery_state IN ('inbox', 'published', 'gave_up')),
    delivery_checked_at     TEXT
);

INSERT INTO publications_new
    SELECT id, post_id, channel_id, scheduled_at, status, published_at,
           remote_container_id, remote_post_id, attempt_count, next_retry_at, last_error,
           first_comment_status, first_comment_remote_id, is_dry_run, created_by,
           created_at, updated_at, metrics_refresh_requested_at, is_held, surface,
           asset_id, first_comment_error, first_comment_retry_requested, is_recycled,
           remote_missing_at, remote_missing_reason, metrics_failure_streak,
           delivery_state, delivery_checked_at
      FROM publications;

DROP TABLE publications;
ALTER TABLE publications_new RENAME TO publications;
CREATE INDEX idx_publications_channel_sched ON publications (channel_id, scheduled_at, status);
CREATE INDEX idx_publications_retry         ON publications (status, next_retry_at);
CREATE INDEX idx_publications_post          ON publications (post_id);

COMMIT;
PRAGMA foreign_keys = ON;
```

- [ ] **Step 3: Write the failing test**

Create `worker/tests/test_migration_0027.py`. It builds a DB at `0026`, applies `0027`, and asserts nothing was lost — this is the test that actually protects the 2,925 metric rows.

```python
"""0027 rebuilds three tables with cascading children. The risk is silent data loss:
a dropped index, a lost column, or children cascaded away by a DROP TABLE that ran with
foreign keys still enabled. Each assertion below names one of those failures.
"""

import sqlite3
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def _apply_through(conn, last: str) -> None:
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.name > last:
            break
        conn.executescript(path.read_text())


@pytest.fixture
def db(tmp_path):
    conn = sqlite3.connect(tmp_path / "t.db")
    conn.row_factory = sqlite3.Row
    _apply_through(conn, "0026_tiktok_account_stats.sql")
    return conn


def test_reel_posts_become_video(db):
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'reel')")
    db.commit()
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    assert db.execute("SELECT post_type FROM posts WHERE id = 1").fetchone()[0] == "video"


def test_reel_surface_is_accepted(db):
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'video')")
    db.execute("INSERT INTO channels (id, platform, account_name) VALUES (1, 'facebook', 'APT')")
    db.execute("INSERT INTO post_targets (post_id, channel_id, surface) VALUES (1, 1, 'reel')")
    db.commit()
    assert db.execute("SELECT COUNT(*) FROM post_targets WHERE surface='reel'").fetchone()[0] == 1


def test_bogus_surface_is_still_refused(db):
    """The CHECK must still bite — a widened constraint that accepts anything is no
    constraint, and would let a typo schedule a send to nowhere."""
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'video')")
    db.execute("INSERT INTO channels (id, platform, account_name) VALUES (1, 'facebook', 'APT')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO post_targets (post_id, channel_id, surface) VALUES (1, 1, 'tiktok')")


def test_children_survive_the_rebuild(db):
    """The whole point of PRAGMA foreign_keys = OFF. With it on, DROP TABLE publications
    cascades and these metric rows vanish silently."""
    db.execute("INSERT INTO posts (id, post_type) VALUES (1, 'single')")
    db.execute("INSERT INTO channels (id, platform, account_name) VALUES (1, 'facebook', 'APT')")
    db.execute(
        "INSERT INTO publications (id, post_id, channel_id, scheduled_at) "
        "VALUES (9, 1, 1, '2026-01-01T00:00:00Z')"
    )
    db.execute("INSERT INTO post_metrics (publication_id, fetched_at) VALUES (9, '2026-01-01T00:00:00Z')")
    db.commit()

    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())

    assert db.execute("SELECT COUNT(*) FROM post_metrics").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM publications WHERE id = 9").fetchone()[0] == 1
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_indexes_survive_the_rebuild(db):
    db.executescript((MIGRATIONS / "0027_video_surface.sql").read_text())
    names = {
        r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
        )
    }
    for expected in (
        "idx_publications_channel_sched",
        "idx_publications_retry",
        "idx_publications_post",
        "idx_post_targets_channel",
        "idx_posts_archived_at",
    ):
        assert expected in names, f"{expected} was dropped by the rebuild"
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0027.py -v`
Expected: all five pass. If `test_children_survive_the_rebuild` fails, the `PRAGMA foreign_keys = OFF` placement is wrong — check that it sits outside `BEGIN`.

- [ ] **Step 5: Rehearse against a copy of the real database**

Never against the live file. Compare the schema and every row count before and after.

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler"
SCRATCH=/private/tmp/claude-501/-Users-kelanliparoto-Documents-Claude-Projects-Apps-SocialScheduler/bed6691c-c1e4-4783-8414-87c78f0f674e/scratchpad
sqlite3 data/socialscheduler.db ".backup '$SCRATCH/rehearse.db'"
sqlite3 -readonly "$SCRATCH/rehearse.db" ".schema" > "$SCRATCH/before.schema"
for t in posts publications post_metrics post_targets remote_media post_assets caption_variants; do
  echo "$t $(sqlite3 -readonly "$SCRATCH/rehearse.db" "SELECT COUNT(*) FROM $t;")"
done > "$SCRATCH/before.counts"
sqlite3 "$SCRATCH/rehearse.db" < migrations/0027_video_surface.sql
sqlite3 -readonly "$SCRATCH/rehearse.db" ".schema" > "$SCRATCH/after.schema"
for t in posts publications post_metrics post_targets remote_media post_assets caption_variants; do
  echo "$t $(sqlite3 -readonly "$SCRATCH/rehearse.db" "SELECT COUNT(*) FROM $t;")"
done > "$SCRATCH/after.counts"
diff "$SCRATCH/before.counts" "$SCRATCH/after.counts" && echo "ROW COUNTS UNCHANGED"
diff "$SCRATCH/before.schema" "$SCRATCH/after.schema"
sqlite3 -readonly "$SCRATCH/rehearse.db" "PRAGMA foreign_key_check;"
sqlite3 -readonly "$SCRATCH/rehearse.db" "SELECT post_type, COUNT(*) FROM posts GROUP BY post_type;"
```

Expected: `ROW COUNTS UNCHANGED`; the schema diff shows **only** the three CHECK changes; `foreign_key_check` prints nothing; `post_type` shows `video|1` and no `reel`.

**Do not proceed if the row counts differ.** That is the failure this whole task is built to catch.

- [ ] **Step 6: Commit**

```bash
git add migrations/0027_video_surface.sql worker/tests/test_migration_0027.py
git commit -m "feat(schema): post_type='video' and a 'reel' surface for Facebook

Separates what a post is from where it goes, so one clip can be an
Instagram Reel and a Facebook feed video at once. Three tables rebuilt
because SQLite cannot alter a CHECK; foreign keys are disabled around
the swap so the 2,925 post_metrics rows are not cascaded away."
```

---

## Task 2: `video_surfaces` replaces the `supports_video` bool

**Files:**
- Modify: `worker/clients.py:82-175` (`PlatformCaps`, `PLATFORM_CAPS`)
- Test: `worker/tests/test_clients.py`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime.
- Produces: `PlatformCaps.video_surfaces: frozenset[str]`, and `PlatformCaps.supports_video` as a **derived property** returning `bool(self.video_surfaces)`. `autofill._platform_capability_params` keeps calling `caps.supports_video` unchanged.

- [ ] **Step 1: Write the failing test**

Add to `worker/tests/test_clients.py`:

```python
from worker.clients import PLATFORM_CAPS


def test_facebook_declares_both_video_surfaces():
    caps = PLATFORM_CAPS["facebook"]
    assert caps.video_surfaces == frozenset({"feed", "reel"})


def test_instagram_has_no_reel_surface():
    """All Instagram feed video IS Reels, so a separate 'reel' surface would mean the
    same thing as 'feed' — two values that can never differ. Facebook-only by design."""
    assert PLATFORM_CAPS["instagram"].video_surfaces == frozenset({"feed", "story"})


def test_supports_video_is_derived_not_stored():
    """autofill's SQL binding still reads caps.supports_video; it must keep working
    without autofill knowing surfaces exist."""
    assert PLATFORM_CAPS["facebook"].supports_video is True
    assert PLATFORM_CAPS["threads"].supports_video is False
    assert PLATFORM_CAPS["threads"].video_surfaces == frozenset()
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `.venv/bin/python -m pytest worker/tests/test_clients.py -k video -v`
Expected: FAIL — `PlatformCaps` has no attribute `video_surfaces`.

- [ ] **Step 3: Implement**

In `worker/clients.py`, replace the `supports_video: bool = False` field with:

```python
    # WHICH video destinations this platform has, not merely whether it has any. A bool
    # cannot express Facebook, where the same clip goes to the feed as an ordinary video
    # OR to Reels — two different endpoints with different rules. Empty = no video path,
    # the safe default: worst case autofill under-selects rather than queuing a video a
    # channel can never publish (which fails terminally forever — see select_candidates).
    video_surfaces: frozenset[str] = frozenset()
```

Add the derived property to the dataclass:

```python
    @property
    def supports_video(self) -> bool:
        """Kept so autofill's :supports_video binding needs no knowledge of surfaces."""
        return bool(self.video_surfaces)
```

Update the entries:

```python
    "instagram": PlatformCaps(
        supports_text=False, max_carousel=10, caption_chars={},
        video_surfaces=frozenset({"feed", "story"}),
    ),
    # Facebook Pages: feed video (POST /{page}/videos, any aspect ratio, <=20 min) and
    # Reels (POST /{page}/video_reels, vertical, 3-90s). Two genuinely different
    # products, which is why this is a set and not a bool.
    "facebook": PlatformCaps(
        supports_text=False, max_carousel=10, caption_chars={},
        video_surfaces=frozenset({"feed", "reel"}),
    ),
```

and TikTok's `supports_video=True` becomes `video_surfaces=frozenset({"feed"})`.

- [ ] **Step 4: Run the full worker suite**

Run: `.venv/bin/python -m pytest worker/tests/ -v`
Expected: PASS. `worker/tests/test_tiktok_publishing.py:89` asserts `caps.supports_video is True` — the derived property keeps that green without editing the test.

- [ ] **Step 5: Commit**

```bash
git add worker/clients.py worker/tests/test_clients.py
git commit -m "feat(caps): declare which video surfaces a platform has, not just whether

A bool cannot describe Facebook, where one clip has two possible video
destinations. supports_video survives as a derived property so autofill
is untouched."
```

---

## Task 3: Rename `'reel'` to `'video'` through the worker

**Files:**
- Modify: `worker/publisher.py:30` (`SUPPORTED_POST_TYPES`), `worker/publisher.py:241-246` (validation), `worker/publisher.py:604-627` (dispatch)
- Modify: `worker/autofill.py:64-72` (`_TYPE_CAPABILITY_SQL`)
- Test: `worker/tests/test_autofill.py`; **create** `worker/tests/test_publisher_validate.py` (no validation-specific test file exists yet — `_validate` is currently exercised incidentally by `test_reels_publish.py` and `test_tiktok_publishing.py`)

**Interfaces:**
- Consumes: Task 1's schema, Task 2's `video_surfaces`.
- Produces: `post_type='video'` is the only video content shape the worker recognizes. `'reel'` is rejected by `_validate` as an unknown type.

- [ ] **Step 1: Write the failing test**

```python
def test_video_post_type_is_supported():
    from worker.publisher import SUPPORTED_POST_TYPES
    assert "video" in SUPPORTED_POST_TYPES
    assert "reel" not in SUPPORTED_POST_TYPES


def test_video_needs_exactly_one_video_asset():
    with pytest.raises(_NonRetryable, match="needs a video asset"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "image", "id": 1}],
            dry_run=True, asset_base_url=None, platform="facebook",
        )
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest worker/tests/test_publisher_validate.py -k video -v`
Expected: FAIL — `'video'` is not in `SUPPORTED_POST_TYPES`.

- [ ] **Step 3: Implement the rename**

In `worker/publisher.py`:

```python
SUPPORTED_POST_TYPES = ("single", "carousel", "text", "video")
```

and in `_validate`, change the `post_type == "reel"` branch to `post_type == "video"`, keeping both messages accurate:

```python
    if post_type == "video":
        if len(assets) != 1:
            raise _NonRetryable(f"a video post needs exactly 1 asset, has {len(assets)}")
        if assets[0]["media_kind"] != "video":
            raise _NonRetryable(
                f"a video post needs a video asset, got media_kind='{assets[0]['media_kind']}'"
            )
```

In `_publish_instagram`, rename the `elif post_type == "reel":` branch to `"video"` (the function it calls, `_publish_reel`, keeps its name — on Instagram it genuinely publishes a Reel).

In `worker/autofill.py`, `_TYPE_CAPABILITY_SQL`:

```python
            OR (p.post_type = 'video' AND :supports_video = 1
               AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id))
```

Update the docstring at `autofill.py:170` so "a reel only if it declares supports_video" reads "a video post only if…".

- [ ] **Step 4: Run the full suite, including the group path**

Run: `.venv/bin/python -m pytest worker/tests/ -v`
Expected: PASS. Pay attention to `test_autofill_groups.py` — this install runs auto-fill through a **channel group**, so a selection change verified only on solo channels is not verified for this install.

- [ ] **Step 5: Commit**

```bash
git add worker/publisher.py worker/autofill.py worker/tests/
git commit -m "refactor(worker): post_type 'reel' becomes 'video'

The content shape is 'one video clip'; which surface it lands on is the
target's business, not the post's."
```

---

## Task 4: Rename `'reel'` to `'video'` through the dashboard

**Files:**
- Modify: `dashboard/lib/platforms.ts` (Facebook entry, `supportsVideo`), `dashboard/lib/types.ts`, `dashboard/app/api/posts/route.ts:49`, `dashboard/app/api/posts/draft/route.ts:59`
- Test: `dashboard/lib/platforms.test.ts`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces: `PostType` includes `"video"` and excludes `"reel"`; `supportsVideo("facebook") === true`; a new `videoSurfaces(platform: string): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { supportsVideo, videoSurfaces } from "@/lib/platforms";

test("facebook accepts video on two surfaces", () => {
  assert.equal(supportsVideo("facebook"), true);
  assert.deepEqual(videoSurfaces("facebook").sort(), ["feed", "reel"]);
});

test("instagram has no separate reel surface", () => {
  assert.deepEqual(videoSurfaces("instagram").sort(), ["feed", "story"]);
});

test("an unknown platform gets no video surfaces", () => {
  assert.deepEqual(videoSurfaces("myspace"), []);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd dashboard && npm test`
Expected: FAIL — `videoSurfaces` is not exported.

- [ ] **Step 3: Implement**

In `dashboard/lib/platforms.ts`, replace each entry's `supportsVideo: boolean` with `videoSurfaces: string[]` (`instagram: ["feed","story"]`, `facebook: ["feed","reel"]`, `tiktok: ["feed"]`, `[]` elsewhere), then:

```ts
// Mirrors worker/clients.py's PlatformCaps.video_surfaces. As the comment at the top of
// this file warns, THIS copy has no assert guarding it against drift — it must be updated
// by hand whenever the worker's set changes.
export function videoSurfaces(value: string): string[] {
  return PLATFORMS.find((p) => p.value === value)?.videoSurfaces ?? [];
}

// Default false stays the safe direction for an unrecognised platform.
export function supportsVideo(value: string): boolean {
  return videoSurfaces(value).length > 0;
}
```

Change the post-type derivation in both API routes from `"reel"` to `"video"`, and update `PostType` in `dashboard/lib/types.ts`.

- [ ] **Step 4: Run tests and lint**

Run: `cd dashboard && npm test && npm run lint`
Expected: tests PASS, lint reports **0 errors**.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib dashboard/app/api/posts
git commit -m "refactor(dashboard): post_type 'video'; declare per-platform video surfaces"
```

---

**PHASE 1 CHECKPOINT.** Verify against the **worktree's** database copy only — apply `0027`
there, start the dashboard, and confirm it still loads the queue and the existing video post.

**Do NOT apply the migration to the live install at this point.** Task 2 makes Facebook declare
video support, but the Facebook video publish path does not exist until Task 8. In that window
the invariant "a platform that declares video support has a working publish path" is false, and
auto-fill would happily queue a video post to a Facebook channel that cannot publish it — failing
it terminally every cycle, since `failed` is not in `ACTIVE_QUEUE_STATUSES`. This install runs
auto-fill through a channel GROUP, so the Facebook channel is genuinely reachable that way.

The live migration moves to the **Phase 2 checkpoint**, after Task 8 closes the gap.

---

# Phase 2 — Worker publish paths

## Task 5: `create_page_video` — the Facebook feed video endpoint

**Files:**
- Modify: `worker/graph_api.py` (after `create_page_feed_post`, ~line 640)
- Test: `worker/tests/test_graph_api_facebook.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GraphClient.create_page_video(page_id: str, file_url: str, token: str, description: str | None = None) -> str` returning the **video id** (not the post id — Task 8 resolves that).

- [ ] **Step 1: Write the failing test**

```python
def test_create_page_video_posts_file_url_to_videos_edge():
    session = FakeSession([FakeResponse({"id": "v123"})])
    client = GraphClient("v25.0", session=session, base_url="https://graph.facebook.com")

    video_id = client.create_page_video("PAGE", "https://x.test/a.mp4", "TOK", description="hi")

    assert video_id == "v123"
    url, data = session.posts[0]
    assert url.endswith("/PAGE/videos")
    assert data["file_url"] == "https://x.test/a.mp4"
    assert data["description"] == "hi"


def test_create_page_video_omits_empty_description():
    """An empty description must be absent, not sent as "" — Meta treats a present-but-
    empty field differently from an absent one."""
    session = FakeSession([FakeResponse({"id": "v1"})])
    client = GraphClient("v25.0", session=session, base_url="https://graph.facebook.com")
    client.create_page_video("PAGE", "https://x.test/a.mp4", "TOK", description=None)
    assert "description" not in session.posts[0][1]
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_facebook.py -k page_video -v`
Expected: FAIL — no attribute `create_page_video`.

- [ ] **Step 3: Implement**

```python
    def create_page_video(
        self,
        page_id: str,
        file_url: str,
        token: str,
        description: str | None = None,
    ) -> str:
        """Publish an ordinary video to a Page's feed. Returns the VIDEO id.

        One call, no upload session: Meta fetches file_url server-side, exactly as the
        photo path does. Accepts any aspect ratio and up to 20 minutes via URL, which is
        why the feed surface sends the untouched original rather than the 9:16 derivative.

        The returned id is the VIDEO node, NOT the feed post. Metrics read against the
        post, so the caller must resolve it (see publisher._resolve_fb_post_id).
        """
        data = {"file_url": file_url, "access_token": token}
        if description:
            data["description"] = description
        return self._post(f"{page_id}/videos", data)["id"]
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_facebook.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/graph_api.py worker/tests/test_graph_api_facebook.py
git commit -m "feat(graph): create_page_video for Facebook feed video"
```

---

## Task 6: `create_page_reel` — the three-phase Reels upload

**Files:**
- Modify: `worker/graph_api.py` (`__init__` to store the version; new `_post_rupload` helper; `create_page_reel`)
- Test: `worker/tests/test_graph_api_facebook.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GraphClient.create_page_reel(page_id: str, file_url: str, token: str, description: str | None = None) -> str` returning the **video id**. Also `self.graph_version` on the client.

The upload phase does **not** go through `_post`: it targets `rupload.facebook.com`, sends headers rather than form data, and has no body. The hosted-file and local-file forms are alternatives — the hosted form sends `Authorization` and `file_url` and nothing else. Sending `offset`/`file_size` alongside `file_url` is the local-file shape and will fail confusingly.

- [ ] **Step 1: Extend the test fake to record headers**

`FakeSession.post` currently has no `headers` parameter, so the rupload call cannot be asserted. In `worker/tests/test_graph_api_facebook.py`:

```python
class FakeSession:
    def __init__(self, responses=None):
        self.posts = []
        self.gets = []
        self._responses = list(responses or [])

    def _next(self):
        return self._responses.pop(0) if self._responses else FakeResponse({"id": "x"})

    def post(self, url, data=None, timeout=None, headers=None):
        self.posts.append((url, data, headers))
        return self._next()

    def get(self, url, params=None, timeout=None):
        self.gets.append((url, params))
        return self._next()
```

Every existing test unpacking `url, data = session.posts[0]` must become `url, data, _ = session.posts[0]`. Update them in the same step — the suite must stay green.

- [ ] **Step 2: Write the failing test**

```python
def test_create_page_reel_runs_all_three_phases():
    session = FakeSession([
        FakeResponse({"video_id": "v9", "upload_url": "https://rupload.facebook.com/video-upload/v25.0/v9"}),
        FakeResponse({"success": True}),
        FakeResponse({"success": True}),
    ])
    client = GraphClient("v25.0", session=session, base_url="https://graph.facebook.com")

    video_id = client.create_page_reel("PAGE", "https://x.test/a.mp4", "TOK", description="hi")

    assert video_id == "v9"
    assert len(session.posts) == 3

    start_url, start_data, _ = session.posts[0]
    assert start_url.endswith("/PAGE/video_reels")
    assert start_data["upload_phase"] == "start"

    up_url, up_data, up_headers = session.posts[1]
    assert up_url == "https://rupload.facebook.com/video-upload/v25.0/v9"
    assert up_headers["Authorization"] == "OAuth TOK"
    assert up_headers["file_url"] == "https://x.test/a.mp4"
    # The hosted form sends NO body and none of the local-file headers.
    assert up_data is None
    assert "offset" not in up_headers and "file_size" not in up_headers

    fin_url, fin_data, _ = session.posts[2]
    assert fin_url.endswith("/PAGE/video_reels")
    assert fin_data["upload_phase"] == "finish"
    assert fin_data["video_id"] == "v9"
    assert fin_data["video_state"] == "PUBLISHED"
    assert fin_data["description"] == "hi"


def test_create_page_reel_raises_when_start_returns_no_video_id():
    """Without this the upload phase would POST to .../None and fail somewhere far away
    from the actual cause."""
    session = FakeSession([FakeResponse({})])
    client = GraphClient("v25.0", session=session, base_url="https://graph.facebook.com")
    with pytest.raises(GraphAPIError, match="no video_id"):
        client.create_page_reel("PAGE", "https://x.test/a.mp4", "TOK")
```

- [ ] **Step 3: Run to confirm failure**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_facebook.py -k reel -v`
Expected: FAIL — no attribute `create_page_reel`.

- [ ] **Step 4: Implement**

First, store the version in `__init__` (it is currently folded into `self.base` and unrecoverable):

```python
        self.graph_version = graph_version
        self.base = f"{base_url.rstrip('/')}/{graph_version}"
```

Add the upload helper next to `_post`:

```python
    RUPLOAD_BASE = "https://rupload.facebook.com/video-upload"

    def _post_rupload(self, video_id: str, token: str, file_url: str) -> dict:
        """The Reels upload phase, which does NOT go through _post.

        Different host, headers instead of form fields, and no body at all: Meta fetches
        file_url itself. The token rides in an Authorization header rather than the URL,
        so unlike _post there is no token in the request line — but the response is still
        redacted, because a Meta error body can echo request context back.
        """
        url = f"{self.RUPLOAD_BASE}/{self.graph_version}/{video_id}"
        headers = {"Authorization": f"OAuth {token}", "file_url": file_url}
        try:
            resp = self.session.post(url, headers=headers, timeout=self.timeout)
        except requests.RequestException as exc:
            raise GraphAPIError(f"POST rupload -> request failed: {redact(str(exc))}") from None
        if not resp.ok:
            raise GraphAPIError(
                f"POST rupload -> {resp.status_code}: {redact(resp.text)}",
                status_code=resp.status_code,
                **_error_fields(resp.text),
            )
        return resp.json()
```

Then the three-phase method:

```python
    def create_page_reel(
        self,
        page_id: str,
        file_url: str,
        token: str,
        description: str | None = None,
    ) -> str:
        """Publish a Reel to a Page in Meta's three phases. Returns the VIDEO id.

        start  -> Meta allocates a video id and an upload URL
        upload -> we hand it a public file_url; Meta fetches the bytes itself
        finish -> video_state=PUBLISHED, with the caption as `description`

        Like create_page_video, the id returned is the VIDEO node and not the feed post.
        """
        started = self._post(f"{page_id}/video_reels", {
            "upload_phase": "start",
            "access_token": token,
        })
        video_id = started.get("video_id")
        if not video_id:
            raise GraphAPIError(f"video_reels start returned no video_id: {redact(str(started))}")

        self._post_rupload(video_id, token, file_url)

        data = {
            "upload_phase": "finish",
            "video_id": video_id,
            "video_state": "PUBLISHED",
            "access_token": token,
        }
        if description:
            data["description"] = description
        self._post(f"{page_id}/video_reels", data)
        return video_id
```

- [ ] **Step 5: Run the full suite**

Run: `.venv/bin/python -m pytest worker/tests/ -v`
Expected: PASS, including every pre-existing Facebook test updated for the 3-tuple in Step 1.

- [ ] **Step 6: Verify the token cannot leak**

Run: `.venv/bin/python -m pytest worker/tests/test_redact.py -v`
Then confirm by inspection that `_post_rupload` never puts `token` into a message except through `redact()`.

- [ ] **Step 7: Commit**

```bash
git add worker/graph_api.py worker/tests/
git commit -m "feat(graph): create_page_reel via the three-phase rupload flow

The upload phase targets rupload.facebook.com with headers and no body,
so it needs its own helper rather than _post."
```

---

## Task 7: `get_page_video_status` — normalize Facebook's status vocabulary

**Files:**
- Modify: `worker/graph_api.py`
- Test: `worker/tests/test_graph_api_facebook.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GraphClient.get_page_video_status(video_id: str, token: str) -> str` returning Instagram's vocabulary: `"FINISHED"`, `"ERROR"`, `"EXPIRED"`, or the raw in-progress value.

Normalizing at the client boundary means `publisher._poll_until_finished` needs **no changes** — it already accepts a `status_fn`, which is how Threads reuses it. Teaching that loop a second vocabulary would put platform trivia in shared code.

- [ ] **Step 1: Write the failing test**

```python
import pytest


@pytest.mark.parametrize("video_status,expected", [
    ("ready", "FINISHED"),
    ("error", "ERROR"),
    ("upload_failed", "ERROR"),
    ("expired", "EXPIRED"),
    ("processing", "processing"),
    ("uploading", "uploading"),
    ("upload_complete", "upload_complete"),
])
def test_status_is_normalized_to_the_instagram_vocabulary(video_status, expected):
    session = FakeSession([FakeResponse({"status": {"video_status": video_status}})])
    client = GraphClient("v25.0", session=session, base_url="https://graph.facebook.com")
    assert client.get_page_video_status("v1", "TOK") == expected


def test_missing_status_is_not_mistaken_for_finished():
    """A response we cannot read must keep polling, never resolve as done — publishing on
    an unknown status is exactly the silent-success failure the project forbids."""
    session = FakeSession([FakeResponse({})])
    client = GraphClient("v25.0", session=session, base_url="https://graph.facebook.com")
    assert client.get_page_video_status("v1", "TOK") == "unknown"
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_facebook.py -k status -v`
Expected: FAIL — no attribute `get_page_video_status`.

- [ ] **Step 3: Implement**

```python
    # Facebook's video status is a nested object of lowercase values; Instagram's is a
    # flat status_code of SCREAMING ones. Mapping here — at the client boundary — lets
    # publisher._poll_until_finished stay exactly as it is, the same way Threads reuses
    # it through get_threads_container_status.
    _FB_VIDEO_STATUS = {
        "ready": "FINISHED",
        "error": "ERROR",
        "upload_failed": "ERROR",
        "expired": "EXPIRED",
    }

    def get_page_video_status(self, video_id: str, token: str) -> str:
        """Poll a Page video/Reel until it is done, in the poll loop's own vocabulary.

        Anything unrecognised passes through unchanged, which the loop treats as "keep
        polling" — the safe direction. A status we cannot read must never resolve as
        FINISHED: that would publish on a guess.
        """
        payload = self._get(video_id, {"fields": "status", "access_token": token})
        raw = (payload.get("status") or {}).get("video_status") or "unknown"
        return self._FB_VIDEO_STATUS.get(raw, raw)
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_facebook.py -v`
Expected: PASS (9 status cases).

- [ ] **Step 5: Commit**

```bash
git add worker/graph_api.py worker/tests/test_graph_api_facebook.py
git commit -m "feat(graph): normalize Facebook video status into the poll loop's vocabulary"
```

---

## Task 8: Surface dispatch, polling, and feed-post id resolution

**Files:**
- Modify: `worker/publisher.py:620-627` (`_publish_facebook`), plus two new helpers above it
- Test: `worker/tests/test_facebook_video_publishing.py` (create)

**Interfaces:**
- Consumes: `create_page_video`, `create_page_reel`, `get_page_video_status` (Tasks 5–7); `plan["surface"]` and `plan["media_kind"]`.
- Produces: `_publish_facebook` handles `post_type='video'` on surfaces `feed` and `reel`, returning the id stored in `publications.remote_post_id`.

**The id-resolution risk.** `_fetch_facebook` reads metrics against a **feed post** id via `get_page_post_summary`. Both video endpoints return a **video** id, a different node. We resolve with `GET /{video-id}?fields=post_id` and fall back to the video id when absent — mirroring the preference `_publish_fb_single` already applies. **This is the design's highest-risk assumption and Task 13 must confirm it against the real Page.** If `post_id` is unavailable, Facebook video metrics read zero, and a zero is indistinguishable from a post nobody engaged with.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_facebook_video_publishing.py`:

```python
"""Facebook video: surface picks the endpoint, and the id we store is the FEED POST id."""

import pytest

from worker.publisher import _NonRetryable, _publish_facebook


class FakeClient:
    def __init__(self, statuses=None, post_id="POST1"):
        self.calls = []
        self._statuses = list(statuses or ["FINISHED"])
        self._post_id = post_id

    def create_page_video(self, page_id, file_url, token, description=None):
        self.calls.append(("video", page_id, file_url, description))
        return "v1"

    def create_page_reel(self, page_id, file_url, token, description=None):
        self.calls.append(("reel", page_id, file_url, description))
        return "v1"

    def get_page_video_status(self, video_id, token):
        return self._statuses.pop(0) if self._statuses else "FINISHED"

    def get_page_video_post_id(self, video_id, token):
        return self._post_id


class Cfg:
    reels_status_poll_interval = 0
    reels_status_poll_max_tries = 3
    status_poll_interval = 0
    status_poll_max_tries = 3


def _plan(surface):
    return {
        "account_id": "PAGE", "post_type": "video", "surface": surface,
        "asset_urls": ["https://x.test/a.mp4"], "caption": "hello", "media_kind": "video",
    }


def test_feed_surface_uses_the_videos_edge():
    client = FakeClient()
    result = _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert client.calls[0][0] == "video"
    assert result == "POST1"


def test_reel_surface_uses_the_reels_edge():
    client = FakeClient()
    result = _publish_facebook(client, _plan("reel"), "TOK", Cfg(), lambda _s: None)
    assert client.calls[0][0] == "reel"
    assert result == "POST1"


def test_it_polls_until_finished_before_resolving():
    client = FakeClient(statuses=["processing", "processing", "FINISHED"])
    _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)
    assert client._statuses == []


def test_a_failed_transcode_is_terminal_not_silent():
    client = FakeClient(statuses=["ERROR"])
    with pytest.raises(RuntimeError, match="ERROR"):
        _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None)


def test_missing_post_id_falls_back_to_the_video_id():
    """Never lose the id entirely: a video id still lets a human find the post."""
    client = FakeClient(post_id=None)
    assert _publish_facebook(client, _plan("feed"), "TOK", Cfg(), lambda _s: None) == "v1"


def test_an_unknown_surface_is_refused_terminally():
    with pytest.raises(_NonRetryable, match="surface"):
        _publish_facebook(client=FakeClient(), plan=_plan("story"), token="TOK",
                          config=Cfg(), sleep_fn=lambda _s: None)
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest worker/tests/test_facebook_video_publishing.py -v`
Expected: FAIL — `_publish_facebook` has no `video` branch.

- [ ] **Step 3: Add `get_page_video_post_id` to the client**

In `worker/graph_api.py`:

```python
    def get_page_video_post_id(self, video_id: str, token: str) -> str | None:
        """The FEED POST id for a published Page video, or None if Meta omits it.

        Metrics read reactions/comments/shares off the POST node, but the publish
        endpoints return the VIDEO node. Returning None rather than raising lets the
        caller fall back to the video id: a post that published successfully must not be
        recorded as failed just because its metrics id could not be resolved.
        """
        payload = self._get(video_id, {"fields": "post_id", "access_token": token})
        return payload.get("post_id")
```

- [ ] **Step 4: Implement the dispatch**

In `worker/publisher.py`, above `_publish_facebook`:

```python
def _publish_fb_video(client, plan, token, config, sleep_fn, *, as_reel: bool) -> str:
    """Publish a Page video, to the feed or to Reels, and return the FEED POST id.

    Both endpoints are asynchronous — Meta transcodes server-side — so both poll before
    the publish is treated as done. The Reels budget is used for each: the image path's
    5-minute ceiling is too short for video, and running out is retryable, never terminal.
    """
    page = plan["account_id"]
    url = plan["asset_urls"][0]
    create = client.create_page_reel if as_reel else client.create_page_video
    video_id = create(page, url, token, description=plan["caption"])

    _poll_until_finished(
        client, video_id, token, config, sleep_fn,
        status_fn=client.get_page_video_status,
        interval=config.reels_status_poll_interval,
        max_tries=config.reels_status_poll_max_tries,
    )

    # The video node is not the post node. Prefer the post id metrics can actually read,
    # but never fail a live post over it — see the note in the design spec.
    return client.get_page_video_post_id(video_id, token) or video_id
```

and rewrite the dispatcher:

```python
def _publish_facebook(client, plan, token, config, sleep_fn) -> str:
    post_type = plan["post_type"]
    surface = plan.get("surface", "feed")
    if post_type == "video":
        if surface == "feed":
            return _publish_fb_video(client, plan, token, config, sleep_fn, as_reel=False)
        if surface == "reel":
            return _publish_fb_video(client, plan, token, config, sleep_fn, as_reel=True)
        raise _NonRetryable(
            f"facebook has no video publish path for surface '{surface}'"
        )
    if post_type == "single":
        return _publish_fb_single(client, plan, token)
    if post_type == "carousel":
        return _publish_fb_multi(client, plan, token)
    raise _NonRetryable(f"facebook adapter has no publish path for post_type '{post_type}'")
```

- [ ] **Step 5: Run tests**

Run: `.venv/bin/python -m pytest worker/tests/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/publisher.py worker/graph_api.py worker/tests/test_facebook_video_publishing.py
git commit -m "feat(publisher): Facebook video dispatches on surface

feed -> /videos, reel -> /video_reels. Both poll to completion, then
resolve the feed post id metrics actually read against."
```

---

## Task 9: Surface-aware framing — don't crop a Facebook feed video

**Files:**
- Modify: `worker/publisher.py:167-210` (`_resolve_local_path`, `_resolve_rel`)
- Test: **create** `worker/tests/test_publisher_media_resolution.py` (media resolution is currently covered only incidentally, by `test_delivery.py`)

**Interfaces:**
- Consumes: `PlatformCaps.needs_conformed_media`, the new `feed_video_is_constrained`, `surface`, and the asset's `media_kind`. (It does NOT read `video_surfaces` — an earlier draft said so.)
- Produces: `PlatformCaps.feed_video_is_constrained: bool = True`, and a module-level
  `_needs_conformed(caps: PlatformCaps, surface: str, media_kind: str | None) -> bool` in
  `worker/publisher.py`. `_resolve_rel(asset, surface="feed", needs_conformed=True)` gains a
  keyword argument; `_resolve_url` and `_resolve_local_path` compute it via `_needs_conformed`
  and pass it down.

Facebook feed video accepts **any** aspect ratio; Reels requires vertical. Without this, a landscape clip is cropped to 9:16 for a feed post that never needed it — a visible quality regression, and exactly the silent reframing the story picker's "will be reframed" note exists to prevent.

- [ ] **Step 1: Write the failing test**

```python
def test_facebook_feed_video_keeps_the_original_framing():
    asset = {"storage_path": "orig.mp4", "publish_path": "conformed.mp4", "media_kind": "video"}
    assert _resolve_rel(asset, surface="feed", needs_conformed=False) == "orig.mp4"


def test_facebook_reel_uses_the_conformed_derivative():
    asset = {"storage_path": "orig.mp4", "publish_path": "conformed.mp4", "media_kind": "video"}
    assert _resolve_rel(asset, surface="reel", needs_conformed=True) == "conformed.mp4"


def test_a_reel_without_a_derivative_falls_back_to_the_original():
    """Better to publish the original and let Meta reject a bad ratio than to resolve to
    nothing and fail with 'no media', which says nothing about the real cause."""
    asset = {"storage_path": "orig.mp4", "publish_path": None, "media_kind": "video"}
    assert _resolve_rel(asset, surface="reel", needs_conformed=True) == "orig.mp4"
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest worker/tests/test_publisher_media_resolution.py -v`
Expected: FAIL — `_resolve_rel` takes no `needs_conformed` argument.

- [ ] **Step 3: Implement**

First add the new flag to `PlatformCaps` in `worker/clients.py`:

```python
    # Whether this platform's FEED video has aspect-ratio rules of its own. True keeps
    # today's behaviour everywhere. False only for Facebook, whose /videos edge accepts
    # any ratio up to 20 minutes — Instagram's feed video IS Reels and genuinely is
    # constrained, so the two cannot share one platform-wide answer.
    feed_video_is_constrained: bool = True
```

and set `feed_video_is_constrained=False` on the `facebook` entry only.

Then add the decision helper to `worker/publisher.py`, above `_resolve_rel`:

```python
def _needs_conformed(caps: PlatformCaps, surface: str, media_kind: str | None) -> bool:
    """Whether this send should get the Instagram-shaped derivative.

    Conformance is a per-SURFACE question, not only a per-platform one. A video headed for
    a feed that accepts any aspect ratio should arrive untouched; the same clip headed for
    Reels gets the 9:16 derivative. Images are unaffected and keep the platform-wide
    answer, which is what every existing caller already relies on.
    """
    if media_kind == "video" and surface == "feed" and not caps.feed_video_is_constrained:
        return False
    return caps.needs_conformed_media
```

Then thread it through. `_resolve_rel` gains a keyword argument and stops consulting `caps` itself:

```python
def _resolve_rel(asset, surface: str = "feed", needs_conformed: bool = True) -> str | None:
```

replacing its internal `if caps.needs_conformed_media:` test with `if needs_conformed:`. `_resolve_url` and `_resolve_local_path` each compute the value once and pass it down:

```python
    needs_conformed = _needs_conformed(caps, surface, asset_media_kind)
    rel = _resolve_rel(asset, surface, needs_conformed)
```

`_resolve_url` currently takes no `caps`; give it the same `caps` parameter its sibling already has, and update its call sites in `_validate_media_available` and `_build_plan` to pass it.

- [ ] **Step 4: Run the full suite**

Run: `.venv/bin/python -m pytest worker/tests/ -v`
Expected: PASS. Instagram and Story behaviour must be unchanged — those tests are the regression guard.

- [ ] **Step 5: Commit**

```bash
git add worker/publisher.py worker/clients.py worker/tests/
git commit -m "feat(publisher): don't crop a Facebook feed video to 9:16

Facebook's feed takes any aspect ratio; only Reels is constrained."
```

---

## Task 10: Reels format validation, refused while scheduling

**Files:**
- Modify: `worker/publisher.py:212-278` (`_validate`)
- Test: `worker/tests/test_publisher_validate.py` (created in Task 3)

**Interfaces:**
- Consumes: `assets[0]["duration_ms"]`, `width`, `height`; `surface`.
- Produces: `_validate` refuses a Facebook Reel outside 3–90 s or under 540×960.

- [ ] **Step 1: Write the failing test**

```python
def test_a_too_long_reel_is_refused_before_publishing():
    with pytest.raises(_NonRetryable, match="90 seconds"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 95_000,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_a_too_short_reel_is_refused():
    with pytest.raises(_NonRetryable, match="3 seconds"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 1_500,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
        )


def test_the_same_clip_is_fine_on_the_facebook_feed():
    """95 seconds is over the Reels ceiling but far under the feed's 20 minutes. This is
    the whole reason surface exists."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": 95_000,
          "width": 1920, "height": 1080}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="feed",
    )


def test_unknown_duration_does_not_block_a_reel():
    """duration_ms is NULL for assets imported before the video pipeline existed.
    Refusing on unknown would block a clip that is probably fine; Meta is the backstop."""
    _validate(
        {"post_type": "video"},
        [{"media_kind": "video", "id": 1, "duration_ms": None,
          "width": 1080, "height": 1920}],
        dry_run=True, asset_base_url=None, platform="facebook", surface="reel",
    )
```

- [ ] **Step 2: Run to confirm failure**

Run: `.venv/bin/python -m pytest worker/tests/test_publisher_validate.py -k reel -v`
Expected: FAIL — no duration check exists.

- [ ] **Step 3: Implement**

In `_validate`, after the `post_type == "video"` block:

```python
    # Facebook Reels limits, checked here rather than left to Meta: an over-length clip
    # comes back as a generic OAuthException that says nothing about duration, and by
    # then the send has already read "scheduled" to the owner. Verified 2026-08-23:
    # 3-90 seconds, at least 540x960. See reference.md.
    if post_type == "video" and platform == "facebook" and surface == "reel":
        asset = assets[0]
        duration_ms = asset["duration_ms"] if "duration_ms" in asset.keys() else None
        if duration_ms is not None:
            if duration_ms < 3_000:
                raise _NonRetryable(
                    f"a Facebook Reel must be at least 3 seconds, this is "
                    f"{duration_ms / 1000:.1f}s"
                )
            if duration_ms > 90_000:
                raise _NonRetryable(
                    f"a Facebook Reel can be at most 90 seconds, this is "
                    f"{duration_ms / 1000:.1f}s — send it to the Facebook feed instead, "
                    "which allows up to 20 minutes"
                )
        width = asset["width"] if "width" in asset.keys() else None
        height = asset["height"] if "height" in asset.keys() else None
        if width and height and (width < 540 or height < 960):
            raise _NonRetryable(
                f"a Facebook Reel needs at least 540x960, this is {width}x{height}"
            )
```

- [ ] **Step 4: Run the full suite**

Run: `.venv/bin/python -m pytest worker/tests/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/publisher.py worker/tests/test_publisher_validate.py
git commit -m "feat(publisher): refuse an out-of-spec Facebook Reel before scheduling it"
```

---

**PHASE 2 CHECKPOINT.** Full worker suite green. Verify against the worktree copy only.

**Still do NOT migrate the live install here.** The earlier amendment moved the live migration
from Phase 1 to Phase 2, which was not far enough. The live install runs the code on `main`,
where `SUPPORTED_POST_TYPES` is still `(..., "reel")` and `PostType` has no `"video"`. Migrating
the live database while the live code is the OLD code renames the owner's existing post to a
value their running worker refuses and their running dashboard does not know — breaking a post
that works today, for the whole window until the branch merges.

Schema and the code that understands it must move TOGETHER. The live migration therefore belongs
**after the merge**, immediately before the live verification in Tasks 12-13, and it is an
outward-facing change to the owner's working install: ASK before running it, and back up first
(`sqlite3 data/socialscheduler.db ".backup 'data/pre-0027-backup.db'"`).

---

# Phase 3 — Dashboard and live verification

## Task 11: The Reel toggle in the channel/surface picker

**Files:**
- Modify: `dashboard/components/channel-surface-picker.tsx:60-120`
- Test: `dashboard/test-ui/channel-surface-picker-ui.test.ts` (exists — add to it; note the `-ui` suffix, which is what the `test-ui/*.test.ts` glob and the `ui-hook.mjs` loader expect)

**Interfaces:**
- Consumes: `videoSurfaces` (Task 4).
- Produces: a **Reel** toggle for platforms declaring a `reel` surface, shown only when the post has video.

- [ ] **Step 1: Write the failing test**

```ts
test("a video post offers Facebook a Reel toggle", () => {
  const html = render(<ChannelSurfacePicker
    channels={[{ id: 4, platform: "facebook", account_name: "APT" }]}
    hasVideo={true} value={[]} onChange={() => {}} />);
  assert.match(html, /Reel/);
});

test("an image post offers no Reel toggle", () => {
  const html = render(<ChannelSurfacePicker
    channels={[{ id: 4, platform: "facebook", account_name: "APT" }]}
    hasVideo={false} value={[]} onChange={() => {}} />);
  assert.doesNotMatch(html, /Reel/);
});

test("instagram never offers a Reel toggle", () => {
  const html = render(<ChannelSurfacePicker
    channels={[{ id: 1, platform: "instagram", account_name: "me" }]}
    hasVideo={true} value={[]} onChange={() => {}} />);
  assert.doesNotMatch(html, /Reel/);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd dashboard && npm test`
Expected: FAIL — no Reel toggle rendered.

- [ ] **Step 3: Implement**

`videoDisabled` becomes surface-aware, and a Reel row appears beside Feed/Story:

```tsx
const surfaces = videoSurfaces(c.platform);
// A video post can only use this channel's VIDEO surfaces; an image post is unaffected.
const videoDisabled = hasVideo && surfaces.length === 0;
const offersReel = hasVideo && surfaces.includes("reel");
```

Render the Reel toggle with the same structure as the existing Story toggle so there is one behaviour to learn, and keep the disabled reason wording consistent with the existing `can't post video` copy.

- [ ] **Step 4: Run tests and lint**

Run: `cd dashboard && npm test && npm run lint`
Expected: PASS, 0 lint errors.

- [ ] **Step 5: Verify in a real browser**

`renderToStaticMarkup` cannot catch click handlers or layout. Start the dashboard on port 3939, open the composer, attach a video, and confirm the Facebook channel shows Feed and Reel toggles that actually toggle.

The owner uses **Safari**, where Turbopack reuses one CSS URL and serves stale styles — hard-reload with **Cmd+Option+R** before judging any visual result.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/channel-surface-picker.tsx dashboard/test-ui/
git commit -m "feat(composer): offer Facebook Feed and Reel surfaces for video posts"
```

---

## Task 12: Dry run

**Files:** none changed — this task is verification.

- [ ] **Step 1: Confirm the kill switch and dry-run flags**

```bash
grep -n "KILL_SWITCH\|DRY_RUN" .env
```

The install posts for real (`DRY_RUN=0`). A launch-time env var outranks `.env`, so the dry run below sets it explicitly.

- [ ] **Step 2: Schedule one Facebook feed video and one Facebook Reel**

Through the composer, against the real Page channel (id 4), scheduled a few minutes out.

- [ ] **Step 3: Run the worker in dry-run mode**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler"
DRY_RUN=1 .venv/bin/python -m worker.run
```

Expected in the log, with **no** Graph API publish call: both publications resolve, the feed send names the **original** file and the Reel names the **conformed** derivative, and each names its endpoint.

- [ ] **Step 4: Confirm nothing published**

```bash
sqlite3 -readonly data/socialscheduler.db \
  "SELECT id, surface, status, is_dry_run, remote_post_id FROM publications ORDER BY id DESC LIMIT 4;"
```

Expected: `is_dry_run = 1`, `remote_post_id` NULL.

---

## Task 13: Live verification and documentation

**Files:**
- Modify: `reference.md` (a verified Facebook video section), `docs/tasks.md`

- [ ] **Step 1: Confirm the token's permissions before posting**

`worker/exchange_token.py:126` already has `debug_token`. Read the Page channel's token from the local DB and inspect its scopes — never print the token itself:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler"
.venv/bin/python -c "
from worker.config import Config
from worker.db import connect
from worker.exchange_token import debug_token

cfg = Config.from_env()
conn = connect(cfg.database_path)
row = conn.execute(
    \"SELECT access_token FROM channels WHERE platform='facebook' AND is_active=1 LIMIT 1\"
).fetchone()
scopes = set(debug_token(cfg, row['access_token']).get('scopes', []))
for need in ('pages_manage_posts', 'pages_read_engagement', 'pages_show_list'):
    print(('OK   ' if need in scopes else 'MISSING '), need)
"
```

Expected: all three `OK`. If any is `MISSING`, add it to the Meta app's use case and re-issue the Page token **before** attempting a publish — a missing scope surfaces as a generic `#200`, which says nothing about which one is absent.

- [ ] **Step 2: Publish one real feed video**

Restart the worker with `DRY_RUN=0` and let the scheduled feed send fire.

- [ ] **Step 3: Publish one real Reel**

Same, for the Reel send.

- [ ] **Step 4: Read both back from the API, not from our DB**

This is the step that settles the id-resolution risk. For each published id:

```bash
.venv/bin/python -c "
from worker.config import Config
from worker.graph_api import GraphClient
cfg = Config.from_env()
# Facebook Pages always live on graph.facebook.com (clients.FACEBOOK_BASE), independent
# of whatever host this install configured for Instagram.
client = GraphClient(cfg.graph_version, base_url='https://graph.facebook.com')
token = '<page token>'
for pid in ('<stored remote_post_id 1>', '<stored remote_post_id 2>'):
    print(pid, client.get_page_post_summary(pid, token))
"
```

Expected: real reaction/comment/share counts for **both**. If either returns an error, `get_page_video_post_id` did not resolve a usable post id — Facebook video metrics would silently read zero, and the fallback needs rethinking before this feature is called done.

- [ ] **Step 5: Confirm both posts on the Page itself**

Open the Facebook Page. Confirm the feed video appears with its original framing (not cropped to vertical) and the Reel appears under Reels.

- [ ] **Step 6: Record what was verified**

Add to `reference.md` under "Facebook Pages publishing", with the real ids and the date — following the existing verified-section convention, including the documented-but-unenforced 30 Reels/24 h limit.

Update the open-work table in `docs/tasks.md`: close the Facebook video item, and record Facebook **Stories** as the remaining known gap.

- [ ] **Step 7: Commit**

```bash
git add reference.md docs/tasks.md
git commit -m "docs: record verified Facebook feed video and Reels publishing"
```

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — data model → 1; capability model → 2; worker/graph_api → 5, 6, 7; publisher dispatch + id resolution → 8; framing → 9; validation → 10; dashboard → 4, 11; testing/verification → 12, 13; rename → 3, 4.
- **Deliberately deferred:** Facebook Stories, `cover_url`, scheduled/draft Reels, bulk import — all listed out of scope in the spec.
- **Known weak point:** Task 9's `feed_video_is_constrained` flag adds a second framing knob to `PlatformCaps`. If the reviewer prefers, it can be folded into `video_surfaces` as a richer per-surface record — but that is a larger refactor and the flag is honest about what it controls.
