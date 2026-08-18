# Post Media Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a post's media be changed after it is composed — add slides (by upload or from the library) and remove slides, with an explicit choice between removing a file from the post and deleting it from disk entirely.

**Architecture:** Uploads keep going through the existing `POST /api/assets/upload`; the new endpoints deal only in asset ids. All the rules live in one pure module (`lib/post-media-edit.ts`) so they are unit-testable without a database, mirroring the existing `lib/asset-order.ts`. The live-send guard is re-asserted inside the write statement, the way `deletePost()` does it, so a send going live mid-request cannot slip through. One shared React component is mounted in both the full editor and the quick-edit dialog.

**Tech Stack:** Next.js 16 App Router (route handlers, `runtime = "nodejs"`), TypeScript, `better-sqlite3`, React 19 client components, Tailwind v4. Tests are the **node built-in test runner** (`node --test`), not vitest.

**Spec:** `docs/design-post-media-editing.md`

## Global Constraints

- **Run tests with `npm test` from `dashboard/`.** It runs three suites: `test-ui/*.test.ts`, then `lib/*.test.ts` and `test/*.test.ts` under `--conditions=react-server`. To run one file: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/post-media-edit.test.ts`
- **Imports inside tests and lib use explicit `.ts` extensions** (`./asset-order.ts`, `../lib/queries.ts`). Follow the surrounding files.
- **Route tests must call `makeTestDb()` from `test/helpers.ts` BEFORE any `await import(...)` of `lib/queries.ts`** — `lib/config.ts` reads `DATABASE_PATH` once at module load. This is why route tests use dynamic imports rather than top-level ones.
- **Never touch the owner's live database.** `makeTestDb()` gives each run a fresh migrated temp DB and an isolated `ASSET_STORAGE_DIR`.
- **The worker cannot publish video inside a carousel.** `worker/publisher.py:508`'s `_publish_carousel` builds an image container for every child. A post with a video slide alongside anything else must be refused.
- **`incompatiblePostError()` (`lib/platforms.ts:252`) is the only correct implementation of the channel-compatibility rules.** Reuse it. Do not hand-roll a carousel-size check — a previous hand-rolled copy used `Math.max` instead of `Math.min` and accepted carousels guaranteed to fail.
- **"Already sent" means `publications.status IN ('posted','publishing')`, never `posts.status`.** Same definition `deletePost()` (`lib/queries.ts:866`) and `loadMergeCandidate()` already use.
- **HTTP status convention, matching the existing routes:** malformed or invalid *requests* are `400`; conflicts with *other state* (a live send, a shared asset) are `409`; a missing post or slide is `404`.
- **Lint is at zero errors — keep it there.** `cd dashboard && npm run lint`
- **`eslint-disable-next-line @next/next/no-img-element`** is required above any `<img>` tag, as elsewhere in the codebase.
- Commit after every task.

---

# Phase 1 — Rules, queries, and endpoints

### Task 1: The pure rules module

**Files:**
- Create: `dashboard/lib/post-media-edit.ts`
- Test: `dashboard/lib/post-media-edit.test.ts`
- Modify: `dashboard/lib/queries.ts:760-772` (make the private `derivePostType` delegate to the new pure helper)

**Interfaces:**
- Consumes: `incompatiblePostError`, `ChannelLikeForCompat` from `./platforms`; `PostType` from `./types`
- Produces:
  - `derivePostTypeFromKinds(kinds: string[]): PostType`
  - `interface Slide { asset_id: number; media_kind: string }`
  - `interface MediaEditContext { slides: Slide[]; hasLiveSend: boolean; channels: ChannelLikeForCompat[] }`
  - `type MediaEditCheck = { ok: true; post_type: PostType; slides: Slide[] } | { ok: false; code: MediaEditErrorCode; error: string; status: number }`
  - `checkAddAssets(ctx: MediaEditContext, incoming: Slide[]): MediaEditCheck`
  - `checkRemoveAsset(ctx: MediaEditContext, assetId: number, mode: "post" | "everywhere", otherPostCount: number): MediaEditCheck`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/lib/post-media-edit.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAddAssets,
  checkRemoveAsset,
  derivePostTypeFromKinds,
  type MediaEditContext,
  type Slide,
} from "./post-media-edit.ts";

const IG = { id: 1, platform: "instagram", account_name: "liparoto" };

function img(id: number): Slide {
  return { asset_id: id, media_kind: "image" };
}
function vid(id: number): Slide {
  return { asset_id: id, media_kind: "video" };
}
function ctx(over: Partial<MediaEditContext> = {}): MediaEditContext {
  return { slides: [img(1), img(2)], hasLiveSend: false, channels: [IG], ...over };
}

test("derivePostTypeFromKinds matches the rules the composer uses", () => {
  assert.equal(derivePostTypeFromKinds([]), "single");
  assert.equal(derivePostTypeFromKinds(["image"]), "single");
  assert.equal(derivePostTypeFromKinds(["video"]), "reel");
  assert.equal(derivePostTypeFromKinds(["image", "image"]), "carousel");
});

test("adding an image to a single makes it a carousel", () => {
  const res = checkAddAssets(ctx({ slides: [img(1)] }), [img(9)]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "carousel");
  assert.deepEqual(res.slides.map((s) => s.asset_id), [1, 9]);
});

test("adding nothing is a bad request", () => {
  const res = checkAddAssets(ctx(), []);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "bad_body");
  assert.equal(res.status, 400);
});

test("a live send blocks adding", () => {
  const res = checkAddAssets(ctx({ hasLiveSend: true }), [img(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "live_send");
  assert.equal(res.status, 409);
});

test("a live send blocks removing", () => {
  const res = checkRemoveAsset(ctx({ hasLiveSend: true }), 1, "post", 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "live_send");
});

test("an asset already on the post is refused", () => {
  const res = checkAddAssets(ctx(), [img(2)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "already_on_post");
});

test("a video cannot join a post that has other slides", () => {
  const res = checkAddAssets(ctx(), [vid(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("nothing can join a post whose only slide is a video", () => {
  const res = checkAddAssets(ctx({ slides: [vid(1)] }), [img(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("two videos at once are refused", () => {
  const res = checkAddAssets(ctx({ slides: [] }), [vid(8), vid(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("a lone video on an empty post becomes a reel", () => {
  const res = checkAddAssets(ctx({ slides: [] }), [vid(9)]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "reel");
});

test("an 11th slide is refused with Instagram's real limit named", () => {
  const ten = Array.from({ length: 10 }, (_, i) => img(i + 1));
  const res = checkAddAssets(ctx({ slides: ten }), [img(99)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "incompatible");
  assert.match(res.error, /at most 10/);
});

test("removing a slide from a carousel of two leaves a single", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 0);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "single");
  assert.deepEqual(res.slides.map((s) => s.asset_id), [1]);
});

test("the last slide cannot be removed", () => {
  const res = checkRemoveAsset(ctx({ slides: [img(1)] }), 1, "post", 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "last_slide");
});

test("removing a slide the post does not have is a 404", () => {
  const res = checkRemoveAsset(ctx(), 77, "post", 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_on_post");
  assert.equal(res.status, 404);
});

test("delete-entirely is refused when the asset is on other posts", () => {
  const res = checkRemoveAsset(ctx(), 2, "everywhere", 3);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "shared_asset");
  assert.equal(res.status, 409);
  assert.match(res.error, /3 other posts/);
});

test("remove-from-post is allowed even when the asset is shared", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 3);
  assert.equal(res.ok, true);
});

test("removing leaves a lone video as a reel, and re-checks video support", () => {
  const noVideo = { id: 2, platform: "threads", account_name: "t" };
  const res = checkRemoveAsset(
    { slides: [vid(1), img(2)], hasLiveSend: false, channels: [noVideo] },
    2,
    "post",
    0
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "incompatible");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/post-media-edit.test.ts`
Expected: FAIL — cannot find module `./post-media-edit.ts`

- [ ] **Step 3: Write the implementation**

Create `dashboard/lib/post-media-edit.ts`:

```ts
/**
 * Can this post's media be changed the way the request asks, and what does that make it?
 *
 * The rules half of adding/removing slides, kept pure and DB-free so every rule below has
 * a unit test rather than a route test. Same split as lib/asset-order.ts.
 *
 * `PATCH /api/posts/[id]/assets` gets to be as simple as it is because a reorder cannot
 * change the slide count, which makes posts.post_type correct by construction. Adding and
 * removing give that up, so post_type has to be re-derived and channel compatibility
 * re-checked on every call — that is the whole reason this is a separate endpoint and a
 * separate module.
 */
import { incompatiblePostError, type ChannelLikeForCompat } from "./platforms";
import type { PostType } from "./types";

export interface Slide {
  asset_id: number;
  media_kind: string;
}

export interface MediaEditContext {
  /** The post's slides right now, in order. */
  slides: Slide[];
  /**
   * Any publication 'posted' or 'publishing'. Same live-send definition deletePost() uses:
   * 'posted' means it exists on the platform, 'publishing' means the worker is mid-flight
   * with it right now. NOT posts.status, which is only the coarse overview hint.
   */
  hasLiveSend: boolean;
  /** Channels this post must still satisfy. See getPostCompatChannels() in queries.ts. */
  channels: ChannelLikeForCompat[];
}

export type MediaEditErrorCode =
  | "bad_body"
  | "live_send"
  | "already_on_post"
  | "video_mix"
  | "not_on_post"
  | "last_slide"
  | "shared_asset"
  | "incompatible";

export type MediaEditCheck =
  | { ok: true; post_type: PostType; slides: Slide[] }
  | { ok: false; code: MediaEditErrorCode; error: string; status: number };

function fail(code: MediaEditErrorCode, error: string, status: number): MediaEditCheck {
  return { ok: false, code, error, status };
}

/**
 * The same rule createDraftPost derives from the database, without the database.
 * queries.ts's derivePostType() delegates here so the two can never drift.
 */
export function derivePostTypeFromKinds(kinds: string[]): PostType {
  // No slides is left as "single" rather than guessed at "text", matching the behaviour
  // this replaced: a text post always states its type explicitly.
  if (kinds.length === 0) return "single";
  if (kinds.length > 1) return "carousel";
  return kinds[0] === "video" ? "reel" : "single";
}

/**
 * The checks every media change shares, run in the order a person would want them: the
 * thing that makes the whole request moot first, the details after.
 */
function settle(ctx: MediaEditContext, next: Slide[]): MediaEditCheck {
  // worker/publisher.py's _publish_carousel builds an IMAGE container for every child, so
  // a video alongside anything else publishes as a broken carousel or dies outright. The
  // composer refuses the same combination when the post is first built.
  if (next.length > 1 && next.some((s) => s.media_kind === "video")) {
    return fail(
      "video_mix",
      "A video has to be on its own. It can't be mixed with images or with another video.",
      400
    );
  }

  const postType = derivePostTypeFromKinds(next.map((s) => s.media_kind));
  const compat = incompatiblePostError(postType, next.length, ctx.channels);
  if (compat) return fail("incompatible", compat, 400);

  return { ok: true, post_type: postType, slides: next };
}

export function checkAddAssets(ctx: MediaEditContext, incoming: Slide[]): MediaEditCheck {
  if (incoming.length === 0) {
    return fail("bad_body", "asset_ids must list at least one asset to add.", 400);
  }
  if (ctx.hasLiveSend) {
    return fail(
      "live_send",
      "This post has already gone out, or is going out right now, so its media can't be changed.",
      409
    );
  }

  const have = new Set(ctx.slides.map((s) => s.asset_id));
  const dupe = incoming.find((s) => have.has(s.asset_id));
  if (dupe) {
    return fail(
      "already_on_post",
      "That file is already on this post. The same photo can only appear once.",
      400
    );
  }
  // Catches the same file listed twice in one request, which the UNIQUE(post_id, asset_id)
  // index would otherwise turn into an opaque SQLITE_CONSTRAINT mid-transaction.
  if (new Set(incoming.map((s) => s.asset_id)).size !== incoming.length) {
    return fail("bad_body", "asset_ids lists the same file more than once.", 400);
  }

  return settle(ctx, [...ctx.slides, ...incoming]);
}

export function checkRemoveAsset(
  ctx: MediaEditContext,
  assetId: number,
  mode: "post" | "everywhere",
  otherPostCount: number
): MediaEditCheck {
  if (ctx.hasLiveSend) {
    return fail(
      "live_send",
      "This post has already gone out, or is going out right now, so its media can't be changed.",
      409
    );
  }
  if (!ctx.slides.some((s) => s.asset_id === assetId)) {
    return fail("not_on_post", "That file isn't on this post.", 404);
  }
  if (ctx.slides.length === 1) {
    return fail(
      "last_slide",
      "A post needs at least one photo. Delete the post itself if you don't want it.",
      400
    );
  }
  if (mode === "everywhere" && otherPostCount > 0) {
    return fail(
      "shared_asset",
      `This file is also used by ${otherPostCount} other post${
        otherPostCount === 1 ? "" : "s"
      }, so it can't be deleted outright. Remove it from this post instead.`,
      409
    );
  }

  return settle(
    ctx,
    ctx.slides.filter((s) => s.asset_id !== assetId)
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/post-media-edit.test.ts`
Expected: PASS — 17 tests

- [ ] **Step 5: Make queries.ts delegate, so the two derivations can't drift**

In `dashboard/lib/queries.ts`, add to the existing import block near the top (next to the `./platforms` import on line 24):

```ts
import { derivePostTypeFromKinds } from "./post-media-edit";
```

Replace the body of the private `derivePostType` (currently `lib/queries.ts:760-772`) with:

```ts
function derivePostType(db: DatabaseType.Database, assetIds: number[]): PostType {
  // The rule itself lives in lib/post-media-edit.ts so the add/remove endpoints and this
  // creation path can never disagree about what a post's type is. This function is only
  // the database half: fetch the kinds, then ask.
  if (assetIds.length === 0) return derivePostTypeFromKinds([]);
  if (assetIds.length > 1) return derivePostTypeFromKinds(["image", "image"]);
  const row = db
    .prepare("SELECT media_kind FROM assets WHERE id = ?")
    .get(assetIds[0]) as { media_kind: string } | undefined;
  return derivePostTypeFromKinds([row?.media_kind ?? "image"]);
}
```

- [ ] **Step 6: Run the whole suite — nothing else may break**

Run: `cd dashboard && npm test && npm run lint`
Expected: all suites PASS, lint reports 0 errors

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/post-media-edit.ts dashboard/lib/post-media-edit.test.ts dashboard/lib/queries.ts
git commit -m "feat(media): rules for adding and removing a post's slides"
```

---

### Task 2: Database helpers

**Files:**
- Modify: `dashboard/lib/queries.ts` (append after `reorderPostAssets`, which ends at line 604)
- Test: `dashboard/test/post-media-queries.test.ts`

**Interfaces:**
- Consumes: `derivePostTypeFromKinds` (Task 1), `getDb`, `nowIso` (existing, private to queries.ts)
- Produces:
  - `getPostSlides(postId: number): Slide[]`
  - `postHasLiveSend(postId: number): boolean`
  - `getPostCompatChannels(postId: number): ChannelLikeForCompat[]`
  - `countOtherPostsUsingAsset(postId: number, assetId: number): number`
  - `addPostAssets(postId: number, assetIds: number[], postType: PostType): "ok" | "has_live"`
  - `removePostAsset(postId: number, assetId: number, postType: PostType, alsoDeleteAsset: boolean): "ok" | "has_live" | "still_used"`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/test/post-media-queries.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

let seq = 0;

function mkAsset(kind: "image" | "video" = "image"): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, ?, ?, 1080, 1080)"
      )
      .run(`pmq-hash-${n}`, kind, `a/pmq/${n}.jpg`).lastInsertRowid
  );
}

function mkPost(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: assetIds.length > 1 ? "carousel" : "single",
  });
}

function mkChannel(platform: string): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES (?, ?, ?, 1)"
      )
      .run(platform, `acct-${n}`, `remote-${n}`).lastInsertRowid
  );
}

function slideIds(postId: number): number[] {
  return q.getPostSlides(postId).map((s) => s.asset_id);
}

test("getPostSlides returns slides in order with their media kind", () => {
  const a = mkAsset();
  const b = mkAsset("video");
  const post = mkPost([a, b]);
  assert.deepEqual(q.getPostSlides(post), [
    { asset_id: a, media_kind: "image" },
    { asset_id: b, media_kind: "video" },
  ]);
});

test("addPostAssets appends after the existing slides and sets post_type", () => {
  const post = mkPost([mkAsset()]);
  const extra = mkAsset();
  assert.equal(q.addPostAssets(post, [extra], "carousel"), "ok");
  assert.equal(slideIds(post).at(-1), extra);
  assert.equal(q.getPost(post)!.post_type, "carousel");
});

test("removePostAsset unlinks the slide and leaves the asset alone", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  assert.equal(q.removePostAsset(post, b, "single", false), "ok");
  assert.deepEqual(slideIds(post), [a]);
  assert.ok(q.getAsset(b), "the asset row must survive a remove-from-post");
});

test("removePostAsset with alsoDeleteAsset removes the row too", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  assert.equal(q.removePostAsset(post, b, "single", true), "ok");
  assert.deepEqual(slideIds(post), [a]);
  assert.equal(q.getAsset(b), undefined);
});

test("a live send blocks both writes, and nothing changes", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  const channel = mkChannel("instagram");
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(post, channel);

  assert.equal(q.addPostAssets(post, [mkAsset()], "carousel"), "has_live");
  assert.equal(q.removePostAsset(post, b, "single", false), "has_live");
  assert.deepEqual(slideIds(post), [a, b]);
});

test("countOtherPostsUsingAsset excludes the post being edited", () => {
  const shared = mkAsset();
  const one = mkPost([shared, mkAsset()]);
  assert.equal(q.countOtherPostsUsingAsset(one, shared), 0);
  mkPost([shared, mkAsset()]);
  assert.equal(q.countOtherPostsUsingAsset(one, shared), 1);
});

test("removePostAsset refuses to delete an asset another post still holds", () => {
  const shared = mkAsset();
  const post = mkPost([shared, mkAsset()]);
  mkPost([shared, mkAsset()]);
  assert.equal(q.removePostAsset(post, shared, "single", true), "still_used");
  assert.deepEqual(slideIds(post).includes(shared), true, "the link must survive a refusal");
  assert.ok(q.getAsset(shared));
});

test("an untargeted draft falls back to Instagram's stricter cap", () => {
  const post = mkPost([mkAsset()]);
  assert.deepEqual(
    q.getPostCompatChannels(post).map((c) => c.platform),
    ["instagram"]
  );
});

test("getPostCompatChannels unions targets and queued sends", () => {
  const post = mkPost([mkAsset()]);
  const target = mkChannel("threads");
  const queued = mkChannel("facebook");
  db.prepare("INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)").run(post, target);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled')"
  ).run(post, queued);
  assert.deepEqual(
    q.getPostCompatChannels(post).map((c) => c.platform).sort(),
    ["facebook", "threads"]
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/post-media-queries.test.ts`
Expected: FAIL — `q.getPostSlides is not a function`

- [ ] **Step 3: Write the implementation**

Append to `dashboard/lib/queries.ts`, immediately after `reorderPostAssets` (which ends at line 604), and add `type Slide` / `type MediaEditContext` to the `./post-media-edit` import added in Task 1:

```ts
// ---- Adding and removing a post's slides ------------------------------------------
// The write half of lib/post-media-edit.ts. Every guard here is ON the write statement
// rather than in front of it, for the same reason deletePost()'s is: the worker may take
// this post live between the check and the write, and a slide list rewritten underneath a
// container being built is the one way this can publish something genuinely wrong.

/** A post's slides with the one extra field the media rules need: media_kind. */
export function getPostSlides(postId: number): Slide[] {
  return getDb()
    .prepare(
      `SELECT pa.asset_id AS asset_id, a.media_kind AS media_kind
         FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
        WHERE pa.post_id = ? ORDER BY pa.sort_order ASC`
    )
    .all(postId) as Slide[];
}

/**
 * Has this post actually gone out, or is it going out right now?
 *
 * The same live-send definition deletePost() uses. Deliberately NOT posts.status, which
 * migrations/0001_init.sql documents as the coarse overview lifecycle hint: a post can sit
 * at status='scheduled' while one of its two sends is already on Instagram.
 */
export function postHasLiveSend(postId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM publications WHERE post_id = ? AND status IN ('posted','publishing') LIMIT 1"
    )
    .get(postId);
  return row !== undefined;
}

/**
 * The channels a media change on this post still has to satisfy: what it is targeted at,
 * plus what it already has queued. A send can exist without a target row and vice versa,
 * and either would fail at publish if the slide count outgrew it.
 *
 * An untargeted draft falls back to Instagram for the same reason mergeTargetPlatforms
 * does: 10 is the strictest carousel cap here, and a draft that isn't pointed anywhere yet
 * can be pointed anywhere later, so it has to satisfy the tightest limit rather than none.
 */
export function getPostCompatChannels(postId: number): ChannelLikeForCompat[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT c.id AS id, c.platform AS platform, c.account_name AS account_name
         FROM channels c
        WHERE c.id IN (SELECT channel_id FROM post_targets WHERE post_id = @id)
           OR c.id IN (SELECT channel_id FROM publications
                        WHERE post_id = @id AND status <> 'canceled')`
    )
    .all({ id: postId }) as ChannelLikeForCompat[];
  return rows.length > 0 ? rows : [{ id: 0, platform: "instagram", account_name: "Instagram" }];
}

/** How many OTHER posts hold this asset — what makes "delete entirely" safe or not. */
export function countOtherPostsUsingAsset(postId: number, assetId: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM post_assets WHERE asset_id = ? AND post_id <> ?")
    .get(assetId, postId) as { n: number };
  return row.n;
}

/** Append slides to a post. `postType` comes from checkAddAssets — never re-derived here. */
export function addPostAssets(
  postId: number,
  assetIds: number[],
  postType: PostType
): "ok" | "has_live" {
  const db = getDb();
  const nextOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM post_assets WHERE post_id = ?"
  );
  // The NOT EXISTS is the guard: if a send went live since checkAddAssets ran, this
  // inserts 0 rows and the whole transaction rolls back.
  const link = db.prepare(
    `INSERT INTO post_assets (post_id, asset_id, sort_order)
     SELECT @post, @asset, @order
      WHERE NOT EXISTS (SELECT 1 FROM publications
                         WHERE post_id = @post AND status IN ('posted','publishing'))`
  );
  const retype = db.prepare("UPDATE posts SET post_type = ?, updated_at = ? WHERE id = ?");

  const tx = db.transaction(() => {
    let order = (nextOrder.get(postId) as { n: number }).n;
    for (const assetId of assetIds) {
      const info = link.run({ post: postId, asset: assetId, order });
      if (info.changes === 0) throw new LiveSendError();
      order += 1;
    }
    retype.run(postType, nowIso(), postId);
  });

  try {
    tx();
    return "ok";
  } catch (err) {
    if (err instanceof LiveSendError) return "has_live";
    throw err;
  }
}

/**
 * Remove one slide, optionally deleting the asset outright.
 *
 * Order inside the transaction matters: post_assets.asset_id is REFERENCES assets(id) ON
 * DELETE RESTRICT, so the link has to go first. And the asset DELETE carries its own
 * NOT EXISTS so a second post that picked this asset up mid-request cannot lose its file.
 *
 * Deleting the FILES is the caller's job, deliberately: it happens after this returns "ok",
 * so a failed row delete can never leave files deleted. Same order DELETE /api/assets/[id]
 * already uses.
 */
export function removePostAsset(
  postId: number,
  assetId: number,
  postType: PostType,
  alsoDeleteAsset: boolean
): "ok" | "has_live" | "still_used" {
  const db = getDb();
  const unlink = db.prepare(
    `DELETE FROM post_assets
      WHERE post_id = @post AND asset_id = @asset
        AND NOT EXISTS (SELECT 1 FROM publications
                         WHERE post_id = @post AND status IN ('posted','publishing'))`
  );
  const resequence = db.prepare(
    `UPDATE post_assets SET sort_order = sort_order - 1
      WHERE post_id = @post AND sort_order > @gap`
  );
  const gapOf = db.prepare(
    "SELECT sort_order AS n FROM post_assets WHERE post_id = ? AND asset_id = ?"
  );
  const dropAsset = db.prepare(
    `DELETE FROM assets
      WHERE id = @asset
        AND NOT EXISTS (SELECT 1 FROM post_assets WHERE asset_id = @asset)`
  );
  const retype = db.prepare("UPDATE posts SET post_type = ?, updated_at = ? WHERE id = ?");

  const tx = db.transaction(() => {
    const gap = gapOf.get(postId, assetId) as { n: number } | undefined;
    if (!gap) throw new LiveSendError(); // vanished between check and write — same refusal
    if (unlink.run({ post: postId, asset: assetId }).changes === 0) throw new LiveSendError();
    // UNIQUE(post_id, sort_order) means the hole left behind must be closed, or the next
    // append lands on a number that is already taken.
    resequence.run({ post: postId, gap: gap.n });
    if (alsoDeleteAsset && dropAsset.run({ asset: assetId }).changes === 0) {
      throw new StillUsedError();
    }
    retype.run(postType, nowIso(), postId);
  });

  try {
    tx();
    return "ok";
  } catch (err) {
    if (err instanceof LiveSendError) return "has_live";
    if (err instanceof StillUsedError) return "still_used";
    throw err;
  }
}

/** Rollback signals. Thrown only inside the transactions above, never escaping this file. */
class LiveSendError extends Error {}
class StillUsedError extends Error {}
```

Add the imports these need to the existing import block at the top of `queries.ts`:

```ts
import type { ChannelLikeForCompat } from "./platforms";
import { derivePostTypeFromKinds, type Slide } from "./post-media-edit";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/post-media-queries.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Run the whole suite**

Run: `cd dashboard && npm test && npm run lint`
Expected: all PASS, 0 lint errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/test/post-media-queries.test.ts
git commit -m "feat(media): DB writes for adding and removing a post's slides"
```

---

### Task 3: `POST /api/posts/[id]/assets`

**Files:**
- Modify: `dashboard/app/api/posts/[id]/assets/route.ts` (add `POST`; leave `GET` and `PATCH` untouched)
- Test: `dashboard/test/post-assets-add-route.test.ts`

**Interfaces:**
- Consumes: `checkAddAssets` (Task 1); `getPostSlides`, `postHasLiveSend`, `getPostCompatChannels`, `addPostAssets`, `getAsset`, `getPost` (Task 2 + existing)
- Produces: `POST(req, { params })` → `200 { post_type, asset_ids }`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/test/post-assets-add-route.test.ts`:

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

function mkAsset(kind: "image" | "video" = "image"): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, ?, ?, 1080, 1080)"
      )
      .run(`add-hash-${n}`, kind, `a/add/${n}.jpg`).lastInsertRowid
  );
}

function mkPost(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: assetIds.length > 1 ? "carousel" : "single",
  });
}

async function post(postId: number | string, body: unknown) {
  return route.POST(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(postId) }) }
  );
}

test("adding a slide returns the new order and type", async () => {
  const first = mkAsset();
  const p = mkPost([first]);
  const extra = mkAsset();

  const res = await post(p, { asset_ids: [extra] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.asset_ids, [first, extra]);
  assert.equal(body.post_type, "carousel");
  assert.equal(q.getPost(p)!.post_type, "carousel");
});

test("an unknown post is a 404", async () => {
  const res = await post(999999, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 404);
});

test("an unknown asset id is a 400 and adds nothing", async () => {
  const p = mkPost([mkAsset()]);
  const before = q.getPostSlides(p).length;
  const res = await post(p, { asset_ids: [999999] });
  assert.equal(res.status, 400);
  assert.equal(q.getPostSlides(p).length, before);
});

test("a malformed body is a 400", async () => {
  const p = mkPost([mkAsset()]);
  const res = await post(p, { asset_ids: "nope" });
  assert.equal(res.status, 400);
});

test("mixing a video into a carousel is refused", async () => {
  const p = mkPost([mkAsset(), mkAsset()]);
  const res = await post(p, { asset_ids: [mkAsset("video")] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "video_mix");
  assert.equal(q.getPostSlides(p).length, 2);
});

test("a live send is a 409 and adds nothing", async () => {
  const p = mkPost([mkAsset()]);
  const channel = Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', 'a', 'b', 1)"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(p, channel);

  const res = await post(p, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "live_send");
  assert.equal(q.getPostSlides(p).length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/post-assets-add-route.test.ts`
Expected: FAIL — `route.POST is not a function`

- [ ] **Step 3: Write the implementation**

Append to `dashboard/app/api/posts/[id]/assets/route.ts`, and extend its existing import from `@/lib/queries`:

```ts
/**
 * Add slides to a post. Body: { asset_ids: [12, 9] } — appended after what it already has.
 *
 * The counterpart to PATCH above, and separate from it for the reason PATCH's own comment
 * gives: a reorder cannot change the slide count, which is what lets it stay this simple.
 * Adding can, so post_type is re-derived and channel compatibility re-checked here.
 *
 * The assets themselves must already exist — uploading is POST /api/assets/upload, which
 * owns content-hash dedup, image conforming, and video validation/conversion. This route
 * deliberately knows none of that; it only links ids that are already in the library.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId) || !getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const raw = (body as { asset_ids?: unknown } | null)?.asset_ids;
  if (!Array.isArray(raw) || !raw.every((v) => Number.isInteger(v))) {
    return NextResponse.json(
      { error: "Expected a JSON body with asset_ids as whole numbers.", code: "bad_body" },
      { status: 400 }
    );
  }

  // Resolve every id to a real asset BEFORE any rule runs, so "asset 999 doesn't exist"
  // is reported as itself rather than as a confusing type or compatibility error.
  const incoming = [];
  for (const assetId of raw as number[]) {
    const asset = getAsset(assetId);
    if (!asset) {
      return NextResponse.json(
        { error: `There's no file with id ${assetId} in the library.`, code: "bad_body" },
        { status: 400 }
      );
    }
    incoming.push({ asset_id: asset.id, media_kind: asset.media_kind });
  }

  const checked = checkAddAssets(
    {
      slides: getPostSlides(postId),
      hasLiveSend: postHasLiveSend(postId),
      channels: getPostCompatChannels(postId),
    },
    incoming
  );
  if (!checked.ok) {
    return NextResponse.json(
      { error: checked.error, code: checked.code },
      { status: checked.status }
    );
  }

  // The same live-send rule again, this time inside the write, where it cannot be raced.
  const result = addPostAssets(
    postId,
    incoming.map((s) => s.asset_id),
    checked.post_type
  );
  if (result === "has_live") {
    return NextResponse.json(
      {
        error: "This post went live while you were editing it, so nothing was changed.",
        code: "live_send",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    post_type: checked.post_type,
    asset_ids: checked.slides.map((s) => s.asset_id),
  });
}
```

Replace the file's existing `@/lib/queries` import with:

```ts
import {
  addPostAssets,
  getAsset,
  getPost,
  getPostAssets,
  getPostCompatChannels,
  getPostSlides,
  postHasLiveSend,
  postHasPublishingPublication,
  reorderPostAssets,
} from "@/lib/queries";
import { checkAssetOrder } from "@/lib/asset-order";
import { checkAddAssets } from "@/lib/post-media-edit";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/post-assets-add-route.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Run the whole suite**

Run: `cd dashboard && npm test && npm run lint`
Expected: all PASS (including the pre-existing `assets-order-route.test.ts`), 0 lint errors

- [ ] **Step 6: Commit**

```bash
git add "dashboard/app/api/posts/[id]/assets/route.ts" dashboard/test/post-assets-add-route.test.ts
git commit -m "feat(media): add slides to an existing post"
```

---

### Task 4: `DELETE /api/posts/[id]/assets/[assetId]`

**Files:**
- Create: `dashboard/app/api/posts/[id]/assets/[assetId]/route.ts`
- Test: `dashboard/test/post-assets-remove-route.test.ts`

**Interfaces:**
- Consumes: `checkRemoveAsset` (Task 1); `removePostAsset`, `countOtherPostsUsingAsset`, `getPostSlides`, `postHasLiveSend`, `getPostCompatChannels` (Task 2); `assetFilePaths`, `unlinkInsideStore` (`@/lib/asset-files`)
- Produces: `DELETE(req, { params })` → `200 { post_type, asset_ids, deleted_asset, leftover }`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/test/post-assets-remove-route.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { config } = await import("../lib/config.ts");
const route = await import("../app/api/posts/[id]/assets/[assetId]/route.ts");

let seq = 0;

/** Writes a real byte on disk too, so the file-deletion half is actually exercised. */
function mkAsset(): number {
  const n = ++seq;
  const rel = `rm/${n}.jpg`;
  const abs = path.join(config.assetStorageDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x");
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, 'image', ?, 1080, 1080)"
      )
      .run(`rm-hash-${n}`, rel).lastInsertRowid
  );
}

function fileFor(assetId: number): string {
  return path.join(config.assetStorageDir, q.getAsset(assetId)!.storage_path!);
}

function mkPost(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: assetIds.length > 1 ? "carousel" : "single",
  });
}

async function del(postId: number | string, assetId: number | string, mode?: string) {
  const qs = mode ? `?mode=${mode}` : "";
  return route.DELETE(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets/${assetId}${qs}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: String(postId), assetId: String(assetId) }) }
  );
}

test("mode=post unlinks the slide and keeps the file", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);

  const res = await del(p, b, "post");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.asset_ids, [a]);
  assert.equal(body.post_type, "single");
  assert.equal(body.deleted_asset, false);
  assert.ok(q.getAsset(b), "the asset row survives");
  assert.ok(fs.existsSync(fileFor(b)), "the file survives");
});

test("mode defaults to post when it is missing or nonsense", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const res = await del(p, b);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted_asset, false);
  assert.ok(q.getAsset(b));
});

test("mode=everywhere removes the row and the file from disk", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const filePath = fileFor(b);

  const res = await del(p, b, "everywhere");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted_asset, true);
  assert.equal(q.getAsset(b), undefined);
  assert.equal(fs.existsSync(filePath), false);
});

test("mode=everywhere is refused for a shared asset, changing NOTHING", async () => {
  const shared = mkAsset();
  const p = mkPost([shared, mkAsset()]);
  mkPost([shared, mkAsset()]);
  const filePath = fileFor(shared);

  const res = await del(p, shared, "everywhere");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "shared_asset");
  assert.match(body.error, /1 other post/);
  assert.ok(q.getPostSlides(p).some((s) => s.asset_id === shared), "still on the post");
  assert.ok(fs.existsSync(filePath), "file untouched");
});

test("the last slide cannot be removed", async () => {
  const a = mkAsset();
  const p = mkPost([a]);
  const res = await del(p, a, "post");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "last_slide");
  assert.equal(q.getPostSlides(p).length, 1);
});

test("a slide that isn't on this post is a 404", async () => {
  const p = mkPost([mkAsset(), mkAsset()]);
  const res = await del(p, mkAsset(), "post");
  assert.equal(res.status, 404);
});

test("an unknown post is a 404", async () => {
  const res = await del(999999, mkAsset(), "post");
  assert.equal(res.status, 404);
});

test("a live send is a 409 and removes nothing", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const channel = Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', 'live', 'x', 1)"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'publishing')"
  ).run(p, channel);

  const res = await del(p, b, "everywhere");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "live_send");
  assert.equal(q.getPostSlides(p).length, 2);
  assert.ok(fs.existsSync(fileFor(b)));
});

test("removing the middle slide leaves a gap-free order that can be appended to", async () => {
  const [a, b, c] = [mkAsset(), mkAsset(), mkAsset()];
  const p = mkPost([a, b, c]);
  assert.equal((await del(p, b, "post")).status, 200);
  const extra = mkAsset();
  assert.equal(q.addPostAssets(p, [extra], "carousel"), "ok");
  assert.deepEqual(q.getPostSlides(p).map((s) => s.asset_id), [a, c, extra]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/post-assets-remove-route.test.ts`
Expected: FAIL — cannot find the route module

- [ ] **Step 3: Write the implementation**

Create `dashboard/app/api/posts/[id]/assets/[assetId]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { assetFilePaths, unlinkInsideStore } from "@/lib/asset-files";
import {
  countOtherPostsUsingAsset,
  getAsset,
  getPost,
  getPostCompatChannels,
  getPostSlides,
  postHasLiveSend,
  removePostAsset,
} from "@/lib/queries";
import { checkRemoveAsset } from "@/lib/post-media-edit";

export const runtime = "nodejs";

/**
 * Take one slide off a post — and, optionally, delete the file itself.
 *
 * `?mode=post` (the default) unlinks the slide and leaves the file in the library, where
 * /media will show it as unused. `?mode=everywhere` also deletes the asset row and its
 * files from disk, permanently.
 *
 * ONE endpoint rather than the UI chaining an unlink and DELETE /api/assets/[id]: that
 * sequence refuses a shared asset only AFTER the slide is already gone, leaving a
 * half-done edit exactly when the user asked for the safer outcome. Here nothing is
 * written until everything has been checked.
 *
 * Anything unrecognised in `mode` falls back to the non-destructive one on purpose. A
 * typo'd query string must never be the thing that deletes a file.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id, assetId: rawAssetId } = await params;
  const postId = Number(id);
  const assetId = Number(rawAssetId);
  if (!Number.isInteger(postId) || !getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  if (!Number.isInteger(assetId)) {
    return NextResponse.json({ error: "That file isn't on this post." }, { status: 404 });
  }

  const mode = req.nextUrl.searchParams.get("mode") === "everywhere" ? "everywhere" : "post";

  // Read the paths BEFORE the row can disappear — after the DELETE there is nothing left
  // to read them from. Same reason DELETE /api/assets/[id] reads them up front.
  const asset = getAsset(assetId);

  const checked = checkRemoveAsset(
    {
      slides: getPostSlides(postId),
      hasLiveSend: postHasLiveSend(postId),
      channels: getPostCompatChannels(postId),
    },
    assetId,
    mode,
    countOtherPostsUsingAsset(postId, assetId)
  );
  if (!checked.ok) {
    return NextResponse.json(
      { error: checked.error, code: checked.code },
      { status: checked.status }
    );
  }

  const result = removePostAsset(postId, assetId, checked.post_type, mode === "everywhere");
  if (result === "has_live") {
    return NextResponse.json(
      {
        error: "This post went live while you were editing it, so nothing was changed.",
        code: "live_send",
      },
      { status: 409 }
    );
  }
  if (result === "still_used") {
    return NextResponse.json(
      {
        error:
          "Another post picked this file up while you were editing, so it wasn't deleted. " +
          "Nothing was changed.",
        code: "shared_asset",
      },
      { status: 409 }
    );
  }

  // Rows are gone — now the files, and only now. A failed row delete must never leave
  // files deleted, but a failed file delete only leaves harmless bytes behind.
  // assetFilePaths() owns the list of what an asset writes to disk; spelling it out here
  // instead is how the story canvas came to be missed when it was added.
  let leftover: string[] = [];
  if (mode === "everywhere" && asset) {
    leftover = (await Promise.all(assetFilePaths(asset).map(unlinkInsideStore))).filter(
      (p): p is string => p !== null
    );
    if (leftover.length > 0) {
      console.warn(`Asset ${assetId} row deleted, but these files remain: ${leftover.join(", ")}`);
    }
  }

  return NextResponse.json({
    post_type: checked.post_type,
    asset_ids: checked.slides.map((s) => s.asset_id),
    deleted_asset: mode === "everywhere",
    leftover,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/post-assets-remove-route.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Run the whole suite**

Run: `cd dashboard && npm test && npm run lint`
Expected: all PASS, 0 lint errors

- [ ] **Step 6: Commit**

```bash
git add "dashboard/app/api/posts/[id]/assets/[assetId]/route.ts" dashboard/test/post-assets-remove-route.test.ts
git commit -m "feat(media): remove a slide from a post, or delete the file outright"
```

**PHASE 1 CHECKPOINT — stop here and report.** The API is complete and tested; no UI exists yet. Confirm with the owner before starting Phase 2.

---

# Phase 2 — The UI

### Task 5: The library picker dialog

**Files:**
- Create: `dashboard/components/asset-picker-modal.tsx`
- Modify: `dashboard/app/api/assets/route.ts` — create it if absent; if a list route already exists, reuse it instead and skip Step 1
- Test: manual (a presentational dialog; the logic it carries is covered by Task 6's route calls)

**Interfaces:**
- Consumes: `GET /api/assets?exclude=1,2,3` → `{ assets: { id, media_kind, original_filename, cover_frame_ms }[] }`
- Produces: `<AssetPickerModal excludeIds={number[]} onPick={(ids: number[]) => void} onClose={() => void} />`

- [ ] **Step 1: Check whether an asset-list endpoint already exists**

Run: `cd dashboard && ls app/api/assets/ && grep -rn "export function listAssets\|export function getAssets" lib/queries.ts`

If `app/api/assets/route.ts` with a `GET` already exists, use it and skip to Step 2. Otherwise create `dashboard/app/api/assets/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { listAssetsWithUsage } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * The library, for the "choose an existing file" picker. Browser-facing, so the field
 * list is deliberately narrow: no storage_path, no content_hash, no public_url.
 *
 * `exclude` drops the slides a post already has, so the picker never offers a file that
 * would come straight back as "already_on_post".
 */
export async function GET(req: NextRequest) {
  const exclude = new Set(
    (req.nextUrl.searchParams.get("exclude") ?? "")
      .split(",")
      .map(Number)
      .filter(Number.isInteger)
  );
  const assets = listAssetsWithUsage()
    .filter((a) => !exclude.has(a.id))
    .map((a) => ({
      id: a.id,
      media_kind: a.media_kind,
      original_filename: a.original_filename,
      cover_frame_ms: a.cover_frame_ms,
    }));
  return NextResponse.json({ assets });
}
```

Check the real name of the library query first — `app/media/page.tsx` already reads it to render the media manager:

Run: `cd dashboard && grep -n "AssetWithUsage\|assets" app/media/page.tsx`

Use whatever function that page calls; replace `listAssetsWithUsage` above with its real name.

- [ ] **Step 2: Write the picker**

Create `dashboard/components/asset-picker-modal.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { videoPreviewSrc } from "@/lib/format";

interface PickableAsset {
  id: number;
  media_kind: string;
  original_filename: string | null;
  cover_frame_ms: number | null;
}

/**
 * Pick files already in the library to add to a post.
 *
 * Uploading the same file again would resolve to the same asset anyway — /api/assets/upload
 * dedups by content hash — so this exists to save hunting for the original on disk, not to
 * avoid a duplicate.
 */
export function AssetPickerModal({
  excludeIds,
  onPick,
  onClose,
}: {
  excludeIds: number[];
  onPick: (ids: number[]) => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<PickableAsset[] | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/assets?exclude=${excludeIds.join(",")}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((body: { assets: PickableAsset[] }) => live && setAssets(body.assets))
      .catch(() => live && setError("Couldn't load the library."));
    return () => {
      live = false;
    };
  }, [excludeIds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggle(id: number) {
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-card border border-border bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-medium text-ink">Choose from the library</h2>
        <p className="mt-1 text-sm text-faint">
          Files already on this post aren&rsquo;t shown.
        </p>

        {error ? <p className="mt-4 text-sm text-status-failed">{error}</p> : null}

        <div className="mt-4 grid flex-1 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
          {assets === null && !error ? (
            <p className="col-span-full text-sm text-faint">Loading…</p>
          ) : null}
          {assets?.length === 0 ? (
            <p className="col-span-full text-sm text-faint">
              Nothing else in the library yet.
            </p>
          ) : null}
          {assets?.map((a) => {
            const on = chosen.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => toggle(a.id)}
                aria-pressed={on}
                title={a.original_filename ?? `Asset ${a.id}`}
                className={`relative aspect-square overflow-hidden rounded-lg border-2 bg-surface-sunken ${
                  on ? "border-accent" : "border-transparent"
                }`}
              >
                {a.media_kind === "video" ? (
                  <video
                    src={videoPreviewSrc(a.id, a.cover_frame_ms)}
                    preload="metadata"
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${a.id}?variant=thumb`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                {on ? (
                  <span className="absolute right-1 top-1 rounded-full bg-accent px-2 py-0.5 text-xs text-on-accent">
                    {chosen.indexOf(a.id) + 1}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={() => onPick(chosen)}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-50"
          >
            Add {chosen.length || ""}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles and lints**

Run: `cd dashboard && npx tsc --noEmit && npm run lint`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add dashboard/components/asset-picker-modal.tsx dashboard/app/api/assets/route.ts
git commit -m "feat(media): pick an existing library file to add to a post"
```

---

### Task 6: The shared media editor strip

**Files:**
- Create: `dashboard/components/post-media-editor.tsx`
- Test: manual, in Task 7

**Interfaces:**
- Consumes: `POST /api/posts/[id]/assets`, `DELETE /api/posts/[id]/assets/[assetId]?mode=`, `POST /api/assets/upload`, `AssetPickerModal` (Task 5)
- Produces: `<PostMediaEditor postId={number} slides={EditorSlide[]} onChanged={() => void} />` where `interface EditorSlide { id: number; media_kind: string; cover_frame_ms: number | null }`

- [ ] **Step 1: Write the component**

Create `dashboard/components/post-media-editor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { videoPreviewSrc } from "@/lib/format";
import { AssetPickerModal } from "@/components/asset-picker-modal";

export interface EditorSlide {
  id: number;
  media_kind: string;
  cover_frame_ms: number | null;
}

/**
 * Add and remove a post's slides, in one component both edit surfaces mount.
 *
 * CHANGES APPLY IMMEDIATELY, not behind a Save button. QuickEditModal is
 * confirm-on-dismiss and compares every field against what it opened with; staging media
 * inside that model would mean tracking pending deletes and orphaning already-uploaded
 * files whenever someone hit Cancel. Slide REORDER in the same dialog already works this
 * way — its own Save, separate from the text fields — so this follows an existing
 * precedent rather than inventing a second one.
 *
 * Reordering is deliberately not here: <CarouselReorder> already owns it, through its own
 * endpoint, and the two are mounted side by side.
 */
export function PostMediaEditor({
  postId,
  slides,
  onChanged,
}: {
  postId: number;
  slides: EditorSlide[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState<EditorSlide | null>(null);
  const [otherUses, setOtherUses] = useState<number | null>(null);

  async function attach(assetIds: number[]) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/posts/${postId}/assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ asset_ids: assetIds }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't add that to the post.");
        return;
      }
      onChanged();
    } catch {
      setError("Couldn't reach the server. Is the dashboard still running?");
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    const uploaded: number[] = [];
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          asset?: { id: number };
        };
        if (!res.ok || !body.asset) {
          setError(body.error ?? `Couldn't upload ${file.name}.`);
          break;
        }
        uploaded.push(body.asset.id);
      }
    } catch {
      setError("Couldn't reach the server. Is the dashboard still running?");
    } finally {
      setBusy(false);
    }
    // Attach whatever DID upload, even if a later file failed — the successful uploads
    // are already in the library, and silently stranding them there is worse than
    // attaching them and showing the error about the one that failed.
    if (uploaded.length > 0) await attach(uploaded);
  }

  /**
   * Open the two-option confirm, and find out first whether "delete entirely" is even
   * available. The server refuses a shared asset independently — this only decides
   * whether to offer the button, so a stale count can't destroy anything.
   */
  async function openConfirm(slide: EditorSlide) {
    setError(null);
    setOtherUses(null);
    setConfirming(slide);
    try {
      const res = await fetch(`/api/assets/${slide.id}/usage?post_id=${postId}`);
      const body = (await res.json().catch(() => ({}))) as { other_post_count?: number };
      setOtherUses(body.other_post_count ?? 0);
    } catch {
      setOtherUses(0);
    }
  }

  async function remove(slide: EditorSlide, mode: "post" | "everywhere") {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/posts/${postId}/assets/${slide.id}?mode=${mode}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't remove that.");
        return;
      }
      setConfirming(null);
      onChanged();
    } catch {
      setError("Couldn't reach the server. Is the dashboard still running?");
    } finally {
      setBusy(false);
    }
  }

  const shared = otherUses !== null && otherUses > 0;

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {slides.map((s) => (
          <div
            key={s.id}
            className="relative h-24 w-24 overflow-hidden rounded-lg border border-border bg-surface-sunken"
          >
            {s.media_kind === "video" ? (
              <video
                src={videoPreviewSrc(s.id, s.cover_frame_ms)}
                preload="metadata"
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/${s.id}?variant=thumb`}
                alt=""
                className="h-full w-full object-cover"
              />
            )}
            <button
              type="button"
              disabled={busy || slides.length === 1}
              onClick={() => openConfirm(s)}
              title={
                slides.length === 1
                  ? "A post needs at least one photo"
                  : "Remove this from the post"
              }
              aria-label={`Remove slide ${s.id}`}
              className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 text-xs text-white disabled:opacity-40"
            >
              ✕
            </button>
          </div>
        ))}

        <div className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-faint">
          <label className="cursor-pointer text-ink-soft hover:underline">
            {busy ? "Working…" : "Upload"}
            {/* Accept both the MIME types and the extensions: a Windows machine with
                nothing registered for .webp sends an empty type. See lib/upload-mime.ts. */}
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.mp4,.mov"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                onFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => setPicking(true)}
            className="text-ink-soft hover:underline"
          >
            Library
          </button>
        </div>
      </div>

      {error ? <p className="mt-2 text-sm text-status-failed">{error}</p> : null}

      {picking ? (
        <AssetPickerModal
          excludeIds={slides.map((s) => s.id)}
          onClose={() => setPicking(false)}
          onPick={(ids) => {
            setPicking(false);
            attach(ids);
          }}
        />
      ) : null}

      {confirming ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !busy && setConfirming(null)}
        >
          <div
            className="w-full max-w-md rounded-card border border-border bg-surface p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-medium text-ink">Remove this photo?</h2>
            <p className="mt-2 text-sm text-muted">
              You can take it off this post and keep it in your library, or delete the file
              from your computer for good.
            </p>
            {shared ? (
              <p className="mt-2 text-sm text-faint">
                Also used by {otherUses} other post{otherUses === 1 ? "" : "s"}, so it
                can&rsquo;t be deleted outright.
              </p>
            ) : null}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(confirming, "post")}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink"
              >
                Remove from this post
              </button>
              <button
                type="button"
                disabled={busy || otherUses === null || shared}
                title={shared ? `Also used by ${otherUses} other posts` : undefined}
                onClick={() => remove(confirming, "everywhere")}
                className="rounded-lg bg-status-failed px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Delete the file entirely
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Add the usage endpoint the confirm dialog reads**

Create `dashboard/app/api/assets/[id]/usage/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { countOtherPostsUsingAsset } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * How many OTHER posts hold this asset — what decides whether the delete confirm can
 * offer "delete the file entirely".
 *
 * Advisory only. DELETE /api/posts/[id]/assets/[assetId] re-checks it inside its own
 * transaction, so a stale answer here can hide the button but can never destroy a file
 * another post is still using.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const assetId = Number(id);
  const postId = Number(req.nextUrl.searchParams.get("post_id"));
  if (!Number.isInteger(assetId) || !Number.isInteger(postId)) {
    return NextResponse.json({ error: "Bad ids." }, { status: 400 });
  }
  return NextResponse.json({ other_post_count: countOtherPostsUsingAsset(postId, assetId) });
}
```

- [ ] **Step 3: Verify it compiles and lints**

Run: `cd dashboard && npx tsc --noEmit && npm run lint`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add dashboard/components/post-media-editor.tsx "dashboard/app/api/assets/[id]/usage/route.ts"
git commit -m "feat(media): shared add/remove strip for a post's slides"
```

---

### Task 7: Mount it, and verify in a real browser

**Files:**
- Modify: `dashboard/components/post-editor.tsx:270-315` (the slide strip region)
- Modify: `dashboard/components/quick-edit-modal.tsx` (beside its existing `<CarouselReorder>`)
- Test: browser, against a scratch database

**Interfaces:**
- Consumes: `PostMediaEditor` (Task 6)
- Produces: nothing new

- [ ] **Step 1: Mount in the full editor**

In `dashboard/components/post-editor.tsx`, add the import:

```tsx
import { PostMediaEditor } from "@/components/post-media-editor";
```

Render it directly above the existing `<CarouselReorder>` / image-strip block (around line 273). `router` and `assets` are already in scope; `router.refresh()` re-runs the server component so the strip, the send panel, and `post_type` all update together — the same thing `saveSlideOrder` already does:

```tsx
<PostMediaEditor
  postId={post.id}
  slides={assets.map((a) => ({
    id: a.id,
    media_kind: a.media_kind,
    cover_frame_ms: a.cover_frame_ms,
  }))}
  onChanged={() => router.refresh()}
/>
```

- [ ] **Step 2: Mount in the quick-edit dialog**

`quick-edit-modal.tsx` currently loads its slides **only for a carousel** (`if (!isCarousel) return;` at line 174), because reordering is the only thing it needed them for. A single-image post therefore has no slide list at all — and that is exactly the post you most want to add a second photo to. So the fetch has to become unconditional, and it has to be re-runnable.

Add the import:

```tsx
import { PostMediaEditor } from "@/components/post-media-editor";
import { useCallback } from "react";
```

Replace the whole `useEffect` at lines 173-188 with a re-runnable loader:

```tsx
  // Loads unconditionally, not just for a carousel. Reordering only ever needed these for
  // a multi-slide post, but adding media needs them for a single too — and `post.post_type`
  // / `post.asset_count` come from the Library list, so they go stale the moment media
  // changes. `orderAssets` is the live truth once it lands.
  const reloadSlides = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/posts/${post.id}/assets`, { signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body.assets)) return;
      setOrderAssets(body.assets);
    } catch {
      // A failed load leaves the dialog exactly as it is today: captions and scheduling
      // still work, there is simply no media block. Not worth an error banner.
    }
  }, [post.id]);

  useEffect(() => {
    const controller = new AbortController();
    reloadSlides(controller.signal);
    return () => controller.abort();
  }, [reloadSlides]);
```

Then change `isCarousel` so the reorder block follows the live slide count rather than the stale prop — otherwise a post that just became a carousel shows no reorder UI until the dialog is reopened:

```tsx
  // Derived from the fetched slides, not post.post_type/post.asset_count: those are the
  // Library list's snapshot and do not move when media is added or removed here.
  const isCarousel = (orderAssets?.length ?? 0) > 1;
```

Note this makes the existing `const isCarousel = ...` on line 168 dead — delete that line, and move the new one below the `orderAssets` state declaration.

Finally, render the media editor immediately above the existing `{isCarousel && orderAssets ? (` block (line 344):

```tsx
        {orderAssets ? (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted">Media</h3>
            <PostMediaEditor
              postId={post.id}
              slides={orderAssets.map((a) => ({
                id: a.id,
                media_kind: a.media_kind,
                cover_frame_ms: a.cover_frame_ms,
              }))}
              onChanged={() => {
                // Media changes are immediate and OUTSIDE this dialog's dirty tracking, so
                // refetch rather than patching local state: post_type may have changed too,
                // and slideOrder's baseline has to move with it or a later reorder save
                // would send a stale permutation.
                void reloadSlides();
                onSaved?.();
              }}
            />
          </div>
        ) : null}
```

Check `onSaved`'s real name and signature in the component's props before using it — the Library and the Overview pass different callbacks. If calling it forces the dialog closed, drop it and rely on `reloadSlides()` alone; the parent list refreshes when the dialog is dismissed.

- [ ] **Step 3: Verify it compiles, lints, and the suite still passes**

Run: `cd dashboard && npx tsc --noEmit && npm run lint && npm test`
Expected: no errors, all tests PASS

- [ ] **Step 4: Set up a scratch database — do NOT verify against the live one**

This flow deletes files irreversibly. `process.env` beats `.env`, so point a second dashboard at a copy:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler"
mkdir -p /tmp/ss-scratch
sqlite3 data/socialscheduler.db ".backup /tmp/ss-scratch/scratch.db"
cp -R data/assets /tmp/ss-scratch/assets
cd dashboard && DATABASE_PATH=/tmp/ss-scratch/scratch.db ASSET_STORAGE_DIR=/tmp/ss-scratch/assets npm run dev -- -p 3940
```

Confirm the real DB path with `grep DATABASE_PATH ../.env` first and use whatever it actually names.

- [ ] **Step 5: Verify in the browser at `http://localhost:3940`**

Drive these with Playwright rather than by hand — media grids reflow after every change, so click coordinates drift. Check each:

1. **Full editor, add by upload** — open a draft at `/library/<id>`, upload an image. The strip gains a tile and the type line changes `single` → `carousel`.
2. **Full editor, add from library** — "Library", pick two, Add. Both appear, in the order picked.
3. **Remove from post** — ✕ on a slide → "Remove from this post". The tile goes; `/media` still lists the file, now as unused.
4. **Delete entirely** — ✕ → "Delete the file entirely". The tile goes and the file is gone from `/media`. Confirm on disk: `ls /tmp/ss-scratch/assets/<path>` returns nothing.
5. **Shared asset** — put one file on two posts (add it from the library to a second post), then try "Delete the file entirely". The button is disabled and reads "Also used by 1 other post".
6. **Last slide** — on a single-image post, ✕ is disabled with the title "A post needs at least one photo".
7. **Video mixing** — try adding a video to a carousel. The inline error reads "A video has to be on its own."
8. **Quick-edit dialog** — repeat 1 and 3 from the Library grid's Edit dialog, then press Esc. It must close *silently* — media changes are immediate, so they must not register as unsaved text edits.
9. **Overview queue** — repeat 3 from a queue row's Edit. The queue row's slide count updates.

- [ ] **Step 6: Stop the scratch server and clean up**

```bash
rm -rf /tmp/ss-scratch
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/post-editor.tsx dashboard/components/quick-edit-modal.tsx
git commit -m "feat(media): add and remove slides from every post edit surface"
```

- [ ] **Step 8: Update the docs**

Mark the feature done in `docs/tasks.md` following the file's existing format, and commit:

```bash
git add docs/tasks.md
git commit -m "docs: post media editing shipped"
```
