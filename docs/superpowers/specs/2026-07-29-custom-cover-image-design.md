# Custom Cover Image for Reels — Design

**Date:** 2026-07-29
**Goal:** Let the owner upload a real image as a Reel's cover, instead of only picking a frame
from the video.

## Why

The cover-frame picker can only choose a moment that already exists in the footage. Every other
scheduling tool lets you supply a designed cover — a title card, a branded frame, a better photo.
The owner asked for it directly: *"most of the sites allow you to put a cover Image, not just one
from the video, but an actual cover Image."*

Instagram supports it natively, so this is plumbing rather than invention.

## Verified platform facts (re-verified against Meta's live docs 2026-07-29)

From the IG User Media endpoint reference:

- **`cover_url`** — *"For Reels only. The path to an image to use as the cover image for the Reels
  tab. We will cURL the image using the URL that you specify so the image must be on a public
  server."*
- **Precedence, quoted:** *"If you specify both `cover_url` and `thumb_offset`, we use `cover_url`
  and ignore `thumb_offset`."*
- **Reels cover photo spec:** JPEG · **8 MB maximum** · sRGB (*"Images that use other color spaces
  will be converted to sRGB"*) · aspect ratio *"We recommend 9:16 to avoid cropping or blank
  space. If the aspect ratio of the original image is not 9:16, we crop the image and use the
  middle most 9:16 rectangle."*
- Whether a cover can be changed **after** publishing is **not documented**. We do not assume it
  can.

## The trap this design exists to avoid

**9:16 is a ratio of 0.5625. The existing image pipeline conforms uploads to Instagram's *feed*
range of 0.8–1.91** (`REEL_SPEC`-adjacent constants in `dashboard/lib/conform.ts`). A cover pushed
through the normal upload path would therefore be **cropped to 0.8** — mangling exactly the
framing the owner chose, and doing it silently.

A cover is not a feed image and must not be conformed like one.

## Decisions

### Decision 1 — A cover is an ordinary asset row, referenced by the video

Add `assets.cover_asset_id` (nullable, FK to `assets.id`). The cover image is stored as a normal
`assets` row with `media_kind='image'`, so it inherits content-hash dedup, the local store, and
URL resolution for free.

Rejected: a dedicated `cover_images` table. It would duplicate dedup and storage logic for no
benefit, and the cover genuinely *is* an image asset — it just has a different job.

Note the Library lists **posts**, not assets, so a cover asset does not appear as a spurious
library entry.

### Decision 2 — Covers get their own conform target: colour and size only, never aspect

`conformCover(bytes)` produces sRGB JPEG within 8 MB and **does not touch the aspect ratio.**

Meta already center-crops a non-9:16 cover to the middle 9:16, and it is better to let the
platform do that visibly than to crop locally and pretend the result was chosen. What we *do* is
**warn** when the uploaded image is not close to 9:16, naming what Instagram will do to it — the
same warn-don't-refuse principle the video validator already uses for aspect ratio.

This deliberately does **not** reuse `conformImage`, whose whole purpose is the feed range.

### Decision 3 — A cover image overrides the cover frame, and the UI says so

Meta's precedence is fixed: `cover_url` wins and `thumb_offset` is ignored. The UI must not
present two controls that silently fight.

So the picker shows one choice — **"Frame from the video"** or **"Uploaded image"** — and when an
image is set, the frame scrubber is visibly marked as overridden rather than hidden. Hiding it
would lose the information that a frame *was* chosen; the owner may want to go back to it.

Removing the cover image restores the frame, which is still stored in `cover_frame_ms`. Nothing is
destroyed by switching.

### Decision 4 — The worker sends whichever is set, and never both

`_build_plan` resolves the cover once: if the video asset has a `cover_asset_id`, the plan carries
`cover_url` (resolved through the same tunnel/`_resolve_url` chain as any asset) and **omits
`thumb_offset` entirely**; otherwise it carries `thumb_offset` as today.

Sending both and relying on Meta's documented precedence would work, but it hides the decision
inside Meta's behaviour rather than making it explicit in our plan — and the dry-run plan is one
of this project's main debugging surfaces.

### Decision 5 — Instagram only, and the schema says nothing about other platforms

`cover_url` is Reels-only. Threads and TikTok have no equivalent (TikTok has a *timestamp*, like
`thumb_offset`). Nothing about this design assumes it generalises, and no platform capability flag
is added for it — if another platform ever gains custom covers, that is when to model it.

### Decision 6 — Uploading a cover is its own endpoint

`POST /api/assets/[id]/cover-image` takes a file, conforms it as a cover (Decision 2), stores it,
and links it. `DELETE` on the same route clears the link.

Rejected: a flag on the general `/api/assets/upload` route. That route's job is "add media to a
post"; overloading it with "and sometimes this is a cover for a different asset" would tangle two
unrelated flows, and its post-type derivation logic would have to learn to ignore covers.

## Components

**Migration `0012_cover_asset.sql`** — `ALTER TABLE assets ADD COLUMN cover_asset_id INTEGER
REFERENCES assets(id)`. Additive, no rebuild. Note SQLite does not enforce a foreign key added
this way unless `foreign_keys` is on, which this project does enable — but the app must still
tolerate a dangling id defensively, since `/data` is per-install and hand-edited databases happen.

**`dashboard/lib/conform-cover.ts`** *(new, pure)* — `conformCover(bytes): Promise<{buffer,
warnings}>`. sRGB, JPEG, quality-stepped to ≤8 MB, aspect untouched; warns when the ratio is not
within a tolerance of 9:16.

**`dashboard/app/api/assets/[id]/cover-image/route.ts`** *(new)* — `POST` (upload + link),
`DELETE` (unlink). Refuses a non-video target with 409, mirroring the existing
`assets/[id]/cover` route's guard.

**`dashboard/lib/queries.ts`** *(modify)* — `setAssetCoverImage(videoAssetId, coverAssetId | null)`
and expose `cover_asset_id` on `Asset`.

**`dashboard/components/cover-frame-picker.tsx`** *(modify)* — the Frame/Image choice from
Decision 3, plus upload and remove controls.

**`worker/publisher.py`** *(modify)* — `_build_plan` resolves the cover per Decision 4;
`_publish_reel` passes `cover_url` through.

**`worker/graph_api.py`** *(modify)* — `create_video_container` gains an optional `cover_url`.

## Data flow

1. Owner opens a Reel in the post editor and chooses **Uploaded image**, selecting a JPEG/PNG.
2. `POST /api/assets/[id]/cover-image` conforms it (sRGB JPEG ≤8 MB, ratio untouched), stores it as
   an image asset, links it via `cover_asset_id`, and returns any ratio warning.
3. The picker shows the cover image and marks the frame scrubber as overridden.
4. At publish, `_build_plan` sees `cover_asset_id`, resolves that asset's public URL through the
   tunnel, and puts `cover_url` in the plan **without** `thumb_offset`.
5. `create_video_container` sends `cover_url`. Meta cURLs it, center-cropping to 9:16 if needed.

## Error handling

- **Non-video target** → 409, as the sibling cover-frame route does.
- **Not an image / unreadable** → 422 before anything is written.
- **Over 8 MB after quality stepping** → 422 naming the measured size, matching how the video
  validator reports sizes.
- **Dangling `cover_asset_id`** (asset row deleted out from under it) → the worker falls back to
  `thumb_offset` and logs it, rather than failing the publish. A missing cover is a cosmetic
  problem; refusing to publish over it would be worse.
- **A cover on a non-Instagram target** → ignored, not an error. The post may fan out to several
  platforms and only Instagram can use a cover.

## Testing

- **Unit (pure):** `conformCover` converts to sRGB JPEG, steps quality to land under 8 MB, and
  leaves dimensions untouched; warns for 1:1 and 16:9 inputs, silent for 9:16.
- **Route:** upload links the asset and returns the warning; `DELETE` unlinks and leaves
  `cover_frame_ms` intact; non-video → 409; oversize → 422 with nothing written.
- **Worker:** with a cover set, the plan contains `cover_url` and **no** `thumb_offset`; without
  one, `thumb_offset` as today; a dangling `cover_asset_id` falls back rather than raising. Assert
  on the dry-run plan, which is the project's established way to pin publish behaviour.
- **Browser:** upload a cover on the real Reel post, see the scrubber marked overridden, remove it
  and see the frame restored.
- **Live:** deliberately **not** part of this work. The owner has already published one real Reel;
  a second real post to verify a cover is their call, not something this spec assumes.

## Out of scope

- Changing the cover of an **already-published** Reel. Meta does not document whether that is
  possible, and this project's rule is never to assume undocumented behaviour.
- Generating a cover (title cards, text overlay, frame extraction to an editable image).
- Covers for Threads or TikTok — Decision 5.
- Cropping the cover locally to 9:16 — Decision 2.
