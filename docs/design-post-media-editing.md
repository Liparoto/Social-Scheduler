# Design — Add and remove media on an existing post

**Date:** 2026-08-18
**Status:** approved, not yet built

## The problem

A post's media is fixed the moment it is composed. Every edit surface can change the
words, the tags, the status, the schedule and the *order* of the slides — but not which
slides there are.

The gap is not an oversight, it is a stated one. `PATCH /api/posts/[id]/assets` says so in
its own header comment:

> Adding or removing slides is a bigger operation (it moves `post_type` and re-runs
> platform compatibility) and is deliberately not this endpoint.

And `DELETE /api/assets/[id]` refuses any asset attached to a post with an error that
points at a door which does not exist:

> Something still references this file, so it can't be deleted. If it's attached to a
> post, remove it from the post first.

There is no way to remove it from the post first. So today, fixing one wrong photo in a
ten-slide carousel means rebuilding the post from scratch, and an asset attached to a
post can never be deleted at all.

## What we're building

Two things, in every place a post can be edited:

1. **Add media** — upload new files, or pick files already in the library, and append them
   as slides.
2. **Remove media** — with an explicit choice between *remove from this post* (the file
   stays in the library) and *delete the file entirely* (gone from disk, permanently).

## Two findings that shape the rules

**The worker cannot publish video inside a carousel.** `_publish_carousel`
(`worker/publisher.py:508`) calls `create_image_container` for every child. A multi-slide
post containing a video would be accepted by the dashboard and then die terminally at
publish time. The composer already blocks this — "A Reel is a single video with no other
images or videos alongside it" — and the new write path must enforce the identical rule.
Without it, "add media" becomes a way to build a post guaranteed to fail.

**`incompatiblePostError()` already exists and is the only correct implementation of the
compatibility rules.** `lib/platforms.ts:252` knows both rules — text support, and
per-platform carousel size using the *strictest* selected channel. Its own comment records
that a hand-rolled copy once used `Math.max` instead of `Math.min` and accepted carousels
guaranteed to fail on one of their own targets. This design reuses it and does not
re-derive it.

## Scope decisions

| Decision | Chosen | Why |
|---|---|---|
| Which surfaces | Full editor **and** both quick-edit dialogs | The two dialogs are one component; it is two integrations, not three. |
| Which posts | Any post with **no live publication** | See below — the axis is `publications.status`, not `posts.status`. |
| Shared assets | "Delete entirely" is refused, with the reason named | Nothing gets destroyed by surprise. Cascading a delete across posts you cannot see from here is not recoverable. |
| Where added media comes from | Upload **and** pick-from-library | Content-hash dedup already means re-uploading an existing file resolves to the same asset, but a picker saves hunting for the original on disk. |

## Architecture

### Uploads are not re-implemented

New files keep going through the existing `POST /api/assets/upload`, which already does
content-hash dedup, image conforming, video validation, and video conversion. The new
endpoints deal only in asset **ids**. None of that pipeline is duplicated or bypassed.

### Two endpoints

**`POST /api/posts/[id]/assets`** — body `{ asset_ids: [12, 9] }`. Appends after the
existing slides, in the order given.

**`DELETE /api/posts/[id]/assets/[assetId]?mode=post|everywhere`** — one endpoint for both
delete flavours.

- `mode=post` unlinks the slide. The file stays in the library, where `/media` will show
  it as unused.
- `mode=everywhere` unlinks the slide *and* deletes the asset row and its files, in one
  transaction, reusing `assetFilePaths()` + `unlinkInsideStore()` so that every file an
  asset writes (thumb, derivative, story canvas) is covered. Spelling that list out by
  hand is how the story canvas came to be missed once already.

**Why one endpoint with a mode, rather than the UI chaining two existing calls.** Removing
the link and then calling `DELETE /api/assets/[id]` would work, but the refusal would
arrive *after* the slide was already unlinked — leaving a half-done edit whenever the
asset turned out to be shared. One endpoint checks everything before it writes anything.

**Why not a flag on the existing PATCH.** Both operations re-derive `post_type` and re-run
channel compatibility as part of the same write. The PATCH endpoint's guarantee is that
the slide count *cannot* change, which is precisely what makes it safe to be as simple as
it is.

### One pure rules module

`lib/post-media-edit.ts`, following the existing `lib/asset-order.ts` pattern: a pure
function the route calls, unit-tested without a database.

| Rule | Behaviour |
|---|---|
| Live send | Refused if any publication is `posted` or `publishing` → 409. See "Which posts are editable" below. |
| Last slide | Refused. "A post needs at least one photo. Delete the post instead." |
| Video mixing | Refused in both directions — no video into a post that has other slides, and nothing added alongside an existing video. Mirrors the composer. |
| `post_type` | Re-derived: 1 image = `single`, 1 video = `reel`, 2+ = `carousel`. |
| Channel fit | `incompatiblePostError(newType, newCount, targetChannels)` → **400** naming the offending channel and its real limit. It is an invalid request, like the video-mixing rule beside it, so it follows the "Error handling" convention below rather than the 409 an earlier draft of this table said. |
| Queued Story send — removing | Refused → 409 when a `scheduled`/`pending_approval` publication names THIS slide (`publications.asset_id`). Cancel or hold the send first. Never auto-canceled: this feature does not write to the queue for you. |
| Queued Story send — adding | Refused → 409 when the post has ANY `scheduled`/`pending_approval` publication with a non-NULL `asset_id`. The Story fan-out is one row per slide and happens once, at scheduling time, with no resync — a slide added afterwards would have no row and silently never post, while the queue rendered it as "Story 4 of 4". Never fanned out for you, for the same reason removal is never auto-canceled. A **feed** send (`asset_id IS NULL`) does not block adding: it publishes whatever slides exist at publish time, so picking the new one up is the point. |
| Text post | Refused → 400. A `post_type='text'` post has no slides by design and cannot become a media post; make a new post instead. The mirror of `Last slide`, which refuses the same conversion from the other direction. |
| Other references (`mode=everywhere`) | Refused → 409 when anything outside `post_assets` points at the asset row: `publications.asset_id` in **any** status (ON DELETE RESTRICT, migration 0014 — `failed` and `canceled` count) or `assets.cover_asset_id` (migration 0016). Counted up front so the refusal names the real reason; left to SQLite it surfaced as a bare constraint error that got reported as a shared-asset race that never happened. `mode=post` still works and the message says so. |

### Which posts are editable

The obvious guard is `posts.status`, and it is the wrong one. `posts.status` is documented
in `migrations/0001_init.sql` as the coarse overview lifecycle hint; the axis that says
whether something actually reached Instagram is `publications.status`. A post can sit at
`status='scheduled'` while one of its two sends has already gone out.

So this reuses the **same live-send definition `deletePost()` already uses**
(`queries.ts:866`), which `loadMergeCandidate()` also reuses and names explicitly:

> `'posted'` means it exists on the platform, `'publishing'` means the worker is mid-flight
> with it right now.

**Refused when any publication is `posted` or `publishing`.** That single rule covers both
concerns at once: it protects the record of what actually went out, and it protects the
worker from having `post_assets` rewritten underneath it mid-container.

It also gets the valuable case right for free. A post whose send **failed** has no live
publication, so its media *is* editable — and fixing the media before retrying is very
often exactly why the send failed. A `posts.status`-based guard would have had to special-
case that; this one does not.

**The guard belongs on the write, not before it.** `deletePost()` puts its check inside
the `DELETE` statement's `NOT EXISTS` clause precisely so a send going live between
validation and write cannot slip through. These endpoints do the same: the pure rules
module decides everything it can, and the live-send check is re-asserted inside the
transaction, which no-ops to a 409 if it lost the race.

### The delete confirmation

Clicking ✕ on a slide opens a confirm with two distinct buttons, not a generic yes/no:

- **Remove from this post** — always available.
- **Delete the file entirely** — permanent. When the asset is attached to other posts the
  button is disabled with the reason inline ("Also used by 3 other posts"), and the server
  refuses the same request independently, so a stale UI cannot get around it.

### The UI

One shared component, `components/post-media-editor.tsx`, mounted in two places:

- The full editor at `/library/[id]` — the slide strip gains an "Add media" tile and a ✕
  per slide.
- `QuickEditModal` — the same strip, which the Library grid and the Overview queue already
  share.

**Add and remove apply immediately, not behind Save.** `QuickEditModal` is
confirm-on-dismiss and compares against the values it opened with; staging media changes
inside that model would mean tracking pending deletes and orphaning uploaded files on
Cancel. Slide *reorder* already works this way — its own Save button, separate from the
text fields — so this matches an established precedent in the same dialog rather than
introducing a new one.

## Error handling

Every refusal carries a sentence a person can act on, in the style the existing routes
already use. Status codes follow what those routes already do: an invalid **request** is
`400` (a video that can't be mixed, a carousel past the channel's limit, the last slide),
a conflict with **other state** is `409` (a live send, a shared asset), and a missing post
or slide is `404`. The UI shows it inline next to the strip and leaves the post
untouched. A failed file unlink after a successful row delete is logged and reported as
`leftover`, exactly as `DELETE /api/assets/[id]` does today: a failed row delete must
never leave files deleted, but a failed file delete only leaves harmless bytes behind.

## Testing

- **Unit** — `lib/post-media-edit.test.ts` covers every row of the rules table.
- **Route** — `test/post-assets-mutate-route.test.ts`, alongside the existing
  `assets-order-route.test.ts` and `asset-delete-cleanup.test.ts`. Includes the case that
  matters most: a refused `mode=everywhere` delete leaves the post link intact and the
  files on disk.
- **Browser** — against a **scratch copy of the database on port 3940**, never the live
  one. This flow deletes files irreversibly, and coordinates drift when media grids
  reflow, so the destructive paths are driven through Playwright rather than clicked by
  hand.

## Files

**New**
- `dashboard/lib/post-media-edit.ts` + `.test.ts` — the rules
- `dashboard/app/api/posts/[id]/assets/[assetId]/route.ts` — the remove endpoint
- `dashboard/app/api/assets/[id]/usage/route.ts` — how many other posts hold this asset, so the confirm dialog knows whether to offer "delete entirely"
- `dashboard/app/api/assets/route.ts` — the library list the picker reads (only if no list route already exists)
- `dashboard/components/post-media-editor.tsx` — the shared strip
- `dashboard/components/asset-picker-modal.tsx` — pick from the library
- `dashboard/test/post-media-queries.test.ts`, `post-assets-add-route.test.ts`, `post-assets-remove-route.test.ts`

**Modified**
- `dashboard/app/api/posts/[id]/assets/route.ts` — add `POST`
- `dashboard/components/post-editor.tsx`
- `dashboard/components/quick-edit-modal.tsx`
- `dashboard/lib/queries.ts` — `addPostAssets`, `removePostAsset`, `assetOtherPostUsage`

**No migration.** `post_assets` already carries everything this needs.

## Deliberately not in scope

- Changing media on a post that has already gone out. Its slides are history.
- Replacing a slide in place. Remove then add is the same result with fewer rules.
- Video slides inside a carousel. The worker has no publish path for them.
- Converting a media post to a text post by removing its last slide. That is a change of
  post kind, not a change of media.
