# Carousel Reorder, Library Stack, and Swipe-Through Lightbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an existing carousel's slide order be changed from the post detail page and the Library quick-edit dialog, show carousels as a stack in the Library, and make the lightbox flip through every slide.

**Architecture:** One new API resource, `/api/posts/[id]/assets`, is the single write path — `GET` returns the ordered slides, `PATCH` reorders them. The `PATCH` accepts only a *permutation* of the post's current assets, so slide count (and therefore `posts.post_type`) cannot drift. The two editing screens share a hook for order state and the write, and share the existing `SlideReorder` grid for the UI. `MediaLightbox` widens from one asset to an array; the Library card opens it on slide 1 from data it already has and fills in the rest from `GET`.

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, `better-sqlite3`, Tailwind v4. Tests are the **Node built-in test runner** (`node:test` + `node:assert/strict`), run via `npm test` in `dashboard/`.

**Spec:** [docs/design-carousel-reorder-and-swipe.md](../../design-carousel-reorder-and-swipe.md)

## Global Constraints

- **No schema migration.** No file is added to `/migrations`. `post_assets` is used as it stands.
- **No worker change.** `worker/db.py::get_ordered_assets` already reads `ORDER BY pa.sort_order ASC` at publish time.
- **`lib/queries.ts` is the sole data-access layer.** Route handlers never open the DB themselves.
- **Reorder only.** The `PATCH` can never add or remove a slide. `posts.post_type` is written at creation and frozen; `worker/publisher.py::_validate` raises `_NonRetryable` on a `carousel` with fewer than 2 assets.
- **`UNIQUE (post_id, sort_order)` is checked per-row, immediately.** Reordering must DELETE then re-INSERT inside one transaction, never a loop of `UPDATE`s.
- **Never run `migrate.py` against the live DB** — it has no argument parser; every invocation migrates whatever `DATABASE_PATH` points at. `test/helpers.ts::makeTestDb()` points it at a temp file.
- **Tests must be added to `npm test`.** `lib/*.test.ts` and `test/*.test.ts` are globbed already; `test-ui/` currently lists files explicitly (Task 4 fixes that).
- Existing comment style: explain *why*, not *what*. Match it.

---

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/lib/asset-order.ts` | **New.** Pure permutation check. No DB, no React. |
| `dashboard/lib/asset-order.test.ts` | **New.** Tests for the above. |
| `dashboard/lib/queries.ts` | **Modify.** Add `reorderPostAssets` + `postHasPublishingPublication`. |
| `dashboard/lib/queries.reorder.test.ts` | **New.** DB-level tests. |
| `dashboard/app/api/posts/[id]/assets/route.ts` | **New.** `GET` + `PATCH`. Validation and the `publishing` guard live here. |
| `dashboard/test/assets-order-route.test.ts` | **New.** Route tests. |
| `dashboard/components/carousel-reorder.tsx` | **New.** `useAssetOrder` hook (state + the PATCH) and `CarouselReorder` (grid + queued notice). Co-located: always used together. |
| `dashboard/test-ui/carousel-reorder-ui.test.ts` | **New.** Markup test. |
| `dashboard/components/post-editor.tsx` | **Modify.** Carousels get the reorder block instead of the sliced read-only strip. |
| `dashboard/components/quick-edit-modal.tsx` | **Modify.** Loads assets on open; its Save writes the order first. |
| `dashboard/lib/lightbox-nav.ts` | **New.** Pure index stepping (clamped, no wrap). |
| `dashboard/lib/lightbox-nav.test.ts` | **New.** Tests for the above. |
| `dashboard/components/media-lightbox.tsx` | **Modify.** `assets: LightboxAsset[]`; extract `LightboxPanel` so the markup is testable without a DOM (`createPortal` cannot be server-rendered). |
| `dashboard/test-ui/media-lightbox-ui.test.ts` | **New.** Panel markup test. |
| `dashboard/components/carousel-stack.tsx` | **New.** The layered-thumbnail treatment + count chip. |
| `dashboard/components/media-manager.tsx` | **Modify.** One-line call-site update (`asset` → `assets`). |
| `dashboard/components/library-view.tsx` | **Modify.** Stack on the card; multi-asset lightbox open. |
| `dashboard/package.json` | **Modify.** Glob `test-ui/*.test.ts`. |

**Phases (per the project's `tasks.md` convention):** Phase 1 = Tasks 1–3 (data + API, no UI). Phase 2 = Tasks 4–6 (reorder UI). Phase 3 = Tasks 7–9 (stack + swipe). Each phase ends verified before the next begins.

---

## Task 1: Permutation validation

**Files:**
- Create: `dashboard/lib/asset-order.ts`
- Test: `dashboard/lib/asset-order.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `checkAssetOrder(current: number[], proposed: unknown): AssetOrderCheck`, where
  `AssetOrderCheck = { ok: true; asset_ids: number[] } | { ok: false; code: "not_an_array" | "empty" | "not_integers" | "not_a_permutation"; error: string }`.

**Why this is its own module:** it is the check that makes the frozen-`post_type` invariant hold, and it is pure — no DB, no request. Testing it needs neither.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/asset-order.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAssetOrder } from "./asset-order.ts";

test("a genuine reordering is accepted and returned", () => {
  const res = checkAssetOrder([7, 8, 9], [9, 7, 8]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.asset_ids, [9, 7, 8]);
});

test("the unchanged order is accepted — saving a no-op is not an error", () => {
  assert.equal(checkAssetOrder([7, 8, 9], [7, 8, 9]).ok, true);
});

// THE invariant from spec §3: anything that changes the slide COUNT would change what
// post_type has to be, and post_type is frozen. All four of these must be refused.
test("a dropped slide is refused", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("an added slide is refused", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8, 9, 10]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("a duplicated slide is refused even though the length matches", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 7, 8]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("a foreign asset id is refused even though the length matches", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8, 99]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("non-arrays, empties, and non-integers are refused with their own codes", () => {
  for (const [proposed, code] of [
    [undefined, "not_an_array"],
    [null, "not_an_array"],
    ["7,8,9", "not_an_array"],
    [{ 0: 7 }, "not_an_array"],
    [[], "empty"],
    [[7, 8, "9"], "not_integers"],
    [[7, 8, 9.5], "not_integers"],
    [[7, 8, NaN], "not_integers"],
  ] as const) {
    const res = checkAssetOrder([7, 8, 9], proposed);
    assert.equal(res.ok, false, `${JSON.stringify(proposed)} should be refused`);
    if (res.ok) return;
    assert.equal(res.code, code);
  }
});

test("every refusal carries a message fit to show a person", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /\w+ \w+/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/asset-order.test.ts
```

Expected: FAIL — `Cannot find module './asset-order.ts'`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/lib/asset-order.ts`:

```ts
/**
 * Is a proposed slide order a valid reordering of the slides a post actually has?
 *
 * This is the check that keeps posts.post_type honest. post_type is computed once at
 * creation and then frozen, and worker/publisher.py::_validate re-derives the expectation
 * at publish time — a 'carousel' that lost a slide here would look completely correct in
 * the dashboard and then fail at send time with "carousel needs 2-10 assets, has 1".
 * Refusing anything that isn't a permutation makes the asset count invariant, which makes
 * post_type correct by construction rather than by remembering to update it.
 */
export type AssetOrderCheck =
  | { ok: true; asset_ids: number[] }
  | {
      ok: false;
      code: "not_an_array" | "empty" | "not_integers" | "not_a_permutation";
      error: string;
    };

export function checkAssetOrder(current: number[], proposed: unknown): AssetOrderCheck {
  if (!Array.isArray(proposed)) {
    return { ok: false, code: "not_an_array", error: "asset_ids must be an array." };
  }
  if (proposed.length === 0) {
    return { ok: false, code: "empty", error: "asset_ids must not be empty." };
  }
  if (!proposed.every((value) => Number.isInteger(value))) {
    return { ok: false, code: "not_integers", error: "asset_ids must be whole numbers." };
  }

  const next = proposed as number[];
  const proposedSet = new Set(next);
  const isPermutation =
    next.length === current.length &&
    // Catches duplicates: a repeated id collapses in the Set, so the sizes diverge even
    // though the lengths matched.
    proposedSet.size === next.length &&
    current.every((id) => proposedSet.has(id));

  if (!isPermutation) {
    return {
      ok: false,
      code: "not_a_permutation",
      error:
        "asset_ids must list exactly this post's slides, each one once. This endpoint " +
        "reorders slides; it cannot add or remove them.",
    };
  }

  return { ok: true, asset_ids: next };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/asset-order.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/asset-order.ts dashboard/lib/asset-order.test.ts
git commit -m "feat(library): validate a proposed carousel order as a permutation"
```

---

## Task 2: The database write

**Files:**
- Modify: `dashboard/lib/queries.ts` (add both functions immediately after `getPostAssets`, around line 471)
- Test: `dashboard/lib/queries.reorder.test.ts`

**Interfaces:**
- Consumes: `getDb`, `nowIso` (already imported at the top of `queries.ts`); `getPostAssets(postId): Asset[]` (existing, line ~464).
- Produces:
  - `reorderPostAssets(postId: number, assetIds: number[]): void`
  - `postHasPublishingPublication(postId: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/queries.reorder.test.ts`. The `setup()` shape and the `setupSeq` prefix are copied from `lib/queries.merge.test.ts` — read its header comment for why the prefix is load-bearing (`lib/db.ts` memoises its connection, so every test in this file shares one database).

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// Same constraint as queries.merge.test.ts: node --test gives this FILE its own process,
// but lib/db.ts memoises the connection in a module-level `_db`, so every setup() here
// gets the SAME database. Assets are deduped by content_hash (UNIQUE), so a literal
// "hash-1" in two tests would collide — hence the per-setup prefix.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `t${++setupSeq}`;
  const mkAsset = (n: number) =>
    Number(
      db
        .prepare(
          "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)"
        )
        .run(`${prefix}-hash-${n}`, `a/${prefix}/${n}.jpg`).lastInsertRowid
    );
  const mkCarousel = (assetIds: number[]) =>
    q.createDraftPost({
      caption: "",
      first_comment: "",
      asset_ids: assetIds,
      post_type: "carousel",
    });
  const orderOf = (postId: number) =>
    db
      .prepare(
        "SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order"
      )
      .all(postId);
  return { q, db, mkAsset, mkCarousel, orderOf };
}

test("reordering rewrites sort_order contiguously from zero", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [ids[2], ids[0], ids[1]]);

  assert.deepEqual(orderOf(post), [
    { asset_id: ids[2], sort_order: 0 },
    { asset_id: ids[0], sort_order: 1 },
    { asset_id: ids[1], sort_order: 2 },
  ]);
});

// The reason this can't be a loop of UPDATEs: UNIQUE (post_id, sort_order) is enforced
// per-row and immediately, so moving the last slide to position 0 collides with the row
// already there. A reversal is the case that trips every intermediate position at once.
test("a full reversal survives UNIQUE (post_id, sort_order)", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4), mkAsset(5)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [...ids].reverse());

  assert.deepEqual(
    orderOf(post).map((r) => (r as { asset_id: number }).asset_id),
    [...ids].reverse()
  );
});

test("reordering one post leaves another post's order alone", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const mine = [mkAsset(1), mkAsset(2)];
  const theirs = [mkAsset(3), mkAsset(4)];
  const postA = mkCarousel(mine);
  const postB = mkCarousel(theirs);

  q.reorderPostAssets(postA, [mine[1], mine[0]]);

  assert.deepEqual(
    orderOf(postB).map((r) => (r as { asset_id: number }).asset_id),
    theirs
  );
});

// Assets are content-hash-shared and ON DELETE RESTRICT. Rebuilding join rows must not
// reach them.
test("no asset row is deleted by a reorder", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;

  q.reorderPostAssets(post, [ids[1], ids[2], ids[0]]);

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n, before);
});

test("post_type and asset count are untouched", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [ids[1], ids[0], ids[2]]);

  assert.equal(q.getPost(post)?.post_type, "carousel");
  assert.equal(orderOf(post).length, 3);
});

test("getPostAssets reads back in the new order", async () => {
  const { q, mkAsset, mkCarousel } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [ids[2], ids[1], ids[0]]);

  assert.deepEqual(
    q.getPostAssets(post).map((a) => a.id),
    [ids[2], ids[1], ids[0]]
  );
});

test("a reorder bumps posts.updated_at", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const post = mkCarousel(ids);
  db.prepare("UPDATE posts SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(post);

  q.reorderPostAssets(post, [ids[1], ids[0]]);

  const row = db.prepare("SELECT updated_at FROM posts WHERE id = ?").get(post) as {
    updated_at: string;
  };
  assert.notEqual(row.updated_at, "2000-01-01T00:00:00Z");
});

test("postHasPublishingPublication only reports the in-flight status", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const post = mkCarousel([mkAsset(1), mkAsset(2)]);
  const channel = q.createChannel({
    platform: "instagram",
    display_name: `reorder-${setupSeq}`,
    account_ref: `acct-${setupSeq}`,
  });
  const addSend = (status: string) =>
    db
      .prepare(
        `INSERT INTO publications (post_id, channel_id, status, scheduled_for)
         VALUES (?, ?, ?, '2030-01-01T00:00:00Z')`
      )
      .run(post, channel.id, status);

  assert.equal(q.postHasPublishingPublication(post), false, "no sends at all");

  addSend("scheduled");
  assert.equal(q.postHasPublishingPublication(post), false, "a queued send does not block");

  addSend("posted");
  assert.equal(q.postHasPublishingPublication(post), false, "a past send does not block");

  addSend("publishing");
  assert.equal(q.postHasPublishingPublication(post), true, "an in-flight send blocks");
});
```

> **Note for the implementer:** confirm `createChannel`'s exact signature and required fields in `lib/queries.ts` before running (search for `export function createChannel`). If it differs from the call above, adjust the fixture — the assertion is what matters, not how the channel gets made. If a `publications` column is `NOT NULL` without a default, add it to the INSERT.

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/queries.reorder.test.ts
```

Expected: FAIL — `q.reorderPostAssets is not a function`.

- [ ] **Step 3: Write the implementation**

In `dashboard/lib/queries.ts`, directly below `getPostAssets` (ends ~line 471):

```ts
/**
 * True while any of this post's sends is mid-flight in the worker.
 *
 * The guard on reordering. Unlike merge — which refuses posted and publishing posts
 * because it DELETES posts and their queued sends — a reorder destroys nothing, so the
 * only genuinely dangerous moment is the one where the worker is reading post_assets for
 * this post right now to build a container. Reordering a 'posted' post is the whole point
 * for evergreen content, and reordering a 'scheduled' one is expected (the UI says so).
 */
export function postHasPublishingPublication(postId: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM publications WHERE post_id = ? AND status = 'publishing' LIMIT 1")
    .get(postId);
  return row !== undefined;
}

/**
 * Rewrite a post's slide order.
 *
 * `assetIds` MUST already have been checked against this post's current assets by
 * lib/asset-order.ts — this function trusts it completely and will happily write whatever
 * it is handed. Validation lives at the route because that is where the 400 is returned.
 *
 * DELETE-then-INSERT rather than a loop of UPDATEs, for the reason mergePostsIntoCarousel
 * documents: UNIQUE (post_id, sort_order) is checked per-row and immediately, so any
 * in-place shuffle collides at the first move. post_assets is (id, post_id, asset_id,
 * sort_order) and nothing references its id, so rebuilding the rows loses nothing. The
 * assets themselves are ON DELETE RESTRICT and are not reachable from here.
 */
export function reorderPostAssets(postId: number, assetIds: number[]): void {
  const db = getDb();
  const clear = db.prepare("DELETE FROM post_assets WHERE post_id = ?");
  const link = db.prepare(
    "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, ?)"
  );
  const touch = db.prepare("UPDATE posts SET updated_at = ? WHERE id = ?");
  const tx = db.transaction(() => {
    clear.run(postId);
    assetIds.forEach((assetId, index) => link.run(postId, assetId, index));
    touch.run(nowIso(), postId);
  });
  tx();
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/queries.reorder.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/lib/queries.reorder.test.ts
git commit -m "feat(library): reorder a post's slides at the database layer"
```

---

## Task 3: The API resource

**Files:**
- Create: `dashboard/app/api/posts/[id]/assets/route.ts`
- Test: `dashboard/test/assets-order-route.test.ts`

**Interfaces:**
- Consumes: `checkAssetOrder` (Task 1); `getPost`, `getPostAssets`, `reorderPostAssets`, `postHasPublishingPublication` (Task 2 + existing).
- Produces: the HTTP contract every UI task depends on —
  - `GET /api/posts/:id/assets` → `200 { assets: [{ id, media_kind, cover_frame_ms, width, height }] }` in `sort_order`.
  - `PATCH /api/posts/:id/assets` with `{ asset_ids: number[] }` → `200 { asset_ids: number[] }`.
  - Errors: `404 { error }` unknown post; `400 { error, code }` bad payload; `409 { error, code: "publishing" }` mid-publish.

**Note the App Router signature:** `params` is a **Promise** in Next 16 — `{ params }: { params: Promise<{ id: string }> }`, then `const { id } = await params`. Copy the shape from `app/api/posts/[id]/content/route.ts`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/test/assets-order-route.test.ts`. Pattern copied from `test/bulk-edit-route.test.ts` — note `makeTestDb()` runs at module top level *before* the dynamic imports, because `lib/config.ts` reads `DATABASE_PATH` once at load.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const route = await import("../app/api/posts/[id]/assets/route.ts");

let seq = 0;

function mkAsset(): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, 'image', ?, 1080, 1080)"
      )
      .run(`route-hash-${n}`, `a/route/${n}.jpg`).lastInsertRowid
  );
}

function mkCarousel(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: "carousel",
  });
}

function orderOf(postId: number): number[] {
  return q.getPostAssets(postId).map((a) => a.id);
}

const params = (postId: number | string) => ({ params: Promise.resolve({ id: String(postId) }) });

async function patch(postId: number | string, body: unknown) {
  return route.PATCH(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(postId)
  );
}

async function get(postId: number | string) {
  return route.GET(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets`),
    params(postId)
  );
}

test("GET returns the slides in order with what the lightbox needs", async () => {
  const ids = [mkAsset(), mkAsset(), mkAsset()];
  const post = mkCarousel(ids);

  const res = await get(post);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(
    body.assets.map((a: { id: number }) => a.id),
    ids
  );
  assert.deepEqual(Object.keys(body.assets[0]).sort(), [
    "cover_frame_ms",
    "height",
    "id",
    "media_kind",
    "width",
  ]);
});

test("PATCH saves a new order and reports it back", async () => {
  const ids = [mkAsset(), mkAsset(), mkAsset()];
  const post = mkCarousel(ids);

  const res = await patch(post, { asset_ids: [ids[2], ids[0], ids[1]] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).asset_ids, [ids[2], ids[0], ids[1]]);
  assert.deepEqual(orderOf(post), [ids[2], ids[0], ids[1]]);
});

test("an unknown post is a 404 on both verbs", async () => {
  assert.equal((await get(999999)).status, 404);
  assert.equal((await patch(999999, { asset_ids: [1] })).status, 404);
});

test("a non-numeric id is a 404, not a crash", async () => {
  assert.equal((await get("banana")).status, 404);
});

// The invariant. Each of these would change the slide count or the slide SET.
test("anything that is not a permutation is a 400 and writes nothing", async () => {
  const ids = [mkAsset(), mkAsset(), mkAsset()];
  const foreign = mkAsset();
  const post = mkCarousel(ids);

  for (const bad of [
    [ids[0], ids[1]],
    [...ids, foreign],
    [ids[0], ids[0], ids[1]],
    [ids[0], ids[1], foreign],
    [],
  ]) {
    const res = await patch(post, { asset_ids: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} should be a 400`);
    assert.deepEqual(orderOf(post), ids, "the saved order must be untouched");
  }
});

test("a malformed body is a 400, not a 500", async () => {
  const ids = [mkAsset(), mkAsset()];
  const post = mkCarousel(ids);

  assert.equal((await patch(post, {})).status, 400);
  assert.equal((await patch(post, { asset_ids: "1,2" })).status, 400);
  assert.equal((await patch(post, { asset_ids: [1.5, 2] })).status, 400);
  assert.deepEqual(orderOf(post), ids);
});

test("a post that is mid-publish is refused with 409 and is not rewritten", async () => {
  const ids = [mkAsset(), mkAsset()];
  const post = mkCarousel(ids);
  const channel = q.createChannel({
    platform: "instagram",
    display_name: `route-ch-${++seq}`,
    account_ref: `route-acct-${seq}`,
  });
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, status, scheduled_for)
     VALUES (?, ?, 'publishing', '2030-01-01T00:00:00Z')`
  ).run(post, channel.id);

  const res = await patch(post, { asset_ids: [ids[1], ids[0]] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "publishing");
  assert.deepEqual(orderOf(post), ids);
});

test("a queued send does NOT block a reorder — spec §4", async () => {
  const ids = [mkAsset(), mkAsset()];
  const post = mkCarousel(ids);
  const channel = q.createChannel({
    platform: "instagram",
    display_name: `route-queued-${++seq}`,
    account_ref: `route-queued-acct-${seq}`,
  });
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, status, scheduled_for)
     VALUES (?, ?, 'scheduled', '2030-01-01T00:00:00Z')`
  ).run(post, channel.id);

  assert.equal((await patch(post, { asset_ids: [ids[1], ids[0]] })).status, 200);
  assert.deepEqual(orderOf(post), [ids[1], ids[0]]);
});

test("a single-image post can be 'reordered' to itself without error", async () => {
  const only = mkAsset();
  const post = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [only] });
  assert.equal((await patch(post, { asset_ids: [only] })).status, 200);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/assets-order-route.test.ts
```

Expected: FAIL — cannot resolve `../app/api/posts/[id]/assets/route.ts`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/app/api/posts/[id]/assets/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  getPost,
  getPostAssets,
  postHasPublishingPublication,
  reorderPostAssets,
} from "@/lib/queries";
import { checkAssetOrder } from "@/lib/asset-order";

export const runtime = "nodejs";

/**
 * A post's slides, in order.
 *
 * Two consumers, both of which need one post's slides and neither of which can get them
 * from the Library list query: the quick-edit dialog (which already lazy-loads its
 * captions from /content the same way) and the Library card's lightbox. listPosts()
 * already carries asset_ids_csv, but not each slide's media_kind/width/height — adding
 * those as four more GROUP_CONCAT subqueries would ship every slide's metadata for every
 * card on every Library load to serve a dialog that opens one post at a time.
 *
 * The field list is deliberately exactly LightboxAsset plus nothing: no storage_path, no
 * public_url, no content_hash. This is a browser-facing read.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId) || !getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  return NextResponse.json({
    assets: getPostAssets(postId).map((a) => ({
      id: a.id,
      media_kind: a.media_kind,
      cover_frame_ms: a.cover_frame_ms,
      width: a.width,
      height: a.height,
    })),
  });
}

/**
 * Reorder a post's slides. Body: { asset_ids: [12, 9, 30] } — the complete new order.
 *
 * The single write path for slide order, shared by the post detail page and the Library's
 * quick-edit dialog. It reorders and does nothing else: `asset_ids` must be a permutation
 * of what the post already has, so the slide count cannot change, so posts.post_type
 * cannot go stale. Adding or removing slides is a bigger operation (it moves post_type and
 * re-runs platform compatibility) and is deliberately not this endpoint.
 *
 * Everything is checked before anything is written.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId) || !getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return NextResponse.json(
      { error: "Expected a JSON body with asset_ids.", code: "bad_body" },
      { status: 400 }
    );
  }

  const current = getPostAssets(postId).map((a) => a.id);
  const checked = checkAssetOrder(current, (body as { asset_ids?: unknown }).asset_ids);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error, code: checked.code }, { status: 400 });
  }

  // Last, because it is the only check that can go stale between here and the write — and
  // the one that matters: the worker is reading post_assets for this post right now to
  // build a container. Rewriting the rows underneath it is the single way a reorder can
  // produce a genuinely wrong published carousel.
  if (postHasPublishingPublication(postId)) {
    return NextResponse.json(
      {
        error: "This post is being published right now. Try again once that send finishes.",
        code: "publishing",
      },
      { status: 409 }
    );
  }

  reorderPostAssets(postId, checked.asset_ids);
  return NextResponse.json({ asset_ids: checked.asset_ids });
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/assets-order-route.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Run the whole suite and lint**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

Expected: all green. **Phase 1 gate — do not start Task 4 until this passes.**

- [ ] **Step 6: Commit**

```bash
git add "dashboard/app/api/posts/[id]/assets/route.ts" dashboard/test/assets-order-route.test.ts
git commit -m "feat(library): add GET/PATCH /api/posts/:id/assets for slide order"
```

---

## Task 4: The shared reorder UI

**Files:**
- Create: `dashboard/components/carousel-reorder.tsx`
- Create: `dashboard/test-ui/carousel-reorder-ui.test.ts`
- Modify: `dashboard/package.json` (test script)

**Interfaces:**
- Consumes: `SlideReorder`, `Slide` from `@/components/slide-reorder` (existing, unchanged); the `PATCH` contract from Task 3.
- Produces:
  - `interface OrderableAsset { id: number; media_kind: "image" | "video" }`
  - `useAssetOrder(postId: number, assets: OrderableAsset[])` → `{ order: number[]; setOrder: (next: number[]) => void; isDirty: boolean; reset: () => void; save: () => Promise<boolean>; error: string | null }`
  - `CarouselReorder({ assets, order, onOrderChange, queuedSendCount }: { assets: OrderableAsset[]; order: number[]; onOrderChange: (next: number[]) => void; queuedSendCount: number })`

**Why a hook plus a dumb component, rather than one self-saving component:** the two homes disagree about *when* to save. The detail page has its own Save button; the quick-edit dialog has exactly one Save and a confirm-on-discard flow, and bolting a second independently-saving control inside it is how work gets silently lost. So the hook owns the state and the one `fetch` (nothing is duplicated), and each host owns its own button. `SlideReorder` stays untouched — it deliberately knows only `{ assetId, label }`.

- [ ] **Step 1: Widen the test-ui glob so new UI tests actually run**

In `dashboard/package.json`, replace the two explicitly-listed `test-ui` files with a glob, matching how the other half of the script already works:

```json
"test": "node --import ./test/ui-hook.mjs --test --test-concurrency=1 \"test-ui/*.test.ts\" && node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 \"lib/*.test.ts\" \"test/*.test.ts\""
```

Verify the existing two UI tests still run:

```bash
cd dashboard && npm test 2>&1 | tail -20
```

Expected: the same test count as before this change (nothing lost by globbing).

- [ ] **Step 2: Write the failing test**

Create `dashboard/test-ui/carousel-reorder-ui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CarouselReorder, type OrderableAsset } from "../components/carousel-reorder.tsx";

const noop = () => {};
const assets: OrderableAsset[] = [
  { id: 11, media_kind: "image" },
  { id: 22, media_kind: "image" },
  { id: 33, media_kind: "image" },
];

function render(order: number[], queuedSendCount = 0) {
  return renderToStaticMarkup(
    React.createElement(CarouselReorder, {
      assets,
      order,
      onOrderChange: noop,
      queuedSendCount,
    })
  );
}

test("slides render in the order given, not in the order of the assets prop", () => {
  const html = render([33, 11, 22]);
  const positions = [11, 22, 33].map((id) => html.indexOf(`/api/media/${id}?variant=thumb`));
  assert.ok(positions.every((p) => p > -1), "every slide has a thumbnail");
  // 33 first, then 11, then 22.
  assert.ok(positions[2] < positions[0], "33 renders before 11");
  assert.ok(positions[0] < positions[1], "11 renders before 22");
});

test("every slide is shown — no slice(0, 4) like the old read-only strip", () => {
  const many: OrderableAsset[] = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i,
    media_kind: "image",
  }));
  const html = renderToStaticMarkup(
    React.createElement(CarouselReorder, {
      assets: many,
      order: many.map((a) => a.id),
      onOrderChange: noop,
      queuedSendCount: 0,
    })
  );
  for (const a of many) {
    assert.ok(html.includes(`/api/media/${a.id}?variant=thumb`), `slide ${a.id} is missing`);
  }
});

test("queued sends are named before you save, and pluralised", () => {
  assert.match(render([11, 22, 33], 3), /3 queued sends will go out in this order/);
  assert.match(render([11, 22, 33], 1), /1 queued send will go out in this order/);
});

test("with no queued sends there is no notice at all", () => {
  assert.doesNotMatch(render([11, 22, 33], 0), /queued send/);
});

// An order that names an asset the post no longer has must not blow up mid-render.
test("an unknown id in the order is skipped rather than thrown on", () => {
  const html = render([11, 999, 22, 33]);
  assert.ok(html.includes("/api/media/11?variant=thumb"));
  assert.ok(!html.includes("/api/media/999?variant=thumb"));
});
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/carousel-reorder-ui.test.ts
```

Expected: FAIL — cannot resolve `../components/carousel-reorder.tsx`.

- [ ] **Step 4: Write the implementation**

Create `dashboard/components/carousel-reorder.tsx`:

```tsx
"use client";

import { useState } from "react";
import { SlideReorder, type Slide } from "@/components/slide-reorder";

/** The least a slide needs to be reordered and drawn. Matches what GET /assets returns. */
export interface OrderableAsset {
  id: number;
  media_kind: "image" | "video";
}

/**
 * Slide-order state and the one PATCH that saves it.
 *
 * Lives in a hook rather than inside <CarouselReorder> because the two screens that can
 * reorder disagree about when saving happens: the post detail page has its own Save
 * button, while the quick-edit dialog saves everything through a single Save and would
 * quietly lose work if a control inside it saved on its own schedule. The hook is what
 * keeps the write itself singular; the button belongs to whoever is hosting it.
 */
export function useAssetOrder(postId: number, assets: OrderableAsset[]) {
  const savedOrder = assets.map((a) => a.id);
  const [order, setOrder] = useState<number[]>(savedOrder);
  const [error, setError] = useState<string | null>(null);

  // String compare rather than element-wise: order is a small array of numbers, and this
  // reads as "is it the same list in the same sequence", which is exactly the question.
  const isDirty = order.join(",") !== savedOrder.join(",");

  /** Resolves true when the order is saved — or when there was nothing to save. */
  async function save(): Promise<boolean> {
    if (!isDirty) return true;
    setError(null);
    try {
      const res = await fetch(`/api/posts/${postId}/assets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_ids: order }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Could not save the slide order.");
        return false;
      }
      return true;
    } catch {
      setError("Could not confirm whether the slide order saved. Reload the page to check.");
      return false;
    }
  }

  return {
    order,
    setOrder,
    isDirty,
    reset: () => {
      setOrder(savedOrder);
      setError(null);
    },
    save,
    error,
  };
}

/**
 * The reorder grid for a carousel that already exists, plus the one thing the user needs
 * told before they save it. Controlled — it holds no state of its own, so the host can
 * decide when the order is written (see useAssetOrder above).
 */
export function CarouselReorder({
  assets,
  order,
  onOrderChange,
  queuedSendCount,
}: {
  assets: OrderableAsset[];
  order: number[];
  onOrderChange: (next: number[]) => void;
  queuedSendCount: number;
}) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  // An id in `order` that no longer exists on the post is dropped rather than rendered as
  // a broken thumbnail. It shouldn't happen — the PATCH refuses non-permutations — but a
  // stale prop mid-refresh must not take the page down.
  const slides: Slide[] = order
    .filter((id) => byId.has(id))
    .map((id, index) => ({ assetId: id, label: `Slide ${index + 1}` }));

  return (
    <div className="space-y-2">
      <SlideReorder
        slides={slides}
        onReorder={(next) => onOrderChange(next.map((s) => s.assetId))}
      />
      {queuedSendCount > 0 ? (
        <p className="data text-[11px] text-muted">
          {queuedSendCount} queued send{queuedSendCount === 1 ? "" : "s"} will go out in this
          order.
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/carousel-reorder-ui.test.ts
```

Expected: PASS, 5 tests. If the pluralisation assertions fail on whitespace, the JSX line-wrap has inserted a newline inside the sentence — join the string onto one line rather than loosening the assertion.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/carousel-reorder.tsx dashboard/test-ui/carousel-reorder-ui.test.ts dashboard/package.json
git commit -m "feat(library): shared carousel reorder grid and order-saving hook"
```

---

## Task 5: Reorder on the post detail page

**Files:**
- Modify: `dashboard/components/post-editor.tsx` (the read-only context strip, ~lines 191–247)

**Interfaces:**
- Consumes: `useAssetOrder`, `CarouselReorder` (Task 4). `PostEditor` already receives `post: Post`, `assets: Asset[]`, and `sends: PostPublicationRow[]`.
- Produces: nothing other tasks depend on.

**What changes:** today the strip renders `assets.slice(0, 4)` read-only — a 10-slide carousel shows 4 thumbnails and hides 6. For `post.post_type === "carousel"` that becomes the reorder block showing **all** slides, with its own Save/Reset. Singles and Reels keep the existing strip exactly as it is, including `CoverFramePicker` and `ConformControl`.

- [ ] **Step 1: Read the surrounding code**

Read `dashboard/components/post-editor.tsx` lines 1–60 (props, imports) and 182–260 (the strip). Confirm the field name for a send's status on `PostPublicationRow` by checking its definition in `lib/queries.ts` — the step below assumes `status`.

- [ ] **Step 2: Add the imports**

Near the other component imports at the top of `post-editor.tsx`:

```tsx
import { CarouselReorder, useAssetOrder } from "@/components/carousel-reorder";
```

- [ ] **Step 3: Add the hook and its save handler**

Inside `PostEditor`, alongside the other `useState` declarations:

```tsx
// Slide order is only editable for a carousel: a single or a Reel has one slide, and
// there is nothing to order. Hooks can't be conditional, so this always runs and the
// carousel check happens at render.
const slideOrder = useAssetOrder(post.id, assets);
const [savingOrder, setSavingOrder] = useState(false);
const isCarousel = post.post_type === "carousel" && assets.length > 1;
const queuedSendCount = sends.filter(
  (s) => s.status === "scheduled" || s.status === "pending_approval"
).length;

async function saveSlideOrder() {
  if (savingOrder) return;
  setSavingOrder(true);
  const ok = await slideOrder.save();
  setSavingOrder(false);
  // Re-fetch so the strip, the send panel, and anything else reading assets agree with
  // what was just written — the same refresh the caption save already does.
  if (ok) startTransition(() => router.refresh());
}
```

- [ ] **Step 4: Render the reorder block for carousels**

Replace the `<div className="flex gap-2">…</div>` that wraps the `assets.slice(0, 4)` map with a conditional. The non-carousel branch is the **existing markup, moved unchanged**:

```tsx
{isCarousel ? (
  <div className="space-y-2">
    <CarouselReorder
      assets={assets}
      order={slideOrder.order}
      onOrderChange={slideOrder.setOrder}
      queuedSendCount={queuedSendCount}
    />
    {slideOrder.error ? (
      <p className="text-xs text-status-failed">{slideOrder.error}</p>
    ) : null}
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={saveSlideOrder}
        disabled={!slideOrder.isDirty || savingOrder}
        className="rounded-md border border-border px-2.5 py-1 text-xs text-ink transition-colors hover:bg-surface-sunken disabled:opacity-40"
      >
        {savingOrder ? "Saving…" : "Save order"}
      </button>
      <button
        type="button"
        onClick={slideOrder.reset}
        disabled={!slideOrder.isDirty || savingOrder}
        className="rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-ink disabled:opacity-40"
      >
        Reset
      </button>
    </div>
  </div>
) : (
  <div className="flex gap-2">
    {/* ...the existing strip, unchanged... */}
  </div>
)}
```

- [ ] **Step 5: Typecheck and lint**

```bash
cd dashboard && npx tsc --noEmit && npm run lint
```

Expected: clean. A complaint about `startTransition`/`router` means they're named differently in this file — use whatever the existing `save()` uses (see ~line 165).

- [ ] **Step 6: Verify it in the browser**

Start the dev server (port 3939 — see `.claude/launch.json`) and open a carousel post's detail page.

- All slides appear (find a post with more than 4 to prove the `slice(0, 4)` limit is gone).
- Drag slide 3 to the front; **Save order** enables; **Reset** puts it back and disables both.
- Save, then hard-reload the page: the new order persists.
- Open a **single-image** post and a **Reel**: unchanged, cover-frame picker still works.

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/post-editor.tsx
git commit -m "feat(library): reorder carousel slides from the post detail page"
```

---

## Task 6: Reorder in the Library quick-edit dialog

**Files:**
- Modify: `dashboard/components/quick-edit-modal.tsx`
- Modify: `dashboard/components/library-view.tsx` (pass two new props at the `QuickEditModal` call site, ~line 875)

**Interfaces:**
- Consumes: `useAssetOrder`, `CarouselReorder` (Task 4); `GET /api/posts/:id/assets` (Task 3).
- Produces: `QuickEditPost` gains `asset_count: number` and `scheduled_count: number`.

**Save ordering is load-bearing:** the order `PATCH` runs **first** and aborts the save if it fails. It is the request that can 409, so failing first leaves nothing written. (A content failure *after* a successful reorder leaves the reorder applied — visible, non-destructive, retryable. That is the cheaper way to be wrong, and it is a deliberate choice, not an oversight.)

- [ ] **Step 1: Extend the props**

In `quick-edit-modal.tsx`, add to the `QuickEditPost` interface:

```ts
  /** How many slides — the dialog only offers reordering for a real carousel. */
  asset_count: number;
  /** Queued sends, so the reorder block can say they'll go out in the new order. */
  scheduled_count: number;
```

In `library-view.tsx` at the `QuickEditModal` call site, add to the `post={{ … }}` object:

```tsx
            asset_count: quickEditPost.asset_count,
            scheduled_count: quickEditPost.scheduled_count,
```

- [ ] **Step 2: Load the slides on open**

Add the import:

```tsx
import { CarouselReorder, useAssetOrder, type OrderableAsset } from "@/components/carousel-reorder";
```

Add state next to the caption state, and a loader modelled on the existing `loadCaptions` effect (same `AbortController` shape, same "stay silent on abort" rule):

```tsx
  const isCarousel = post.post_type === "carousel" && post.asset_count > 1;
  // null until the fetch lands. While it is null there is nothing to reorder and nothing
  // to save — exactly like openedCaptions above.
  const [orderAssets, setOrderAssets] = useState<OrderableAsset[] | null>(null);

  useEffect(() => {
    if (!isCarousel) return;
    const controller = new AbortController();
    async function loadAssets() {
      try {
        const res = await fetch(`/api/posts/${post.id}/assets`, { signal: controller.signal });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(body.assets)) return;
        setOrderAssets(body.assets);
      } catch {
        // A failed load leaves the dialog exactly as it is today: captions and scheduling
        // still work, there is simply no reorder block. Not worth an error banner.
      }
    }
    loadAssets();
    return () => controller.abort();
  }, [post.id, isCarousel]);

  const slideOrder = useAssetOrder(post.id, orderAssets ?? []);
```

- [ ] **Step 3: Fold the order into the dirty check**

Extend the existing `isDirty` expression (~line 146) with one more clause:

```tsx
    slideOrder.isDirty ||
```

This makes closing the dialog after only reordering ask before discarding, like every other field.

- [ ] **Step 4: Save the order first**

In `save()`, immediately after `setError(null)` and before the `/content` fetch:

```tsx
      // First, and abort on failure. This is the request that can 409 (the post is being
      // published right now), so failing here leaves nothing at all written.
      if (!(await slideOrder.save())) {
        setError(slideOrder.error ?? "Could not save the slide order.");
        return;
      }
```

`setSaving(false)` already runs in the `finally`, so the early return is safe.

- [ ] **Step 5: Render the block**

Inside the dialog body, above the caption editor:

```tsx
        {isCarousel && orderAssets ? (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted">Slide order</h3>
            <CarouselReorder
              assets={orderAssets}
              order={slideOrder.order}
              onOrderChange={slideOrder.setOrder}
              queuedSendCount={post.scheduled_count}
            />
          </div>
        ) : null}
```

- [ ] **Step 6: Typecheck, lint, and run the suite**

```bash
cd dashboard && npx tsc --noEmit && npm run lint && npm test
```

Expected: clean, all tests pass.

- [ ] **Step 7: Verify it in the browser**

- Open quick edit on a carousel: the slide order block appears a beat after the dialog.
- Open quick edit on a single-image post: **no** reorder block, dialog otherwise unchanged.
- Reorder, then press Escape: the discard prompt appears (it counts as dirty).
- Reorder **and** change a tag, press Save: the list reflects both after it closes; reload and confirm the order persisted.
- Reorder only, Save: works with no caption changes.

- [ ] **Step 8: Commit**

```bash
git add dashboard/components/quick-edit-modal.tsx dashboard/components/library-view.tsx
git commit -m "feat(library): reorder carousel slides from quick edit"
```

**Phase 2 gate.** Both homes reorder, one write path, `npm test` green.

---

## Task 7: Lightbox index stepping

**Files:**
- Create: `dashboard/lib/lightbox-nav.ts`
- Test: `dashboard/lib/lightbox-nav.test.ts`

**Interfaces:**
- Produces: `stepIndex(current: number, delta: number, length: number): number` — clamped to the ends, **never wraps**.

**Why no wrap:** the ends of a carousel are meaningful. Silently looping from slide 7 back to slide 1 hides where you are in the sequence.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/lightbox-nav.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepIndex } from "./lightbox-nav.ts";

test("stepping moves one slide at a time in both directions", () => {
  assert.equal(stepIndex(0, 1, 5), 1);
  assert.equal(stepIndex(3, 1, 5), 4);
  assert.equal(stepIndex(3, -1, 5), 2);
});

test("the ends clamp rather than wrap — a carousel has a start and an end", () => {
  assert.equal(stepIndex(0, -1, 5), 0);
  assert.equal(stepIndex(4, 1, 5), 4);
});

test("a single slide never moves", () => {
  assert.equal(stepIndex(0, 1, 1), 0);
  assert.equal(stepIndex(0, -1, 1), 0);
});

test("degenerate inputs return a usable index instead of NaN or -1", () => {
  assert.equal(stepIndex(0, 1, 0), 0);
  assert.equal(stepIndex(9, -1, 0), 0);
  // An index left over from a longer list (the post lost a slide under us).
  assert.equal(stepIndex(9, 1, 3), 2);
  assert.equal(stepIndex(-4, 1, 3), 0);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/lightbox-nav.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `dashboard/lib/lightbox-nav.ts`:

```ts
/**
 * The next slide index for a step of `delta`, clamped to the ends.
 *
 * Deliberately does not wrap. The ends of a carousel are meaningful — looping silently
 * from the last slide back to the first hides where you are in the sequence, which is
 * most of what the viewer is there to find out.
 *
 * Also clamps `current` itself, so an index left over from a longer list (the post lost a
 * slide while the lightbox was open) resolves to something in range instead of undefined.
 */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const last = length - 1;
  const next = Math.min(Math.max(current, 0), last) + delta;
  return Math.min(Math.max(next, 0), last);
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/lightbox-nav.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/lightbox-nav.ts dashboard/lib/lightbox-nav.test.ts
git commit -m "feat(library): clamped slide stepping for the lightbox"
```

---

## Task 8: Multi-asset lightbox

**Files:**
- Modify: `dashboard/components/media-lightbox.tsx`
- Modify: `dashboard/components/post-editor.tsx` (call site, ~line 185)
- Modify: `dashboard/components/media-manager.tsx` (call site, ~line 170)
- Test: `dashboard/test-ui/media-lightbox-ui.test.ts`

**Interfaces:**
- Consumes: `stepIndex` (Task 7); existing `LightboxAsset`, `videoPreviewSrc`.
- Produces:
  - `MediaLightbox({ assets: LightboxAsset[]; initialIndex?: number; label: string; onClose: () => void })` — **replaces** the `asset: LightboxAsset` prop.
  - `LightboxPanel` — the panel markup, exported for testing.

**Why `LightboxPanel` is extracted:** `MediaLightbox` renders through `createPortal`, which `react-dom/server` cannot render, so the markup is untestable while it lives inside the portal. Splitting the panel out keeps `MediaLightbox` responsible for the portal, focus trap, key handling, and index state, and makes what's on screen assertable. Both stay in one file — they change together.

- [ ] **Step 1: Write the failing test**

Create `dashboard/test-ui/media-lightbox-ui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LightboxPanel } from "../components/media-lightbox.tsx";
import type { LightboxAsset } from "../components/media-lightbox.tsx";

const noop = () => {};
const img = (id: number): LightboxAsset => ({
  id,
  media_kind: "image",
  cover_frame_ms: null,
  width: 1080,
  height: 1080,
});

function render(assets: LightboxAsset[], index = 0) {
  return renderToStaticMarkup(
    React.createElement(LightboxPanel, {
      assets,
      index,
      label: "A post",
      mediaError: false,
      onClose: noop,
      onStep: noop,
      onMediaError: noop,
      panelRef: React.createRef<HTMLDivElement>(),
    })
  );
}

test("a single asset shows no navigation at all — nothing changes for existing callers", () => {
  const html = render([img(5)]);
  assert.ok(html.includes("/api/media/5"));
  assert.doesNotMatch(html, /aria-label="Next slide"/);
  assert.doesNotMatch(html, /aria-label="Previous slide"/);
  assert.doesNotMatch(html, /1 \/ 1/);
});

test("a carousel shows the current slide, a counter, and both arrows", () => {
  const html = render([img(1), img(2), img(3)], 1);
  assert.ok(html.includes("/api/media/2"), "the CURRENT slide is the one rendered");
  assert.match(html, /aria-label="Previous slide"/);
  assert.match(html, /aria-label="Next slide"/);
  assert.match(html, /2 \/ 3/);
});

test("the first slide disables Previous and the last disables Next", () => {
  const first = render([img(1), img(2), img(3)], 0);
  assert.match(first, /aria-label="Previous slide"[^>]*disabled/);
  assert.doesNotMatch(first, /aria-label="Next slide"[^>]*disabled/);

  const last = render([img(1), img(2), img(3)], 2);
  assert.match(last, /aria-label="Next slide"[^>]*disabled/);
  assert.doesNotMatch(last, /aria-label="Previous slide"[^>]*disabled/);
});

test("a video slide renders a player with controls, not an img", () => {
  const html = render([{ ...img(9), media_kind: "video", cover_frame_ms: 400 }]);
  assert.match(html, /<video/);
  assert.match(html, /controls/);
});

test("an empty asset list renders nothing rather than crashing", () => {
  assert.doesNotThrow(() => render([]));
});
```

> The `disabled` assertions depend on attribute order in React's output. If they fail, check the rendered HTML and match on what's actually emitted (e.g. `/Previous slide"\s+disabled/`) — do not weaken the assertion to "the button exists".

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/media-lightbox-ui.test.ts
```

Expected: FAIL — `LightboxPanel` is not exported.

- [ ] **Step 3: Extract `LightboxPanel`**

In `media-lightbox.tsx`, add prev/next glyphs beside the existing `CloseGlyph`, then move the panel's markup into an exported component. It receives everything it needs and owns no state:

```tsx
function ChevronGlyph({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={direction === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

/** The panel itself: media, close, and — for a carousel — the slide navigation.
 *  Stateless and portal-free so it can be rendered in a test; MediaLightbox below owns
 *  the portal, the focus trap, the key handling, and which slide is showing. */
export function LightboxPanel({
  assets,
  index,
  label,
  mediaError,
  onClose,
  onStep,
  onMediaError,
  panelRef,
  onVideoPlay,
}: {
  assets: LightboxAsset[];
  index: number;
  label: string;
  mediaError: boolean;
  onClose: () => void;
  onStep: (delta: number) => void;
  onMediaError: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  onVideoPlay?: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
}) {
  const asset = assets[index];
  if (!asset) return null;
  const many = assets.length > 1;
  const navButton =
    "absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-ink shadow-lg transition-opacity hover:bg-surface-sunken disabled:opacity-30";

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      className="relative max-h-full max-w-full"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-ink shadow-lg hover:bg-surface-sunken"
      >
        <CloseGlyph />
      </button>

      {many ? (
        <>
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={index === 0}
            aria-label="Previous slide"
            title="Previous slide"
            className={`${navButton} -left-4`}
          >
            <ChevronGlyph direction="left" />
          </button>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={index === assets.length - 1}
            aria-label="Next slide"
            title="Next slide"
            className={`${navButton} -right-4`}
          >
            <ChevronGlyph direction="right" />
          </button>
          <span className="data absolute -bottom-7 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-2.5 py-0.5 text-xs text-white">
            {index + 1} / {assets.length}
          </span>
        </>
      ) : null}

      {mediaError ? (
        <p className="max-w-sm rounded-card border border-border bg-surface px-6 py-8 text-sm text-status-failed">
          Couldn&apos;t load this file — it may be missing, or (for a video saved before
          automatic conversion existed) in a format this browser can&apos;t play.
        </p>
      ) : asset.media_kind === "video" ? (
        <video
          key={asset.id}
          src={videoPreviewSrc(asset.id, asset.cover_frame_ms)}
          controls
          playsInline
          autoPlay={false}
          onError={onMediaError}
          onPlay={onVideoPlay}
          className="max-h-[85vh] max-w-[90vw] rounded-card bg-black"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={asset.id}
          src={`/api/media/${asset.id}`}
          alt={label}
          onError={onMediaError}
          className="max-h-[85vh] max-w-[90vw] rounded-card object-contain"
        />
      )}
    </div>
  );
}
```

The `key={asset.id}` on the media element is load-bearing: without it React reuses the same `<img>`/`<video>` across slides and the browser paints the previous frame until the new file decodes.

- [ ] **Step 4: Rewrite `MediaLightbox` around it**

Keep the existing focus-trap effect exactly as it is (including its comment about reading `onClose` through a ref, and its empty dependency array). Change the props and add index state, key handling, swipe, and preload:

```tsx
export function MediaLightbox({
  assets,
  initialIndex = 0,
  label,
  onClose,
}: {
  assets: LightboxAsset[];
  initialIndex?: number;
  label: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const hasPlayed = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [index, setIndex] = useState(() => stepIndex(initialIndex, 0, assets.length));
  const [mediaError, setMediaError] = useState(false);

  // The list can grow under us: the Library card opens on slide 1 with the one asset it
  // already had, then extends to the full carousel when its fetch lands. Reading through
  // stepIndex keeps the index in range through that, and through a post losing a slide.
  const safeIndex = stepIndex(index, 0, assets.length);
  const asset = assets[safeIndex];

  // Kept in a ref so the key handler (installed once, below) always steps from the
  // current slide rather than from whichever one it closed over on mount.
  const stateRef = useRef({ index: safeIndex, length: assets.length });
  stateRef.current = { index: safeIndex, length: assets.length };

  const step = useCallback((delta: number) => {
    const { index: from, length } = stateRef.current;
    const next = stepIndex(from, delta, length);
    if (next === from) return;
    // A new slide is a new file: whatever failed to load on the last one says nothing
    // about this one, and a video's "have we played yet" bookkeeping starts over.
    setMediaError(false);
    hasPlayed.current = false;
    setIndex(next);
  }, []);
```

Extend the **existing** keydown handler inside the focus-trap effect, immediately after the `Escape` branch:

```tsx
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Arrow keys already mean "seek" inside a video player, and the player's own
        // controls must keep working — only steal them when focus is elsewhere.
        const target = e.target as HTMLElement | null;
        if (target?.closest("video")) return;
        if (stateRef.current.length < 2) return;
        e.preventDefault();
        step(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
```

`step` is stable (`useCallback` with no deps) and `stateRef` is a ref, so the effect's empty dependency array stays correct — do not add either to it.

Preload the neighbours so flipping is instant:

```tsx
  useEffect(() => {
    for (const neighbour of [assets[safeIndex - 1], assets[safeIndex + 1]]) {
      if (neighbour && neighbour.media_kind === "image") {
        // Warming the browser cache only — the element is deliberately never mounted.
        const preload = new window.Image();
        preload.src = `/api/media/${neighbour.id}`;
      }
    }
  }, [assets, safeIndex]);
```

Swipe, on the backdrop. One gesture advances one slide:

```tsx
  const touchStartX = useRef<number | null>(null);
  const lastWheelStep = useRef(0);
  const SWIPE_PX = 50;

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    const from = touchStartX.current;
    touchStartX.current = null;
    if (from === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? from) - from;
    if (Math.abs(dx) < SWIPE_PX) return;
    step(dx < 0 ? 1 : -1);
  }
  function onWheel(e: React.WheelEvent) {
    // A Mac trackpad's two-finger horizontal swipe arrives as a stream of wheel events,
    // so without the cooldown one flick would run through the whole carousel. Vertical
    // scroll is ignored outright: the page behind is already locked.
    if (Math.abs(e.deltaX) < 30 || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const now = Date.now();
    if (now - lastWheelStep.current < 350) return;
    lastWheelStep.current = now;
    step(e.deltaX > 0 ? 1 : -1);
  }
```

And the render:

```tsx
  if (!asset) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onWheel={onWheel}
    >
      <LightboxPanel
        assets={assets}
        index={safeIndex}
        label={label}
        mediaError={mediaError}
        onClose={onClose}
        onStep={step}
        onMediaError={() => setMediaError(true)}
        panelRef={panelRef}
        onVideoPlay={(e) => {
          // Unchanged behaviour, moved: the #t= fragment seeks to the cover frame so the
          // video OPENS there (and so Safari paints anything at all), but that is a poster
          // position, not a playback position. Rewind on first play only, and only if the
          // playhead is still where the fragment put it — if the viewer scrubbed somewhere
          // themselves and then pressed play, that is where they meant to start.
          if (hasPlayed.current) return;
          hasPlayed.current = true;
          const video = e.currentTarget;
          const coverSeconds = (asset.cover_frame_ms ?? 0) / 1000;
          if (coverSeconds > 0 && Math.abs(video.currentTime - coverSeconds) < 0.5) {
            video.currentTime = 0;
          }
        }}
      />
    </div>,
    document.body
  );
}
```

Update the imports at the top of the file: add `useCallback` to the `react` import and `import { stepIndex } from "@/lib/lightbox-nav";`.

- [ ] **Step 5: Update the two existing call sites**

`post-editor.tsx` (~line 185) and `media-manager.tsx` (~line 170) both pass one asset. Change `asset={openMedia.asset}` to:

```tsx
          assets={[openMedia.asset]}
```

- [ ] **Step 6: Run the tests, typecheck, lint**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/media-lightbox-ui.test.ts && npx tsc --noEmit && npm run lint
```

Expected: PASS, 5 tests, clean typecheck. A type error at a call site means one was missed — `grep -rn "MediaLightbox" dashboard/components`.

- [ ] **Step 7: Verify in the browser**

The post detail page and the media manager still open a single asset: Escape closes, focus returns, a Reel plays from the start with sound, **no** arrows or counter appear.

- [ ] **Step 8: Commit**

```bash
git add dashboard/components/media-lightbox.tsx dashboard/components/post-editor.tsx dashboard/components/media-manager.tsx dashboard/test-ui/media-lightbox-ui.test.ts
git commit -m "feat(library): lightbox flips through multiple slides"
```

---

## Task 9: The Library card — stack and swipe

**Files:**
- Create: `dashboard/components/carousel-stack.tsx`
- Create: `dashboard/test-ui/carousel-stack-ui.test.ts`
- Modify: `dashboard/components/library-view.tsx`

**Interfaces:**
- Consumes: `MediaLightbox` with `assets` (Task 8); `GET /api/posts/:id/assets` (Task 3).
- Produces: `CarouselStack({ count, children }: { count: number; children: ReactNode })`.

**The clipping trap:** the existing thumbnail wrapper is `overflow-hidden` (`library-view.tsx:538`), so offset layers rendered *inside* it are invisible. `CarouselStack` must wrap **around** that div. The card's `p-3` padding leaves room for the offsets.

- [ ] **Step 1: Write the failing test**

Create `dashboard/test-ui/carousel-stack-ui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CarouselStack } from "../components/carousel-stack.tsx";

const thumb = React.createElement("div", { "data-testid": "thumb" }, "thumb");

test("a single-image post is passed straight through, with nothing added", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 1 }, thumb));
  assert.equal(html, renderToStaticMarkup(thumb));
});

test("a carousel gets a count chip and layers behind the thumbnail", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 5 }, thumb));
  assert.ok(html.includes("thumb"), "the thumbnail is still rendered");
  assert.match(html, />5</);
  assert.match(html, /aria-hidden/, "the decorative layers are hidden from screen readers");
});

test("the count is announced, not left as a bare number", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 5 }, thumb));
  assert.match(html, /5 slides/);
});

test("a zero or negative count is treated as no stack", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 0 }, thumb));
  assert.equal(html, renderToStaticMarkup(thumb));
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/carousel-stack-ui.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `dashboard/components/carousel-stack.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * The "stack of paper" treatment that makes a carousel recognisable in the Library at a
 * glance, without reading text.
 *
 * The layers are empty elements, not thumbnails. Rendering slides 2 and 3 for real would
 * look better and would triple the Library's image requests — a few hundred extra fetches
 * on every load of a list whose whole job is to be skimmed.
 *
 * This wraps AROUND the thumbnail's container rather than sitting inside it: that
 * container is overflow-hidden, so layers placed within it would be clipped to exactly
 * the thumbnail's bounds and never seen.
 */
export function CarouselStack({ count, children }: { count: number; children: ReactNode }) {
  if (count <= 1) return <>{children}</>;

  return (
    <div className="relative shrink-0">
      <span
        aria-hidden
        className="absolute left-1.5 top-1.5 h-full w-full rounded-md border border-border bg-surface-sunken"
      />
      <span
        aria-hidden
        className="absolute left-0.5 top-0.5 h-full w-full rounded-md border border-border bg-surface"
      />
      {/* Positioned so it paints above the two layers, which are absolute and would
          otherwise sit on top of the (unpositioned) thumbnail. */}
      <div className="relative">{children}</div>
      <span className="data absolute -right-1 -top-1 z-10 rounded-full bg-ink px-1.5 py-px text-[10px] font-medium text-surface">
        <span aria-hidden>{count}</span>
        <span className="sr-only">{count} slides</span>
      </span>
    </div>
  );
}
```

If `sr-only` isn't defined in `globals.css`, add it (`position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap`) rather than dropping the announcement.

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/carousel-stack-ui.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Wrap the card thumbnail**

In `library-view.tsx`, import `CarouselStack`, then wrap the thumbnail container at line ~538 — the `<div className="relative h-16 w-16 shrink-0 overflow-hidden …">` and everything through its closing `</div>` — in:

```tsx
              <CarouselStack count={p.asset_count}>
                {/* the existing relative h-16 w-16 … div, unchanged */}
              </CarouselStack>
```

Then remove the now-duplicated count from the meta row (line ~629):

```tsx
                  {p.asset_count > 1 ? <span>{p.asset_count} imgs</span> : null}
```

- [ ] **Step 6: Open the lightbox on the whole carousel**

Change the `openMedia` state (line ~136) to carry the post and every slide it knows about:

```tsx
  const [openMedia, setOpenMedia] = useState<{
    postId: number;
    label: string;
    assets: LightboxAsset[];
    /** What the card says the post has, so the fetch below knows to bother. */
    expectedCount: number;
  } | null>(null);
```

At the `MediaBadge` `onOpen` (line ~583), open immediately with the one asset the card already has — no spinner between click and image:

```tsx
                    onOpen={() =>
                      setOpenMedia({
                        postId: p.id,
                        label: p.caption || `Post ${p.id}`,
                        assets: [
                          {
                            id: p.first_asset_id as number,
                            media_kind: p.first_asset_media_kind as "image" | "video",
                            cover_frame_ms: p.first_asset_cover_frame_ms,
                            width: p.first_asset_width,
                            height: p.first_asset_height,
                          },
                        ],
                        expectedCount: p.asset_count,
                      })
                    }
```

Then fill in the rest:

```tsx
  // The Library list deliberately doesn't carry every slide's metadata (see the GET's
  // header comment), so the remaining slides are fetched when the lightbox opens. If this
  // fails, the lightbox simply stays the single-asset viewer it already was.
  const openMediaPostId = openMedia?.postId;
  const openMediaLoaded = (openMedia?.assets.length ?? 0) > 1;
  const openMediaExpected = openMedia?.expectedCount ?? 0;
  useEffect(() => {
    if (openMediaPostId === undefined || openMediaExpected < 2 || openMediaLoaded) return;
    const controller = new AbortController();
    async function loadSlides() {
      try {
        const res = await fetch(`/api/posts/${openMediaPostId}/assets`, {
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(body.assets) || body.assets.length < 2) return;
        // Guarded on the id: by the time this lands the viewer may have closed the
        // lightbox and opened a different post's.
        setOpenMedia((current) =>
          current && current.postId === openMediaPostId
            ? { ...current, assets: body.assets }
            : current
        );
      } catch {
        // Aborted, or offline. Either way the lightbox keeps working.
      }
    }
    loadSlides();
    return () => controller.abort();
  }, [openMediaPostId, openMediaExpected, openMediaLoaded]);
```

And the render (line ~855):

```tsx
      {openMedia ? (
        <MediaLightbox
          assets={openMedia.assets}
          label={openMedia.label}
          onClose={() => setOpenMedia(null)}
        />
      ) : null}
```

- [ ] **Step 7: Run everything**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

Expected: all green.

- [ ] **Step 8: Verify in the browser**

On `/library`:
- Carousels show the layered stack and a count chip; single-image posts and Reels look exactly as before.
- With the Network panel open and cache disabled, **a carousel card loads exactly one image** — the layers are not fetching anything.
- Click the expand badge on a carousel: slide 1 appears instantly, then the counter and Next appear.
- → / ← and the on-screen arrows walk all slides; the arrows disable at each end.
- Two-finger horizontal swipe on the trackpad advances **one** slide per flick, not several.
- Escape closes and focus returns to the badge.
- Click the badge on a single-image post: no arrows, no counter.
- Open a Reel from the post detail page, click into the video, press → : the video seeks (the player keeps its arrow keys).
- Select a card by clicking it, then open the lightbox from it: bulk-selection still toggles correctly and the count chip stays readable over the selection overlay.

- [ ] **Step 9: Commit**

```bash
git add dashboard/components/carousel-stack.tsx dashboard/test-ui/carousel-stack-ui.test.ts dashboard/components/library-view.tsx
git commit -m "feat(library): show carousels as a stack and swipe through them"
```

---

## Task 10: End-to-end verification and docs

**Files:**
- Modify: `docs/tasks.md`

- [ ] **Step 1: Full suite, typecheck, lint, production build**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint && npm run build
```

Expected: all green. The build matters — `next build` catches server/client boundary mistakes that `tsc` does not.

- [ ] **Step 2: Prove the publish path respects the new order**

This install publishes for real (`DRY_RUN=0`), so this runs as a dry run first. Do **not** edit the live `.env` in place beyond flipping `DRY_RUN` back afterwards.

Pick a carousel draft, reorder it, schedule it a few minutes out, and run the worker with `DRY_RUN=1`. Confirm the logged plan lists the slides in the **new** order. Then restore `DRY_RUN=0`.

Remember: a live heartbeat proves the daemon is running, not that it is running current code. Restart the worker after any change to `worker/`. (This plan changes no worker code, so no restart is required for the feature itself.)

- [ ] **Step 3: Confirm the `publishing` guard against a scratch copy — never the live DB**

```bash
cd "$(git rev-parse --show-toplevel)" && cp data/socialscheduler.db /tmp/reorder-guard-check.db
```

Point a throwaway dev server at `DATABASE_PATH=/tmp/reorder-guard-check.db`, set one publication on a carousel to `publishing`, and confirm the Save order button surfaces the "being published right now" message and the order does **not** change. Confirm the exact DB filename from `.env` before copying.

- [ ] **Step 4: Update `docs/tasks.md`**

Mark this work done, and log the two deferred items from spec §9 so they are not lost:
- Adding/removing slides on an existing post.
- Reordering from inside the lightbox (decided against, recorded so it isn't re-litigated).

- [ ] **Step 5: Commit**

```bash
git add docs/tasks.md
git commit -m "docs: mark carousel reorder and swipe done, log the deferred slide add/remove"
```

---

## Spec coverage check

| Spec section | Task |
|---|---|
| §2 no schema/worker change | Global constraints; nothing in `/migrations` or `worker/` is touched |
| §2 UNIQUE trap → DELETE+INSERT | Task 2 (with a reversal test that would fail under UPDATEs) |
| §3 frozen `post_type` invariant | Task 1 (validation), Task 2 (test), Task 3 (route enforcement) |
| §4 `GET` shape and why not `listPosts` | Task 3 |
| §4 permutation validation, 4 error codes | Tasks 1 + 3 |
| §4 `publishing` → 409; `posted`/`scheduled` allowed | Tasks 2 + 3 |
| §5 stack, count chip, no extra images | Task 9 (verified in the Network panel) |
| §6 one component two homes; all slides shown | Tasks 4, 5, 6 |
| §6 quick edit saves order first | Task 6 |
| §6 queued-sends notice | Task 4 (component), 5 + 6 (counts) |
| §7 array props, arrows, swipe, counter, no wrap | Tasks 7 + 8 |
| §7 arrows ignored inside `<video>` | Task 8 |
| §7 preload neighbours | Task 8 |
| §7 open instantly then extend | Task 9 |
| §7 media manager unchanged | Task 8 step 5 |
| §8 all seven verification items | Tasks 5, 6, 8, 9, 10 |
| §9 deferred items recorded | Task 10 |
