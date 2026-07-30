# Merge posts into a carousel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/design-merge-into-carousel.md` (approved 2026-07-30). The spec is authoritative;
this plan is how to build it.

**Goal:** Select 2+ draft posts in the Library, review the slide order, and merge them into one
carousel draft — without ever deleting a photo.

**Architecture:** No schema change. A merge deletes the involved `post_assets` rows and
re-inserts them on the surviving post in the requested order, unions the merged posts'
targets/tags/periods onto it, flips its `post_type` to `carousel`, then deletes the emptied
posts. All of it in one `better-sqlite3` transaction in `lib/queries.ts`. Pure validation and
ordering logic lives in a separate dependency-free module so it can be tested without a DB.

**Tech Stack:** Next.js App Router + TypeScript, `better-sqlite3`, SQLite (WAL). Tests run on
Node 23's built-in test runner with native TypeScript — **no new dependencies**.

## Global Constraints

- **No new npm or pip dependencies.** Verified 2026-07-30 that `node --test` covers this.
- **No migration.** The existing schema supports the feature (spec §2). Do not add one — and
  note `0012` is already claimed in the live DB by an off-branch migration.
- **Never touch the real database from a test.** Tests set `DATABASE_PATH` to a temp file.
- `posts.post_type` must always match the asset count (spec §3): `single` = 1,
  `carousel` = 2..cap. The worker raises `_NonRetryable` on mismatch at publish time.
- Assets are never deleted by a merge. Only `post_assets` join rows change.
- Route handlers never call `getDb()` — they import named helpers from `lib/queries.ts`.
- Errors are `NextResponse.json({ error: "Sentence-cased human message." }, { status })`.
- Carousel cap is `min(maxCarousel)` across target platforms from `lib/platforms.ts`
  (IG/FB 10, Threads 20). Never hardcode 10.
- Match the codebase's comment style: long *why* comments above non-obvious logic.

---

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/test/hook.mjs` (create) | Resolver hook: append `.ts` to extensionless imports |
| `dashboard/test/helpers.ts` (create) | Build a migrated temp DB; seed channels/assets/posts |
| `dashboard/lib/merge-plan.ts` (create) | Pure validation + slide ordering. No DB, no imports |
| `dashboard/lib/merge-plan.test.ts` (create) | Unit tests for the above |
| `dashboard/lib/queries.ts` (modify) | Add `mergePostsIntoCarousel` transaction |
| `dashboard/lib/queries.merge.test.ts` (create) | Transaction tests against a temp DB |
| `dashboard/app/api/posts/merge/route.ts` (create) | `POST` handler |
| `dashboard/components/slide-reorder.tsx` (create) | Drag/keyboard reorder, lifted from composer |
| `dashboard/components/composer.tsx` (modify) | Use the extracted component |
| `dashboard/components/merge-modal.tsx` (create) | Review step |
| `dashboard/components/library-view.tsx` (modify) | "Merge into carousel" bulk action |
| `dashboard/package.json` (modify) | `test` script |

---

## Task 1: Zero-dependency test harness

**Files:**
- Create: `dashboard/test/hook.mjs`, `dashboard/test/helpers.ts`, `dashboard/test/smoke.test.ts`
- Modify: `dashboard/package.json` (scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: `makeTestDb(): string` — migrates a fresh SQLite file into a temp dir, sets
  `process.env.DATABASE_PATH` to it, returns the path. Must be called **before** any
  `import("../lib/queries.ts")`, because `lib/config.ts` reads the env at module load.
- Produces: `npm test` in `dashboard/`.

- [ ] **Step 1: Write the resolver hook**

`dashboard/test/hook.mjs`:

```js
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

// Next's bundler resolves extensionless relative imports ("./db"); Node's ESM resolver
// does not, so importing lib/queries.ts directly fails on its own internal imports.
// Rewrite "./db" -> "./db.ts" only when the bare specifier isn't a real file, so a
// genuine extensionless file (or a package) still resolves normally.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) {
      const bare = new URL(spec, ctx.parentURL);
      const ts = new URL(spec + ".ts", ctx.parentURL);
      if (!existsSync(bare) && existsSync(ts)) return next(spec + ".ts", ctx);
    }
    return next(spec, ctx);
  },
});
```

- [ ] **Step 2: Write the temp-DB helper**

`dashboard/test/helpers.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Fresh migrated SQLite file in a temp dir, wired up as DATABASE_PATH.
 *
 * MUST be called before importing lib/queries.ts: lib/config.ts reads DATABASE_PATH once
 * at module load, so an import that happens first would bind to the REAL database.
 * That is why every test here uses a dynamic `await import(...)` rather than a top-level one.
 */
export function makeTestDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ss-test-"));
  const dbPath = path.join(dir, "test.db");
  execFileSync("python3", ["migrate.py"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: "pipe",
  });
  process.env.DATABASE_PATH = dbPath;
  return dbPath;
}
```

- [ ] **Step 3: Write the smoke test**

`dashboard/test/smoke.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

test("harness migrates a temp DB and loads the real queries layer", async () => {
  const dbPath = makeTestDb();
  assert.ok(dbPath.includes("ss-test-"), "must not be the real database");
  const q = await import("../lib/queries.ts");
  assert.deepEqual(q.getActiveChannels(), []);
});
```

- [ ] **Step 4: Add the test script**

In `dashboard/package.json` `scripts`, add:

```json
"test": "node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 \"lib/*.test.ts\" \"test/*.test.ts\""
```

Two deliberate choices:
- **Scoped globs, not `**/*.test.ts`.** Node's runner is documented to skip `node_modules`, but
  a bare `**` glob relies on that; naming the two directories that hold tests cannot go wrong.
  Add a directory here when tests land somewhere new.
- **`--test-concurrency=1`.** `DATABASE_PATH` is process-global, so parallel test files would
  race on it and silently share one database — producing failures that look like logic bugs.

- [ ] **Step 5: Run it**

```bash
cd dashboard && npm test
```

Expected: 1 test passes. An `ExperimentalWarning: Type Stripping` line is normal.

- [ ] **Step 6: Commit**

```bash
git add dashboard/test dashboard/package.json
git commit -m "test(dashboard): zero-dependency test harness on node:test"
```

---

## Task 2: Pure merge-planning module

**Files:**
- Create: `dashboard/lib/merge-plan.ts`, `dashboard/lib/merge-plan.test.ts`

**Interfaces:**
- Consumes: `Platform` from `lib/platforms.ts`.
- Produces:

```ts
export interface MergeCandidate {
  post_id: number;
  post_type: string;
  status: string;
  has_live_publication: boolean;
  asset_ids: number[];        // in current sort_order
  media_kinds: string[];      // parallel to asset_ids: "image" | "video"
}
export interface MergeRequest {
  post_ids: number[];         // selection order; [0] is the survivor
  asset_order: number[];      // final slide order
}
export type MergeProblem = { code: string; message: string; status: 400 | 404 | 409 };
export function planMerge(
  candidates: MergeCandidate[],
  req: MergeRequest,
  platforms: Platform[],
): { ok: true; survivorId: number; slides: { asset_id: number; sort_order: number }[] }
 | { ok: false; problem: MergeProblem };
```

This module imports nothing but `lib/platforms.ts` and touches no database — that is the point.
Every guard in spec §5 is decided here, so it can be tested exhaustively without SQLite.

- [ ] **Step 1: Write the failing tests**

`dashboard/lib/merge-plan.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planMerge, type MergeCandidate } from "./merge-plan.ts";

function cand(over: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    post_id: 1, post_type: "single", status: "draft",
    has_live_publication: false, asset_ids: [10], media_kinds: ["image"],
    ...over,
  };
}

test("merges two singles into contiguous slides", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [20, 10] },
    ["instagram"],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.survivorId, 1, "survivor is first SELECTED, not first slide");
  assert.deepEqual(r.slides, [
    { asset_id: 20, sort_order: 0 },
    { asset_id: 10, sort_order: 1 },
  ]);
});

test("rejects a single post", () => {
  const r = planMerge([cand()], { post_ids: [1], asset_order: [10] }, ["instagram"]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
});

test("rejects a post with a live publication", () => {
  const r = planMerge(
    [cand({ post_id: 1 }), cand({ post_id: 2, asset_ids: [20], has_live_publication: true })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram"],
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
  assert.match(r.problem.message, /already/i);
});

test("rejects video assets — a carousel is images only", () => {
  const r = planMerge(
    [cand({ post_id: 1 }), cand({ post_id: 2, asset_ids: [20], media_kinds: ["video"] })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram"],
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.problem.message, /video/i);
});

test("enforces the smallest platform cap, not a hardcoded 10", () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    cand({ post_id: i + 1, asset_ids: [100 + i] }));
  const req = { post_ids: many.map((c) => c.post_id), asset_order: many.map((c) => c.asset_ids[0]) };
  assert.equal(planMerge(many, req, ["threads"]).ok, true, "threads allows 20");
  const r = planMerge(many, req, ["threads", "instagram"]);
  assert.equal(r.ok, false, "instagram caps at 10");
  if (r.ok) return;
  assert.match(r.problem.message, /10/);
});

test("rejects the same asset appearing twice", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [10] })],
    { post_ids: [1, 2], asset_order: [10, 10] },
    ["instagram"],
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
});

test("rejects asset_order that omits a slide", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10] },
    ["instagram"],
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.problem.message, /every photo/i);
});

test("absorbing into an existing carousel keeps it a carousel", () => {
  const r = planMerge(
    [cand({ post_id: 1, post_type: "carousel", asset_ids: [10, 11], media_kinds: ["image", "image"] }),
     cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10, 20, 11] },
    ["instagram"],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.slides.map((s) => s.asset_id), [10, 20, 11]);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd dashboard && npm test
```

Expected: FAIL — `Cannot find module './merge-plan.ts'`.

- [ ] **Step 3: Implement `merge-plan.ts`**

Write the module so all eight tests pass. Requirements, in the order the guards should fire
(most-specific first so the message is useful):

1. `post_ids.length >= 2` → 400 `"Select at least two posts to merge."`
2. every `post_ids` entry has a matching candidate → 404 `"One of those posts no longer exists."`
3. no candidate has `has_live_publication` or `status` of `posted`/`publishing` → 409
   `"That post has already been published — merging would delete its record."`
4. no `media_kinds` entry is `"video"` → 400
   `"A carousel can only contain images. Remove the video and try again."`
5. `asset_order` is exactly the multiset of all candidates' `asset_ids` — same length, same
   members, no duplicates → 400 `"Every photo in the selected posts must appear exactly once."`
6. duplicate asset across candidates → 409
   `"The same photo appears in more than one of those posts."`
7. `asset_order.length <= min(maxCarousel across platforms)` → 400
   `"Instagram allows at most 10 photos in a carousel; you selected N."`
8. otherwise `{ ok: true, survivorId: post_ids[0], slides: asset_order.map((id, i) => ({ asset_id: id, sort_order: i })) }`

Import `PLATFORMS` from `./platforms` to look up `maxCarousel`; do not hardcode.

- [ ] **Step 4: Run to verify they pass**

```bash
cd dashboard && npm test
```

Expected: 9 passing (8 + the Task 1 smoke test).

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/merge-plan.ts dashboard/lib/merge-plan.test.ts
git commit -m "feat(merge): pure planning + guards for merging posts into a carousel"
```

---

## Task 3: The merge transaction

**Files:**
- Modify: `dashboard/lib/queries.ts`
- Create: `dashboard/lib/queries.merge.test.ts`

**Interfaces:**
- Consumes: `planMerge` from Task 2; `getDb`, `nowIso` from `lib/db.ts`.
- Produces:

```ts
export function mergePostsIntoCarousel(
  postIds: number[], assetOrder: number[], caption: string | null,
): { ok: true; post_id: number } | { ok: false; problem: MergeProblem };
```

**This is the destructive task.** Read spec §3 (frozen `post_type`) and §4 (ordering) before
writing code.

- [ ] **Step 1: Write the failing tests**

`dashboard/lib/queries.merge.test.ts`. Build fixtures through the real helpers so the rows are
shaped exactly like production rows:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  // Assets need a unique content_hash; storage_path is NOT NULL.
  const mkAsset = (n: number) =>
    Number(db.prepare(
      "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)"
    ).run(`hash-${n}`, `a/${n}.jpg`).lastInsertRowid);
  return { q, db, mkAsset };
}

test("merging three singles yields one carousel with contiguous slides", async () => {
  const { q, db, mkAsset } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const posts = ids.map((a) => q.createDraftPost({ asset_ids: [a] }));

  const res = q.mergePostsIntoCarousel(posts, [ids[2], ids[0], ids[1]], null);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // THE invariant from spec §3 — wrong here means a silent failure at publish time.
  assert.equal(q.getPost(res.post_id)?.post_type, "carousel");

  const rows = db.prepare(
    "SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order"
  ).all(res.post_id);
  assert.deepEqual(rows, [
    { asset_id: ids[2], sort_order: 0 },
    { asset_id: ids[0], sort_order: 1 },
    { asset_id: ids[1], sort_order: 2 },
  ]);

  assert.equal(q.getPost(posts[1]), undefined, "emptied drafts are deleted");
  assert.equal(q.getPost(posts[2]), undefined);
});

test("no asset is deleted or orphaned", async () => {
  const { q, db, mkAsset } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => q.createDraftPost({ asset_ids: [a] }));
  const before = db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number };

  q.mergePostsIntoCarousel(posts, ids, null);

  const after = db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number };
  assert.equal(after.c, before.c, "merging must never delete a photo");
});

test("merging INTO an existing carousel survives the sort_order collision", async () => {
  const { q, db, mkAsset } = await setup();
  const a = [mkAsset(1), mkAsset(2)];
  const carousel = q.createDraftPost({ asset_ids: a });      // occupies sort_order 0 and 1
  const extra = mkAsset(3);
  const single = q.createDraftPost({ asset_ids: [extra] });

  // Interleave: the new photo lands between the carousel's existing slides.
  const res = q.mergePostsIntoCarousel([carousel, single], [a[0], extra, a[1]], null);
  assert.equal(res.ok, true);
  const rows = db.prepare(
    "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order"
  ).all(carousel) as { asset_id: number }[];
  assert.deepEqual(rows.map((r) => r.asset_id), [a[0], extra, a[1]]);
});

test("caption is written to BOTH posts.caption and caption_variants", async () => {
  const { q, db, mkAsset } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => q.createDraftPost({ asset_ids: [a] }));

  const res = q.mergePostsIntoCarousel(posts, ids, "Grand Teton");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(q.getPost(res.post_id)?.caption, "Grand Teton");
  const vars = db.prepare(
    "SELECT body FROM caption_variants WHERE post_id = ?"
  ).all(res.post_id) as { body: string }[];
  assert.deepEqual(vars.map((v) => v.body), ["Grand Teton"],
    "the worker prefers variants over posts.caption");
});

test("targets and tags are unioned from every merged post", async () => {
  const { q, db, mkAsset } = await setup();
  const ch = (n: string) => Number(db.prepare(
    "INSERT INTO channels (platform, account_name) VALUES ('instagram', ?)"
  ).run(n).lastInsertRowid);
  const c1 = ch("a"), c2 = ch("b");
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => q.createDraftPost({ asset_ids: [a] }));
  q.setPostTargets(posts[0], [c1]);
  q.setPostTargets(posts[1], [c2]);

  const res = q.mergePostsIntoCarousel(posts, ids, null);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(q.getPostTargets(res.post_id).sort(), [c1, c2].sort());
});

test("a rejected merge writes nothing at all", async () => {
  const { q, mkAsset } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => q.createDraftPost({ asset_ids: [a] }));

  const res = q.mergePostsIntoCarousel(posts, [ids[0]], null);  // omits a slide
  assert.equal(res.ok, false);
  assert.equal(q.getPost(posts[0])?.post_type, "single", "untouched");
  assert.ok(q.getPost(posts[1]), "the other draft still exists");
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd dashboard && npm test
```

Expected: FAIL — `q.mergePostsIntoCarousel is not a function`.

- [ ] **Step 3: Implement the transaction**

Add to `lib/queries.ts`, near the other post writers. Gather candidates, call `planMerge`, then
run one `db.transaction`. Execution order is load-bearing:

```ts
// post_assets carries no data worth preserving — (id, post_id, asset_id, sort_order), and
// nothing references its id. So instead of shuffling rows through a temporary high offset to
// dodge UNIQUE (post_id, sort_order) — which SQLite checks per-row, immediately — we delete
// every involved row and rebuild them on the survivor. Simpler and provably collision-free.
//
// Order matters: the join rows must be rebuilt BEFORE the emptied posts are deleted. Deleting
// the posts first would cascade their join rows away and take the asset links with them.
```

1. `DELETE FROM post_assets WHERE post_id IN (…all merged…)`
2. one `INSERT INTO post_assets (post_id, asset_id, sort_order)` per slide, on the survivor
3. `UPDATE posts SET post_type = 'carousel', caption = @caption, updated_at = @now WHERE id = @survivor`
4. replace the survivor's `caption_variants` with the chosen caption (delete then insert one
   row with `platform = NULL, sort_order = 0`); skip entirely when `caption` is null
5. union `post_targets`, `post_tags`, `post_periods` onto the survivor via
   `INSERT OR IGNORE ... SELECT` from the non-survivors
6. `DELETE FROM posts WHERE id IN (…non-survivors…)`

Return `{ ok: true, post_id: survivorId }`.

- [ ] **Step 4: Run to verify they pass**

```bash
cd dashboard && npm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/lib/queries.merge.test.ts
git commit -m "feat(merge): mergePostsIntoCarousel transaction"
```

---

## Task 4: The API route

**Files:**
- Create: `dashboard/app/api/posts/merge/route.ts`

**Interfaces:**
- Consumes: `mergePostsIntoCarousel` from Task 3.
- Produces: `POST /api/posts/merge` → `{ ok: true, post_id }` 200, or `{ error }` 400/404/409.

- [ ] **Step 1: Write the route**

Follow the hand-rolled validation style used by `app/api/posts/targets/bulk/route.ts` — no zod.

```ts
import { NextResponse } from "next/server";
import { mergePostsIntoCarousel } from "@/lib/queries";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { post_ids, asset_order, caption } = body as Record<string, unknown>;
  if (!Array.isArray(post_ids) || !post_ids.every((n) => Number.isInteger(n))) {
    return NextResponse.json({ error: "post_ids must be an array of post ids." }, { status: 400 });
  }
  if (!Array.isArray(asset_order) || !asset_order.every((n) => Number.isInteger(n))) {
    return NextResponse.json({ error: "asset_order must be an array of asset ids." }, { status: 400 });
  }
  if (caption !== null && caption !== undefined && typeof caption !== "string") {
    return NextResponse.json({ error: "caption must be text or null." }, { status: 400 });
  }
  const result = mergePostsIntoCarousel(
    post_ids as number[], asset_order as number[], (caption as string) ?? null,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.problem.message }, { status: result.problem.status });
  }
  return NextResponse.json({ ok: true, post_id: result.post_id });
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd dashboard && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/api/posts/merge/route.ts
git commit -m "feat(merge): POST /api/posts/merge"
```

---

## Task 5: Extract the slide reorder component

**Files:**
- Create: `dashboard/components/slide-reorder.tsx`
- Modify: `dashboard/components/composer.tsx` (replace the inline block at ~431–493)

**Interfaces:**
- Produces:

```tsx
export interface Slide { assetId: number; label?: string }
export function SlideReorder(props: {
  slides: Slide[];
  onReorder: (next: Slide[]) => void;
  onRemove?: (assetId: number) => void;
}): JSX.Element;
```

This is a **pure refactor with no behaviour change.** The composer must work exactly as before.

- [ ] **Step 1: Read the existing block**

Read `dashboard/components/composer.tsx` lines 420–500. Note what must be preserved: the
HTML5 drag events driven by a `useRef` index, the keyboard-reachable ← / → buttons, the 1-based
index badge, the hover "×" remove, and the `/api/media/{id}?variant=thumb` thumbnail source.

- [ ] **Step 2: Create the component**

Move that markup and its drag handlers into `slide-reorder.tsx`, parameterised by the props
above. Keep the ←/→ buttons — they are what makes reordering possible without a mouse.

- [ ] **Step 3: Use it in the composer**

Replace the inline block with `<SlideReorder …/>`, mapping the composer's `assets` state.

- [ ] **Step 4: Verify the composer still works**

```bash
cd dashboard && npx tsc --noEmit
```

Then in the browser at `http://localhost:3939/compose`: upload two images, drag to reorder, use
the ←/→ buttons, remove one. Confirm behaviour is unchanged from before the refactor.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/slide-reorder.tsx dashboard/components/composer.tsx
git commit -m "refactor(composer): extract SlideReorder for reuse by merge"
```

---

## Task 6: The merge modal and Library action

**Files:**
- Create: `dashboard/components/merge-modal.tsx`
- Modify: `dashboard/components/library-view.tsx`

**Interfaces:**
- Consumes: `SlideReorder` (Task 5), `POST /api/posts/merge` (Task 4).
- The Library page must pass each post's assets and captions down. `listPosts()` already
  returns enough for thumbnails; if it does not expose every asset id per post, extend the
  `PostLite` projection in `app/library/page.tsx` rather than fetching per-post in the client.

- [ ] **Step 1: Build the modal**

`merge-modal.tsx`, following `media-lightbox.tsx` for modal structure and focus trapping:

- `<SlideReorder>` seeded in selection order (a carousel expands to all its slides, in order).
- Caption picker — render **only** when ≥1 selected post has a non-empty caption. Radio list of
  the distinct captions plus "No caption". Default: the first non-empty one. (115 of 135 drafts
  have no caption, so this is usually absent entirely.)
- A plain sentence: *"Keeps post #N and deletes the other M emptied drafts. No photos are
  deleted."*
- Confirm + Cancel. Disable Confirm while the request is in flight.
- On error, show `body.error` inline in the modal — do not close it, so the selection survives.

- [ ] **Step 2: Wire the Library bulk bar**

In `library-view.tsx`, add a **Merge into carousel** button beside Bulk schedule / Add target /
Remove target (~line 488–605). Enabled only when `selected.length >= 2`. Opens the modal.

On success: `router.refresh()` inside the existing `useTransition`, clear `selected`, close the
modal — mirroring `schedule()` at ~line 97–122.

- [ ] **Step 3: Typecheck and lint**

```bash
cd dashboard && npx tsc --noEmit && npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/components/merge-modal.tsx dashboard/components/library-view.tsx dashboard/app/library/page.tsx
git commit -m "feat(library): merge selected posts into a carousel"
```

---

## Task 7: End-to-end verification

**Files:**
- Modify: `docs/tasks.md`

**This task must run on the main model, not a subagent.** It is browser verification of a
destructive flow.

- [ ] **Step 1: Back up the database first**

```bash
cp data/socialscheduler.db "data/socialscheduler.db.pre-merge-$(date +%Y%m%d-%H%M%S)"
```

- [ ] **Step 2: Drive the flow in Playwright, not the in-app browser**

Use the Playwright MCP tools with `browser_handle_dialog`. **Do not use the in-app browser for
this** — it auto-accepts `confirm()` dialogs and has previously deleted a real asset.

Merge two real single drafts at `http://localhost:3939/library`. Reorder the slides before
confirming.

- [ ] **Step 3: Assert the result in SQL**

```bash
sqlite3 -header -column data/socialscheduler.db \
  "SELECT p.id, p.post_type, COUNT(pa.id) slides
   FROM posts p JOIN post_assets pa ON pa.post_id = p.id
   WHERE p.id = <merged id> GROUP BY p.id;"
```

Expected: `post_type = carousel` and `slides = 2`. Also confirm the total asset count is
unchanged from before the merge.

- [ ] **Step 4: Confirm the worker would accept it**

```bash
cd worker && python3 -m pytest tests/test_publisher.py -q
```

The publisher's `_validate` is the thing that would reject a bad merge — spec §3.

- [ ] **Step 5: Update `docs/tasks.md`**

Add the phase, mark it complete, and note that the dashboard now has a test harness.

- [ ] **Step 6: Commit**

```bash
git add docs/tasks.md && git commit -m "docs: record the merge-into-carousel phase"
```

---

## Self-review notes

- **Spec coverage:** §2 no-schema → Global Constraints. §3 frozen `post_type` → Task 3 Step 1
  test 1 + Step 3(3). §4 payload/ordering → Tasks 2–4. §4 sort_order trap → Task 3 Step 3
  comment + Step 1 test 3. §5 guards (all 7) → Task 2 Step 1 tests. §6 merge-into-carousel →
  Task 2 test 8 + Task 3 test 3. §7 component extraction → Task 5. §8 harness → Task 1; all six
  §8 cases → Task 3 tests + Task 7.
- **Known follow-up, deliberately not in this plan:** `createDraftPost` sets `post_type` from
  asset count alone and ignores `media_kind`, so a single video created through that path
  becomes `single` rather than `reel`. Confirmed live on 2026-07-30. Pre-existing, unrelated to
  merge, worth its own fix.
