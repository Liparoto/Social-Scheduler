# Design — Merge posts into a carousel

**Status:** approved 2026-07-30, ready for implementation planning
**Depends on:** the Library multi-select + sticky bulk bar (`components/library-view.tsx`), the
composer's drag-to-reorder block (`components/composer.tsx`), `lib/queries.ts` as the sole
data-access layer, and `lib/platforms.ts` for per-platform caps — all shipped.
**Feeds:** cleanup of the existing library. 135 of the 147 drafts are single-image posts; many
of them are really slides of the same carousel and were only imported one-per-photo.

---

## 1. Purpose

The bulk import created one draft per photo. Looking at the library, a lot of those photos
belong together — they were shot in the same place on the same day and would post better as one
carousel than as five separate posts competing for the same feed.

There is currently **no way to change a post's media after creation.** `post_assets` rows are
INSERTed by `createPostWithPublications`, `createDraftPost`, and the bulk-import path, and are
removed only by CASCADE when the post is deleted. `PATCH /api/posts/[id]/content` touches
captions, kind, status, targets, tags and periods — never assets. So today the only way to turn
five singles into a carousel is to delete all five and re-upload the photos in Compose.

This sub-project adds one operation: **select N draft posts in the Library, review the slide
order, and merge them into a single carousel draft.**

### Current shape of the data (measured 2026-07-30)

| | count |
|---|---|
| `single` drafts | 135 |
| `carousel` drafts | 12 |
| single drafts with an empty/NULL caption | 115 of 135 |
| assets referenced by more than one post | 0 (all 166 are 1:1 today) |
| single drafts that already have channel targets | 135 (all of them) |

The caption number is why the caption-picker below is a small problem rather than a large one:
in the overwhelming majority of merges there is no caption to choose between.

---

## 2. No schema change

Deliberately zero migrations. The existing schema already supports this:

```sql
CREATE TABLE post_assets (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id)  ON DELETE CASCADE,
    asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (post_id, sort_order),
    UNIQUE (post_id, asset_id)
);
```

A merge is a re-point of `post_assets.post_id` plus a delete of the emptied posts. Both FKs
declare only `ON DELETE` behaviour — there is no `ON UPDATE` clause — so repointing `post_id` is
permitted as long as the destination post exists.

**Assets are never deleted, and this is structural rather than a matter of us being careful:**
`post_assets.asset_id` is `ON DELETE RESTRICT`, so SQLite itself refuses to drop an asset that
any post still references. Deleting the emptied source posts cascades their (already moved)
join rows and cannot reach the `assets` rows.

---

## 3. The invariant that actually matters

`posts.post_type` is **computed at write time and then frozen.** It is not derived from the
asset count on read. `worker/publisher.py::_validate` re-derives the expectation at publish time
and raises `_NonRetryable` on mismatch:

- `single` → exactly 1 asset
- `carousel` → `2 <= n <= caps.max_carousel`
- `reel` → exactly 1 asset **and** `media_kind = 'video'`

Nothing in the schema enforces the correspondence — there are no triggers. So a merge that moved
the assets but forgot `post_type` would look completely correct in the dashboard and then fail
at send time with `carousel needs 2-10 assets, has 1`.

**Therefore: the merge transaction must set `post_type = 'carousel'` on the surviving post.**
This is the single highest-risk line in the feature and gets a dedicated test.

The same invariant is why merging *away from* a post is safe here but would not be in general:
we always delete the emptied sources rather than leaving behind a `single` post with zero
assets.

---

## 4. Behaviour

### Entry point

Library's bulk bar (`library-view.tsx:488–605`) gains a **Merge into carousel** button beside
the existing Bulk schedule / Add target / Remove target actions. Enabled when 2 or more posts
are selected.

Selection order is already meaningful — `selected` is `useState<number[]>` (an ordered array,
not a Set) and cards already render a 1-based position badge. The merge inherits that order as
the initial slide order, so the ordering the owner sees while selecting is the ordering they get.

### Review step

Clicking opens a modal — the merge is not applied on click. The modal shows:

1. **Slides in order**, drag-to-reorder, with 1-based index badges.
2. **Caption picker** — only rendered when at least one selected post has a non-empty caption.
   Radio list of the distinct captions, plus "no caption". Defaults to the first non-empty one.
   Skipped entirely for the common all-empty case.
3. **A plain sentence naming what gets deleted**, e.g. *"Keeps post #15 and deletes 3 emptied
   drafts. No photos are deleted."*
4. Confirm / Cancel.

### On confirm

`POST /api/posts/merge` with:

```ts
{ post_ids: number[],      // the posts being merged, in SELECTION order
  asset_order: number[],   // every asset across those posts, in final SLIDE order
  caption: string | null } // the final caption; null means no caption
```

**Slide order is carried by `asset_order`, not by `post_ids`** — these are two different
orderings and conflating them is a bug. Once an existing carousel can be part of a merge (§6) a
single post contributes several slides, so a list of post ids can no longer express where each
slide lands. `post_ids` exists only to identify the set being merged and to name the survivor.

Survivor = `post_ids[0]`, the **first post selected** — deliberately independent of slide order,
so dragging a slide to the front does not silently change which draft survives and which get
deleted.

One `db.transaction(...)` in `lib/queries.ts`:

1. Re-validate every guard from §5 **inside** the transaction (the client's view may be stale).
2. Assert `asset_order` is exactly the set of assets across `post_ids` — no additions, no
   omissions, no duplicates. Reject with 400 otherwise rather than silently dropping a slide.
3. Move every `post_assets` row onto the survivor, assigning `sort_order` from `asset_order`.
   This renumbers the survivor's own existing rows too, since its slides may have been
   reordered relative to the incoming ones.
4. `UPDATE posts SET post_type = 'carousel', caption = ?, updated_at = ? WHERE id = survivor`.
5. Write the chosen caption as a `caption_variants` row too, not only `posts.caption` — the
   worker's `_select_caption` prefers variants and falls back to `posts.caption`, and every
   other write path in this codebase maintains both.
6. Union `post_targets`, `post_tags`, and `post_periods` from all merged posts onto the survivor.
7. `DELETE FROM posts WHERE id IN (non-survivors)` — cascades their now-empty join rows.

Returns `{ ok: true, post_id: survivor }`. The client does `router.refresh()` and clears the
selection, matching the existing `schedule()` / `retarget()` pattern.

#### The `sort_order` trap

`UNIQUE (post_id, sort_order)` is checked **per row, immediately** — SQLite does not defer it.
So a naive `UPDATE post_assets SET post_id = @survivor` collides with the survivor's existing
rows, and an in-place renumber like `SET sort_order = sort_order + 1` collides with itself
partway through the set.

Approach: within the transaction, first move every row to a **non-colliding high offset**
(e.g. `sort_order = 1000 + n`), then assign the final `0..n-1` values in a second pass. This is
the established workaround and needs a comment saying why, because the code looks redundant
otherwise.

There is currently **no code anywhere in the repo that UPDATEs or DELETEs a `post_assets` row** —
this feature establishes that pattern, so there is no existing convention to match.

---

## 5. Guards

All checked server-side inside the transaction, each returning a specific human-readable message
rather than a generic failure. The client pre-checks the same rules to disable the button, but
the server is authoritative.

| Guard | Reason | Status |
|---|---|---|
| At least 2 posts | Nothing to merge otherwise | 400 |
| All posts exist | Stale client selection | 404 |
| All are drafts, none with a `posted` or `publishing` publication | Mirrors `deletePost`'s existing `has_live` guard; never destroy the record of something already live | 409 |
| No `video` assets among them | A carousel cannot contain video — enforced today only client-side in Compose (`composer.tsx:169–181`), so the server has never had to check it | 400 |
| Total slides ≤ the cap | `min(maxCarousel)` across the platforms of the unioned target channels, read from `lib/platforms.ts` — **not** hardcoded to 10. IG/FB are 10, Threads is 20 | 400 |
| No asset appears twice across the selection | `UNIQUE (post_id, asset_id)` would otherwise surface as a raw SQLite constraint error | 409 |
| Chosen caption within platform limits for `carousel` | Reuse `captionLimitError` from `lib/caption-limits.ts`; the limit key changes from `single` to `carousel` | 400 |

The video guard deserves note: it is the first server-side enforcement of "carousels are images
only". Merging is the first code path that can assemble a multi-asset post without going through
Compose.

---

## 6. Merging into an existing carousel

Selecting a `carousel` draft plus two singles absorbs the singles into that carousel. This falls
out of the same code path at no extra cost — the survivor is simply already a carousel, and step
4 is a no-op for `post_type`.

Allowed rather than blocked, because "I want three more photos on this carousel" is the same
user intent and blocking it would be arbitrary.

---

## 7. Components

The drag-to-reorder block in `composer.tsx:431–493` is the only such implementation in the repo
(raw HTML5 drag events via a `useRef` index — there is no drag library in the dependencies). It
is currently inline, not extracted.

**Extract it into a shared `components/slide-reorder.tsx`** and have both the composer and the
merge modal use it. This is targeted refactoring in service of the feature, not opportunistic
cleanup: the alternative is a second copy of fiddly drag-and-drop plus keyboard-accessible
←/→ controls, which would then drift.

The extraction must preserve what the original already gets right — the ←/→ buttons that make
reordering reachable without a mouse, and the 1-based index badges.

---

## 8. Testing

Verification is against the real dashboard, but destructive confirmation paths must **not** be
driven through the in-app browser: it auto-accepts `confirm()` dialogs, which previously caused
a real asset to be deleted. Use Playwright with explicit dialog handling for anything that
confirms a delete.

Cases that must be covered:

1. **The frozen-`post_type` invariant** — after merging 3 singles, assert
   `post_type = 'carousel'` **and** that `post_assets` has exactly 3 rows with contiguous
   `sort_order` 0,1,2. This is the failure that would otherwise only appear at publish time.
2. **No asset is orphaned or deleted** — asset count before == after; every merged asset still
   resolves through `/api/media/{id}`.
3. **The `sort_order` collision path** — merge into a post that already has slides, which is
   where the naive implementation throws.
4. **Each guard returns its own message** — particularly the live-publication guard and the
   duplicate-asset guard.
5. **`asset_order` mismatch is rejected** — an order that omits an asset, repeats one, or names
   an asset outside the selection returns 400 and writes nothing. A dropped slide would
   otherwise leave the asset attached to a post that is about to be deleted.
6. **Union semantics** — targets/tags/periods present on a non-survivor survive the merge.
7. **Rollback** — a merge that fails a guard mid-transaction leaves every post untouched.

Dry-run note: the merge only writes to the library and creates no publications, so it cannot
itself cause a post to go out. It is safe to exercise against the real DB, but §8.2 should be
checked on a copy first given the earlier orphan-asset trap.

---

## 9. Deliberately out of scope

- **Splitting** a carousel back into singles.
- **Reordering an existing carousel** outside of a merge — worth doing, but it belongs with a
  general "edit a post's media" capability rather than here.
- **Merging from the Media page** (select files → new carousel). The owner's decision point is
  in the Library, looking at drafts.
- Any change to how the worker publishes carousels — that path already works.
