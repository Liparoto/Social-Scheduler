# Story Canvas & Framing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a non-9:16 photo a deliberate Instagram Story frame, and make every framing
choice previewable at a usable size and changeable forever.

**Architecture:** `assets` gains a second derivative pair — `story_path` + `story_mode`
(`blurred` | `crop`) — alongside the existing feed pair, so the two surfaces stop competing for
one `publish_path`. Canvases render through a pure `sharp` module, are generated lazily via the
media route's existing `variant` dispatch, and cache on disk under `story/`. A per-image Framing
dialog shows both surfaces side by side and never stops offering the controls.

**Tech Stack:** Next.js App Router + TypeScript · `sharp` 0.35 · SQLite (`better-sqlite3`) ·
`node --test` · Python worker (reads the file; no worker query change needed).

**Spec:** `docs/design-story-canvas-and-framing.md` (approved 2026-08-04). Read it first — this
plan implements it and does not restate its reasoning.

## Global Constraints

- **Schema lives in `/migrations` as `.sql`** — never inline in TypeScript or Python.
- **`migrate.py` has no argument parser.** Test migrations against a **scratch copy** made with
  `sqlite3 .backup` (NOT `cp` — the DB is WAL and may be open), never against `/data`.
- **A story canvas is exactly 1080×1920** and must reach Instagram unmodified. **Never run
  `conformImage()` on one** — that pipeline forces images into the feed's 4:5–1.91:1 range and
  would destroy the canvas.
- **A source within ±2% of 0.5625 gets NO canvas.** `story_path` stays NULL and the untouched
  original is published, exactly as today.
- **Framing is never one-way.** No code path may hide or disable the framing controls because a
  choice was already made — that is the bug being fixed.
- **Changing framing never alters already-published media.** It affects future sends only.
- **This install publishes for real (`DRY_RUN=0`)** and the worker may be running. Anything that
  could publish is verified in dry-run first.
- Commit after each task. Run the full suite, not just the new test, before each commit.

**Test commands** (from the repo root):

```bash
cd dashboard && npm test
```

```bash
.venv/bin/python -m pytest worker/tests -q
```

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `dashboard/lib/story-canvas.ts` | **Create.** Pure: does this need a canvas, render it, what does cropping cost. | 1 |
| `dashboard/lib/story-canvas.test.ts` | **Create.** Dimensions, both modes, the tolerance band. | 1 |
| `migrations/0015_story_framing.sql` | **Create.** `story_path` + `story_mode`, additive. | 2 |
| `worker/tests/test_migration_0015.py` | **Create.** Columns, default, CHECK, existing rows untouched. | 2 |
| `dashboard/lib/queries.ts` | **Modify.** `updateAssetStoryFraming`; `Asset` gains the columns. | 3 |
| `dashboard/lib/types.ts` | **Modify.** `story_path`, `story_mode` on `Asset`. | 3 |
| `dashboard/app/api/assets/[id]/story-framing/route.ts` | **Create.** Choose a story mode; renders + persists. | 3 |
| `dashboard/app/api/media/[id]/route.ts` | **Modify.** `variant=story`, `mode=` preview, disk cache. | 4 |
| `dashboard/components/framing-dialog.tsx` | **Create.** Both surfaces, large previews, always open. | 5 |
| `dashboard/components/conform-control.tsx` | **Modify.** Delete the one-way early return; open the dialog. | 5 |
| `worker/publisher.py` | **Modify.** `story_path` joins the story precedence. | 6 |
| `worker/tests/test_stories_publisher.py` | **Modify.** Story prefers `story_path`. | 6 |
| `dashboard/components/channel-surface-picker.tsx` | **Modify.** "will be reframed to 9:16" note. | 7 |

---

## Phase 1 — The canvas itself

### Task 1: `lib/story-canvas.ts`

**Files:**
- Create: `dashboard/lib/story-canvas.ts`
- Test: `dashboard/lib/story-canvas.test.ts`

**Interfaces:**
- Produces, relied on by Tasks 3, 4, 5:
  - `STORY_WIDTH = 1080`, `STORY_HEIGHT = 1920`
  - `type StoryMode = "blurred" | "crop"`
  - `needsStoryCanvas(width: number, height: number): boolean`
  - `renderStoryCanvas(input: Buffer, mode: StoryMode): Promise<Buffer>`
  - `cropLossFraction(width: number, height: number): number` — 0…1, how much of the source
    area is discarded by crop-to-fill.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/lib/story-canvas.test.ts`. Fixtures are generated with `sharp` rather than
committed as binaries — the test needs specific aspect ratios, not specific pictures.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  STORY_WIDTH,
  STORY_HEIGHT,
  needsStoryCanvas,
  renderStoryCanvas,
  cropLossFraction,
} from "./story-canvas.ts";

/** A solid-colour JPEG of the given size — enough to assert geometry. */
async function image(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

// ---- needsStoryCanvas: the tolerance band --------------------------------------
test("a source already at 9:16 needs no canvas", () => {
  assert.equal(needsStoryCanvas(1080, 1920), false);
});

test("a real vertical phone photo just off 9:16 needs no canvas", () => {
  // Asset 173 from the first real Story: 0.5627 vs 0.5625.
  assert.equal(needsStoryCanvas(1320, 2346), false);
});

test("landscape and square sources need a canvas", () => {
  assert.equal(needsStoryCanvas(4032, 3024), true, "landscape");
  assert.equal(needsStoryCanvas(1080, 1080), true, "square");
  assert.equal(needsStoryCanvas(1080, 1350), true, "4:5 portrait is still not 9:16");
});

test("the tolerance band is ±2%, not a free-for-all", () => {
  const tall = Math.round(1920 * (9 / 16) * 0.97); // 3% narrow — outside
  assert.equal(needsStoryCanvas(tall, 1920), true);
  const inside = Math.round(1920 * (9 / 16) * 0.99); // 1% narrow — inside
  assert.equal(needsStoryCanvas(inside, 1920), false);
});

// ---- renderStoryCanvas: geometry ------------------------------------------------
test("blurred fill outputs exactly 1080x1920", async () => {
  const out = await renderStoryCanvas(await image(4032, 3024), "blurred");
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
});

test("crop to fill outputs exactly 1080x1920", async () => {
  const out = await renderStoryCanvas(await image(4032, 3024), "crop");
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
});

test("blurred fill keeps the whole photo — the band is letterboxed, not cropped", async () => {
  // A 4032x3024 (4:3) source fitted inside 1080x1920 is width-limited: 1080x810.
  // The canvas is taller, so bars must exist above and below.
  const out = await renderStoryCanvas(await image(4032, 3024), "blurred");
  const meta = await sharp(out).metadata();
  assert.equal(meta.height, STORY_HEIGHT);
  const bandHeight = Math.round(STORY_WIDTH * (3024 / 4032));
  assert.ok(bandHeight < STORY_HEIGHT, "a 4:3 source cannot fill a 9:16 canvas");
});

test("a portrait source taller than 9:16 is still fitted, not stretched", async () => {
  const out = await renderStoryCanvas(await image(1000, 3000), "blurred");
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
});

// ---- cropLossFraction: the honest cost ------------------------------------------
test("cropping a 4:3 landscape to 9:16 loses most of the width", () => {
  // Cover 1080x1920 from 4032x3024: scale to height -> 2560x1920, keep 1080 wide.
  // 1080/2560 = 0.42 kept, so ~0.58 lost.
  const lost = cropLossFraction(4032, 3024);
  assert.ok(lost > 0.55 && lost < 0.61, `expected ~0.58, got ${lost}`);
});

test("a source already at 9:16 loses nothing to cropping", () => {
  assert.ok(cropLossFraction(1080, 1920) < 0.001);
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test "lib/story-canvas.test.ts"`
Expected: FAIL — cannot resolve `./story-canvas.ts`.

- [ ] **Step 3: Implement the module**

Create `dashboard/lib/story-canvas.ts`:

```ts
import sharp from "sharp";

// Instagram Stories are 9:16. These are the canvas dimensions we produce; the result must
// reach Instagram unmodified — NEVER run conformImage() on it, that pipeline forces images
// into the FEED's 4:5..1.91:1 range and would undo the canvas entirely.
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;
export const STORY_RATIO = STORY_WIDTH / STORY_HEIGHT; // 0.5625

// A source this close to 9:16 is already the right shape: a canvas would add nothing and
// cost a re-encode, so we publish the untouched original instead. 2% is wide enough to
// cover real phone photos (a 1320x2346 shot is 0.5627) and narrow enough that anything
// Instagram would visibly letterbox still gets a deliberate frame.
export const STORY_RATIO_TOLERANCE = 0.02;

export type StoryMode = "blurred" | "crop";

/** True when the source is NOT already story-shaped and deserves a canvas. */
export function needsStoryCanvas(width: number, height: number): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return Math.abs(ratio - STORY_RATIO) > STORY_RATIO * STORY_RATIO_TOLERANCE;
}

/**
 * How much of the source is thrown away by crop-to-fill, as a fraction of its area.
 *
 * Drives the dialog's honest label ("loses 58% of the width") — a generic "some cropping
 * may occur" is exactly the vagueness that made the old 40px preview useless.
 */
export function cropLossFraction(width: number, height: number): number {
  if (!width || !height) return 0;
  const ratio = width / height;
  // Cover scales by whichever axis is short, then crops the other.
  const kept = ratio > STORY_RATIO ? STORY_RATIO / ratio : ratio / STORY_RATIO;
  return Math.max(0, 1 - kept);
}

/**
 * Render a 1080x1920 story canvas.
 *
 *  * blurred — the photo is fitted whole, and an enlarged, blurred, slightly darkened copy
 *    of the SAME photo fills the space behind it. Nothing is lost.
 *  * crop    — scaled to cover and cropped. sharp's `attention` strategy picks the region,
 *    which is a guess; cropLossFraction() is how the owner is told what it costs.
 */
export async function renderStoryCanvas(input: Buffer, mode: StoryMode): Promise<Buffer> {
  // Honor EXIF rotation and normalize colour before measuring or compositing — same
  // reasoning as conform.ts: sharp's metadata() reflects what has been EXECUTED, so the
  // rotation must be materialized into a buffer first or a portrait phone photo reports
  // swapped dimensions.
  const base = await sharp(input).rotate().toColourspace("srgb").toBuffer();

  if (mode === "crop") {
    return sharp(base)
      .resize({ width: STORY_WIDTH, height: STORY_HEIGHT, fit: "cover", position: "attention" })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
  }

  const fitted = await sharp(base)
    .resize({ width: STORY_WIDTH, height: STORY_HEIGHT, fit: "inside" })
    .toBuffer();
  const background = await sharp(base)
    .resize({ width: STORY_WIDTH, height: STORY_HEIGHT, fit: "cover" })
    .blur(40)
    .modulate({ brightness: 0.8 })
    .toBuffer();

  return sharp(background)
    .composite([{ input: fitted, gravity: "centre" }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
```

- [ ] **Step 4: Run the tests**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test "lib/story-canvas.test.ts"`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the whole dashboard suite**

Run: `cd dashboard && npm test`
Expected: PASS. Nothing else touches this module yet.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/story-canvas.ts dashboard/lib/story-canvas.test.ts && git commit -m "feat(dashboard): render a 9:16 story canvas"
```

---

## Phase 2 — Schema

### Task 2: Migration `0015_story_framing.sql`

**Files:**
- Create: `migrations/0015_story_framing.sql`
- Test: `worker/tests/test_migration_0015.py`

**Interfaces:**
- Produces: `assets.story_path`, `assets.story_mode`. Tasks 3–6 depend on these names.

- [ ] **Step 1: Write the failing migration test**

Create `worker/tests/test_migration_0015.py`. The `conn` fixture builds a DB from **all**
migrations, so this exercises the real file.

```python
"""Migration 0015: assets gain a SECOND derivative pair, for the 9:16 story surface."""

from __future__ import annotations

import sqlite3

import pytest


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _asset(conn, content_hash="h1"):
    return conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?,'image','a.jpg')",
        (content_hash,),
    ).lastrowid


def test_assets_gain_the_story_pair(conn):
    assert "story_path" in cols(conn, "assets")
    assert "story_mode" in cols(conn, "assets")


def test_story_path_defaults_to_null_meaning_send_the_original(conn):
    aid = _asset(conn)
    conn.commit()
    row = conn.execute(
        "SELECT story_path, story_mode FROM assets WHERE id=?", (aid,)
    ).fetchone()
    assert row["story_path"] is None, "NULL means: already 9:16, publish the original"
    assert row["story_mode"] == "blurred", "blurred fill is the default treatment"


def test_story_mode_check_rejects_anything_else(conn):
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO assets (content_hash, media_kind, storage_path, story_mode) "
            "VALUES ('h2','image','b.jpg','pad')"
        )


def test_both_story_modes_are_accepted(conn):
    for i, mode in enumerate(("blurred", "crop")):
        conn.execute(
            "INSERT INTO assets (content_hash, media_kind, storage_path, story_mode) "
            "VALUES (?,'image','c.jpg',?)",
            (f"hm{i}", mode),
        )
    conn.commit()
    assert conn.execute(
        "SELECT COUNT(*) FROM assets WHERE story_mode IN ('blurred','crop')"
    ).fetchone()[0] == 2


def test_the_feed_pair_is_untouched(conn):
    """The whole point is that the two surfaces stop sharing one derivative."""
    for c in ("publish_path", "conform_mode", "needs_review"):
        assert c in cols(conn, "assets"), f"{c} must survive"
```

- [ ] **Step 2: Run and confirm it fails**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0015.py -q`
Expected: FAIL — `no such column: story_path`.

- [ ] **Step 3: Write the migration**

Create `migrations/0015_story_framing.sql`:

```sql
-- 0015_story_framing.sql
-- A SECOND derivative pair on assets, for the 9:16 story surface.
--
-- Until now an asset had exactly one derivative (publish_path/conform_mode), shaped for the
-- FEED's 4:5..1.91:1 range. A Story is 9:16 — outside that range — so one derivative cannot
-- serve both surfaces, which is why the story publish path sends the untouched original.
-- That is correct for an already-9:16 source and wrong for a landscape one, where Instagram
-- applies its own fit and the owner has no say.
--
-- story_path NULL means "this source is already story-shaped, publish the original" — the
-- behaviour the first real Story shipped with, deliberately preserved. A canvas is only
-- generated when the source genuinely doesn't fit (see lib/story-canvas.ts's tolerance).
--
-- Additive: no rebuild. Mirrors the existing publish_path/conform_mode pair rather than
-- introducing an asset_derivatives table — a table would generalise to a future Facebook
-- Page Story, but that adapter doesn't exist and this is the shape the codebase already uses.
ALTER TABLE assets ADD COLUMN story_path TEXT;
ALTER TABLE assets ADD COLUMN story_mode TEXT NOT NULL DEFAULT 'blurred'
                                          CHECK (story_mode IN ('blurred', 'crop'));
```

- [ ] **Step 4: Run the test**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0015.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the whole worker suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS — additive columns break nothing.

- [ ] **Step 6: Dry-run against a scratch copy of the live DB**

`.backup`, not `cp` — the DB is WAL and may be open:

```bash
sqlite3 data/socialscheduler.db ".backup '/tmp/scratch15.db'" && DATABASE_PATH=/tmp/scratch15.db .venv/bin/python migrate.py && sqlite3 /tmp/scratch15.db "PRAGMA integrity_check; PRAGMA foreign_key_check; SELECT story_mode, COUNT(*) FROM assets GROUP BY story_mode;"
```

Expected: `ok`, no FK violations, every existing asset reporting `blurred` with a NULL
`story_path`.

- [ ] **Step 7: Commit**

```bash
git add migrations/0015_story_framing.sql worker/tests/test_migration_0015.py && git commit -m "feat(db): add the story derivative pair to assets"
```

---

## Phase 3 — Persisting a choice

### Task 3: Types, query, and the story-framing route

**Files:**
- Modify: `dashboard/lib/types.ts`, `dashboard/lib/queries.ts`
- Create: `dashboard/app/api/assets/[id]/story-framing/route.ts`
- Test: `dashboard/test/story-framing-route.test.ts`

**Interfaces:**
- Consumes: `needsStoryCanvas`, `renderStoryCanvas`, `StoryMode` (Task 1);
  `assets.story_path` / `story_mode` (Task 2).
- Produces: `updateAssetStoryFraming(assetId: number, fields: { story_path: string | null;
  story_mode: StoryMode }): void`, and `POST /api/assets/[id]/story-framing` taking
  `{ mode: "blurred" | "crop" }`.

- [ ] **Step 1: Add the columns to the `Asset` type**

In `dashboard/lib/types.ts`, inside `interface Asset`, after `needs_review`:

```ts
  /** The 9:16 story derivative. NULL means the source is already story-shaped —
   *  publish the untouched original (see migration 0015). */
  story_path: string | null;
  story_mode: "blurred" | "crop";
```

- [ ] **Step 2: Write the failing route test**

Create `dashboard/test/story-framing-route.test.ts`, modelled on
`test/schedule-route-surface.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { config } = await import("../lib/config.ts");
const { POST } = await import("../app/api/assets/[id]/story-framing/route.ts");

let seq = 0;

/** A real landscape JPEG on disk, so the route has something to actually render. */
async function landscapeAsset(): Promise<number> {
  const name = `sf${++seq}.jpg`;
  const abs = path.join(config.assetStorageDir, name);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: { r: 10, g: 90, b: 160 } },
    })
      .jpeg()
      .toBuffer(),
  );
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) " +
          "VALUES (?, 'image', ?, 1600, 1200)",
      )
      .run(`sfhash${seq}`, name).lastInsertRowid,
  );
}

async function choose(assetId: number, body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3939/api/assets/${assetId}/story-framing`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: String(assetId) }) },
  );
}

test("choosing blurred writes a 1080x1920 derivative and records the mode", async () => {
  const id = await landscapeAsset();
  const res = await choose(id, { mode: "blurred" });
  assert.equal(res.status, 200);

  const asset = q.getAsset(id)!;
  assert.equal(asset.story_mode, "blurred");
  assert.ok(asset.story_path, "story_path must be set for a landscape source");
  const meta = await sharp(
    path.join(config.assetStorageDir, asset.story_path!),
  ).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
});

test("the choice is changeable — that is the whole point", async () => {
  const id = await landscapeAsset();
  await choose(id, { mode: "blurred" });
  await choose(id, { mode: "crop" });
  assert.equal(q.getAsset(id)!.story_mode, "crop");
  await choose(id, { mode: "blurred" });
  assert.equal(q.getAsset(id)!.story_mode, "blurred", "and changeable back again");
});

test("an unknown mode is rejected rather than defaulted", async () => {
  const id = await landscapeAsset();
  const res = await choose(id, { mode: "pad" });
  assert.equal(res.status, 400, "'pad' is a FEED mode, not a story mode");
});

test("a video is refused — sharp cannot decode one", async () => {
  const id = Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'video', 'v.mp4')",
      )
      .run(`sfvid${++seq}`).lastInsertRowid,
  );
  const res = await choose(id, { mode: "blurred" });
  assert.equal(res.status, 409);
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test "test/story-framing-route.test.ts"`
Expected: FAIL — the route module does not exist.

- [ ] **Step 4: Add the query helper**

In `dashboard/lib/queries.ts`, beside the existing `updateAssetConform`:

```ts
/** Persist a story framing choice. Always re-runnable — framing is never one-way. */
export function updateAssetStoryFraming(
  assetId: number,
  fields: { story_path: string | null; story_mode: "blurred" | "crop" },
): void {
  getDb()
    .prepare("UPDATE assets SET story_path = @story_path, story_mode = @story_mode WHERE id = @id")
    .run({ ...fields, id: assetId });
}
```

Also add `story_path` and `story_mode` to the column list of whichever asset SELECT/INSERT in
this file enumerates columns explicitly (search for `conform_mode` to find them).

- [ ] **Step 5: Write the route**

Create `dashboard/app/api/assets/[id]/story-framing/route.ts`:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getAsset, updateAssetStoryFraming } from "@/lib/queries";
import { needsStoryCanvas, renderStoryCanvas, type StoryMode } from "@/lib/story-canvas";

export const runtime = "nodejs";

const VALID_MODES = new Set<StoryMode>(["blurred", "crop"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const body = await req.json().catch(() => null);
  const mode = body?.mode;
  // 'pad' and 'crop-to-feed' are FEED modes; a story canvas has its own two. Reject rather
  // than default — a guessed framing is how a Story ends up looking like an accident.
  if (typeof mode !== "string" || !VALID_MODES.has(mode as StoryMode)) {
    return NextResponse.json(
      { error: "mode must be 'blurred' or 'crop'." },
      { status: 400 }
    );
  }

  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  // sharp cannot decode video. Mirrors the same guard in /api/assets/[id]/conform.
  if (asset.media_kind === "video") {
    return NextResponse.json(
      { error: "Only an image can be given a story canvas." },
      { status: 409 }
    );
  }

  // An already-9:16 source needs no canvas: NULL story_path means "publish the untouched
  // original", which is what the story publish path already does correctly.
  if (!needsStoryCanvas(asset.width ?? 0, asset.height ?? 0)) {
    updateAssetStoryFraming(asset.id, {
      story_path: null,
      story_mode: mode as StoryMode,
    });
    return NextResponse.json({ asset: getAsset(asset.id), canvas: false });
  }

  const original = await fs.readFile(
    path.join(config.assetStorageDir, asset.storage_path)
  );
  const canvas = await renderStoryCanvas(original, mode as StoryMode);

  // Mode is in the filename so switching back and forth reuses the cached render instead
  // of re-encoding — which is what makes "change your mind" cheap enough to be true.
  const rel = `story/${asset.content_hash}-${mode}.jpg`;
  const abs = path.join(config.assetStorageDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, canvas);

  updateAssetStoryFraming(asset.id, { story_path: rel, story_mode: mode as StoryMode });
  return NextResponse.json({ asset: getAsset(asset.id), canvas: true });
}
```

- [ ] **Step 6: Run the tests**

Run: `cd dashboard && npm test`
Expected: PASS, including the 4 new route tests.

- [ ] **Step 7: Typecheck and commit**

```bash
cd dashboard && npx tsc --noEmit
```

```bash
git add dashboard/lib/types.ts dashboard/lib/queries.ts "dashboard/app/api/assets/[id]/story-framing/route.ts" dashboard/test/story-framing-route.test.ts && git commit -m "feat(dashboard): choose and persist a story framing"
```

---

## Phase 4 — Previewing without committing

### Task 4: `variant=story` on the media route

**Files:**
- Modify: `dashboard/app/api/media/[id]/route.ts:38-44`

**Interfaces:**
- Consumes: `needsStoryCanvas`, `renderStoryCanvas` (Task 1); `story_path` (Task 2).
- Produces: `GET /api/media/[id]?variant=story` (the chosen framing) and
  `?variant=story&mode=blurred|crop` (a specific one, for previewing before choosing).

- [ ] **Step 1: Extend the variant dispatch**

The route currently picks `rel` from a nested ternary. A story preview must be able to render
on demand, so it cannot be part of that expression — handle it first and return early.

Insert immediately after the `variant` is read, before the existing `rel` ternary:

```ts
  // A story preview may not exist on disk yet: the dialog needs to show BOTH options before
  // one is chosen, and generating every canvas at upload time would burn CPU and disk on the
  // (many) images that are never storied. So render-on-demand, then cache.
  if (variant === "story" && asset.media_kind === "image") {
    const requested = req.nextUrl.searchParams.get("mode");
    const mode = requested === "crop" || requested === "blurred" ? requested : asset.story_mode;

    // Already story-shaped: there is no canvas, and the original is the correct answer.
    if (!needsStoryCanvas(asset.width ?? 0, asset.height ?? 0)) {
      return serveFile(asset.storage_path, req);
    }

    const rel = `story/${asset.content_hash}-${mode}.jpg`;
    const abs = path.join(config.assetStorageDir, rel);
    try {
      await fs.access(abs);
    } catch {
      const original = await fs.readFile(
        path.join(config.assetStorageDir, asset.storage_path)
      );
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, await renderStoryCanvas(original, mode));
    }
    return serveFile(rel, req);
  }
```

Extract the existing path-resolution, traversal guard, read, MIME lookup and Range handling
into `async function serveFile(rel: string, req: NextRequest)` in the same file, and have the
existing code path call it too. That keeps Range support — which the cover-frame scrubber
depends on — working identically for every variant, rather than duplicating it.

Add to the imports:

```ts
import { needsStoryCanvas, renderStoryCanvas } from "@/lib/story-canvas";
```

- [ ] **Step 2: Verify by hand against a real asset**

Start the dev server (`preview_start`, name `dashboard`), then:

```bash
curl -s -o /tmp/s-blur.jpg "http://localhost:3939/api/media/172?variant=story&mode=blurred" && curl -s -o /tmp/s-crop.jpg "http://localhost:3939/api/media/172?variant=story&mode=crop" && sips -g pixelWidth -g pixelHeight /tmp/s-blur.jpg /tmp/s-crop.jpg
```

Expected: both report **1080 × 1920**. Asset 172 is a 4032×3024 landscape.

- [ ] **Step 3: Confirm an already-9:16 asset returns the original, not a canvas**

```bash
curl -s -o /tmp/s-173.jpg "http://localhost:3939/api/media/173?variant=story" && sips -g pixelWidth -g pixelHeight /tmp/s-173.jpg
```

Expected: **1320 × 2346** — the untouched original, because it is already story-shaped.

- [ ] **Step 4: Run the suite and commit**

Run: `cd dashboard && npx tsc --noEmit && npm test`

```bash
git add "dashboard/app/api/media/[id]/route.ts" && git commit -m "feat(dashboard): serve story canvas previews on demand"
```

---

## Phase 5 — The dialog

### Task 5: `FramingDialog`, and deleting the one-way early return

**Files:**
- Create: `dashboard/components/framing-dialog.tsx`
- Modify: `dashboard/components/conform-control.tsx`
- Test: `dashboard/test-ui/framing-dialog-ui.test.ts`

**Interfaces:**
- Consumes: `cropLossFraction`, `needsStoryCanvas` (Task 1); both API routes (Tasks 3–4).
- Produces: `<FramingDialog asset={...} scheduledSendCount={number} onClose={() => void} />`.

- [ ] **Step 1: Write the failing UI test**

`renderToStaticMarkup` gives markup only — no clicks. Interaction is browser-verified in
Step 5; these tests pin structure and, critically, the regression.

Create `dashboard/test-ui/framing-dialog-ui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FramingDialog } from "../components/framing-dialog.tsx";
import type { Asset } from "../lib/types.ts";

const landscape = {
  id: 1, content_hash: "h", media_kind: "image", original_filename: null,
  storage_path: "a.jpg", public_url: null, thumbnail_path: null, mime_type: "image/jpeg",
  width: 4032, height: 3024, byte_size: 1000, publish_path: "pub/a.jpg",
  conform_mode: "crop", needs_review: 0, duration_ms: null, cover_frame_ms: null,
  has_audio: 0, created_at: "2026-08-04", story_path: null, story_mode: "blurred",
} as Asset;

const vertical = { ...landscape, width: 1320, height: 2346 } as Asset;

function render(asset: Asset, scheduledSendCount = 0) {
  return renderToStaticMarkup(
    React.createElement(FramingDialog, { asset, scheduledSendCount, onClose: () => {} }),
  );
}

test("both surfaces are offered, with all four options", () => {
  const html = render(landscape);
  assert.match(html, />Feed</);
  assert.match(html, />Story</);
  assert.match(html, />Crop</);
  assert.match(html, />Pad</);
  assert.match(html, />Blurred fill</);
  assert.match(html, />Crop to fill</);
});

test("the cost of cropping is stated from the REAL dimensions", () => {
  // 4032x3024 cropped to 9:16 loses ~58%. A generic warning is what made the old
  // 40px preview useless.
  assert.match(render(landscape), /58% of the width/);
});

test("an already-9:16 source says no canvas is needed, and offers no story options", () => {
  const html = render(vertical);
  assert.match(html, /already 9:16/i);
  assert.doesNotMatch(html, />Blurred fill</, "nothing to choose when the source fits");
});

test("scheduled sends are named as a consequence of changing framing", () => {
  assert.match(render(landscape, 2), /2 scheduled sends will use the new framing/);
});

test("no scheduled sends means no warning", () => {
  assert.doesNotMatch(render(landscape, 0), /will use the new framing/);
});

// ---- The regression this whole project exists to prevent -------------------------
test("the controls are present even when a choice has already been made", () => {
  const chosen = { ...landscape, needs_review: 0, story_path: "story/h-crop.jpg",
                   story_mode: "crop" } as Asset;
  const html = render(chosen);
  assert.match(html, />Blurred fill</, "framing must never become one-way");
  assert.match(html, />Crop to fill</);
  assert.match(html, />Crop</);
  assert.match(html, />Pad</);
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd dashboard && node --import ./test/ui-hook.mjs --test "test-ui/framing-dialog-ui.test.ts"`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Build the dialog**

Create `dashboard/components/framing-dialog.tsx`. The load-bearing parts, in full — the two
things that must not be got wrong are the preview sizing and the absence of any branch that
hides the controls:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cropLossFraction, needsStoryCanvas } from "@/lib/story-canvas";
import type { Asset } from "@/lib/types";

/** Big enough to judge. The old control was 40x40 with object-cover, which rendered two
 *  different options identically — that is the bug this whole dialog exists to fix. */
const FEED_PREVIEW = "h-[200px] w-[200px]";
const STORY_PREVIEW = "h-[284px] w-[160px]";

/** object-CONTAIN, never object-cover: padding and bars must be visible AS padding and
 *  bars. object-cover crops them away, which is exactly how Crop and Pad came to look the
 *  same. The backdrop makes letterboxing legible against the page. */
const PREVIEW_IMG = "h-full w-full object-contain bg-surface-sunken rounded border border-border";

export function FramingDialog({
  asset,
  scheduledSendCount,
  onClose,
}: {
  asset: Asset;
  /** Scheduled-but-unsent publications using this asset — a real consequence of changing
   *  framing, so it is stated rather than discovered. */
  scheduledSendCount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [feedMode, setFeedMode] = useState(asset.conform_mode);
  const [storyMode, setStoryMode] = useState(asset.story_mode);
  const [bust, setBust] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const w = asset.width ?? 0;
  const h = asset.height ?? 0;
  const storyNeedsCanvas = needsStoryCanvas(w, h);
  const cropLoss = Math.round(cropLossFraction(w, h) * 100);

  async function choose(url: string, body: object, apply: () => void) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? "Could not update framing.");
        return;
      }
      apply();
      setBust((b) => b + 1); // cache-bust the previews
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
         role="dialog" aria-modal="true" aria-label="Framing">
      <div className="max-h-full w-full max-w-3xl overflow-auto rounded-card border border-border bg-surface p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-ink">Framing</h2>
            <p className="data text-[11px] text-faint">
              Source {w} × {h}
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-muted hover:text-ink">Close</button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {/* ---- Feed ------------------------------------------------------------- */}
          <section>
            <h3 className="mb-1 text-xs font-medium text-ink">Feed</h3>
            <p className="mb-2 text-[11px] text-muted">4:5 to 1.91:1</p>
            <div className={FEED_PREVIEW}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/media/${asset.id}?variant=publish&v=${bust}`}
                   alt="Feed framing preview" className={PREVIEW_IMG} />
            </div>
            <div className="mt-2 flex gap-1">
              {(["crop", "pad"] as const).map((m) => (
                <button key={m} disabled={busy} aria-pressed={feedMode === m}
                  onClick={() => choose(`/api/assets/${asset.id}/conform`, { mode: m },
                                        () => setFeedMode(m))}
                  className="rounded-md border border-border px-2 py-1 text-xs capitalize">
                  {m === "crop" ? "Crop" : "Pad"}
                </button>
              ))}
            </div>
          </section>

          {/* ---- Story ------------------------------------------------------------ */}
          <section>
            <h3 className="mb-1 text-xs font-medium text-ink">Story</h3>
            <p className="mb-2 text-[11px] text-muted">9:16</p>
            {!storyNeedsCanvas ? (
              <p className="rounded-lg border border-dashed border-border-strong px-3 py-6 text-center text-xs text-muted">
                Already 9:16 — the original is published untouched, with nothing to choose.
              </p>
            ) : (
              <>
                <div className={STORY_PREVIEW}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${asset.id}?variant=story&mode=${storyMode}&v=${bust}`}
                       alt="Story framing preview" className={PREVIEW_IMG} />
                </div>
                <div className="mt-2 flex gap-1">
                  <button disabled={busy} aria-pressed={storyMode === "blurred"}
                    onClick={() => choose(`/api/assets/${asset.id}/story-framing`,
                                          { mode: "blurred" }, () => setStoryMode("blurred"))}
                    className="rounded-md border border-border px-2 py-1 text-xs">
                    Blurred fill
                  </button>
                  <button disabled={busy} aria-pressed={storyMode === "crop"}
                    onClick={() => choose(`/api/assets/${asset.id}/story-framing`,
                                          { mode: "crop" }, () => setStoryMode("crop"))}
                    className="rounded-md border border-border px-2 py-1 text-xs">
                    Crop to fill
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  {storyMode === "blurred"
                    ? "Keeps the whole photo."
                    : `Fills the frame — loses ${cropLoss}% of the width.`}
                </p>
              </>
            )}
          </section>
        </div>

        {scheduledSendCount > 0 ? (
          <p className="mt-4 text-[11px] text-muted">
            {scheduledSendCount} scheduled send{scheduledSendCount === 1 ? "" : "s"} will use
            the new framing. Already-posted sends are unaffected — we can&apos;t change what is
            already on Instagram.
          </p>
        ) : null}
        {error ? <p className="mt-2 text-[11px] text-status-failed">{error}</p> : null}
      </div>
    </div>
  );
}
```

**There is deliberately no `if (chosen) return …` branch anywhere in this component.** Any
early return that swaps the controls for static text recreates the exact bug being fixed.

Remaining requirements not shown above:

- Two columns, `Feed` and `Story`. Feed offers `Crop` / `Pad` and POSTs to
  `/api/assets/[id]/conform`; Story offers `Blurred fill` / `Crop to fill` and POSTs to
  `/api/assets/[id]/story-framing`.
- Each option shows a preview via `/api/media/[id]?variant=publish` (feed) and
  `?variant=story&mode=…` (story). **Minimum 160px wide for feed, 160×284 for story** — large
  enough to tell the options apart, which is the entire point.
- Never use `object-cover` on these previews. That is the bug from
  `conform-control.tsx:85` — it crops, so it renders Crop and Pad identically. Use
  `object-contain` on a neutral backdrop so padding and bars are visible as padding and bars.
- Show the source dimensions (`4032 × 3024`) and, for the story crop option,
  `Math.round(cropLossFraction(w, h) * 100)` as `loses N% of the width`.
- When `needsStoryCanvas(...)` is false, the Story column says
  *"Already 9:16 — the original is published untouched"* and offers no options.
- When `scheduledSendCount > 0`, show
  `{n} scheduled sends will use the new framing` — and say that already-posted sends are
  unaffected.
- Selecting a mode re-fetches the preview and stays open. **No branch may hide the controls.**
- Follow `merge-modal.tsx` for focus trapping and Escape-to-close; the skeleton above covers
  layout and behaviour but not focus management.

**Where `scheduledSendCount` comes from:** add to `dashboard/lib/queries.ts`:

```ts
/** Scheduled-but-unsent publications that would use this asset's framing. Posted sends are
 *  excluded deliberately — changing framing cannot alter what is already on Instagram. */
export function countScheduledSendsForAsset(assetId: number): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM publications pub
           WHERE pub.status IN ('scheduled', 'pending_approval')
             AND (pub.asset_id = ?
                  OR (pub.asset_id IS NULL
                      AND EXISTS (SELECT 1 FROM post_assets pa
                                   WHERE pa.post_id = pub.post_id AND pa.asset_id = ?)))`,
      )
      .get(assetId, assetId) as { n: number }
  ).n;
}
```

The two-branch WHERE matters: a story publication names its slide via `asset_id`, while a feed
publication has `asset_id IS NULL` and covers every asset on the post. Counting only the first
would under-report on exactly the feed sends most likely to exist.

Server components pass it in; `conform-control.tsx` receives it as a prop rather than fetching
it client-side.

- [ ] **Step 4: Gut the one-way behaviour in `conform-control.tsx`**

Delete the early return at `conform-control.tsx:51`:

```tsx
  if (reviewed) {
    return <p className="mt-1 text-[10px] text-faint">Framing set{...}</p>;
  }
```

Replace the whole component body with a single button that opens `FramingDialog`, labelled
`Review framing` when `needs_review === 1` and `Framing` otherwise. The badge still draws
attention; it no longer gates access. The inline `Crop`/`Pad` buttons and the 40px `object-cover`
preview are removed — the dialog replaces both.

- [ ] **Step 5: Browser-verify (the tests cannot cover this)**

Start the dev server, open a post with a landscape image, then confirm:
1. The framing button opens the dialog.
2. Feed `Crop` and `Pad` previews look **different** from each other.
3. Story `Blurred fill` and `Crop to fill` previews look different, and both are 9:16.
4. Choosing one, closing, and reopening shows the choice persisted **and still changeable**.
5. On a 9:16 asset (173), the Story column says the original is used and offers nothing.

- [ ] **Step 6: Run everything and commit**

Run: `cd dashboard && npx tsc --noEmit && npm test`

```bash
git add dashboard/components/framing-dialog.tsx dashboard/components/conform-control.tsx dashboard/test-ui/framing-dialog-ui.test.ts && git commit -m "feat(dashboard): a framing dialog you can see and reopen"
```

---

## Phase 6 — Publishing the canvas

### Task 6: `story_path` joins the story precedence

**Files:**
- Modify: `worker/publisher.py` (`_resolve_url`, `_resolve_local_path`)
- Test: `worker/tests/test_stories_publisher.py`

**Interfaces:**
- Consumes: `assets.story_path` (Task 2). No worker query change — `db.get_ordered_assets`
  already selects `a.*`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_stories_publisher.py`:

```python
def test_story_prefers_the_story_canvas_over_the_original(conn, config, fake_client,
                                                          make_publication):
    """A landscape source gets a deliberate 9:16 frame instead of whatever Instagram
    would do with it."""
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           public_url=None, now=NOW)
    conn.execute(
        "UPDATE assets SET storage_path='orig.jpg', publish_path='pub/orig.jpg', "
        "story_path='story/orig-blurred.jpg'"
    )
    conn.commit()

    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert "story/orig-blurred.jpg" in out.plan["asset_urls"][0]


def test_story_falls_back_to_the_original_when_there_is_no_canvas(conn, config,
                                                                  fake_client,
                                                                  make_publication):
    """NULL story_path means the source is already 9:16 — publish it untouched. This is
    what the first real Story shipped with and must not regress."""
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           public_url=None, now=NOW)
    conn.execute(
        "UPDATE assets SET storage_path='orig.jpg', publish_path='pub/orig.jpg', "
        "story_path=NULL"
    )
    conn.commit()

    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert "orig.jpg" in out.plan["asset_urls"][0]
    assert "pub/" not in out.plan["asset_urls"][0], "the feed crop is the wrong shape"


def test_a_feed_send_never_uses_the_story_canvas(conn, config, fake_client,
                                                  make_publication):
    pub = make_publication(post_type="single", n_assets=1, public_url=None, now=NOW)
    conn.execute(
        "UPDATE assets SET storage_path='orig.jpg', publish_path='pub/orig.jpg', "
        "story_path='story/orig-blurred.jpg'"
    )
    conn.commit()

    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert "pub/orig.jpg" in out.plan["asset_urls"][0]
    assert "story/" not in out.plan["asset_urls"][0]
```

- [ ] **Step 2: Run and confirm it fails**

Run: `.venv/bin/python -m pytest worker/tests/test_stories_publisher.py -q`
Expected: FAIL — the story canvas is ignored; the original is used.

- [ ] **Step 3: Add the candidate**

In `worker/publisher.py`, `_resolve_url`, replace the relative-path selection:

```python
        # keys() guard: legacy rows / some test fixtures may not carry these columns.
        has_publish_path = "publish_path" in asset.keys() and asset["publish_path"]
        conformed = asset["publish_path"] if has_publish_path else None
        has_story_path = "story_path" in asset.keys() and asset["story_path"]
        story = asset["story_path"] if has_story_path else None
        original = asset["storage_path"]
        if surface == "story":
            # The 9:16 canvas when one was made; otherwise the untouched original (the
            # source was already story-shaped). The FEED crop is never right here.
            rel = story or original or conformed
        else:
            rel = conformed or original
```

Apply the same precedence in `_resolve_local_path`, whose story branch currently returns
`original or conformed` — it becomes `story or original or conformed`, using the same
existence-aware `_candidate()` helper already in that function.

- [ ] **Step 4: Run the worker suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/publisher.py worker/tests/test_stories_publisher.py && git commit -m "feat(worker): publish the 9:16 story canvas when one exists"
```

---

## Phase 7 — Saying so before it happens

### Task 7: The composer's reframing note

**Files:**
- Modify: `dashboard/components/channel-surface-picker.tsx`

- [ ] **Step 1: Add the note**

The picker already warns `{n} slides → {n} Stories` before scheduling. Add the same kind of
advance notice for reframing: when a Story chip is selected and any selected asset returns
`needsStoryCanvas(w, h) === true`, show:

```
Not 9:16 — will be reframed to fit a Story.
```

This needs the assets' dimensions, so the picker gains an optional
`assets?: { width: number | null; height: number | null }[]` prop, passed from the composer
(which already holds them) and omitted by callers that don't (the sends panel).

- [ ] **Step 2: Verify and commit**

Run: `cd dashboard && npx tsc --noEmit && npm test`

Browser: select a landscape image, tick `Story`, confirm the note appears; swap for a 9:16
image and confirm it disappears.

```bash
git add dashboard/components/channel-surface-picker.tsx && git commit -m "feat(dashboard): say when a photo will be reframed for a Story"
```

---

## Phase 8 — Live verification

### Task 8: One real Story from a landscape photo

**Files:**
- Modify: `reference.md`, `docs/tasks.md`

- [ ] **Step 1: Migrate the live database**

```bash
sqlite3 data/socialscheduler.db ".backup 'data/socialscheduler.db.bak-pre-0015'" && .venv/bin/python migrate.py
```

- [ ] **Step 2: Restart the worker**

A live heartbeat proves the daemon is running, **not** that it is running current code.

- [ ] **Step 3: Dry run first**

Set `DRY_RUN=1`, restart the worker, schedule a **landscape** photo to a Story. Confirm the
plan's `asset_urls` points at `story/<hash>-blurred.jpg` — not `pub/` and not the bare original.

- [ ] **Step 4: One real Story**

Set `DRY_RUN=0`, restart, publish it. Then **look at it on a phone.** Whether blurred fill
actually looks good is not something a test can answer — that judgement is the deliverable.

- [ ] **Step 5: Record it**

In `reference.md`, extend the verified-Stories section with the canvas result (dimensions sent,
which mode, how it looked). In `docs/tasks.md`, mark the 9:16 canvas done and note whether
manual crop framing is still worth building — the answer depends on how often `attention`
picked the wrong region.

- [ ] **Step 6: Commit**

```bash
git add reference.md docs/tasks.md && git commit -m "docs: record the first real story canvas"
```

---

## Risks

| Risk | Mitigation |
|---|---|
| A story canvas gets fed through `conformImage()` and is squashed back into feed range. | The canvas is written by `story-framing/route.ts` and the media route only; neither calls `conformImage`. Task 1's tests assert exact 1080×1920 output. |
| `attention` crops to the wrong region on real photos. | `cropLossFraction` states the cost, blurred fill is the default, and Task 8 Step 5 records whether manual framing is now worth building. |
| Extracting `serveFile()` breaks Range support and silently kills the cover-frame scrubber. | Task 4 routes **every** variant through the same extracted function rather than duplicating it; the scrubber is exercised in Task 5's browser pass. |
| Disk growth from caching two canvases per storied asset. | Only generated for assets whose framing dialog is opened or that are actually storied — not every upload. Files are ~200–400KB. |
| `conform.ts` still has no tests, so a feed-side regression stays invisible. | Out of scope here, but `story-canvas.ts` ships fully tested so the new surface is not added to the untested pile. |
