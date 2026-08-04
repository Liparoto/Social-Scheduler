# Instagram Stories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a post be sent to an Instagram Story as a per-channel destination, so one photo
can be a Story on Instagram and an ordinary post on Telegram from a single Library entry.

**Architecture:** "Story" is a **surface on the target**, never a `post_type`. `post_targets`
and `publications` each gain a `surface` column (`feed` | `story`); `publications` also gains
`asset_id`, NULL for feed sends and set for story sends. A multi-slide post targeted at a
Story fans out at *scheduling* time into one independent publication per slide, so each Story
retries, fails, and reports metrics on its own — reusing the publication machinery rather than
building a parallel one.

**Tech Stack:** SQLite (WAL, one file per install) · Python 3 worker (`venv`, pytest) ·
Next.js App Router + TypeScript dashboard (`better-sqlite3`, `node --test`).

**Spec:** `docs/design-instagram-stories.md` (approved 2026-08-03). Read it first — this plan
implements it and does not restate its reasoning.

## Global Constraints

- **The schema lives in `/migrations` as `.sql` files and is the source of truth.** Never
  define schema inline in TypeScript or Python — write a migration.
- **`migrate.py` has no argument parser.** Every invocation migrates the real database. Always
  test migrations against a **scratch copy**, never `/data`.
- **Never skip the container status check.** Poll `status_code` until `FINISHED` before
  publishing — including for story images, where it is usually immediate.
- **Never hardcode the publishing rate limit.** Read `content_publishing_limit` at runtime.
- **Failed publishes must be visibly failed, never silent.** One slide failing must not roll
  back or block its siblings.
- **Never log tokens or full API responses.** Use `worker/redact.py`.
- **This install publishes for real (`DRY_RUN=0`).** Every phase that can reach the network is
  verified with `DRY_RUN=1` before anything else.
- **Restart the worker after changing worker code.** A live heartbeat proves the daemon is
  running, not that it is running current code.
- Commit after each task. Run the full suite, not just the new test, before each commit.

**Test commands** (from the repo root):

```bash
.venv/bin/python -m pytest worker/tests -q
```

```bash
cd dashboard && npm test
```

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `migrations/0014_story_surface.sql` | **Create.** `post_targets` rebuild for widened PK; `publications` additive columns. | 1 |
| `worker/tests/test_migration_0014.py` | **Create.** Migration behaviour: backfill, CHECK, RESTRICT, widened PK. | 1 |
| `worker/db.py` | **Modify.** Deterministic due-publication ordering. | 1 |
| `worker/graph_api.py` | **Modify.** `create_story_container()`. | 2 |
| `worker/publisher.py` | **Modify.** Surface-aware load/validate/resolve/plan + `_publish_story`; surface-aware retirement. | 2 |
| `worker/tests/test_stories_publish.py` | **Create.** Story publish path, validation, isolation. | 2 |
| `worker/autofill.py` | **Modify.** Candidate query restricted to `surface = 'feed'`. | 2 |
| `dashboard/lib/types.ts` | **Modify.** `Surface` type, `PostTarget` shape. | 3 |
| `dashboard/lib/story-fanout.ts` | **Create.** The one place that expands a story target into per-slide rows. | 3 |
| `dashboard/lib/queries.ts` | **Modify.** Surface through `post_targets` + publication writes. | 3 |
| `dashboard/lib/queries.stories.test.ts` | **Create.** Round-trip, fan-out, ordering. | 3 |
| `dashboard/components/channel-surface-picker.tsx` | **Create.** Feed/Story chips + guards. | 4 |
| `dashboard/components/composer.tsx` | **Modify.** Adopt the picker; slide-count note. | 4 |
| `dashboard/components/publication-queue.tsx` | **Modify.** Group sibling story rows. | 4 |
| `worker/metrics.py` | **Modify.** Story metric set + 24h cutoff. | 5 |
| `worker/tests/test_metrics.py` | **Modify.** Story metric selection and cutoff. | 5 |
| `docs/tasks.md` | **Modify.** Record phases and deferred follow-ups. | 6 |

---

## Phase 1 — Schema and deterministic ordering

**Deliverable:** the database can express a surface; nothing else behaves differently.

### Task 1: Migration `0014_story_surface.sql`

**Files:**
- Create: `migrations/0014_story_surface.sql`
- Test: `worker/tests/test_migration_0014.py`

**Interfaces:**
- Produces: `post_targets.surface`, `publications.surface`, `publications.asset_id`. Every
  later task depends on these column names.

- [ ] **Step 1: Write the failing migration test**

`worker/tests/test_migration_0014.py`. The `conn` fixture in `worker/tests/conftest.py` builds
a DB from **all** migrations in order, so these tests exercise the real file.

```python
"""Migration 0014: post_targets gains a surface (PK widens); publications gains
surface + asset_id additively."""

from __future__ import annotations

import sqlite3

import pytest


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _post_and_channel(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','single')"
    ).lastrowid
    return pid, cid


def test_both_tables_gain_surface(conn):
    assert "surface" in cols(conn, "post_targets")
    assert "surface" in cols(conn, "publications")
    assert "asset_id" in cols(conn, "publications")


def test_existing_rows_default_to_feed(conn):
    pid, cid = _post_and_channel(conn)
    conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, cid))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)",
        (pid, cid, "2026-08-01T18:00:00+00:00"),
    )
    conn.commit()
    assert conn.execute("SELECT surface FROM post_targets").fetchone()[0] == "feed"
    row = conn.execute("SELECT surface, asset_id FROM publications").fetchone()
    assert row["surface"] == "feed"
    assert row["asset_id"] is None, "a feed send means ALL assets, not a specific one"


def test_one_channel_can_be_targeted_on_both_surfaces(conn):
    """The whole point of widening the primary key."""
    pid, cid = _post_and_channel(conn)
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'feed')",
        (pid, cid),
    )
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
        (pid, cid),
    )
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM post_targets").fetchone()[0] == 2


def test_the_same_surface_twice_is_still_rejected(conn):
    pid, cid = _post_and_channel(conn)
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
        (pid, cid),
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
            (pid, cid),
        )


def test_surface_check_rejects_anything_else(conn):
    pid, cid = _post_and_channel(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'reel')",
            (pid, cid),
        )


def test_deleting_an_asset_a_story_send_needs_is_refused(conn):
    """ON DELETE RESTRICT: a scheduled Story must never be silently orphaned."""
    pid, cid = _post_and_channel(conn)
    aid = conn.execute(
        "INSERT INTO assets (content_hash, storage_path) VALUES ('h1','a.jpg')"
    ).lastrowid
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, surface, asset_id) "
        "VALUES (?,?,?,'story',?)",
        (pid, cid, "2026-08-01T18:00:00+00:00", aid),
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM assets WHERE id=?", (aid,))


def test_post_targets_channel_index_survives_the_rebuild(conn):
    names = {
        r["name"]
        for r in conn.execute("PRAGMA index_list(post_targets)").fetchall()
    }
    assert "idx_post_targets_channel" in names


def test_cascade_from_posts_still_works_after_the_rebuild(conn):
    """The rebuild disables foreign keys; if they aren't restored, this silently passes
    with orphaned rows instead of cascading."""
    pid, cid = _post_and_channel(conn)
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'feed')",
        (pid, cid),
    )
    conn.commit()
    conn.execute("DELETE FROM posts WHERE id=?", (pid,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM post_targets").fetchone()[0] == 0
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0014.py -q`
Expected: FAIL — `no such column: surface`.

- [ ] **Step 3: Write the migration**

`migrations/0014_story_surface.sql`. The `PRAGMA`/`BEGIN` dance and its reasoning are copied
from `0008_platform_foundation.sql` — read that file's header before editing this one.

```sql
-- 0014_story_surface.sql
-- Instagram Stories are a DESTINATION, not a post type. posts.post_type is inferred from
-- the content and says what a post IS; "story" says where it LANDS. Where a post lands
-- already lives on post_targets, so that is where the surface goes.
--
-- posts.post_type still lists 'story' in its CHECK (from 0001). That value is VESTIGIAL and
-- unused: nothing creates it and publisher._validate refuses it. Do not reach for it — the
-- real story surface is post_targets.surface / publications.surface. It is left in place
-- only because removing it would mean a second full table rebuild for zero behaviour change.
--
-- post_targets must be REBUILT because its PRIMARY KEY widens and SQLite cannot ALTER one.
-- As in 0008: DROP TABLE with foreign keys ENABLED fires ON DELETE CASCADE, so enforcement
-- is disabled around the rebuild and restored after. The PRAGMAs stay OUTSIDE the explicit
-- transaction (PRAGMA foreign_keys is a silent no-op while a transaction is open).
-- Nothing references post_targets, so no child tables are at risk here, but the pattern is
-- kept identical so this file cannot be read as an exception to it.
--
-- publications is NOT rebuilt. It has three indexes and a cascading child (post_metrics),
-- which is exactly the risk 0008's header describes, and no key changes here force a
-- rebuild. Verified against SQLite: ADD COLUMN accepts NOT NULL DEFAULT + CHECK, and accepts
-- REFERENCES ... ON DELETE RESTRICT because the new column defaults to NULL.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE post_targets_new (
    post_id    INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- 'feed' = the normal post for that platform. 'story' = an Instagram Story.
    -- Written generically so Facebook Page Stories can adopt it when that adapter lands.
    surface    TEXT    NOT NULL DEFAULT 'feed' CHECK (surface IN ('feed', 'story')),
    PRIMARY KEY (post_id, channel_id, surface)
);

-- Every existing target is a feed target: nothing today can be a story.
INSERT INTO post_targets_new (post_id, channel_id, surface)
    SELECT post_id, channel_id, 'feed' FROM post_targets;

DROP TABLE post_targets;
ALTER TABLE post_targets_new RENAME TO post_targets;
CREATE INDEX idx_post_targets_channel ON post_targets (channel_id);

COMMIT;
PRAGMA foreign_keys = ON;

-- publications: additive only.
--   surface  — which destination this send is for.
--   asset_id — NULL for a feed send (meaning "all of the post's assets, in order");
--              set for a story send (meaning "this ONE slide"). RESTRICT so deleting an
--              asset a scheduled Story depends on is refused, not silently orphaned.
ALTER TABLE publications ADD COLUMN surface TEXT NOT NULL DEFAULT 'feed'
                                            CHECK (surface IN ('feed', 'story'));
ALTER TABLE publications ADD COLUMN asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0014.py -q`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the whole worker suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS. Nothing should regress — every existing row backfills to `feed`.

- [ ] **Step 6: Dry-run the migration against a scratch copy of the live DB**

Never point `migrate.py` at `/data`. Copy first — and use `.backup`, not `cp`: the DB is
in WAL mode and may be open, so a plain file copy can capture a torn read.

```bash
sqlite3 data/socialscheduler.db ".backup '/tmp/scratch.db'" && DATABASE_PATH=/tmp/scratch.db .venv/bin/python migrate.py && sqlite3 /tmp/scratch.db "PRAGMA integrity_check; PRAGMA foreign_key_check; SELECT surface, COUNT(*) FROM post_targets GROUP BY surface;"
```

Expected: `ok`, no foreign-key violations, and every existing target reported as `feed`.

- [ ] **Step 7: Commit**

```bash
git add migrations/0014_story_surface.sql worker/tests/test_migration_0014.py && git commit -m "feat(db): add story surface to post_targets and publications"
```

### Task 2: Deterministic due-publication ordering

**Files:**
- Modify: `worker/db.py:32`
- Test: `worker/tests/test_db.py`

**Interfaces:**
- Produces: `fetch_due_publications()` returns rows in `(scheduled_at, id)` order. Phase 2's
  slide ordering depends on this.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_db.py`:

```python
def test_due_publications_break_ties_by_id(conn):
    """Slides of one Story share a scheduled_at and MUST go out in insertion order.
    scheduled_at alone leaves tie order up to SQLite."""
    from worker import db

    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('x','carousel')"
    ).lastrowid
    when = "2026-08-01T18:00:00+00:00"
    ids = [
        conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, surface) "
            "VALUES (?,?,?,'story')",
            (pid, cid, when),
        ).lastrowid
        for _ in range(4)
    ]
    conn.commit()

    got = [r["id"] for r in db.fetch_due_publications(conn, "2026-08-01T19:00:00+00:00")]
    assert got == ids, "story slides must publish in insertion (slide) order"
```

- [ ] **Step 2: Run it**

Run: `.venv/bin/python -m pytest worker/tests/test_db.py::test_due_publications_break_ties_by_id -q`
Expected: may pass by luck. Treat this as a **regression guard**, not a red-green cycle — the
current query has no tie-break, so passing is incidental. Proceed to Step 3 regardless.

- [ ] **Step 3: Add the tie-break**

In `worker/db.py`, `fetch_due_publications`:

```python
        ORDER BY scheduled_at ASC, id ASC
```

And extend the docstring:

```python
    """Publications that are ready to be worked: scheduled, past their time, and either
    never attempted or past their retry backoff. Ordered oldest-first (fair queueing),
    with id as an explicit tie-break: the slides of one Story share a scheduled_at and
    must be published in slide order, which is insertion order.
    """
```

- [ ] **Step 4: Run the suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/db.py worker/tests/test_db.py && git commit -m "fix(worker): break due-publication ties by id so story slides keep their order"
```

---

## Phase 2 — Worker: publishing a Story

**Deliverable:** a story publication row publishes correctly, in dry-run and for real.

### Task 3: `create_story_container()` on the Graph client

**Files:**
- Modify: `worker/graph_api.py` (after `create_video_container`)
- Test: `worker/tests/test_stories_publish.py` (create)

**Interfaces:**
- Produces: `GraphClient.create_story_container(ig_user_id, token, image_url=None,
  video_url=None) -> str`. Task 4 calls exactly this signature.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_stories_publish.py`:

```python
"""Instagram Stories: container shape, validation, and per-slide isolation."""

from __future__ import annotations

import pytest


def test_story_container_sends_media_type_stories_and_no_caption(fake_graph):
    """Stories have no caption field. Sending one is at best ignored, at worst an error."""
    fake_graph.create_story_container("178414", "tok", image_url="https://x/a.jpg")
    call = fake_graph.calls[-1]
    assert call["data"]["media_type"] == "STORIES"
    assert call["data"]["image_url"] == "https://x/a.jpg"
    assert "caption" not in call["data"]


def test_story_container_uses_video_url_for_video(fake_graph):
    fake_graph.create_story_container("178414", "tok", video_url="https://x/a.mp4")
    call = fake_graph.calls[-1]
    assert call["data"]["media_type"] == "STORIES"
    assert call["data"]["video_url"] == "https://x/a.mp4"
    assert "image_url" not in call["data"]
```

**Note for the implementer:** `fake_graph` is the shared fake client fixture in
`worker/tests/conftest.py`. Read it before writing this test and mirror how
`test_reels_publish.py` asserts on recorded calls — if the fake records calls under a
different key than `calls`/`data`, use the existing convention rather than inventing one, and
add `create_story_container` to the fake alongside `create_video_container`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `.venv/bin/python -m pytest worker/tests/test_stories_publish.py -q`
Expected: FAIL — `create_story_container` does not exist.

- [ ] **Step 3: Implement it**

In `worker/graph_api.py`, after `create_video_container`:

```python
    def create_story_container(
        self,
        ig_user_id: str,
        token: str,
        image_url: str | None = None,
        video_url: str | None = None,
    ) -> str:
        """Create a STORIES container from exactly ONE image or video.

        There is no such thing as a carousel Story in the API — a multi-slide post
        becomes several Stories, fanned out into one publication per slide before we
        ever get here (see publisher._load_targets).

        Stories take NO caption: the field does not exist on this surface, so the
        caller's caption is deliberately dropped rather than passed through.
        """
        if bool(image_url) == bool(video_url):
            raise ValueError("a story needs exactly one of image_url or video_url")
        data = {"media_type": "STORIES", "access_token": token}
        if video_url:
            data["video_url"] = video_url
        else:
            data["image_url"] = image_url
        return self._post(f"{ig_user_id}/media", data)["id"]
```

- [ ] **Step 4: Run it**

Run: `.venv/bin/python -m pytest worker/tests/test_stories_publish.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/graph_api.py worker/tests/test_stories_publish.py worker/tests/conftest.py && git commit -m "feat(worker): add STORIES container creation to the Graph client"
```

### Task 4: Surface-aware publish path

**Files:**
- Modify: `worker/publisher.py` — `_surface` (new helper), `_load_targets`, `_resolve_url`,
  `_validate`, `_build_plan`, `_publish_instagram`, `_publish_story` (new),
  `_maybe_retire_one_time`
- Test: `worker/tests/test_stories_publish.py`

**Interfaces:**
- Consumes: `GraphClient.create_story_container(...)` from Task 3.
- Produces: `plan["surface"]` and `plan["media_kind"]` keys, relied on by dry-run output.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_stories_publish.py`. Use the `make_publication` factory from
`conftest.py`; extend it with `surface` and `asset_id` parameters as part of this step.

```python
def test_story_publishes_container_then_publishes_it(conn, config, fake_graph,
                                                     make_publication):
    from worker.publisher import publish_one

    pub = make_publication(post_type="single", n_assets=1, surface="story")
    out = publish_one(conn, pub, config, fake_graph, dry_run=False)

    assert out.result == "posted"
    kinds = [c["path"] for c in fake_graph.calls]
    assert any("media_publish" in k for k in kinds), "a story must actually be published"


def test_story_sends_the_original_not_the_feed_conformed_derivative(conn, config,
                                                                    fake_graph,
                                                                    make_publication):
    """Conformance targets the FEED (4:5..1.91:1). A Story is 9:16, outside that range,
    so the conformed copy is the wrong image."""
    from worker.publisher import publish_one

    pub = make_publication(post_type="single", n_assets=1, surface="story")
    conn.execute(
        "UPDATE assets SET storage_path='orig.jpg', publish_path='conformed.jpg', "
        "public_url=NULL"
    )
    conn.commit()
    out = publish_one(conn, pub, config, fake_graph, dry_run=True)

    assert "orig.jpg" in out.plan["asset_urls"][0]
    assert "conformed.jpg" not in out.plan["asset_urls"][0]


def test_story_publication_without_an_asset_id_fails_terminally(conn, config, fake_graph,
                                                                make_publication):
    from worker.publisher import publish_one

    pub = make_publication(post_type="single", n_assets=1, surface="story")
    conn.execute("UPDATE publications SET asset_id = NULL WHERE id = ?", (pub["id"],))
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id=?", (pub["id"],)).fetchone()

    out = publish_one(conn, pub, config, fake_graph, dry_run=False)
    assert out.result == "failed", "a story with no slide is a data bug, not a retry"


def test_only_instagram_accepts_a_story(conn, config, fake_graph, make_publication):
    from worker.publisher import publish_one

    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           platform="telegram")
    out = publish_one(conn, pub, config, fake_graph, dry_run=False)
    assert out.result == "failed"


def test_story_ignores_the_caption_length_limit(conn, config, fake_graph, make_publication):
    """No caption is sent, so a caption too long for the feed must not block a Story."""
    from worker.publisher import publish_one

    pub = make_publication(post_type="single", n_assets=1, surface="story")
    conn.execute("UPDATE posts SET caption = ?", ("x" * 5000,))
    conn.commit()
    out = publish_one(conn, pub, config, fake_graph, dry_run=True)
    assert out.result == "dry_run"
    assert out.plan["caption"] is None, "a story plan must carry no caption at all"


def test_one_time_post_is_not_retired_until_every_surface_has_posted(conn, make_publication):
    """A post targeted at IG feed AND IG story must not retire when only the feed
    send succeeds."""
    from worker.publisher import _maybe_retire_one_time
    from datetime import datetime, timezone

    pub = make_publication(post_type="single", n_assets=1, surface="feed")
    post_id, channel_id = pub["post_id"], pub["channel_id"]
    conn.execute("UPDATE posts SET content_kind='one_time' WHERE id=?", (post_id,))
    conn.execute("DELETE FROM post_targets WHERE post_id=?", (post_id,))
    for surface in ("feed", "story"):
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,?)",
            (post_id, channel_id, surface),
        )
    conn.execute(
        "UPDATE publications SET status='posted', is_dry_run=0 WHERE id=?", (pub["id"],)
    )
    conn.commit()

    retired = _maybe_retire_one_time(conn, post_id, datetime.now(timezone.utc))
    assert retired is False, "the story target has not posted yet"
```

- [ ] **Step 2: Run and confirm they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_stories_publish.py -q`
Expected: FAIL — `make_publication() got an unexpected keyword argument 'surface'`.

- [ ] **Step 3: Extend the `make_publication` factory**

In `worker/tests/conftest.py`, add `surface="feed"` to `_make`'s signature. When
`surface == "story"`, write `surface` and the **first** asset's id onto the publication row so
the fixture produces a realistic single-slide story send.

- [ ] **Step 4: Implement the publisher changes**

In `worker/publisher.py`:

```python
def _surface(pub) -> str:
    """A publication's destination surface, defaulting to 'feed'.

    The .keys() guard matches the existing idiom for publish_path/cover_frame_ms: many
    tests build publication fixtures as plain dicts without this column, and a bare
    pub["surface"] would KeyError on every one of them.
    """
    return pub["surface"] if "surface" in pub.keys() else "feed"
```

`_load_targets` — narrow a story to its one slide, so validation and plan-building both see
exactly one asset:

```python
def _load_targets(conn, pub):
    channel = db.get_channel(conn, pub["channel_id"])
    post = db.get_post(conn, pub["post_id"])
    if channel is None:
        raise _NonRetryable(f"channel {pub['channel_id']} not found")
    if post is None:
        raise _NonRetryable(f"post {pub['post_id']} not found")
    assets = db.get_ordered_assets(conn, pub["post_id"])
    if _surface(pub) == "story":
        # A story send is ONE slide. The fan-out into one publication per slide happened
        # at scheduling time; here we just resolve which slide this row is for.
        asset_id = pub["asset_id"] if "asset_id" in pub.keys() else None
        if asset_id is None:
            raise _NonRetryable("story publication has no asset_id (nothing to post)")
        assets = [a for a in assets if a["id"] == asset_id]
        if not assets:
            raise _NonRetryable(
                f"story asset {asset_id} is not on post {pub['post_id']}"
            )
    return channel, post, assets
```

`_resolve_url` — add a `surface` parameter defaulting to `"feed"`, and prefer the original for
stories:

```python
def _resolve_url(asset, asset_base_url: str | None, surface: str = "feed") -> str | None:
    """The public URL Meta will download from.

    Precedence: an explicit external public_url (the manual/paste escape hatch) always
    wins. Otherwise it depends on the SURFACE. A feed post prefers the Meta-conformed
    derivative at publish_path; a STORY prefers the untouched original, because
    conformance targets the feed's 4:5..1.91:1 range and a story is 9:16 — outside it.
    Sending the conformed copy to a story would post a deliberately mis-shaped image.
    Either way we fall back to the other, then to nothing.
    """
    external = asset["public_url"]
    if external:
        return external
    if asset_base_url:
        has_publish_path = "publish_path" in asset.keys() and asset["publish_path"]
        conformed = asset["publish_path"] if has_publish_path else None
        original = asset["storage_path"]
        rel = (original or conformed) if surface == "story" else (conformed or original)
        if rel:
            return f"{asset_base_url.rstrip('/')}/{rel}"
    return None
```

`_validate` — take `surface` and apply story rules, skipping the caption limit:

```python
    if surface == "story":
        if platform != "instagram":
            raise _NonRetryable(f"{platform} has no Stories surface in this worker")
        if len(assets) != 1:
            raise _NonRetryable(f"a story needs exactly 1 asset, has {len(assets)}")
        if assets[0]["media_kind"] not in ("image", "video"):
            raise _NonRetryable(
                f"a story needs an image or video, got '{assets[0]['media_kind']}'"
            )
        # No caption-limit check: a story sends no caption at all.
    else:
        limit = caps.caption_limit(post_type)
        if limit is not None and caption is not None and len(caption) > limit:
            raise _NonRetryable(
                f"caption is {len(caption)} characters; {platform} allows {limit} "
                f"for a {post_type} post"
            )
```

Keep the existing `post_type` checks for the feed path unchanged, and leave the
`SUPPORTED_POST_TYPES` refusal in place — but update its message, which currently says
Stories are unimplemented:

```python
    if post_type not in SUPPORTED_POST_TYPES:
        raise _NonRetryable(
            f"post_type '{post_type}' is not a publishable content shape "
            "(note: Stories are a target SURFACE, not a post_type)"
        )
```

`_build_plan` — carry the surface, force the caption to None for stories, and expose the media
kind so `_publish_story` knows which URL field to use:

```python
        "surface": surface,
        # Stories have no caption field. Null it in the PLAN, not just at the call site,
        # so dry-run output shows the truth about what would be sent.
        "caption": None if surface == "story" else caption,
        "media_kind": assets[0]["media_kind"] if assets else None,
```

`_publish_instagram` — dispatch on surface before post_type:

```python
def _publish_instagram(client, plan, token, config, sleep_fn) -> str:
    # Surface first: a Story is one media regardless of the post's content shape, so
    # post_type ('single'/'carousel') describes the SOURCE, not what gets published here.
    if plan.get("surface") == "story":
        return _publish_story(client, plan, token, config, sleep_fn)
    post_type = plan["post_type"]
    ...
```

```python
def _publish_story(client, plan, token, config, sleep_fn) -> str:
    """One media, no caption, container -> poll -> publish.

    We poll even for images, where the container is usually ready immediately: never
    skipping the status check is a project rule, and the cost is one cheap request.
    Video gets the longer Reels poll budget, since Meta transcodes it server-side.
    """
    ig = plan["account_id"]
    url = plan["asset_urls"][0]
    is_video = plan.get("media_kind") == "video"
    container = client.create_story_container(
        ig,
        token,
        video_url=url if is_video else None,
        image_url=None if is_video else url,
    )
    _poll_until_finished(
        client, container, token, config, sleep_fn,
        interval=config.reels_status_poll_interval if is_video else None,
        max_tries=config.reels_status_poll_max_tries if is_video else None,
    )
    return client.publish_container(ig, container, token)
```

`_maybe_retire_one_time` — compare `(channel_id, surface)` pairs, not channels:

```python
def _maybe_retire_one_time(conn, post_id: int, now: datetime) -> bool:
    """Retire a one-time post once EVERY targeted (channel, surface) has posted it.

    Surface matters: a post aimed at both a channel's feed AND its story is not spent
    when only the feed send succeeds — retiring there would strand the Story.
    """
    targets = conn.execute(
        "SELECT channel_id, surface FROM post_targets WHERE post_id = ?", (post_id,)
    ).fetchall()
    if not targets:
        return False
    for t in targets:
        done = conn.execute(
            "SELECT 1 FROM publications WHERE post_id = ? AND channel_id = ? "
            "AND surface = ? AND status = 'posted' AND is_dry_run = 0 LIMIT 1",
            (post_id, t["channel_id"], t["surface"]),
        ).fetchone()
        if not done:
            return False
    db.update_post(conn, post_id, content_status="retired", updated_at=_iso(now))
    return True
```

Thread `surface = _surface(pub)` from `publish_one` through to `_validate` and `_build_plan`,
and pass it into every `_resolve_url` call.

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest worker/tests/test_stories_publish.py -q`
Expected: PASS.

- [ ] **Step 6: Run the whole worker suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS, including `test_platform_dispatch.py` and the existing
`test_publisher.py::test_story_not_supported` — **that test asserts the old refusal and must
be updated, not deleted.** Rewrite it to assert that `post_type='story'` is still refused
(it is vestigial) while `surface='story'` publishes.

- [ ] **Step 7: Commit**

```bash
git add worker/publisher.py worker/tests/ && git commit -m "feat(worker): publish Instagram Stories from a story-surface publication"
```

### Task 5: Auto-fill stays feed-only

**Files:**
- Modify: `worker/autofill.py:181`
- Test: `worker/tests/test_autofill.py`

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill.py`:

```python
def test_a_story_only_post_is_never_autofilled_into_the_feed(conn, config):
    """post_targets now carries a surface. Matching on channel_id alone would let a
    post meant ONLY for Stories be queued as an ordinary feed post."""
    from worker.autofill import select_candidates

    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, autofill_enabled) "
        "VALUES ('instagram','IG',1)"
    ).lastrowid
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, content_status) "
        "VALUES ('x','single','ready')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'story')",
        (pid, cid),
    )
    conn.commit()

    got = select_candidates(conn, cid, limit=10)
    assert pid not in [r["post_id"] for r in got]
```

**Note for the implementer:** match `select_candidates`' real signature and the surrounding
fixtures in `test_autofill.py` — adapt this test to them rather than changing the function.

- [ ] **Step 2: Run it**

Run: `.venv/bin/python -m pytest worker/tests/test_autofill.py -q`
Expected: FAIL — the story-only post is selected.

- [ ] **Step 3: Restrict the candidate query**

`worker/autofill.py:181`:

```sql
          AND EXISTS (SELECT 1 FROM post_targets pt
                       WHERE pt.post_id = p.id AND pt.channel_id = :cid
                         AND pt.surface = 'feed')
```

With a comment above the query:

```python
        # surface = 'feed': auto-fill queues ordinary posts only. A post targeted solely
        # at a Story must never be auto-queued as a feed post. Story recycling is a
        # deliberate v1 scope cut (docs/design-instagram-stories.md §4), not an oversight.
```

- [ ] **Step 4: Run the suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill.py && git commit -m "fix(worker): keep auto-fill to feed targets so story-only posts aren't queued"
```

---

## Phase 3 — Dashboard data layer

**Deliverable:** the dashboard can store a surface and fan a story target out into per-slide
publications. No UI yet.

### Task 6: Types and the fan-out helper

**Files:**
- Modify: `dashboard/lib/types.ts`
- Create: `dashboard/lib/story-fanout.ts`
- Create: `dashboard/lib/queries.stories.test.ts`

**Interfaces:**
- Produces: `type Surface = "feed" | "story"`; `interface PostTarget { channel_id: number;
  surface: Surface }`; `storySlideAssetIds(db, postId): number[]`. Tasks 7 and 8 use these
  exact names.

- [ ] **Step 1: Add the types**

In `dashboard/lib/types.ts`, below `PostType`:

```ts
// Where a send lands, as opposed to what the content IS (that's PostType, which is
// INFERRED from the assets). 'story' is an Instagram Story. Kept separate so one post can
// be a Story on Instagram and an ordinary post on Telegram — see
// docs/design-instagram-stories.md.
export type Surface = "feed" | "story";

export interface PostTarget {
  channel_id: number;
  surface: Surface;
}
```

- [ ] **Step 2: Write the failing fan-out test**

Create `dashboard/lib/queries.stories.test.ts`. The `setup` helper below follows
`queries.timezone.test.ts` exactly — `makeTestDb()`, then a dynamic `import` of `queries.ts`,
then raw inserts for assets.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `s${++setupSeq}`;

  const ig = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-ig`,
    timezone: "America/Los_Angeles",
  } as Parameters<typeof q.createChannel>[0]);
  const telegram = q.createChannel({
    platform: "telegram",
    account_name: `${prefix}-tg`,
    timezone: "America/Los_Angeles",
  } as Parameters<typeof q.createChannel>[0]);

  const assetIds = [0, 1, 2].map((n) =>
    Number(
      db
        .prepare(
          "INSERT INTO assets (content_hash, media_kind, storage_path) " +
            "VALUES (?, 'image', ?)",
        )
        .run(`${prefix}-h${n}`, `a/${prefix}-${n}.jpg`).lastInsertRowid,
    ),
  );

  const pubs = (postId: number) =>
    db
      .prepare(
        "SELECT surface, asset_id FROM publications WHERE post_id = ? ORDER BY id ASC",
      )
      .all(postId) as { surface: string; asset_id: number | null }[];

  return { q, db, ig, telegram, assetIds, pubs };
}

test("a story target fans out into one publication per slide, in slide order", async () => {
  const { q, ig, assetIds, pubs } = await setup();
  const { postId } = q.createPostWithPublications({
    caption: "hi",
    first_comment: "",
    asset_ids: assetIds,
    scheduled_at: "2026-08-10T18:00:00.000Z",
    targets: [{ channel_id: ig, surface: "story" }],
  } as Parameters<typeof q.createPostWithPublications>[0]);

  const rows = pubs(postId);
  assert.equal(rows.length, 3, "3 slides -> 3 Stories");
  assert.deepEqual(rows.map((r) => r.surface), ["story", "story", "story"]);
  assert.deepEqual(
    rows.map((r) => r.asset_id),
    assetIds,
    "slides must be created in sort_order — ascending id IS publish order",
  );
});

test("a feed target stays one publication with a null asset_id", async () => {
  const { q, ig, assetIds, pubs } = await setup();
  const { postId } = q.createPostWithPublications({
    caption: "hi",
    first_comment: "",
    asset_ids: assetIds,
    scheduled_at: "2026-08-10T18:00:00.000Z",
    targets: [{ channel_id: ig, surface: "feed" }],
  } as Parameters<typeof q.createPostWithPublications>[0]);

  const rows = pubs(postId);
  assert.equal(rows.length, 1, "a feed carousel is ONE post, not one per slide");
  assert.equal(rows[0].asset_id, null, "null means ALL assets, in order");
});

test("feed and story on one channel produce independent sends", async () => {
  const { q, ig, telegram, assetIds, pubs } = await setup();
  const { postId } = q.createPostWithPublications({
    caption: "hi",
    first_comment: "",
    asset_ids: assetIds.slice(0, 2),
    scheduled_at: "2026-08-10T18:00:00.000Z",
    targets: [
      { channel_id: ig, surface: "feed" },
      { channel_id: ig, surface: "story" },
      { channel_id: telegram, surface: "feed" },
    ],
  } as Parameters<typeof q.createPostWithPublications>[0]);

  const rows = pubs(postId);
  assert.equal(rows.filter((r) => r.surface === "feed").length, 2, "IG feed + Telegram");
  assert.equal(rows.filter((r) => r.surface === "story").length, 2, "2 slides -> 2 Stories");
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd dashboard && npm test`
Expected: FAIL.

- [ ] **Step 4: Write the fan-out helper**

Create `dashboard/lib/story-fanout.ts`:

```ts
import type Database from "better-sqlite3";

/**
 * The asset ids of a post, in slide order.
 *
 * This is the ONLY place the "one Story per slide" rule is expressed on the TypeScript
 * side. Its Python twin is worker/autofill.py's scheduling path — the two languages share
 * a database, not code, so this rule is deliberately duplicated and tested on both sides
 * (docs/design-instagram-stories.md §4).
 */
export function storySlideAssetIds(db: Database.Database, postId: number): number[] {
  return (
    db
      .prepare(
        "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order ASC",
      )
      .all(postId) as { asset_id: number }[]
  ).map((r) => r.asset_id);
}

/**
 * Expand one target into the publication rows it should produce.
 *
 * A feed target is one row covering ALL the post's assets (asset_id null). A story target
 * is one row PER slide, emitted in slide order so ascending publication id is publish
 * order — which is what worker/db.py's `ORDER BY scheduled_at, id` relies on.
 */
export function expandTarget(
  db: Database.Database,
  postId: number,
  surface: "feed" | "story",
): (number | null)[] {
  return surface === "story" ? storySlideAssetIds(db, postId) : [null];
}
```

- [ ] **Step 5: Wire it into the scheduling writes**

In `dashboard/lib/queries.ts`:

1. On `CreatePostInput`, replace `channel_ids: number[]` with `targets: PostTarget[]`.
2. At both `INSERT INTO publications` sites — `createPostWithPublications` (near line 561) and
   the bulk write (near line 1078) — add `surface` and `asset_id` to the column list, and loop
   over `expandTarget(db, postId, t.surface)` per target instead of inserting one row per
   channel.
3. Update `createPostWithPublications`' doc comment, which currently promises "one publication
   PER target channel" — now one per target, *and* one per slide for story targets.

The composer and its API route still send channel ids at this point (the picker arrives in
Phase 4), so map them to `{ channel_id, surface: "feed" }` at the route boundary. Fan-out is a
no-op for feed targets, so behaviour is unchanged until the UI lands.

- [ ] **Step 6: Run the tests**

Run: `cd dashboard && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/types.ts dashboard/lib/story-fanout.ts dashboard/lib/queries.ts dashboard/lib/queries.stories.test.ts && git commit -m "feat(dashboard): fan a story target out into one publication per slide"
```

### Task 7: Surface through `post_targets`

**Files:**
- Modify: `dashboard/lib/queries.ts` — `getPostTargets`, `setPostTargets`,
  `insertContentModelRows`, `bulkAddTargets`, `bulkRemoveTargets`, and the merge-targets copy
  near line 893
- Modify: `dashboard/app/api/posts/[id]/content/route.ts`,
  `dashboard/app/library/[id]/page.tsx`
- Test: `dashboard/lib/queries.stories.test.ts`

**Interfaces:**
- Consumes: `PostTarget` from Task 6.
- Produces: `getPostTargets(postId): PostTarget[]` — **a shape change from `number[]`**, so
  every caller must be updated in this task.

- [ ] **Step 1: Write the failing round-trip test**

Append to `dashboard/lib/queries.stories.test.ts`, reusing the `setup()` helper from Task 6
(`const { q, ig, telegram, assetIds } = await setup();`, then
`const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: assetIds });`):

```ts
test("targets round-trip with their surface", async () => {
  q.setPostTargets(postId, [
    { channel_id: ig, surface: "story" },
    { channel_id: ig, surface: "feed" },
    { channel_id: telegram, surface: "feed" },
  ]);
  assert.deepEqual(q.getPostTargets(postId), [
    { channel_id: ig, surface: "feed" },
    { channel_id: ig, surface: "story" },
    { channel_id: telegram, surface: "feed" },
  ]);
});

test("removing one surface leaves the other in place", async () => {
  q.setPostTargets(postId, [
    { channel_id: ig, surface: "feed" },
    { channel_id: ig, surface: "story" },
  ]);
  q.setPostTargets(postId, [{ channel_id: ig, surface: "story" }]);
  assert.deepEqual(q.getPostTargets(postId), [{ channel_id: ig, surface: "story" }]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd dashboard && npm test`
Expected: FAIL — `getPostTargets` returns numbers.

- [ ] **Step 3: Update the query functions**

```ts
export function getPostTargets(postId: number): PostTarget[] {
  return getDb()
    .prepare(
      "SELECT channel_id, surface FROM post_targets WHERE post_id = ? " +
        "ORDER BY channel_id ASC, surface ASC",
    )
    .all(postId) as PostTarget[];
}

/** Replace a post's target set atomically (delete-all then insert — the "all" snapshot). */
export function setPostTargets(postId: number, targets: PostTarget[]): void {
  const db = getDb();
  const tx = db.transaction((rows: PostTarget[]) => {
    db.prepare("DELETE FROM post_targets WHERE post_id = ?").run(postId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO post_targets (post_id, channel_id, surface) VALUES (?, ?, ?)",
    );
    for (const t of rows) insert.run(postId, t.channel_id, t.surface);
  });
  tx(targets);
}
```

Apply the same treatment to `insertContentModelRows` (its `target_channel_ids` input becomes
`targets: PostTarget[]`), `bulkAddTargets`, `bulkRemoveTargets`, and the merge copy near line
893 — which must carry `surface` across or it silently converts stories to feed posts.

- [ ] **Step 4: Update the callers**

`dashboard/app/api/posts/[id]/content/route.ts` (lines 206 and 222) and
`dashboard/app/library/[id]/page.tsx:46`. Run `npx tsc --noEmit` to find any missed.

- [ ] **Step 5: Run everything**

Run: `cd dashboard && npx tsc --noEmit && npm test`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/ && git commit -m "feat(dashboard): carry surface through post targets"
```

---

## Phase 4 — Dashboard UI

**Deliverable:** you can tick Feed and/or Story per Instagram channel, and the queue reads
sensibly.

### Task 8: The channel + surface picker

**Files:**
- Create: `dashboard/components/channel-surface-picker.tsx`
- Modify: `dashboard/components/composer.tsx`
- Test: `dashboard/test-ui/channel-surface-picker-ui.test.ts`

**Interfaces:**
- Consumes: `PostTarget`, `Surface` from Task 6.
- Produces: `<ChannelSurfacePicker channels value onChange hasVideo textOnly slideCount />`
  where `value: PostTarget[]`.

- [ ] **Step 1: Write the failing UI test**

Model it on `dashboard/test-ui/bulk-edit-context-ui.test.ts`. Assert:
- a Telegram row renders **one** control, with no surface chips (non-IG channels are visually
  unchanged);
- an Instagram row renders **two** chips, `Feed` and `Story`;
- ticking `Story` alone yields `[{channel_id, surface: "story"}]`;
- with `textOnly`, the `Story` chip is **absent** (a story has nothing to show);
- with `slideCount = 4` and `Story` ticked, the note `4 slides → 4 Stories` is shown.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd dashboard && npm test`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Build the picker**

New component. Non-Instagram channels keep exactly today's single-checkbox row. Instagram rows
render `Feed` and `Story` chips. Guards, each **stating its reason** rather than silently
disappearing:

| Condition | Behaviour |
|---|---|
| `textOnly` | `Story` chip hidden — nothing to show. |
| video longer than IG's story cap | `Story` chip disabled, with the reason in a title/aria-label. |
| `slideCount > 1` and `Story` ticked | Note: `{n} slides → {n} Stories`. |

Reuse `channelColor` from `lib/format` and match the chip/toggle styling already used by
`checkbox-filter-dropdown.tsx` and `channel-toggles.tsx` — there is no `design.md` in this
repo, so the existing components are the style reference.

**Before writing the length guard, verify Instagram's current story video cap against live
Meta docs** and record the number and verification date in `reference.md`. Do not take it from
memory — `reference.md` carries a standing rule that the Stories adapter gets the same
live-docs verification the image/carousel path got.

- [ ] **Step 4: Adopt it in all three places that pick channels**

The picker is shared, so all three inherit it from this one component:

1. `dashboard/components/composer.tsx` — replace the `Set<number>` selection state with
   `PostTarget[]` and send `targets` instead of `channel_ids` in both submit paths (lines ~279
   and ~311). Keep the existing text-only and video compatibility filtering; it now filters
   targets rather than ids.
2. `dashboard/components/schedule-from-library.tsx`.
3. `dashboard/components/quick-edit-modal.tsx`.

Then remove the temporary `channel_ids → feed` mapping added at the route boundary in Task 6,
Step 5 — the UI now sends real targets.

- [ ] **Step 5: Run everything**

Run: `cd dashboard && npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 6: Browser-verify**

Start the dev server on port 3939. Confirm: a Telegram row looks unchanged; an IG row shows
both chips; ticking IG `Story` + Telegram and scheduling a 3-slide post creates 1 Telegram
publication and 3 IG story publications. Check the DB directly:

```bash
sqlite3 data/socialscheduler.db "SELECT id, channel_id, surface, asset_id FROM publications ORDER BY id DESC LIMIT 5;"
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/ && git commit -m "feat(dashboard): pick Feed and/or Story per Instagram channel"
```

### Task 9: Group story slides in the queue

**Files:**
- Modify: `dashboard/components/publication-queue.tsx`

- [ ] **Step 1: Group sibling rows**

Rows sharing `(post_id, channel_id, surface='story', scheduled_at)` render under one heading
showing `Story — 3 slides`, with each slide listed as `Story 1 of 3` and its own status. Add a
group-level **Cancel all** that calls the existing per-publication cancel for each row — the
individual rows stay authoritative; the grouping is presentation only.

- [ ] **Step 2: Browser-verify**

Confirm a 3-slide story shows as one group of three, that cancelling one slide leaves the
others scheduled, and that **Cancel all** cancels the group.

- [ ] **Step 3: Commit**

```bash
git add dashboard/components/publication-queue.tsx && git commit -m "feat(dashboard): group story slides in the queue"
```

---

## Phase 5 — Metrics

### Task 10: Story insights and the 24-hour cutoff

**Files:**
- Modify: `worker/metrics.py`
- Test: `worker/tests/test_metrics.py`

- [ ] **Step 1: Verify the metric names against live docs**

**Do this first.** Fetch Meta's current IG media-insights reference for story media and record
the exact supported metric names and the verification date in `reference.md`. Stories do not
support the feed metric set, and guessing produces silent empty rows plus recurring errors.

- [ ] **Step 2: Write the failing tests**

```python
def test_story_publications_request_story_metrics(conn, config, fake_graph,
                                                  make_publication):
    """The feed metric set is rejected for stories — asking for it yields empty rows
    and recurring API errors."""
    from worker.metrics import run_metrics

    pub = make_publication(post_type="single", surface="story")
    conn.execute(
        "UPDATE publications SET status='posted', remote_post_id='M1', "
        "published_at=? WHERE id=?",
        ("2026-08-01T18:00:00+00:00", pub["id"]),
    )
    conn.commit()
    run_metrics(conn, config, fake_graph,
                now=datetime(2026, 8, 1, 20, tzinfo=timezone.utc))
    requested = fake_graph.calls[-1]["params"]["metric"]
    assert "saved" not in requested, "saves is a feed metric, not a story metric"


def test_a_story_older_than_24h_is_not_refreshed(conn, config, make_publication):
    """The story no longer exists; refreshing only produces errors."""
    from worker.metrics import publications_needing_metrics

    pub = make_publication(post_type="single", surface="story")
    conn.execute(
        "UPDATE publications SET status='posted', remote_post_id='M1', "
        "published_at=? WHERE id=?",
        ("2026-08-01T00:00:00+00:00", pub["id"]),
    )
    conn.commit()
    got = publications_needing_metrics(
        conn, now=datetime(2026, 8, 3, tzinfo=timezone.utc),
        max_age_days=30, min_interval_hours=6,
    )
    assert pub["id"] not in [r["id"] for r in got]


def test_a_manual_refresh_still_selects_an_expired_story_once(conn, config,
                                                              make_publication):
    """Excluding it outright would leave metrics_refresh_requested_at set forever,
    because run_metrics' finally block never gets to clear it."""
    from worker.metrics import publications_needing_metrics

    pub = make_publication(post_type="single", surface="story")
    conn.execute(
        "UPDATE publications SET status='posted', remote_post_id='M1', "
        "published_at=?, metrics_refresh_requested_at=? WHERE id=?",
        ("2026-08-01T00:00:00+00:00", "2026-08-03T00:00:00+00:00", pub["id"]),
    )
    conn.commit()
    got = publications_needing_metrics(
        conn, now=datetime(2026, 8, 3, tzinfo=timezone.utc),
        max_age_days=30, min_interval_hours=6,
    )
    assert pub["id"] in [r["id"] for r in got]
```

- [ ] **Step 3: Implement**

Add the verified story metric list beside `REQUESTED_METRICS`:

```python
# Stories report a DIFFERENT metric set from feed media, and expire after 24 hours.
# Names verified against live Meta docs on <verification date> — see reference.md.
REQUESTED_STORY_METRICS = [<the names Step 1 verified>]
```

This is the **one** deliberately unfilled value in this plan. It is not an oversight: Meta
retires and renames insight metrics, and writing a plausible list here is exactly how empty
metric rows and recurring API errors get shipped. Step 1 is the gate that fills it.

`_fetch_instagram` selects by surface. In `publications_needing_metrics`, put the cutoff in the
**automatic** branch only, beside the platform exclusion:

```sql
              -- A story is gone 24h after publishing, so automatic refresh stops there.
              -- This clause is INSIDE the automatic branch on purpose: a manual refresh
              -- must still select the row once, or run_metrics' finally block never
              -- clears metrics_refresh_requested_at and the flag sticks forever.
              AND (pub.surface != 'story' OR pub.published_at >= ?)
```

Leave `COLUMN_MAP` alone: `replies` already maps to `comments` (added for Threads) and stays
that way; taps and exits have no column and live in `raw_json`.

- [ ] **Step 4: Run the suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/metrics.py worker/tests/test_metrics.py reference.md && git commit -m "feat(worker): fetch story insights and stop refreshing after 24h"
```

---

## Phase 6 — Live verification

### Task 11: Dry run, then one real Story

**Files:**
- Modify: `docs/tasks.md`, `reference.md`

- [ ] **Step 1: Migrate the real database**

Back up first, then migrate:

```bash
sqlite3 data/socialscheduler.db ".backup 'data/socialscheduler.db.bak-pre-0014'" && .venv/bin/python migrate.py
```

- [ ] **Step 2: Restart the worker**

Stop and restart via `Stop-SocialScheduler-Mac.command` / `Start-SocialScheduler-Mac.command`.
A live heartbeat only proves the daemon is running, **not** that it is running current code.

- [ ] **Step 3: Dry run**

Set `DRY_RUN=1` in `.env`, restart the worker, and schedule a 3-slide post targeting IG
`Story` + Telegram. Confirm in the log: **three** story sends with no caption and the
**original** (not `publish_path`) asset URLs, plus **one** Telegram send that *does* carry the
caption.

- [ ] **Step 4: One real Story**

Set `DRY_RUN=0`, restart the worker, and publish a single-image Story to the personal
Instagram account. Then read it back from the API and confirm `media_product_type` is `STORY`
— a genuine Story, not a feed post — the same way the first real Reel was verified.

- [ ] **Step 5: Confirm failure isolation**

Schedule a 2-slide Story where the second asset's file is missing. Confirm slide 1 posts,
slide 2 lands in a visible `failed` with a readable `last_error`, and slide 1 is untouched.

- [ ] **Step 6: Update the docs**

In `docs/tasks.md`, mark Stories done under Phase 6 and record the deferred follow-ups from the
spec's §8: the 9:16 story canvas, auto-fill story recycling, and Facebook Page Stories. In
`reference.md`, add a verified-Stories section recording the media id, `media_product_type`,
and the date, matching the existing Reels entry.

- [ ] **Step 7: Commit**

```bash
git add docs/tasks.md reference.md && git commit -m "docs: record Instagram Stories verified live"
```

---

## Risks

| Risk | Mitigation |
|---|---|
| A rebuild of `post_targets` with foreign keys on would cascade-delete rows. | `PRAGMA foreign_keys = OFF` around the rebuild, plus a test that cascade still works afterwards (Task 1, Step 1). |
| `getPostTargets` changes shape and a caller is missed. | `npx tsc --noEmit` in Task 7, Step 5. |
| Story metric names guessed rather than verified. | Task 10, Step 1 is an explicit live-docs verification gate before any code. |
| A 10-slide Story burns 10 publishes of the account's quota. | The existing runtime `content_publishing_limit` gate applies unchanged; the composer states the slide count up front. |
| Fan-out logic drifts between TypeScript and Python. | Tested on both sides; the TS rule lives in one file (`story-fanout.ts`) with a comment naming its Python twin. |
