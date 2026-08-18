# Design — Add and remove media on an existing post

**Date:** 2026-08-18
**Status:** built and shipped (2026-08-18). The sections below describe what exists.

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

**One strip, `components/post-media-editor.tsx`, and every slide appears on the page
exactly once inside it.** The first draft of this design put an add/remove strip *next to*
the existing `<CarouselReorder>` grid, which meant two grids of the same six photos side by
side — one confusing feature, not two. Reordering moved into the strip instead and
`<CarouselReorder>` was deleted; add, remove, reorder, the number badge and whatever the
host hangs off a tile (the framing button, the lightbox badge) now share one tile.

Mounted in every edit surface:

- The full editor at `/library/[id]`.
- `QuickEditModal` — the same strip, which the Library grid and the Overview queue's
  `QueueQuickEdit` both mount.

Numbering and the ← → arrows appear only when the host wires up `reorder` **and** there are
2+ slides. `useAssetOrder` (`components/use-asset-order.ts`) stays outside the strip because
the two hosts disagree about when the order is saved: the post page has its own Save button,
quick edit rides the dialog's single Save.

**Modal layers, not modals.** The strip opens two overlays of its own — the asset picker and
the remove-slide confirm — and in quick edit those stack on top of a dialog that is itself
listening for Escape. `useModalLayer()` (`components/use-modal-focus-trap.ts`) makes Escape
close only the topmost one; without it, backing out of the picker threw away the whole quick
edit. Both overlays are separate components mounted only while open, so their focus trap
activates on open rather than when the strip mounts.

**Add and remove apply immediately, not behind Save.** `QuickEditModal` is
confirm-on-dismiss and compares against the values it opened with; staging media changes
inside that model would mean tracking pending deletes and orphaning uploaded files on
Cancel. Media therefore sits deliberately *outside* that dirty tracking. Slide *reorder* is
the exception and stays the host's business — which is why an add or a remove first warns
that an unsaved drag is about to be discarded, rather than saving it for you.

**Nothing that cannot succeed is offered.** A post with a live send (`posted`/`publishing`)
gets every media control disabled and the reason spelled out on the page —
`hasLiveSend` is passed in by each host (`PostEditor` derives it from the sends it already
loads; `QuickEditModal` reads `has_live_send`, which both callers already carry). This is
purely about the UI: the server refused these edits from day one, but the delete confirm's
usage lookup counts `publications.asset_id`, which a **feed** publication leaves NULL — so a
published carousel looked unreferenced and the red "Delete the file entirely" button was
being offered on history.

**Uploads are pre-flighted.** `GET /api/posts/[id]/assets/can-add` answers the rules that
need nothing but the post — live send, queued Story send, text post — *before* the browser
uploads a byte, because `POST /api/assets/upload` writes the original, a conformed
derivative and a thumbnail into `/data` before the add can be refused. Without it, every
refused attempt left another orphaned copy in the library. It runs the same
`checkCanAddMedia()` the write path runs, so there is one rule and one sentence. The
asset-dependent rules (video mixing, already-on-post, carousel size) still run after upload:
they cannot be judged without an asset row, and content-hash dedup makes re-uploading the
same file resolve to the asset that already exists. The library picker needs no pre-flight —
it writes nothing.

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

- **Unit** — `lib/post-media-edit.test.ts` covers every row of the rules table, plus
  `checkCanAddMedia()` and the fact that it and `checkAddAssets()` refuse identically.
  `lib/media-delete-confirm.test.ts` covers the fail-closed "delete entirely" gate.
- **Route** — `test/post-assets-add-route.test.ts` and `post-assets-remove-route.test.ts`
  (the design first guessed at one `post-assets-mutate-route.test.ts`; they split), plus
  `post-media-queries.test.ts`, alongside the existing `assets-order-route.test.ts` and
  `asset-delete-cleanup.test.ts`. Includes the case that matters most: a refused
  `mode=everywhere` delete leaves the post link intact and the files on disk.
- **Markup** — `test-ui/post-media-editor-ui.test.ts`: one tile per slide (the two-grid bug
  this strip exists to prevent), the disabled sole-slide ✕, and the live-send gate.
- **Browser** — against a **scratch copy of the database on port 3940**, never the live
  one. This flow deletes files irreversibly, and coordinates drift when media grids
  reflow, so the destructive paths are driven through Playwright rather than clicked by
  hand.

## Files

**New**
- `dashboard/lib/post-media-edit.ts` + `.test.ts` — the rules, including `checkCanAddMedia()`
- `dashboard/lib/media-delete-confirm.ts` + `.test.ts` — whether "delete entirely" is offered, and why not
- `dashboard/app/api/posts/[id]/assets/[assetId]/route.ts` — the remove endpoint
- `dashboard/app/api/posts/[id]/assets/can-add/route.ts` — the upload pre-flight
- `dashboard/app/api/assets/[id]/usage/route.ts` — what else references this asset, so the confirm dialog knows whether to offer "delete entirely"
- `dashboard/app/api/assets/route.ts` — the library list the picker reads
- `dashboard/components/post-media-editor.tsx` — the one strip (add + remove + reorder + the two overlays)
- `dashboard/components/asset-picker-modal.tsx` — pick from the library
- `dashboard/test/post-media-queries.test.ts`, `post-assets-add-route.test.ts`, `post-assets-remove-route.test.ts`
- `dashboard/test-ui/post-media-editor-ui.test.ts` — the strip's markup

**Modified**
- `dashboard/app/api/posts/[id]/assets/route.ts` — add `POST`
- `dashboard/components/post-editor.tsx`, `quick-edit-modal.tsx` — mount the strip, pass `hasLiveSend`
- `dashboard/components/library-view.tsx`, `queue-quick-edit.tsx`, `app/library/page.tsx` — carry `has_live_send`
- `dashboard/lib/queries.ts` — `addPostAssets`, `removePostAsset`, the usage counts, and `live_send_count` on the list/quick-edit reads

**Renamed**
- `dashboard/components/carousel-reorder.tsx` → `use-asset-order.ts`. `<CarouselReorder>` was
  deleted when reordering moved into the strip; the file holds only `useAssetOrder` and
  `OrderableAsset` now, so the old name described something no longer in it.

**Deleted**
- `dashboard/components/carousel-reorder.tsx`'s `<CarouselReorder>` grid and its
  `test-ui/carousel-reorder-ui.test.ts` — absorbed into the strip and its tests.

**No migration.** `post_assets` already carries everything this needs.

## Deliberately not in scope

- Changing media on a post that has already gone out. Its slides are history.
- Replacing a slide in place. Remove then add is the same result with fewer rules.
- Video slides inside a carousel. The worker has no publish path for them.
- Converting a media post to a text post by removing its last slide. That is a change of
  post kind, not a change of media.
