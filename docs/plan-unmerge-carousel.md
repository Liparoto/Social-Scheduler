# Unmerge a carousel into separate posts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a carousel post and split it into one post per slide — the original survives and keeps slide 1, each remaining slide becomes a new draft post carrying a copy of the caption, channels, tags, and seasons.

**Architecture:** Four layers, mirroring the shipped merge feature exactly. A pure planning module (`lib/unmerge-plan.ts`) holds every guard and imports no runtime code, so the whole rejection chain is unit-testable without SQLite. One `.immediate()` transaction (`unmergeCarousel` in `lib/queries.ts`) turns an approved plan into writes. A thin route passes through. A confirm modal fronts it. Five tasks, because the modal is the third to need the same focus trap, so Task 4 extracts that into a shared hook before Task 5 consumes it.

**Tech Stack:** Next.js 16.2.11 (App Router), React 19.2.4, TypeScript, better-sqlite3 ^13.0.1, `node --test` (the runner already wired up in `dashboard/package.json`).

**Spec:** `docs/design-unmerge-carousel.md`. Section references below (§3, §5, …) point into it.

## Global Constraints

- **Run every command from `dashboard/`.** Paths in this plan are relative to the repo root; commands are not.
- **No new dependencies.** Everything needed is already installed.
- **No schema migration.** Every table and column this needs exists. If you find yourself writing SQL DDL, stop — you have misread the plan.
- **Three checks must be at 0 errors before any task is done:** `npm test`, `npx tsc --noEmit`, `npm run lint`. Lint is currently at 0 and stays there.
- **Never `cp` the live database.** `data/socialscheduler.db` is in WAL mode and a plain copy reads torn. Tests use `makeTestDb()` (a fresh migrated temp DB); manual inspection uses `sqlite3 .backup`.
- **Never run `migrate.py` against the live DB to inspect it.** It has no argument parser — even `--help` applies migrations.
- **Guard messages are copied verbatim** from §5. They are owner-facing copy, not placeholders; do not reword them.
- **Only theme classes that already exist in `app/globals.css`.** There are 7 theme families × light and dark = 14 palettes, and an invented class renders invisible in some of them. Copy classes from `components/merge-modal.tsx` and `components/post-editor.tsx`.
- **Assets are never created, modified, or deleted** by any code in this plan. If an `INSERT`, `UPDATE`, or `DELETE` touches the `assets` table, it is wrong.

---

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/lib/unmerge-plan.ts` | **new.** Pure. Every guard from §5, plus `derivePostType`. Imports only a type. |
| `dashboard/lib/unmerge-plan.test.ts` | **new.** Guard chain, exhaustive, no SQLite. |
| `dashboard/lib/queries.ts` | **modify.** Add `loadUnmergeCandidate` (private reader) and `unmergeCarousel` (the transaction). |
| `dashboard/lib/queries.unmerge.test.ts` | **new.** The transaction against a real migrated DB. |
| `dashboard/app/api/posts/[id]/unmerge/route.ts` | **new.** Thin passthrough. No guards live here. |
| `dashboard/test/unmerge-route.test.ts` | **new.** Status codes and body shape through the real handler. |
| `dashboard/components/use-modal-focus-trap.ts` | **new.** The focus trap shared by every modal — extracted from the two existing copies. |
| `dashboard/components/media-lightbox.tsx` | **modify.** Convert to the shared hook. |
| `dashboard/components/merge-modal.tsx` | **modify.** Convert to the shared hook. |
| `dashboard/components/unmerge-modal.tsx` | **new.** Confirm dialog. Exports `splitSummary` so the copy is testable. |
| `dashboard/test-ui/unmerge-modal-ui.test.ts` | **new.** `splitSummary` pluralization. |
| `dashboard/components/post-editor.tsx` | **modify.** The action, rendered only for a carousel with 2+ slides. |
| `docs/tasks.md` | **modify.** Mark the Unmerge section done. |

---

## Task 1: Pure planning layer

**Files:**
- Create: `dashboard/lib/unmerge-plan.ts`
- Create: `dashboard/lib/unmerge-plan.test.ts`
- Modify: `docs/design-unmerge-carousel.md` (one factual correction, step 7)

**Interfaces:**
- Consumes: `PostType` from `dashboard/lib/types.ts` — `"single" | "carousel" | "reel" | "story" | "text"`.
- Produces, for Tasks 2 and 3:
  - `interface UnmergeSlide { asset_id: number; media_kind: string }`
  - `interface UnmergeCandidate { post_id: number; post_type: string; status: string; has_live_publication: boolean; has_queued_publication: boolean; slides: UnmergeSlide[] }`
  - `interface UnmergePart { asset_id: number; post_type: PostType }`
  - `type UnmergeProblem = { code: string; message: string; status: 400 | 404 | 409 }`
  - `function derivePostType(mediaKind: string): PostType`
  - `function planUnmerge(candidate: UnmergeCandidate | undefined): { ok: true; parts: UnmergePart[] } | { ok: false; problem: UnmergeProblem }`

**Note on `parts`:** `parts[0]` describes the **original** post's new state (it keeps slide 1 and gets retyped). `parts[1..]` each become a **new** post. It is deliberately not called `children` — that name would imply all of them are new, and Task 2 would then write one post too many.

**Note on the `has_live_publication` / `has_queued_publication` split:** at this layer they are plain booleans, so "has a `posted` publication" and "has a `publishing` publication" are the *same input*. Which publication statuses set each boolean is decided by the SQL in Task 2 and tested there. Do not write two identical tests here.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/unmerge-plan.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planUnmerge, derivePostType, type UnmergeCandidate } from "./unmerge-plan.ts";

function cand(over: Partial<UnmergeCandidate> = {}): UnmergeCandidate {
  return {
    post_id: 1,
    post_type: "carousel",
    status: "draft",
    has_live_publication: false,
    has_queued_publication: false,
    slides: [
      { asset_id: 10, media_kind: "image" },
      { asset_id: 20, media_kind: "image" },
    ],
    ...over,
  };
}

test("a three-image carousel splits into three single-image parts", () => {
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 10, media_kind: "image" },
        { asset_id: 20, media_kind: "image" },
        { asset_id: 30, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.parts, [
    { asset_id: 10, post_type: "single" },
    { asset_id: 20, post_type: "single" },
    { asset_id: 30, post_type: "single" },
  ]);
});

test("parts stay in the carousel's existing slide order", () => {
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 99, media_kind: "image" },
        { asset_id: 11, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    r.parts.map((p) => p.asset_id),
    [99, 11],
    "order is preserved verbatim — there is no reorder step"
  );
});

test("a video slide becomes a reel, not a single", () => {
  // THE invariant from spec §3. Wrong here means the child looks fine in the dashboard and
  // then fails NON-retryably at publish, which is the failure mode this guard exists for.
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 10, media_kind: "image" },
        { asset_id: 20, media_kind: "video" },
        { asset_id: 30, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    r.parts.map((p) => p.post_type),
    ["single", "reel", "single"]
  );
});

test("a video in slot ONE retypes the original post, not a new one", () => {
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 10, media_kind: "video" },
        { asset_id: 20, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parts[0].post_type, "reel", "parts[0] is the ORIGINAL post's new type");
});

test("a ten-slide carousel splits into ten parts", () => {
  const slides = Array.from({ length: 10 }, (_, i) => ({
    asset_id: (i + 1) * 10,
    media_kind: "image",
  }));
  const r = planUnmerge(cand({ slides }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parts.length, 10);
});

test("a missing post is 404, not a crash", () => {
  const r = planUnmerge(undefined);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 404);
  assert.equal(r.problem.code, "post_not_found");
});

test("a single-image post cannot be split", () => {
  const r = planUnmerge(cand({ post_type: "single", slides: [{ asset_id: 10, media_kind: "image" }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
  assert.equal(r.problem.code, "not_a_carousel");
});

test("a reel cannot be split", () => {
  const r = planUnmerge(cand({ post_type: "reel", slides: [{ asset_id: 10, media_kind: "video" }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "not_a_carousel");
});

test("a carousel with one slide has nothing to split", () => {
  const r = planUnmerge(cand({ slides: [{ asset_id: 10, media_kind: "image" }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
  assert.equal(r.problem.code, "too_few_slides");
});

test("a carousel with a live publication is refused", () => {
  const r = planUnmerge(cand({ has_live_publication: true }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
  assert.equal(r.problem.code, "already_published");
});

test("a post whose own status is 'posted' is refused even with no publication rows", () => {
  const r = planUnmerge(cand({ status: "posted" }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "already_published");
});

test("a carousel with a queued send is refused, with its OWN message", () => {
  const r = planUnmerge(cand({ has_queued_publication: true }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
  assert.equal(r.problem.code, "send_queued");
  assert.match(r.problem.message, /queue/i, "must point the owner at queue control");
});

test("published beats queued — the unresolvable problem is the one reported", () => {
  const r = planUnmerge(cand({ has_live_publication: true, has_queued_publication: true }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "already_published");
});

test("guards run before type derivation — a bad post is rejected, not described", () => {
  // A 'posted' carousel containing a video must report already_published. If derivation ran
  // first this would still pass, so the point is the ORDER, checked via the failure code.
  const r = planUnmerge(
    cand({ status: "posted", slides: [{ asset_id: 10, media_kind: "video" }, { asset_id: 20, media_kind: "image" }] })
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "already_published");
});

test("derivePostType maps media_kind, never asset count", () => {
  assert.equal(derivePostType("video"), "reel");
  assert.equal(derivePostType("image"), "single");
});

test("derivePostType never produces 'story' — a Story is a target surface, not a type", () => {
  assert.equal(derivePostType("story"), "single");
  assert.equal(derivePostType(""), "single");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/unmerge-plan.test.ts
```

Expected: FAIL — `Cannot find module './unmerge-plan.ts'`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/lib/unmerge-plan.ts`:

```ts
// Pure decision layer for splitting one carousel back into separate posts. Every guard from
// docs/design-unmerge-carousel.md §5 lives here and nowhere else, and this file imports only
// a TYPE — no database, no server-only, no Node built-ins, not even ./platforms — so the
// whole guard chain can be exhaustively unit-tested without ever touching SQLite. The caller
// (unmergeCarousel, running inside a DB transaction) is responsible for loading an
// UnmergeCandidate and turning an { ok: true } result into actual writes; this module never
// mutates anything.
//
// Unlike merge, there is no per-platform cap to consult: splitting only ever produces posts
// with ONE asset, and no platform caps that. Hence no ./platforms import.

import type { PostType } from "./types";

export interface UnmergeSlide {
  asset_id: number;
  media_kind: string; // "image" | "video"
}

export interface UnmergeCandidate {
  post_id: number;
  post_type: string;
  status: string;
  /** Any publication 'posted' or 'publishing' — it exists on the platform, or is mid-flight. */
  has_live_publication: boolean;
  /** Any publication 'scheduled' or 'pending_approval' — waiting, and the owner can cancel it. */
  has_queued_publication: boolean;
  slides: UnmergeSlide[]; // in current sort_order
}

/**
 * One resulting post. `parts[0]` describes the ORIGINAL post's new state — it keeps slide 1,
 * its id, its publications, and the metrics hanging off them. `parts[1..]` each become a NEW
 * draft post. Not called "children": that name would imply all of them are new, and the
 * caller would write one post too many.
 */
export interface UnmergePart {
  asset_id: number;
  post_type: PostType;
}

export type UnmergeProblem = { code: string; message: string; status: 400 | 404 | 409 };

type UnmergeResult =
  | { ok: true; parts: UnmergePart[] }
  | { ok: false; problem: UnmergeProblem };

function problem(code: string, message: string, status: 400 | 404 | 409): UnmergeResult {
  return { ok: false, problem: { code, message, status } };
}

/**
 * A post's type comes from its ONE asset's media_kind, never from asset count.
 * worker/publisher.py re-validates post_type against the real assets at publish time and
 * fails NON-retryably on a mismatch, so a video slide left as 'single' looks perfect in the
 * dashboard and then dies at send.
 *
 * 'story' is never produced here: an Instagram Story is a per-target SURFACE
 * (post_targets.surface), not a post_type. See docs/design-instagram-stories.md.
 */
export function derivePostType(mediaKind: string): PostType {
  return mediaKind === "video" ? "reel" : "single";
}

export function planUnmerge(candidate: UnmergeCandidate | undefined): UnmergeResult {
  // Guard 1: a stale link or a post deleted between page load and submit fails here, as a
  // 404, rather than later as a confusing undefined.
  if (!candidate) {
    return problem("post_not_found", "That post no longer exists.", 404);
  }

  // Guard 2: only a carousel has slides to separate. A single, reel, story or text post has
  // nothing to split, and silently succeeding on one would be a no-op the owner can't see.
  if (candidate.post_type !== "carousel") {
    return problem("not_a_carousel", "Only a carousel can be split into separate posts.", 400);
  }

  // Guard 3: a one-slide "carousel" is already inconsistent data. Splitting it would produce
  // exactly one post — a no-op dressed up as an operation.
  if (candidate.slides.length < 2) {
    return problem(
      "too_few_slides",
      "That carousel only has one photo — there's nothing to split.",
      400,
    );
  }

  // Guard 4: a published carousel has real Instagram media attached and metrics accumulating
  // against it. It is a record of something that actually happened, and rewriting its slides
  // would make the record describe something other than what was posted.
  //
  // Checked BEFORE guard 5 deliberately: a carousel that is both published and re-queued
  // reports THIS problem, which is the one the owner can never resolve.
  if (candidate.has_live_publication || candidate.status === "posted") {
    return problem(
      "already_published",
      "That carousel has already been published — splitting it would break the record of what went out.",
      409,
    );
  }

  // Guard 5: one carousel with a queued send becomes N posts, and there is no non-surprising
  // answer to where that send should land. Canceling it silently kills something the owner
  // scheduled; letting it follow the original silently changes what publishes. So the
  // decision goes back to the owner, who already has cancel and hold in queue control.
  if (candidate.has_queued_publication) {
    return problem(
      "send_queued",
      "That carousel has a send in the queue. Cancel or hold that send first, then split.",
      409,
    );
  }

  return {
    ok: true,
    parts: candidate.slides.map((s) => ({
      asset_id: s.asset_id,
      post_type: derivePostType(s.media_kind),
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/unmerge-plan.test.ts
```

Expected: PASS, 16 tests, 0 failures.

- [ ] **Step 5: Run the full check suite**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass, **0 errors** from each. If lint reports anything, fix it now — it is at 0 today.

- [ ] **Step 6: Correct one factual claim in the design doc**

§5 of `docs/design-unmerge-carousel.md` says the module "imports nothing but `./platforms`". It turned out not to need `./platforms` at all — splitting only ever produces one-asset posts, and no platform caps those. In `docs/design-unmerge-carousel.md`, replace:

```
All of them live in `dashboard/lib/unmerge-plan.ts`, which imports nothing but `./platforms` —
no database, no `server-only`, no Node built-ins — so the whole chain is exhaustively unit
testable without SQLite. This mirrors `lib/merge-plan.ts` exactly.
```

with:

```
All of them live in `dashboard/lib/unmerge-plan.ts`, which imports only a type — no database,
no `server-only`, no Node built-ins, not even `./platforms` — so the whole chain is
exhaustively unit testable without SQLite. This mirrors `lib/merge-plan.ts`, which does import
`./platforms` for the carousel size cap; splitting has no cap to consult, because it only ever
produces posts with one asset.
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/unmerge-plan.ts dashboard/lib/unmerge-plan.test.ts docs/design-unmerge-carousel.md
git commit -m "feat(unmerge): pure planning layer with every guard

planUnmerge holds all five guards from the design's §5 and derives each
resulting post's type from its own asset's media_kind, so a video slide
becomes a reel rather than an unpublishable single. Pure — imports only a
type, so the guard chain tests without SQLite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The transaction

**Files:**
- Modify: `dashboard/lib/queries.ts` (add two functions; add to the existing import from `./unmerge-plan`)
- Create: `dashboard/lib/queries.unmerge.test.ts`

**Interfaces:**
- Consumes from Task 1: `planUnmerge`, `UnmergeCandidate`, `UnmergeProblem`.
- Consumes, already in `lib/queries.ts`: `getDb()`, `nowIso()`, `getPost(id)`.
- Produces, for Task 3:
  - `function unmergeCarousel(postId: number): { ok: true; post_ids: number[] } | { ok: false; problem: UnmergeProblem }`
  - `post_ids[0]` is always the original `postId`; the rest are newly created, in slide order.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/queries.unmerge.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// node --test runs each FILE in its own process, but every test in this file shares that
// process — and lib/db.ts memoises its connection in a module-level `_db`, so the second
// setup() here gets the SAME database as the first no matter how many temp files
// makeTestDb() creates. Hence the per-setup prefix on content_hash/storage_path: assets are
// deduped by content hash (UNIQUE), so a literal "hash-1" in two tests would collide.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `u${++setupSeq}`;

  const mkAsset = (n: number, kind: "image" | "video" = "image") =>
    Number(
      db
        .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, ?, ?)")
        .run(`${prefix}-hash-${n}`, kind, `a/${prefix}/${n}.jpg`).lastInsertRowid
    );

  const mkChannel = (name: string) =>
    Number(
      db
        .prepare(
          "INSERT INTO channels (platform, account_name, is_active) VALUES ('instagram', ?, 1)"
        )
        .run(`${prefix}-${name}`).lastInsertRowid
    );

  // tags.name is UNIQUE COLLATE NOCASE and periods.name is UNIQUE — both need the prefix for
  // the same reason the asset hashes do: every setup() in this file shares one database.
  const mkTag = (name: string) =>
    Number(
      db
        .prepare("INSERT INTO tags (kind, name) VALUES ('topic', ?)")
        .run(`${prefix}-${name}`).lastInsertRowid
    );

  const mkPeriod = (name: string) =>
    Number(
      db
        .prepare(
          "INSERT INTO periods (name, start_month, start_day, end_month, end_day) VALUES (?, 6, 1, 8, 31)"
        )
        .run(`${prefix}-${name}`).lastInsertRowid
    );

  /** A carousel with N slides, created directly so post_type is exactly what we say. */
  const mkCarousel = (assetIds: number[]) =>
    q.createDraftPost({
      caption: "",
      first_comment: "",
      asset_ids: assetIds,
      post_type: "carousel",
    });

  return { q, db, mkAsset, mkChannel, mkTag, mkPeriod, mkCarousel };
}

test("a three-slide carousel becomes three posts, original first", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const assets = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(assets);

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.post_ids.length, 3);
  assert.equal(res.post_ids[0], original, "the original post survives and comes first");

  // Each resulting post holds exactly one slide, at sort_order 0, in the original order.
  res.post_ids.forEach((pid, i) => {
    const rows = db
      .prepare("SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order")
      .all(pid);
    assert.deepEqual(rows, [{ asset_id: assets[i], sort_order: 0 }], `post ${i} holds slide ${i}`);
  });
});

test("every resulting post is retyped — none is left as a carousel", async () => {
  // THE invariant from spec §3. A post left as 'carousel' with one asset looks fine in the
  // dashboard and then fails NON-retryably at send with "carousel needs 2-10 assets, has 1".
  const { q, mkAsset, mkCarousel } = await setup();
  const res = q.unmergeCarousel(mkCarousel([mkAsset(1), mkAsset(2)]));
  assert.equal(res.ok, true);
  if (!res.ok) return;

  for (const pid of res.post_ids) {
    assert.equal(q.getPost(pid)?.post_type, "single");
  }
});

test("a video slide becomes a reel, including when it is slide one", async () => {
  const { q, mkAsset, mkCarousel } = await setup();
  const vid = mkAsset(1, "video");
  const img = mkAsset(2);
  const res = q.unmergeCarousel(mkCarousel([vid, img]));
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(q.getPost(res.post_ids[0])?.post_type, "reel", "the ORIGINAL was retyped");
  assert.equal(q.getPost(res.post_ids[1])?.post_type, "single");
});

test("no asset is created, deleted, or orphaned", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2), mkAsset(3)]);
  const before = (db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c;

  q.unmergeCarousel(original);

  const after = (db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c;
  assert.equal(after, before, "assets are SHARED, never copied or deleted");
});

test("the post_assets row count is unchanged, so /media usage stays correct", async () => {
  // listAssetsWithUsage() counts usage via post_assets. N rows on one post must become
  // N rows across N posts — if this drifts, the "unused" figure and the reclaim total on
  // /media start lying.
  const { q, db, mkAsset, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2), mkAsset(3)]);
  const before = (db.prepare("SELECT COUNT(*) c FROM post_assets").get() as { c: number }).c;

  q.unmergeCarousel(original);

  const after = (db.prepare("SELECT COUNT(*) c FROM post_assets").get() as { c: number }).c;
  assert.equal(after, before);
});

test("each new post gets its own COPY of caption, variants, targets, tags and seasons", async () => {
  const { q, db, mkAsset, mkChannel, mkTag, mkPeriod } = await setup();
  const channel = mkChannel("ig");
  const tag = mkTag("beach");
  const periodId = mkPeriod("summer");
  const original = q.createDraftPost({
    caption: "sunset",
    first_comment: "#tags",
    asset_ids: [mkAsset(1), mkAsset(2)],
    post_type: "carousel",
    content_kind: "evergreen",
    content_status: "ready",
    cooldown_days: 45,
    targets: [{ channel_id: channel, surface: "story" }],
    tag_ids: [tag],
    period_links: [{ periodId, mode: "green" }],
    caption_variants: [{ platform: null, body: "sunset", sort_order: 0 }],
  });

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const child = res.post_ids[1];

  const post = q.getPost(child);
  assert.equal(post?.caption, "sunset");
  assert.equal(post?.first_comment, "#tags");
  assert.equal(post?.content_kind, "evergreen");
  assert.equal(post?.content_status, "ready");
  assert.equal(post?.cooldown_days, 45);
  assert.equal(post?.status, "draft", "a post with no publications is a draft");

  assert.deepEqual(
    db.prepare("SELECT body FROM caption_variants WHERE post_id = ?").all(child),
    [{ body: "sunset" }],
    "the worker prefers caption_variants over posts.caption — both must come across"
  );
  assert.deepEqual(
    db.prepare("SELECT channel_id, surface FROM post_targets WHERE post_id = ?").all(child),
    [{ channel_id: channel, surface: "story" }],
    "surface must survive — a Story target is not a plain channel target"
  );
  assert.deepEqual(db.prepare("SELECT tag_id FROM post_tags WHERE post_id = ?").all(child), [
    { tag_id: tag },
  ]);
  assert.deepEqual(
    db.prepare("SELECT period_id, mode FROM post_periods WHERE post_id = ?").all(child),
    [{ period_id: periodId, mode: "green" }]
  );
});

test("the original keeps everything it had — only its slides and type change", async () => {
  const { q, db, mkAsset, mkChannel } = await setup();
  const channel = mkChannel("ig");
  const original = q.createDraftPost({
    caption: "kept",
    first_comment: "",
    asset_ids: [mkAsset(1), mkAsset(2)],
    post_type: "carousel",
    targets: [{ channel_id: channel, surface: "feed" }],
    caption_variants: [{ platform: null, body: "kept", sort_order: 0 }],
  });

  q.unmergeCarousel(original);

  assert.equal(q.getPost(original)?.caption, "kept");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM caption_variants WHERE post_id = ?").get(original) as { c: number }).c,
    1,
    "the original's variants are not moved to the children — they are copied"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM post_targets WHERE post_id = ?").get(original) as { c: number }).c,
    1
  );
});

test("editing a child's caption afterwards does not change the original", async () => {
  // The copy-not-share contract from §4. If this fails, the modal's "each keeps" is a lie.
  const { q, db, mkAsset } = await setup();
  const original = q.createDraftPost({
    caption: "shared?",
    first_comment: "",
    asset_ids: [mkAsset(1), mkAsset(2)],
    post_type: "carousel",
  });
  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  db.prepare("UPDATE posts SET caption = 'changed' WHERE id = ?").run(res.post_ids[1]);
  assert.equal(q.getPost(original)?.caption, "shared?");
});

test("non-contiguous sort_order is rebuilt from zero", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const assets = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(assets);
  // Force a gap-y order. Descending, so no intermediate UPDATE collides with an existing row.
  db.prepare("UPDATE post_assets SET sort_order = 7 WHERE post_id = ? AND asset_id = ?").run(original, assets[2]);
  db.prepare("UPDATE post_assets SET sort_order = 3 WHERE post_id = ? AND asset_id = ?").run(original, assets[1]);

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  for (const pid of res.post_ids) {
    const rows = db.prepare("SELECT sort_order FROM post_assets WHERE post_id = ?").all(pid);
    assert.deepEqual(rows, [{ sort_order: 0 }], "every post's single slide sits at 0");
  }
});

test("a carousel with a 'posted' publication is refused and nothing is written", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(original, mkChannel("ig"));
  const postsBefore = (db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c;

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.status, 409);
  assert.equal(res.problem.code, "already_published");

  assert.equal((db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c, postsBefore);
  assert.equal(q.getPost(original)?.post_type, "carousel", "a refused split changes nothing");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM post_assets WHERE post_id = ?").get(original) as { c: number }).c,
    2,
    "its slides are intact"
  );
});

test("a 'publishing' publication is refused too — the worker is mid-flight", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'publishing')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "already_published");
});

test("a 'scheduled' publication is refused, pointing at queue control", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'scheduled')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.status, 409);
  assert.equal(res.problem.code, "send_queued");
});

test("a 'pending_approval' publication is refused — it is a real pending send", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'pending_approval')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "send_queued");
});

test("'failed' and 'canceled' publications do NOT block a split", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  const ch = mkChannel("ig");
  const ins = db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', ?)"
  );
  ins.run(original, ch, "failed");
  ins.run(original, ch, "canceled");

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true, "neither is live and neither is waiting to go out");
});

test("a dead publication stays on the ORIGINAL and is not copied to a child", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'failed')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM publications WHERE post_id = ?").get(original) as { c: number }).c,
    1,
    "the original keeps its own history"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM publications WHERE post_id = ?").get(res.post_ids[1]) as { c: number }).c,
    0,
    "a new post has never been sent anywhere"
  );
});

test("a missing post is 404", async () => {
  const { q } = await setup();
  const res = q.unmergeCarousel(999999);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.status, 404);
});

test("the database has no broken references afterwards", async () => {
  const { q, db, mkAsset, mkChannel, mkTag } = await setup();
  const original = q.createDraftPost({
    caption: "fk",
    first_comment: "",
    asset_ids: [mkAsset(1), mkAsset(2), mkAsset(3)],
    post_type: "carousel",
    targets: [{ channel_id: mkChannel("ig"), surface: "feed" }],
    tag_ids: [mkTag("t")],
  });
  q.unmergeCarousel(original);

  assert.deepEqual(db.pragma("foreign_key_check"), [], "no dangling references");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/queries.unmerge.test.ts
```

Expected: FAIL — `q.unmergeCarousel is not a function`.

> If instead it fails inside `setup()` on a `channels`, `tags`, or `periods` INSERT, a NOT NULL column is missing from the fixture. Read the table in `migrations/0001_init.sql` and add the column — do not change the test's intent.

- [ ] **Step 3: Extend the existing unmerge-plan import in `lib/queries.ts`**

Find the import block near the top of `dashboard/lib/queries.ts` where `merge-plan` is imported and add alongside it:

```ts
import { planUnmerge, type UnmergeCandidate, type UnmergeProblem } from "./unmerge-plan";
```

- [ ] **Step 4: Add the candidate loader**

Add to `dashboard/lib/queries.ts`, directly after the existing `loadMergeCandidate` function:

```ts
/**
 * Everything planUnmerge needs about one post, in two cheap queries plus two EXISTS probes.
 * Not exported: the plan layer is the only consumer, and it must stay the only place that
 * decides what these booleans MEAN.
 */
function loadUnmergeCandidate(
  db: ReturnType<typeof getDb>,
  postId: number
): UnmergeCandidate | undefined {
  const post = db
    .prepare("SELECT id, post_type, status FROM posts WHERE id = ?")
    .get(postId) as { id: number; post_type: string; status: string } | undefined;
  if (!post) return undefined;

  const slides = db
    .prepare(
      `SELECT pa.asset_id, a.media_kind
         FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
        WHERE pa.post_id = ? ORDER BY pa.sort_order ASC`
    )
    .all(postId) as { asset_id: number; media_kind: string }[];

  // Same live-send definition deletePost and loadMergeCandidate use: 'posted' means it exists
  // on the platform, 'publishing' means the worker is mid-flight with it right now.
  const live = db
    .prepare(
      `SELECT 1 FROM publications
        WHERE post_id = ? AND status IN ('posted','publishing') LIMIT 1`
    )
    .get(postId);

  // Deliberately a SEPARATE probe from `live`, not folded into one IN (...) list: a queued
  // send gets its own 409 with its own message, because unlike a published one it is
  // something the owner can actually resolve (cancel or hold it in queue control).
  const queued = db
    .prepare(
      `SELECT 1 FROM publications
        WHERE post_id = ? AND status IN ('scheduled','pending_approval') LIMIT 1`
    )
    .get(postId);

  return {
    post_id: post.id,
    post_type: post.post_type,
    status: post.status,
    has_live_publication: live !== undefined,
    has_queued_publication: queued !== undefined,
    slides,
  };
}
```

- [ ] **Step 5: Add the transaction**

Add to `dashboard/lib/queries.ts`, directly after `mergePostsIntoCarousel`:

```ts
/**
 * Split one carousel into separate posts — the return trip for mergePostsIntoCarousel.
 *
 * The ORIGINAL post survives and keeps slide 1, along with its id, its publications, and the
 * metrics hanging off them. Each remaining slide becomes a NEW draft post carrying a COPY of
 * the original's caption, caption variants, channel targets (surface included), tags, and
 * season links. Copies, not moves: editing one afterwards does not change the others, which
 * is what the confirm modal's "each keeps" promises.
 *
 * **Assets are shared, never copied.** They are deduped by content hash, so every resulting
 * post references the same `assets` row. Nothing is written to /data, and no asset row is
 * created, changed, or deleted by this function.
 *
 * **Each post's `post_type` is derived from its OWN asset's media_kind** (a video slide
 * becomes a 'reel'), never from asset count. This deliberately does NOT go through
 * createDraftPost, which derives post_type from count alone and would leave a video slide as
 * an unpublishable 'single'.
 *
 * Returns the plan's own problem (with its HTTP status) on rejection, having written nothing.
 * `post_ids[0]` is always `postId`.
 */
export function unmergeCarousel(
  postId: number
): { ok: true; post_ids: number[] } | { ok: false; problem: UnmergeProblem } {
  const db = getDb();
  const tx = db.transaction(():
    | { ok: true; post_ids: number[] }
    | { ok: false; problem: UnmergeProblem } => {
    const plan = planUnmerge(loadUnmergeCandidate(db, postId));
    // Rejected: return before a single write happens. (The transaction commits empty.)
    if (!plan.ok) return { ok: false, problem: plan.problem };

    const now = nowIso();
    const [first, ...rest] = plan.parts;

    // Read the source ONCE, before anything is written. Re-reading per child would also
    // start picking up rows the loop itself just inserted.
    const source = db
      .prepare(
        `SELECT caption, first_comment, content_kind, content_status, cooldown_days, created_by
           FROM posts WHERE id = ?`
      )
      .get(postId) as {
      caption: string | null;
      first_comment: string | null;
      content_kind: string;
      content_status: string;
      cooldown_days: number | null;
      created_by: string | null;
    };
    const variants = db
      .prepare("SELECT platform, body, sort_order FROM caption_variants WHERE post_id = ?")
      .all(postId) as { platform: string | null; body: string; sort_order: number }[];
    const targets = db
      .prepare("SELECT channel_id, surface FROM post_targets WHERE post_id = ?")
      .all(postId) as { channel_id: number; surface: string }[];
    const tags = db
      .prepare("SELECT tag_id FROM post_tags WHERE post_id = ?")
      .all(postId) as { tag_id: number }[];
    const periods = db
      .prepare("SELECT period_id, mode FROM post_periods WHERE post_id = ?")
      .all(postId) as { period_id: number; mode: string }[];

    // post_assets carries no data worth preserving — (id, post_id, asset_id, sort_order), and
    // nothing references its id. UNIQUE (post_id, sort_order) is checked per-row and
    // IMMEDIATELY, and the original's sort_order values are not guaranteed contiguous from
    // zero, so rather than reasoning about which rows can safely stay, every row is deleted
    // and the one slide the original keeps is rebuilt at 0. Same resolution
    // mergePostsIntoCarousel uses, for the same reason.
    db.prepare("DELETE FROM post_assets WHERE post_id = ?").run(postId);
    db.prepare("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, 0)").run(
      postId,
      first.asset_id
    );
    // Retyped from slide 1's OWN media_kind — not assumed to be 'single'. Everything else on
    // the original (status, caption, variants, targets, tags, periods, publications) is
    // deliberately untouched.
    db.prepare("UPDATE posts SET post_type = ?, updated_at = ? WHERE id = ?").run(
      first.post_type,
      now,
      postId
    );

    const insertPost = db.prepare(
      `INSERT INTO posts (caption, first_comment, post_type, status, content_kind,
                          content_status, cooldown_days, created_by, updated_at)
       VALUES (@caption, @first_comment, @post_type, 'draft', @content_kind,
               @content_status, @cooldown_days, @created_by, @now)`
    );
    const insertSlide = db.prepare(
      "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, 0)"
    );
    const insertVariant = db.prepare(
      "INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?, ?, ?, ?)"
    );
    const insertTarget = db.prepare(
      "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?, ?, ?)"
    );
    const insertTag = db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)");
    const insertPeriod = db.prepare(
      "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?, ?, ?)"
    );

    const created: number[] = [];
    for (const part of rest) {
      // status is hardcoded 'draft' in the statement above: a brand-new post has no
      // publications, and 'draft' is what that means. Copying the original's status would
      // claim a send history this post does not have.
      const newId = Number(
        insertPost.run({
          caption: source.caption,
          first_comment: source.first_comment,
          post_type: part.post_type,
          content_kind: source.content_kind,
          content_status: source.content_status,
          cooldown_days: source.cooldown_days,
          created_by: source.created_by,
          now,
        }).lastInsertRowid
      );
      insertSlide.run(newId, part.asset_id);
      // posts.caption and caption_variants always move together: the worker reads variants in
      // preference to posts.caption, so copying one without the other would publish text the
      // post record says isn't there.
      for (const v of variants) insertVariant.run(newId, v.platform, v.body, v.sort_order);
      for (const t of targets) insertTarget.run(newId, t.channel_id, t.surface);
      for (const t of tags) insertTag.run(newId, t.tag_id);
      for (const p of periods) insertPeriod.run(newId, p.period_id, p.mode);
      created.push(newId);
    }

    return { ok: true, post_ids: [postId, ...created] };
  });
  // .immediate() takes the write lock at BEGIN instead of on the first write statement. This
  // function reads the rows it validates (loadUnmergeCandidate) and then writes based on what
  // it read, so a deferred transaction would hold together only thanks to WAL snapshot
  // isolation — and under a concurrent writer it would surface as an opaque SQLITE_BUSY
  // partway through the split rather than a clean rejection. Same reasoning as
  // mergePostsIntoCarousel.
  return tx.immediate();
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test lib/queries.unmerge.test.ts
```

Expected: PASS, 17 tests, 0 failures.

- [ ] **Step 7: Run the full check suite**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass, **0 errors** from each.

- [ ] **Step 8: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/lib/queries.unmerge.test.ts
git commit -m "feat(unmerge): the split transaction

unmergeCarousel keeps the original post (and its id, publications, and
metrics) holding slide 1, and creates one new draft per remaining slide
with a copy of the caption, variants, targets, tags and seasons. One
.immediate() transaction; assets are shared, never copied.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The API route

**Files:**
- Create: `dashboard/app/api/posts/[id]/unmerge/route.ts`
- Create: `dashboard/test/unmerge-route.test.ts`

**Interfaces:**
- Consumes from Task 2: `unmergeCarousel(postId)`.
- Produces, for Task 4: `POST /api/posts/:id/unmerge` → `200 { ok: true, post_ids: number[] }`, or an error status from §5 with `{ error: string }`.

**This route holds no guards.** Every rejection comes from `unmergeCarousel`. The only thing checked here is that the URL segment parses as an integer.

- [ ] **Step 1: Write the failing test**

Create `dashboard/test/unmerge-route.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { POST } = await import("../app/api/posts/[id]/unmerge/route.ts");

let seq = 0;

function mkAsset() {
  const n = ++seq;
  return Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`route-hash-${n}`, `a/route/${n}.jpg`).lastInsertRowid
  );
}

function mkCarousel(slides = 2) {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: Array.from({ length: slides }, mkAsset),
    post_type: "carousel",
  });
}

function call(id: string | number) {
  return POST(new NextRequest(`http://localhost:3939/api/posts/${id}/unmerge`, { method: "POST" }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

test("splitting a carousel returns 200 and every resulting post id", async () => {
  const original = mkCarousel(3);
  const res = await call(original);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.post_ids.length, 3);
  assert.equal(body.post_ids[0], original, "the original is first, so the UI can stay on it");
});

test("a missing post is 404 with a readable message", async () => {
  const res = await call(999999);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no longer exists/i);
});

test("a non-numeric id is 400, not a crash", async () => {
  const res = await call("not-a-number");
  assert.equal(res.status, 400);
});

test("a single-image post is 400", async () => {
  const post = q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: [mkAsset()],
  });
  const res = await call(post);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /only a carousel/i);
});

test("a queued send is 409, and the message names the fix", async () => {
  const original = mkCarousel(2);
  const channel = Number(
    db
      .prepare("INSERT INTO channels (platform, account_name, is_active) VALUES ('instagram', ?, 1)")
      .run(`route-ch-${++seq}`).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'scheduled')"
  ).run(original, channel);

  const res = await call(original);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cancel or hold/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/unmerge-route.test.ts
```

Expected: FAIL — cannot resolve `../app/api/posts/[id]/unmerge/route.ts`.

- [ ] **Step 3: Write the route**

Create `dashboard/app/api/posts/[id]/unmerge/route.ts`:

```ts
import { NextResponse } from "next/server";
import { unmergeCarousel } from "@/lib/queries";

// Thin passthrough, matching app/api/posts/merge/route.ts. Every real guard lives in
// lib/unmerge-plan.ts, reached through unmergeCarousel — the only thing validated here is
// that the URL segment is actually a number.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }
  const result = unmergeCarousel(postId);
  if (!result.ok) {
    return NextResponse.json({ error: result.problem.message }, { status: result.problem.status });
  }
  return NextResponse.json({ ok: true, post_ids: result.post_ids });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd dashboard && node --conditions=react-server --import ./test/hook.mjs --test test/unmerge-route.test.ts
```

Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 5: Run the full check suite**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass, **0 errors** from each.

- [ ] **Step 6: Commit**

```bash
git add "dashboard/app/api/posts/[id]/unmerge/route.ts" dashboard/test/unmerge-route.test.ts
git commit -m "feat(unmerge): POST /api/posts/[id]/unmerge

Thin passthrough matching the merge route — the only check here is that
the id parses; every guard lives below it in the plan layer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Extract the shared modal focus trap

**Files:**
- Create: `dashboard/components/use-modal-focus-trap.ts`
- Modify: `dashboard/components/merge-modal.tsx`
- Modify: `dashboard/components/media-lightbox.tsx`

**Interfaces:**
- Produces, for Task 5: `useModalFocusTrap({ panelRef, onClose, onKeyDown? }): void`

**This is a pure refactor. No behaviour changes.** `merge-modal.tsx` and `media-lightbox.tsx` each carry their own copy of the same ~45-line focus-trap effect, and the unmerge modal in Task 5 would make three. Three copies is where it gets extracted. The two existing files must behave *identically* afterwards — if you find yourself improving the trap while moving it, stop and move it unchanged.

**The one real difference between the two copies:** the lightbox also handles `ArrowLeft`/`ArrowRight`, checked **after** Escape and **before** Tab. The hook takes an optional `onKeyDown` for exactly that slot. `merge-modal.tsx` does not pass one.

**Why there is no unit test for this task:** the hook needs a live DOM (`document.activeElement`, `document.body.style`, a real event listener), and this project's test harness has no jsdom — which is why neither existing copy is unit-tested today. `npx tsc --noEmit` and `npm run lint` are the automated gates here; behaviour is verified in the browser at **Task 5, step 7**, which exercises all three modals — the two this task refactors and the new one. Do not add a test framework for this.

- [ ] **Step 1: Write the hook**

Create `dashboard/components/use-modal-focus-trap.ts`:

```ts
"use client";

import { useEffect, useRef } from "react";

// Every focusable thing a modal panel can contain. Shared so the trap, the initial focus,
// and the Tab cycling all agree on what "focusable" means — they broke apart once when only
// one of the three was updated.
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The behaviour every modal in this app shares: focus the first control on open, keep Tab
 * inside the panel, close on Escape, lock body scroll while open, and put focus back where
 * it was on close.
 *
 * Extracted from media-lightbox.tsx and merge-modal.tsx, which had it verbatim twice.
 *
 * `onClose` and `onKeyDown` are read through refs rather than closed over, so the listener
 * installs ONCE on mount and never needs re-binding when the caller re-renders with new
 * callbacks. (Writing a ref during render is flagged by the React Compiler's refs rule, so
 * both are updated in an effect instead.)
 *
 * @param onKeyDown Optional extra key handling, consulted AFTER Escape and BEFORE Tab.
 *                  Return true to say "handled — stop here". The lightbox uses this for
 *                  ArrowLeft/ArrowRight; a plain confirm dialog passes nothing.
 */
export function useModalFocusTrap({
  panelRef,
  onClose,
  onKeyDown,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onKeyDown?: (e: KeyboardEvent) => boolean;
}): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const onKeyDownRef = useRef(onKeyDown);
  useEffect(() => {
    onCloseRef.current = onClose;
    onKeyDownRef.current = onKeyDown;
  });

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
    (focusables()[0] ?? panel)?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      // The caller's slot: after Escape, before Tab. Exactly where the lightbox's arrow
      // handling sat before this was extracted.
      if (onKeyDownRef.current?.(e)) return;
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
    // Mount-only, deliberately: panelRef is a stable ref object, and both callbacks are read
    // through refs above. Re-running would tear down and re-install the listener on every
    // parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
```

> If `npm run lint` does **not** complain about the empty dependency array, delete the `eslint-disable-next-line` comment — an unnecessary disable is itself a lint error under some configs, and this project runs at 0.

- [ ] **Step 2: Convert `merge-modal.tsx`**

In `dashboard/components/merge-modal.tsx`:

1. Change the React import from `import { useEffect, useRef, useState } from "react";` to `import { useRef, useState } from "react";`
2. Add `import { useModalFocusTrap } from "./use-modal-focus-trap";`
3. Delete the local `FOCUSABLE_SELECTOR` const.
4. Delete the `previouslyFocused` ref, the `onCloseRef` ref, the `useEffect` that syncs `onCloseRef`, and the entire focus-trap `useEffect` (the one ending `}, []);` with the comment "Focus in on open, trap Tab while open…").
5. Keep `const panelRef = useRef<HTMLDivElement>(null);` and, in its place, call:

```tsx
useModalFocusTrap({ panelRef, onClose });
```

- [ ] **Step 3: Convert `media-lightbox.tsx`**

In `dashboard/components/media-lightbox.tsx`, the same conversion, plus the arrow keys:

1. Drop `useEffect` from the React import **only if** nothing else in the file still uses it — the file has other effects, so check before editing the import.
2. Add `import { useModalFocusTrap, FOCUSABLE_SELECTOR } from "./use-modal-focus-trap";` — import `FOCUSABLE_SELECTOR` only if something else in the file still references it; otherwise import just the hook and delete the local const.
3. Delete the `previouslyFocused` ref, the `onCloseRef` ref, the effect that syncs `onCloseRef`, and the whole focus-trap `useEffect` at lines ~299-353.
4. Keep `panelRef`, `stepRef` and `stateRef` exactly as they are, and replace the deleted effect with:

```tsx
useModalFocusTrap({
  panelRef,
  onClose,
  // Arrow keys already mean "seek" inside a video player, and the player's own controls
  // must keep working — only steal them when focus is elsewhere. Returning false lets the
  // hook fall through to its Tab handling, which is what the inline version did.
  onKeyDown: (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
    const target = e.target as HTMLElement | null;
    if (target?.closest("video")) return true;
    if (stateRef.current.length < 2) return true;
    e.preventDefault();
    stepRef.current(e.key === "ArrowLeft" ? -1 : 1);
    return true;
  },
});
```

> Note the two `return true` lines for the "ignore this arrow key" cases. The original `return`ed out of the handler entirely, so falling through to Tab handling would be a behaviour change — and an arrow key is never a Tab, so returning true (handled) is what preserves it.

- [ ] **Step 4: Verify nothing else used the deleted constants**

```bash
cd dashboard && grep -rn "FOCUSABLE_SELECTOR\|previouslyFocused\|onCloseRef" components/ app/ lib/
```

Expected: matches **only** in `components/use-modal-focus-trap.ts`. Any match in another file is a leftover — remove it.

- [ ] **Step 5: Run the full check suite**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass, **0 errors** from each, and the test count is **unchanged from the previous task** — this is a refactor, so it neither adds nor removes tests.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/use-modal-focus-trap.ts dashboard/components/merge-modal.tsx dashboard/components/media-lightbox.tsx
git commit -m "refactor(ui): extract the shared modal focus trap

merge-modal and media-lightbox carried the same ~45-line trap verbatim,
and the unmerge modal would have made three. Behaviour is unchanged; the
lightbox's arrow-key handling moves into the hook's optional onKeyDown
slot, in the same position it occupied inline.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The UI

**Files:**
- Create: `dashboard/components/unmerge-modal.tsx`
- Create: `dashboard/test-ui/unmerge-modal-ui.test.ts`
- Modify: `dashboard/components/post-editor.tsx`
- Modify: `docs/tasks.md`

**Interfaces:**
- Consumes from Task 3: `POST /api/posts/:id/unmerge`.
- Consumes from Task 4: `useModalFocusTrap({ panelRef, onClose })` from `./use-modal-focus-trap`.
- Produces: `UnmergeModal({ postId, slideCount, onClose, onUnmerged })` and `splitSummary(slideCount): string`.

**Why `splitSummary` is exported separately:** the modal renders through `createPortal`, which needs a real `document` and so cannot go through `renderToStaticMarkup` — the same reason `merge-modal.tsx` has no UI test. Pulling the one piece of computed copy into a pure function makes the part that can actually be wrong (pluralization, the count) testable without a browser. The rest of the modal is verified in Playwright at step 7.

- [ ] **Step 1: Write the failing test**

Create `dashboard/test-ui/unmerge-modal-ui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSummary } from "../components/unmerge-modal.tsx";

test("the summary names the number of posts that will result", () => {
  assert.match(splitSummary(5), /5 separate posts/);
});

test("the smallest real split is not pluralized wrong", () => {
  // Two slides is the minimum the guards allow, so "2 separate posts" is a real sentence a
  // user will see — and the singular form must never appear, since 1 is impossible.
  assert.match(splitSummary(2), /2 separate posts/);
});

test("the summary says the photos survive", () => {
  // The word this modal exists to make unmissable: nothing is deleted.
  assert.match(splitSummary(4), /no photos are deleted/i);
});

test("the summary says the original keeps the first photo", () => {
  assert.match(splitSummary(3), /first photo/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/unmerge-modal-ui.test.ts
```

Expected: FAIL — cannot resolve `../components/unmerge-modal.tsx`.

- [ ] **Step 3: Write the modal**

Create `dashboard/components/unmerge-modal.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "./use-modal-focus-trap";

/**
 * The modal's one piece of computed copy, pulled out so it can be tested without a DOM —
 * createPortal needs a real document, so the component itself can't go through
 * renderToStaticMarkup. Kept deliberately blunt: this is a bulk change to the library, and
 * the count is the number the owner needs to see before confirming.
 */
export function splitSummary(slideCount: number): string {
  return (
    `This carousel will become ${slideCount} separate posts, one per photo. ` +
    `This post keeps the first photo along with its history. No photos are deleted.`
  );
}

/**
 * Confirm dialog for splitting one carousel back into separate posts. Nothing is written
 * until POST /api/posts/[id]/unmerge succeeds — this holds no draft state of its own, because
 * there is nothing to choose: the split is total and the existing slide order is kept.
 *
 * Focus, Escape, Tab cycling and body-scroll locking all come from useModalFocusTrap, the
 * same hook merge-modal.tsx and media-lightbox.tsx use. No extra keys here — a confirm
 * dialog has nothing to navigate.
 */
export function UnmergeModal({
  postId,
  slideCount,
  onClose,
  onUnmerged,
}: {
  postId: number;
  slideCount: number;
  onClose: () => void;
  onUnmerged: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useModalFocusTrap({ panelRef, onClose });

  async function confirm() {
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/posts/${postId}/unmerge`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSubmitting(false);
      // The server's message is the specific one (already published / send queued), so it is
      // shown verbatim rather than replaced with a generic failure.
      setError(body.error ?? "Could not split this carousel.");
      return;
    }
    onUnmerged();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Split into separate posts"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card border border-border-strong bg-surface p-5 shadow-lg"
      >
        <h2 className="font-display text-base font-semibold text-ink">
          Split into separate posts
        </h2>
        <p className="mt-1 text-sm text-muted">{splitSummary(slideCount)}</p>
        <p className="mt-2 text-sm text-muted">
          Each new post keeps this one&rsquo;s caption, channels, tags and seasons — as its own
          copy, so editing one later won&rsquo;t change the others.
        </p>

        {error ? <p className="mt-4 text-sm text-status-failed">{error}</p> : null}

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={submitting}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
          >
            {submitting ? "Splitting…" : "Split into separate posts"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd dashboard && node --import ./test/ui-hook.mjs --test test-ui/unmerge-modal-ui.test.ts
```

Expected: PASS, 4 tests, 0 failures.

- [ ] **Step 5: Wire the action into the post editor**

Three edits to `dashboard/components/post-editor.tsx`.

**5a.** Add to the import block at the top, after the `MediaLightbox` import:

```tsx
import { UnmergeModal } from "./unmerge-modal";
```

**5b.** Add state beside the existing `confirmDelete` state (near line 90):

```tsx
const [unmergeOpen, setUnmergeOpen] = useState(false);
```

**5c.** Insert this immediately **before** the `{/* Delete post — guarded, irreversible */}` section (near line 414). `isCarousel` already exists above and is exactly the right condition — `post.post_type === "carousel" && assets.length > 1`:

```tsx
{/* Split a carousel back into separate posts — the inverse of merge. Deliberately NOT in
    the destructive-red card below it: nothing is deleted, the photos are shared with the
    new posts, and this post keeps its id and its history. */}
{isCarousel ? (
  <section className={card}>
    <h3 className="mb-1 font-display text-sm font-semibold text-ink">
      Split into separate posts
    </h3>
    <p className="mb-3 text-sm text-muted">
      Turns this carousel into {assets.length} separate posts, one per photo. This post keeps
      the first photo. No photos are deleted.
    </p>
    <button
      type="button"
      onClick={() => setUnmergeOpen(true)}
      className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken"
    >
      Split into separate posts…
    </button>
  </section>
) : null}
{unmergeOpen ? (
  <UnmergeModal
    postId={post.id}
    slideCount={assets.length}
    onClose={() => setUnmergeOpen(false)}
    onUnmerged={() => {
      setUnmergeOpen(false);
      // Stay on this post — it survives, and it is now a single. router.refresh() re-runs
      // the server component so its slides, type, and the now-absent Split card all update.
      startTransition(() => router.refresh());
    }}
  />
) : null}
```

- [ ] **Step 6: Run the full check suite**

```bash
cd dashboard && npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass, **0 errors** from each.

- [ ] **Step 7: Verify in a real browser with Playwright**

`renderToStaticMarkup` strips event handlers and cannot measure layout, so the modal, the button, and the refresh have to be exercised for real. Use the **Playwright MCP tools**, not the in-app browser — a confirm flow needs `browser_handle_dialog` available.

Start the dev server (port 3939):

```bash
cd dashboard && npm run dev
```

Then, in order:

1. **Make a throwaway carousel** — never use real content. In the dashboard, upload 3 test images and compose them into one carousel draft. Note its post id from the URL.
2. `browser_navigate` to `http://localhost:3939/library/<id>`.
3. `browser_snapshot` — confirm the **"Split into separate posts"** card is present and says "3 separate posts".
4. `browser_click` the button; `browser_snapshot` — confirm the modal opens, the summary reads "3 separate posts", and both buttons are present.
5. `browser_press_key` `Escape` — confirm the modal closes and nothing changed.
6. Re-open, `browser_click` **"Split into separate posts"**.
7. `browser_snapshot` — confirm the page now shows a single-image post and the Split card is **gone** (`isCarousel` is false now).
8. `browser_navigate` to `http://localhost:3939/library` — confirm **3** posts are present where 1 was.
9. Open one of the new posts and confirm it shows one photo and the inherited caption.
10. **Negative case:** schedule a send on another throwaway carousel, then open it and click Split. `browser_snapshot` — confirm the modal shows the red error text *"That carousel has a send in the queue. Cancel or hold that send first, then split."* and that the post is **unchanged**.
11. **Theme check:** `browser_navigate` to the post page, switch to a dark theme in the theme controls, `browser_take_screenshot` — confirm the Split card and modal are legible. Repeat for one light theme.

**Task 4 regression checks — the focus trap was refactored under two shipped modals, so both must still work:**

12. **Merge modal:** go to `/library`, multi-select two throwaway single-image drafts, open the merge modal. Confirm it opens with focus inside it, `Tab` cycles within the dialog rather than escaping to the page behind, `Escape` closes it, and focus returns to the control that opened it. Do **not** confirm the merge.
13. **Lightbox arrow keys** — the one behaviour the refactor could plausibly break: open a carousel post, click a photo to open the lightbox, press `ArrowRight` and `ArrowLeft` and confirm it steps between slides. Then `Escape` to close and confirm focus is restored.
14. **Lightbox arrows inside a video:** open a post with a video, click into the video player, press `ArrowLeft` — confirm it seeks the video rather than changing slides. This is the `target?.closest("video")` branch, and it is the easiest one to get backwards when moving it into the hook.
15. **Clean up** the throwaway posts and assets.

Record the outcome of each numbered step. If any fails, fix it and re-run from step 2.

- [ ] **Step 8: Verify the live database is untouched**

The dev server points at the real DB, so confirm the throwaway cleanup left nothing behind and no real post moved:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && sqlite3 -readonly data/socialscheduler.db "PRAGMA foreign_key_check; SELECT post_type, COUNT(*) FROM posts GROUP BY post_type;"
```

Expected: `foreign_key_check` returns nothing, and the carousel count is back to **36** (the pre-work figure recorded in the design's §1).

- [ ] **Step 9: Mark the work done in `docs/tasks.md`**

In `docs/tasks.md`, change the Unmerge section heading from:

```
## Unmerge: split a carousel back into separate posts  `[ ] not started — backlog`
```

to:

```
## Unmerge: split a carousel back into separate posts  `[x] done`
```

Then check off every `- [ ]` item in that section — the five "Settle these before writing code" decisions, all of Phase 1, Phase 2 and Phase 3, and the `listAssetsWithUsage()` landmine — with **exactly one exception**:

- Leave **`createDraftPost` derives `post_type` from asset count alone and ignores `media_kind`** unchecked. It is still broken; unmerge simply never reaches it, because Task 2 writes its own `INSERT` with an explicit `post_type`. Append to that line: `— still open; unmerge sidesteps it rather than fixing it.`

Under the section, add:

```
Shipped 2026-08-05. Design: `docs/design-unmerge-carousel.md`. Plan:
`docs/plan-unmerge-carousel.md`. Full split only — pulling one slide out is still open.
```

- [ ] **Step 10: Commit**

```bash
git add dashboard/components/unmerge-modal.tsx dashboard/components/post-editor.tsx dashboard/test-ui/unmerge-modal-ui.test.ts docs/tasks.md
git commit -m "feat(unmerge): split action and confirm modal on the post screen

Shown only for a carousel with 2+ slides. The modal states the resulting
count, that the photos survive, and that each new post gets its own COPY
of the caption/channels/tags/seasons — verified in a real browser, since
renderToStaticMarkup can't exercise a confirm flow.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deliberately not in this plan

From §9 of the design, restated here so a fresh implementer does not add them:

- **Pulling a single slide out** and leaving the rest a carousel.
- **Fixing `createDraftPost`'s `media_kind` bug.** Task 2 writes its own `INSERT` with an explicit `post_type`, so it never hits it. The bug stays open in `docs/tasks.md`.
- **An undo.** Merge is only a partial inverse — it refuses carousels containing video, so a split that produced a `reel` cannot be re-merged. The modal must not promise reversibility.
- **Any schema migration.** Nothing here needs one.
