# Design — Extract slides from a carousel

**Status:** approved 2026-08-05, ready for implementation planning
**Depends on:** the shipped unmerge feature — `lib/unmerge-plan.ts`, `unmergeCarousel` in
`lib/queries.ts`, `POST /api/posts/[id]/unmerge`, and the Split card in
`components/post-editor.tsx`. All of it is the direct model here.
**Feeds:** the narrower half of unmerge, deliberately deferred when the full split shipped
(see `docs/design-unmerge-carousel.md` §9).

---

## 1. Purpose

The full split is all-or-nothing: a 6-slide carousel becomes 6 separate posts. There is no way
to say "these two photos don't belong here, pull them out, leave the rest alone."

Today the only route is to split the whole carousel and re-merge the survivors — which is
clumsy and lossy: merge *replaces* the survivor's caption variants rather than restoring each
post's own, and it refuses carousels containing video outright.

This adds one operation: **pick one or more slides and extract them, leaving the remaining
slides as a carousel.**

---

## 2. No schema change

Same as the full split. It writes new `posts` rows, new `post_assets` rows, and copies of the
original's `caption_variants` / `post_targets` / `post_tags` / `post_periods`. No new column,
no new table, no migration. `assets` is not touched at all.

---

## 3. Behaviour

### Entry point

The post detail screen, in the **same card** as "Split into separate posts" — the two are the
same family of operation and belong together. A second button, **"Pull slides out…"**, shown
under the same condition (`post_type` is `carousel` and 2+ slides) and disabled by the same
unsaved-changes guard, for the same reason: the transaction copies what is *saved*.

### Review step

A confirm modal with a **checkbox picker over the slide thumbnails**. The confirm button is
disabled until at least one slide is ticked, and the modal states what will result — how many
posts come out, and what the original is left holding.

### On confirm

One `.immediate()` transaction:

1. **Load and plan.** Same candidate the full split loads. Run `planExtractSlides`. On
   rejection, return the problem and commit nothing.
2. **Rebuild the original's slides.** Delete every one of its `post_assets` rows, then
   re-insert the **keepers** at `sort_order` `0..K-1`, preserving their existing relative order.
3. **Retype the original** from what it is left holding — see below.
4. **Create one post per extracted slide**, in the order they appeared in the carousel, each
   with `post_type` derived from its own asset's `media_kind`, `status = 'draft'`, and a copy
   of the original's caption, caption variants, targets (with `surface`), tags, periods,
   `content_kind`, `content_status`, `cooldown_days` and `created_by`.
5. Return `{ ok: true, post_ids: [originalId, ...newIds] }`.

### Retyping the original

```
2 or more slides left  →  stays 'carousel'
exactly 1 slide left   →  derived from that asset's media_kind ('reel' | 'single')
zero slides left       →  impossible; guard 8 refuses it
```

This is the invariant the project already learned the hard way: `post_type` is frozen at write
time and only re-validated by `worker/publisher.py` at publish, which fails **non-retryably**
on a mismatch. A 1-slide post left as `carousel` looks perfect in the dashboard and then dies
at send with `carousel needs 2-10 assets, has 1`.

### The renumbering trap — the real difference from the full split

`post_assets` has `UNIQUE (post_id, sort_order)`, checked **per-row and immediately**.

The full split sidestepped renumbering entirely: the original kept exactly one slide, rebuilt
at `sort_order 0`. Extraction cannot. Pulling slide 2 out of `[0,1,2,3]` leaves `[0,1,3]`,
which must become `[0,1,2]` — and renumbering in place collides with itself partway through
(setting the row at 3 to 2 while a row at 2 still exists).

Resolution, same as merge and the full split: **delete all of the original's join rows and
re-insert the keepers.** A `post_assets` row is `(id, post_id, asset_id, sort_order)` and
nothing references its id, so it carries nothing worth preserving.

---

## 4. Guards

All in `lib/unmerge-plan.ts`, which stays pure (imports only types).

**Guards 1-5 are shared verbatim with the full split** and move into a private prelude both
plan functions call, so one place decides whether a carousel can be restructured at all:

| # | Condition | Status | Code |
|---|---|---|---|
| 1 | Post does not exist | 404 | `post_not_found` |
| 2 | `post_type` is not `carousel` | 400 | `not_a_carousel` |
| 3 | Fewer than 2 slides | 400 | `too_few_slides` |
| 4 | Any publication `posted`/`publishing`, or `posts.status = 'posted'` | 409 | `already_published` |
| 5 | Any publication `scheduled`/`pending_approval` | 409 | `send_queued` |

**Guards 6-8 belong to extraction alone:**

| # | Condition | Status | Code |
|---|---|---|---|
| 6 | No slides selected | 400 | `no_slides_selected` |
| 7 | A selected id is not one of this post's slides | 400 | `slide_not_in_post` |
| 8 | Every slide selected | 400 | `extracts_everything` |

**Guard 7** catches a stale picker — the post was edited in another tab between opening the
modal and confirming. It fails as a clear 400 rather than silently extracting fewer slides
than the owner ticked.

**Guard 8 — why refuse rather than fall through to a full split.** Extracting every slide
would leave the original with zero `post_assets` rows: a post that exists, is reachable, and
can never publish. Silently redirecting to the other operation would also mean a button
labelled "Pull slides out" quietly did something else. The message names the action that does
do it — "That's every slide. Use Split into separate posts instead." — so the owner is one
click from what they wanted.

Guard order is 1→8, so the most specific applicable problem is always the one reported, and
the shared prelude runs before any extraction-specific check.

---

## 5. Two deliberate reuses

Rather than a second parallel implementation:

- **The guard prelude.** `planUnmerge` and `planExtractSlides` both call one private
  `checkRestructurable(candidate)`. A guard added later applies to both by construction.
- **Creating a post from the original's content model.** The block inside `unmergeCarousel`
  that inserts a `posts` row and copies variants/targets/tags/periods becomes a private helper
  both transactions call. The two operations must copy *identically*; a shared helper is what
  guarantees they cannot drift.

Both are refactors of shipped, tested code. The existing tests must stay green throughout and
are the evidence the refactor changed nothing.

---

## 6. Components

| File | Change |
|---|---|
| `dashboard/lib/unmerge-plan.ts` | **extend** — `checkRestructurable` prelude, `planExtractSlides`, `ExtractRequest`. |
| `dashboard/lib/queries.ts` | **extend** — `extractSlidesFromCarousel(postId, assetIds)`; factor out the shared post-creation helper. |
| `dashboard/app/api/posts/[id]/extract/route.ts` | **new** — thin passthrough, matching the unmerge route. |
| `dashboard/components/extract-slides-modal.tsx` | **new** — checkbox picker + confirm. |
| `dashboard/components/post-editor.tsx` | **edit** — second button in the existing Split card. |

Only theme classes already in `app/globals.css` — 7 families × light/dark = 14 palettes, and an
invented class renders invisible in some of them.

---

## 7. Testing

Pure-layer cases (`lib/unmerge-plan.test.ts`): each of guards 6-8; that guards 1-5 still fire
for extraction; extracting one slide; extracting several; a video slide becoming a `reel`;
the original staying `carousel` with 2+ left; the original becoming `single` with 1 left; the
original becoming `reel` when the single survivor is a video.

Transaction cases (`lib/queries.extract.test.ts`): keepers renumbered contiguously from 0 in
their original relative order; `assets` and `post_assets` row counts unchanged; each extracted
post carries its own copy of caption/variants/targets/tags/periods; the original keeps its own
publications; every rejection writes nothing; a mid-loop failure rolls back completely.

Route cases (`test/extract-route.test.ts`): 200 shape, and one case per guard-owned status.

**Verification:** `npm test`, `npx tsc --noEmit`, `npm run lint` at 0 errors. Browser pass
against a `sqlite3 .backup` copy of the live DB — never the live DB — confirming the picker,
the resulting split, the guard-8 message, and that the original's remaining slides are in the
right order afterwards.

---

## 8. Kill switch and dry run

Neither applies to the operation itself: it touches only the local SQLite file and makes no
Graph API call. But as with the full split, the extracted posts **inherit `content_status`**
and the original's feed targets, so extracting from a `ready` carousel produces posts that are
autofill-eligible exactly as the original was. That is intentional — each extracted post is a
fully-formed post — and it only matters once `autofill_enabled` is turned on for a channel.
The field that governs automation is `content_status`, never `posts.status`.

---

## 9. Deliberately out of scope

- **Reordering while extracting.** The keepers hold their existing relative order. Reordering
  is already a separate, shipped control on the same screen.
- **Extracting into a new carousel** (several slides out as one multi-slide post). Settled
  during brainstorming: each extracted slide becomes its own post.
- **Deleting a slide outright.** Extraction always produces a post; it never destroys media.
  Removing a photo entirely remains a delete-the-post operation.
