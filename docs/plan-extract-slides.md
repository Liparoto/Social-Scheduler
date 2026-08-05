# Extract slides from a carousel — Implementation Plan

**Goal:** Pick one or more slides from a carousel and pull them out as their own posts, leaving the remaining slides as a carousel.

**Spec:** `docs/design-extract-slides.md`. Section references below point into it.

**Architecture:** Extends the shipped unmerge feature rather than paralleling it. Guards 1-5 move into a shared prelude both plan functions call; the post-creation-with-content-model block is factored out of `unmergeCarousel` so both transactions copy identically.

## Global Constraints

- Run every command from `dashboard/`.
- **No new dependencies. No schema migration.** If you write SQL DDL, you have misread the plan.
- `npm test`, `npx tsc --noEmit`, `npm run lint` at **0 errors** before each commit. Lint is at 0 and stays there.
- Entering this work: **312 lib/route + 56 UI tests, 0 failures.**
- **Never `cp` the live DB** (WAL — reads torn). Tests use `makeTestDb()`. Browser verification uses a `sqlite3 .backup` copy on port 3940, never the live DB.
- **`assets` is never written to.** No INSERT/UPDATE/DELETE against it.
- Guard messages are owner-facing copy — use them verbatim from §4.
- Only theme classes already in `app/globals.css` (14 palettes).

---

## Task 1 — Shared guard prelude + `planExtractSlides` (pure)

**Files:** `lib/unmerge-plan.ts` (extend), `lib/unmerge-plan.test.ts` (extend)

The refactor lands **first, with the existing tests unchanged and green**, proving `planUnmerge`
still behaves identically. Only then does `planExtractSlides` get added.

1. Extract guards 1-5 from `planUnmerge` into a private `checkRestructurable(candidate)` that
   returns `UnmergeProblem | null`. `planUnmerge` calls it and is otherwise untouched. Run the
   existing 16 tests — all must pass with no edits.
2. Add `planExtractSlides(candidate, assetIds)` → `{ ok: true; extracted: UnmergePart[]; keepers: UnmergePart[]; originalType: PostType } | { ok: false; problem }`.
   - `keepers` are in their existing relative order; the caller writes them at `0..K-1`.
   - `originalType`: `carousel` if `keepers.length >= 2`, else `derivePostType(keepers[0].media_kind)`.
   - Guards 6, 7, 8 per §4, checked after the prelude.
3. Tests per §7's pure-layer list. Write them failing first.

**Verify:** full suite, tsc, lint at 0. Commit.

---

## Task 2 — The transaction

**Files:** `lib/queries.ts` (extend), `lib/queries.extract.test.ts` (new)

1. Factor the post-creation block out of `unmergeCarousel` into a private
   `createPostFromContentModel(db, sourceId, part, source, sideRows, now): number`. Run the
   existing 18 unmerge transaction tests unchanged — green proves the refactor is inert.
2. Add `extractSlidesFromCarousel(postId, assetIds)`, one `.immediate()` transaction:
   read source + side rows once → `DELETE FROM post_assets WHERE post_id = ?` → re-insert
   keepers at `0..K-1` → `UPDATE posts SET post_type = originalType, updated_at` → create one
   post per extracted slide via the shared helper → return `{ ok: true, post_ids: [postId, ...new] }`.
3. Tests per §7's transaction list, including the renumbering case and a rollback test using a
   temp `AFTER INSERT ON posts` trigger that RAISEs.

**Verify:** full suite, tsc, lint at 0. `PRAGMA foreign_key_check` clean in the test. Commit.

---

## Task 3 — API route

**Files:** `app/api/posts/[id]/extract/route.ts` (new), `test/extract-route.test.ts` (new)

Thin passthrough matching `app/api/posts/[id]/unmerge/route.ts`. Validates only that the id
parses and that `asset_ids` is an array of integers; every real guard lives below it.

**Verify:** full suite, tsc, lint at 0. Commit.

---

## Task 4 — Modal + entry point

**Files:** `components/extract-slides-modal.tsx` (new), `components/post-editor.tsx` (edit)

- Modal uses `useModalFocusTrap({ panelRef, onClose })`. Checkbox picker over slide thumbnails
  (reuse the thumbnail treatment already in the editor). Confirm disabled until ≥1 ticked.
- Summary copy states the resulting counts and updates live with the selection.
- Second button in the existing Split card, same `isCarousel` condition and same
  `disabled={isDirty || slideOrder.isDirty}` guard with the same explanation.

**Verify:** full suite, tsc, lint at 0. Browser pass on port 3940 against a `.backup` copy:
picker ticks, resulting split correct, keepers in the right order, guard-8 message, both themes.
Commit.

---

## Task 5 — Docs and ship

Mark the item done in `docs/tasks.md` (it is currently the open "pull a single slide out" note).
Record what shipped and what stayed out of scope. Commit and push to `main`.
