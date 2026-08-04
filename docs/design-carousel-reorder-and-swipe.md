# Design — Reorder carousel slides, stack them in the Library, swipe through them

**Status:** approved 2026-08-03, ready for implementation planning
**Depends on:** `components/slide-reorder.tsx` (drag-to-reorder, already shared by the composer
and the merge modal), `components/media-lightbox.tsx`, `components/library-view.tsx`,
`components/quick-edit-modal.tsx`, `components/post-editor.tsx`, and `lib/queries.ts` as the
sole data-access layer — all shipped.
**Schema change:** none. **Worker change:** none.

---

## 1. Purpose

Slide order is decided once, at creation, and then frozen forever.

`post_assets.sort_order` is written by `createPostWithPublications`, `createDraftPost`, the
bulk-import path, and `mergePostsIntoCarousel`. Nothing updates it afterwards.
`PATCH /api/posts/[id]/content` touches captions, kind, status, targets, tags and periods —
never assets. So today, getting slide 4 to the front of an existing carousel means deleting the
post and rebuilding it.

Two related gaps make that worse than it sounds, because **you cannot see the order you would
be fixing**:

- A Library card renders only the first asset plus the text `5 imgs`. A carousel and a single
  image look nearly identical in the list.
- The lightbox shows exactly one asset. Opening a 7-slide carousel full-size shows slide 1 and
  offers no way to reach slides 2–7.

This sub-project closes all three: **make the order visible, make it browsable, and make it
editable.**

---

## 2. No schema change, no worker change

The existing schema already supports reordering:

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

A reorder rewrites `sort_order` on rows that already exist. No column is added, no constraint
changes.

The worker needs no change either. `worker/db.py::get_ordered_assets` already reads
`ORDER BY pa.sort_order ASC` **at publish time**, not at schedule time, so a reorder saved at
09:00 is respected by a send that fires at 18:00 with no further plumbing.

### The `UNIQUE (post_id, sort_order)` trap

You cannot reorder with a loop of `UPDATE post_assets SET sort_order = ? WHERE id = ?`. SQLite
enforces `UNIQUE` immediately, not at end of transaction, so the very first statement that moves
slide 3 into position 1 collides with the row already sitting at position 1.

`mergePostsIntoCarousel` already hit this and solved it by deleting the join rows and
re-inserting them in the new order inside one transaction. This follows that precedent for the
same reason its design doc gives: `post_assets` is `(id, post_id, asset_id, sort_order)` and
carries no data worth preserving. Assets themselves are never touched — `asset_id` is
`ON DELETE RESTRICT`, so SQLite would refuse anyway.

---

## 3. The invariant this must not break

`posts.post_type` is computed at write time and then frozen; `worker/publisher.py::_validate`
re-derives the expectation at publish time and raises `_NonRetryable` on mismatch:

- `single` → exactly 1 asset
- `carousel` → `2 <= n <= caps.max_carousel`
- `reel` → exactly 1 asset **and** `media_kind = 'video'`

**This endpoint therefore reorders and nothing else.** It cannot add or remove a slide, so the
asset count is invariant, so `post_type` stays correct by construction. That is enforced in
validation (§4), not merely intended.

---

## 4. One write path — `/api/posts/[id]/assets`

Reordering is reachable from two screens, so the write lives in exactly one place.

### `GET /api/posts/[id]/assets`

Returns the post's assets in `sort_order`: `id`, `media_kind`, `cover_frame_ms`, `width`,
`height` — precisely the `LightboxAsset` shape plus what a thumbnail needs.

Two consumers: the quick-edit dialog (which lazily loads its captions from
`GET /api/posts/[id]/content` on open — this follows that established pattern) and the Library
card's lightbox (§7).

**Why not widen `listPosts`?** The Library list query already returns `asset_ids_csv`, so ids
are in hand — but not `media_kind`, `width`, `height`, or `cover_frame_ms` per slide. Adding
four more `GROUP_CONCAT` subqueries would ship every slide's metadata for all ~150 cards on
every Library load to serve a dialog and a lightbox that need one post at a time. Same reasoning
that put caption variants behind a `GET` rather than in the list query.

### `PATCH /api/posts/[id]/assets`

Body: `{ "asset_ids": [12, 9, 30, 4] }` — the complete new order.

**Validation, in order, with nothing written until all of it passes:**

1. Post exists → else `404`.
2. `asset_ids` is a non-empty array of integers → else `400`.
3. It is a **permutation of the post's current asset set**: same length, same members, no
   duplicates → else `400 { code: "not_a_permutation" }`. This is the check that makes §3 hold.
4. No publication on this post has status `publishing` → else
   `409 { code: "publishing" }`.

Then `reorderPostAssets(postId, assetIds)` in `lib/queries.ts` performs
`DELETE FROM post_assets WHERE post_id = ?` followed by ordered re-`INSERT`, inside a single
transaction.

### Why the guard is `publishing` and not `posted`

`mergePostsIntoCarousel` refuses posted and publishing posts, but it is doing something
destructive — it deletes source posts and their queued sends. A reorder deletes nothing.

- **`publishing`** is refused because the worker is reading `post_assets` for that post *right
  now*. Rewriting the rows underneath an in-flight container build is the one case that can
  produce a genuinely wrong published carousel.
- **`posted`** is allowed. Evergreen posts are re-sent; being able to fix the order of a post
  that already went out once is the point, not an accident.
- **`scheduled` / `pending_approval`** is allowed, and the UI says so out loud (§6) — those
  sends will go out in the new order.

---

## 5. Stack in the Library

When `asset_count > 1`, the card's thumbnail gains two offset bordered layers behind it and a
count chip (`⧉ 5`) in the corner.

The layers are **empty CSS elements, not thumbnails.** A 150-card Library must not triple its
image requests to look nicer. The chip replaces the existing `5 imgs` text in the meta row,
which would otherwise say the same thing twice.

`post_type: 'reel'` and single-image posts are unchanged.

---

## 6. Reorder UI — one component, two homes

A new `CarouselReorder` component wraps the existing `SlideReorder` (drag-and-drop plus ←/→
buttons, already working in the composer and the merge modal). `SlideReorder` stays untouched —
it deliberately knows only `{ assetId, label }`, and this adds no reason to widen it.

`CarouselReorder` owns what `SlideReorder` deliberately does not: local order state, dirty
tracking against the saved order, Save/Reset, error rendering, and the queued-sends notice.

**Detail page (`/library/[id]`).** For `post_type === 'carousel'`, the read-only strip becomes
`CarouselReorder`. Assets are already loaded server-side via `getPostAssets`, so it renders with
no fetch. Note that today's strip renders `assets.slice(0, 4)` — a 10-slide carousel currently
shows 4 thumbnails and hides 6. The reorder block shows **all** slides; you cannot reorder what
you cannot see. Singles and Reels keep the existing strip, including its `CoverFramePicker` and
`ConformControl`.

**Quick edit.** Same component, assets fetched via `GET` on open, rendered only for carousels.

**Saving from quick edit.** The dialog has one Save button and one confirm-on-discard flow;
adding a second, separately-saved control inside it would be inconsistent and easy to lose work
in. So Save issues the order `PATCH` **first**, and aborts without touching content if it fails.
Ordering it first is deliberate: it is the request that can 409, so failing first leaves nothing
written. A content-save failure *after* a successful reorder leaves the reorder applied — that
is a visible, non-destructive, retryable partial state, and is the cheaper of the two ways to be
wrong.

**Queued-sends notice.** When `scheduled_count > 0`, the block shows: *"N queued send(s) will go
out in this order."* Not a blocker, not a confirmation dialog — just the fact, stated before the
user saves.

---

## 7. Swipe-through lightbox

`MediaLightbox` changes from `asset: LightboxAsset` to `assets: LightboxAsset[]` plus
`initialIndex`, holding the current index in state. The two single-asset callers — the post
editor and the media manager — pass a one-item array and behave exactly as they do now.

With more than one asset:

- **Keyboard:** ← / → step slides. **Ignored when the event target is inside a `<video>`**,
  where arrow keys already mean seek — the player's own controls must keep working.
- **On-screen prev/next buttons**, disabled at the ends (no wrap-around; the ends of a carousel
  are meaningful and silently looping hides where you are).
- **Swipe:** horizontal touch drag, and trackpad two-finger horizontal scroll. Both are
  threshold-based and rate-limited so one gesture advances one slide.
- **Counter:** `3 / 7`.
- **Preload:** the neighbouring image's `src` is warmed on index change so flipping is instant.

Escape, the focus trap, click-outside-to-close, and body-scroll locking are unchanged.

**Opening from a Library card.** The card already holds the first asset's full metadata, so the
lightbox opens on slide 1 **immediately** with `assets = [firstAsset]`, then extends to the full
list when the `GET` resolves. No spinner between click and image; the counter and next button
appear a beat later. If the `GET` fails, the lightbox stays a working single-asset viewer.

**Media manager is out of scope.** It passes a one-item array. Swiping the whole asset grid is a
separate idea and is not needed to close the gap this design is about.

---

## 8. Testing and verification

1. **Reorder round-trip, both homes.** Reorder from the detail page and from quick edit; confirm
   the new order survives `router.refresh()` and a hard reload, and that the composer/merge
   modal are unaffected.
2. **Permutation validator.** A tampered `PATCH` — dropped id, added id, duplicated id, empty
   array, wrong post's asset — returns `400` and writes nothing. Verified by direct API call,
   not through the UI.
3. **`publishing` guard.** Verified against a **scratch copy of the DB**, never the live one:
   flip a publication to `publishing`, confirm `409`, confirm `post_assets` unchanged.
4. **Quick-edit save ordering.** With a 409 pending, confirm the content fields are *not*
   written.
5. **Lightbox.** Arrows, buttons, touch swipe, trackpad swipe, counter, ends do not wrap, and
   arrow keys still seek when focus is in a Reel's player.
6. **Stack.** Renders for carousels only; confirm via the network panel that a carousel card
   loads exactly one image, as it does today.
7. **Publish order.** A `DRY_RUN=1` send of a reordered carousel reports the slides in the new
   order. This install publishes for real, so the dry run comes first.

---

## 9. Out of scope / deferred

- **Adding or removing slides on an existing post.** A real gap, and a larger one — it moves
  `post_type`, re-runs platform compatibility, and needs the conform pipeline for new uploads.
  Merge covers the assemble case today. To be logged in `tasks.md`.
- **Reordering from inside the lightbox.** Considered and dropped: it turns a read-only viewer
  into a write surface with its own save state, in a component three screens already share.
- **Swiping the media manager's asset grid** (§7).
- **Real thumbnails in the Library stack** (§5) — rejected on image-request cost.
- **Reordering multiple posts at once** from the bulk bar. No use for it.

---

## 10. What good looks like

- A carousel is recognisable as a carousel in the Library at a glance, without reading text.
- Clicking the expand badge on a 7-slide carousel and pressing → seven times shows all seven
  slides, in the order Instagram would show them.
- Dragging slide 4 to the front, pressing Save, and reloading the page shows the new order —
  and a send that fires that evening posts it that way.
- A post that is mid-publish refuses the edit with a reason, instead of silently corrupting the
  carousel that is being built right now.
