# Video + Cover Frames on Instagram Reels — Design

**Date:** 2026-07-28
**Phase:** 6 (Extend adapters) — the "Reels/video" line item, plus the cover-frame capability.
**Goal:** Upload a video, choose which frame is its cover, schedule it, and publish it as an
**Instagram Reel** — reusing the existing publication lifecycle so every queue control
(hold / reschedule / cancel / retarget / Post now) works for a Reel exactly as it does for an image.

**Explicitly not in this sub-project:** TikTok. See "Relationship to TikTok" below.

## Why this is bigger than the adapter sub-projects, and where the work actually is

Facebook, Threads, Discord and Telegram were each *mechanical* — the schema, the fan-out, the
dashboard and the caption machinery already treated them as first-class, so the work was three
worker files and a registry sweep. **Video is not like that.** A codebase map (2026-07-28)
confirms there is no ingest path at all:

- `dashboard/app/api/assets/upload/route.ts:26-32` returns **415** for every video MIME type. Its
  own error string says *"video arrives in a later phase."*
- `media_kind` is **hardcoded** to `"image"` at `dashboard/app/api/assets/upload/route.ts:90`. No
  row can currently be created with `media_kind='video'`.
- `dashboard/lib/conform.ts` is `sharp`-only and image-specific. Nothing in it generalises.
- Both post-creation routes derive `post_type` purely from asset count
  (`dashboard/app/api/posts/route.ts:49`, `draft/route.ts:59`) — neither can ever produce `"reel"`.
- File pickers are image-restricted (`composer.tsx:337`, `bulk-import.tsx:139`).

Conversely, three things are **already done** and shrink the job considerably:

- **`posts.post_type` already allows `'reel'` and `'story'`** — `migrations/0001_init.sql:76`.
  No migration is needed for the post type itself. The only blocker is the hardcoded allow-list
  `SUPPORTED_POST_TYPES = ("single", "carousel", "text")` at `worker/publisher.py:26`, whose
  error message reads *"not supported until Phase 6 (Reels/Stories)"*.
- **`assets.media_kind` CHECK already permits `'video'`** — `migrations/0001_init.sql:55`.
- **`_poll_until_finished` (`worker/publisher.py:221-237`) is already the reusable async
  primitive.** It accepts a `status_fn` override (Threads uses it), and its docstring already
  says carousels/video need it. A Reel reuses it unchanged.
- `worker/asset_server.py:28` already maps `.mp4 → video/mp4`.

## Verified platform facts (Meta docs, re-verified 2026-07-28)

Per the CLAUDE.md rule to re-verify live Meta docs per adapter. **These numbers contradict
widely-circulated third-party "2026 guides", which claim a 4 GB cap and a 90-second limit.
Both are wrong.** Source: the IG User Media endpoint reference, `#reels-specs`.

**Reels video:**
| Property | Verified value |
|---|---|
| Container | MOV or MP4 (MPEG-4 Part 14), no edit lists, **moov atom at the front of the file** |
| Video codec | HEVC or H264, progressive scan, closed GOP, 4:2:0 chroma subsampling |
| Audio codec | AAC, 48kHz max sample rate, mono or stereo |
| Max file size | **300 MB** |
| Duration | **3 seconds minimum, 15 minutes maximum** |
| Aspect ratio | 0.01:1 to 10:1; 9:16 recommended to avoid cropping/blank space |
| Resolution | Maximum 1920 horizontal pixels |
| Frame rate | 23–60 FPS |
| Video bitrate | VBR, 25 Mbps max |
| Audio bitrate | 128 kbps |

**Cover controls** (IG User Media reference, quoted):
- `thumb_offset` — *"For videos and reels. Location, in milliseconds, of the video or reel frame
  to be used as the cover thumbnail image. The default value is `0`, which is the first frame."*
- `cover_url` — *"For Reels only. The path to an image to use as the cover image for the Reels
  tab. We will cURL the image using the URL that you specify so the image must be on a public
  server."* If both are supplied, **`cover_url` wins and `thumb_offset` is ignored.**
- Reels cover photo spec: JPEG, 8 MB max, 9:16 recommended, sRGB.

**Publishing flow:** container with `media_type=REELS` + `video_url`, poll container
`status_code` until `FINISHED`, then publish — the same shape as the existing image flow, but
with a materially longer transcode wait.

## Global constraints (from CLAUDE.md / reference.md)

- LOCAL-ONLY, no cloud/paid SaaS. Per-install `.env` + SQLite; worker↔dashboard share the DB.
- Migrations are additive, numbered `.sql` in `/migrations` (single source of truth).
- Never hardcode secrets; never log tokens, PII, or full API responses containing them.
- **Failed publishes must be visibly failed, never silent.** Each channel target is an
  independent publication; a failure on one must never roll back or block the others.
- Never hardcode a publishing rate limit — IG's runtime `content_publishing_limit` gate applies
  to Reels unchanged (`publisher._QUOTA_GATED["instagram"]` is already `True`).
- Dedup assets by content hash, never by filename.
- Python worker runs in the `.venv`; tests alongside existing `worker/tests/`.
- **Never modify the live `data/socialscheduler.db`** beyond removing test rows created during
  verification; report before/after counts and `PRAGMA foreign_key_check`.
- **Never change `DRY_RUN` or `KILL_SWITCH`** during development; they stay `1` and `0`.

## Decisions

### Decision 1 — Validate and explain; do NOT transcode. No ffmpeg.

The owner's footage is *mostly* vertical iPhone video, occasionally something else. Three
approaches were considered:

1. **Validate and explain** (chosen) — accept video, check it against the spec, refuse
   non-conforming files with a specific plain-English reason. No processing.
2. **ffmpeg conform** — re-encode/crop/trim to spec, mirroring `conformImage`. Rejected:
   ffmpeg is a large system binary every clone owner would have to install (a much heavier ask
   than `cloudflared`), transcoding competes for CPU with the dashboard, and it puts the app in
   the business of editing video. CLAUDE.md's guardrail is explicit that the dashboard's job is
   to make the process *legible*, not polished — and video editing is not scheduling.
3. **Build a seam for ffmpeg now, fill it later** — rejected as speculative abstraction.
   Approach 1 *is* the seam: conversion would slot in exactly where validation currently refuses.

The failure mode also argues for (1): a badly auto-cropped image is embarrassing, but a badly
auto-cropped *video* cuts someone's head off in motion, across the whole clip. The owner already
has good tools for the rare bad case (Photos trims, iMovie crops) on the phone the footage is
already on.

### Decision 2 — Read duration and dimensions from the container headers, in our own code

Validation must be **server-side and authoritative**; trusting a browser-reported duration would
violate the "validate all inputs" standard and, more practically, would let a wrong number
produce a publish that fails hours later in the worker.

Without ffmpeg/ffprobe, the way to get this is to parse the ISO base-media container directly:
`mvhd` gives duration and timescale, `tkhd` gives track dimensions, and the presence of an `hdlr`
box with handler type `soun` establishes whether there is an audio track. Both MP4 and MOV share
this structure. This is roughly 60 lines of plain byte parsing with **no new dependency**.

This is the one genuinely new piece of code in the sub-project, and it is deliberately small and
pure — it takes bytes and returns `{duration_ms, width, height, has_audio}`, which makes it
trivially unit-testable against fixture files without any network or database.

If the parse fails (an unusual but valid file), the upload is **refused with a clear message**
rather than accepted with unknown properties — an unknown-duration video would break the cover
scrubber and could fail at publish time.

### Decision 3 — The cover is one integer, not a generated image

`thumb_offset` takes a **millisecond offset** and Meta extracts the frame itself. So "which frame
is the cover" is a single number. The design stores exactly that: `assets.cover_frame_ms`.

Consequences, all good:
- **No cover image** to generate, hash, dedup, store, serve through the tunnel, or keep in sync
  with the video.
- **Evergreen recycling reuses the choice automatically**, because it lives on the asset — the
  same "decide once, remember per asset" pattern `conform_mode` / `needs_review` established for
  image framing.
- The browser shows the frame while scrubbing (a `<video>` element seeking to the offset), but
  that is *preview only*. Nothing is uploaded.
- `NULL` means "not chosen" and sends no `thumb_offset`, which Meta documents as frame 0.

`cover_url` (a custom cover image that is *not* a frame of the video — a branded title card, say)
is a real feature but **out of scope for v1**. If added later it slots in cleanly, since Meta's
documented precedence is `cover_url` wins over `thumb_offset`.

### Decision 4 — Aspect-ratio mismatch warns; it does not refuse

Instagram accepts 0.01:1 to 10:1. A landscape video is a *valid* Reel that will letterbox. Since
Meta would publish it, refusing it locally would block a post the platform would have accepted.
The composer therefore shows a non-blocking warning ("This is landscape — it will letterbox in
the Reels feed") rather than an error.

*Flagged for owner review: this is the one place the design deliberately permits a mediocre-
looking result. Say so if you would rather it refuse outright.*

Hard **refusals** are reserved for things Meta will actually reject: wrong container, over
300 MB, under 3 seconds, over 15 minutes, unreadable headers.

### Decision 5 — Reels get their own poll budget

`config.status_poll_interval` / `status_poll_max_tries` (`worker/config.py:72`) is currently a
single install-wide pair, tuned for image containers that finish in seconds. Video transcoding
on Meta's side takes substantially longer.

The current defaults are `status_poll_interval = 5` and `status_poll_max_tries = 60`
(`worker/config.py:72-74`) — a **5-minute** ceiling, tuned for image containers.

Reels therefore read their own `REELS_STATUS_POLL_INTERVAL` (default **10** seconds) and
`REELS_STATUS_POLL_MAX_TRIES` (default **90**) — a **15-minute** ceiling, matching the 15-minute
maximum Reel length on the assumption that transcode time scales roughly with duration. Both are
env-overridable and documented in `.env.example`. `_poll_until_finished` itself is **unchanged**
— only the arguments differ.

These defaults are a considered guess, not a verified figure: Meta publishes no transcode-time
SLA. The live test should record how long a real Reel actually took, and the default revised in
`reference.md` if it is wildly off.

Exhausting the budget is a **retryable** failure, not terminal: the container may still be
transcoding, and the next worker cycle should try again rather than burning the post. The
already-present-but-unused `publications.remote_container_id` column is the natural place to
persist a container id across cycles; **v1 does not use it** (inline polling with a longer budget
is simpler), but the column exists if it proves necessary.

### Decision 6 — Per-platform post-type support stays where it is

There is no "allowed post types" field on `PlatformCaps`; each `_publish_*` function has an
`if/elif` chain ending in `else: raise _NonRetryable(...)`. That already gives correct, terminal,
clearly-worded refusal for every platform that cannot publish a Reel — Facebook, Threads, Discord
and Telegram need **no changes at all**.

Generalising this into a `PlatformCaps.post_types` set is tempting and would be tidier, but it is
a refactor of five working adapters in service of one new post type. Deferred; noted as a
follow-up if a second video-capable platform ever lands (i.e. if TikTok revives).

### Decision 7 — Reels must be included in auto-fill, explicitly

`worker/autofill.py:99-101` matches only `post_type IN ('single','carousel')` or `'text'`. Left
alone, a Reel would be publishable but would **never be auto-queued** — it would simply never
appear, with no error. Since evergreen recycling of demo videos is a primary goal, widening this
query is in scope, not a follow-up.

## Data model

One additive migration, `0011_video_assets.sql`, on `assets` only:

| Column | Type | Meaning |
|---|---|---|
| `duration_ms` | INTEGER | NULL for images. Validation + scrubber bound. |
| `cover_frame_ms` | INTEGER | The cover decision. NULL = not chosen = Meta's frame 0. |
| `has_audio` | INTEGER NOT NULL DEFAULT 0 | Cheap to read; powers a "this Reel is silent" warning. |

No table rebuild is required (plain `ALTER TABLE ADD COLUMN`, like `0010`), because both
`assets.media_kind` and `posts.post_type` **already** permit the values needed. This is
deliberately unlike `0008`/`0009`, which had to rebuild tables to widen CHECK constraints.

## Components

**`dashboard/lib/video-meta.ts`** *(new, pure)* — `readVideoMeta(bytes) → {duration_ms, width,
height, has_audio}` by parsing `mvhd`/`tkhd`. No I/O, no dependency. Unit-tested against fixtures.

**`dashboard/lib/video-spec.ts`** *(new, pure)* — the verified spec table above as constants, plus
`validateReel(meta, byteSize, mime) → {ok} | {errors[], warnings[]}`. Separated from the parser so
the rules are readable in one place and testable without fixture files.

**`dashboard/app/api/assets/upload/route.ts`** *(modify)* — extend `EXT_BY_MIME` with
`video/mp4 → mp4` and `video/quicktime → mov`; branch on kind; set `media_kind` from the detected
type instead of the hardcoded `"image"`; skip `conformImage` and thumbnailing for video; persist
the parsed metadata. Content-hash dedup is untouched and applies to video identically.

**`dashboard/app/api/media/[id]/route.ts`** *(modify)* — its `MIME_BY_EXT` map is images-only
(`jpg`/`jpeg`/`png`/`webp`). Without `mp4 → video/mp4` and `mov → video/quicktime`, a video would
be served as `application/octet-stream` and **the browser would download it instead of playing
it** — which breaks the cover scrubber entirely, since the scrubber is a `<video>` element
pointed at this route. Easy to miss; central to the feature working.

**Video preview in the library.** Video assets get **no generated thumbnail file** — `sharp`
cannot produce one and Decision 1 rules out ffmpeg. Instead, surfaces that show a thumbnail today
render a `<video preload="metadata">` for video assets, which makes the browser display the first
frame without downloading the whole file. Where a `cover_frame_ms` exists, the element seeks to it
so the library shows *the chosen cover*, not frame 0. This keeps `assets.thumbnail_path` NULL for
video, which is already nullable and already tolerated by every consumer.

**`dashboard/app/api/assets/[id]/cover/route.ts`** *(new)* — `POST {cover_frame_ms}`, validated
against the asset's own `duration_ms`, persists. Mirrors the existing
`assets/[id]/conform/route.ts` in shape and guarding.

**`dashboard/components/cover-frame-picker.tsx`** *(new)* — `<video>` + range input bounded by
`duration_ms`, live frame preview via seeking, "Cover frame: 2.4s" readout, Save. Used in the
composer and the post editor, exactly as `<ConformControl>` is.

**`worker/graph_api.py`** *(modify)* — `create_video_container(...)` alongside
`create_image_container`, taking `video_url`, `media_type="REELS"`, optional `thumb_offset`.

**`worker/publisher.py`** *(modify)* — add `"reel"` to `SUPPORTED_POST_TYPES`; a shape rule
(exactly one asset, and it must be `media_kind='video'`); `_publish_reel` reusing
`_poll_until_finished` with the Reels poll budget; a `post_type == "reel"` arm in the Instagram
chain only.

**`worker/autofill.py`** *(modify)* — include `'reel'` in the candidate query.

**`dashboard/lib/platforms.ts`** *(modify)* — this file hand-mirrors `PLATFORM_CAPS` with **no
assert guarding it** (unlike the nine worker registries, which fail at import). It needs a video
capability flag so the composer can disable non-Instagram channels for a Reel. Its comment already
warns it is a mirror; this design does not fix that structural weakness, but the plan must not
forget the file.

## Data flow

1. Owner picks a `.mp4`/`.mov` in the composer.
2. Upload route hashes the bytes (dedup as today), parses container headers, validates against the
   Reels spec. **Refusal is specific**: *"This is 16m04s. Reels caps at 15 minutes."*
3. Asset row is written with `media_kind='video'`, `duration_ms`, `has_audio`. No conform
   derivative is produced; `publish_path` stays NULL, so `_resolve_url` naturally falls through
   to `storage_path` **with no worker change** — the existing precedence already handles this.
4. Cover picker appears. Scrubbing seeks the local `<video>`; saving writes `cover_frame_ms`.
5. Post is created with `post_type='reel'`; channel picker offers Instagram only.
6. Scheduled, held, rescheduled, cancelled, Post-now'd — all unchanged, all platform-agnostic.
7. Worker picks it up, opens the cloudflared tunnel (Instagram's `uploads_media_bytes` is
   `False`, so this already happens), creates a REELS container with `video_url` +
   `thumb_offset`, polls on the Reels budget, publishes, stores `remote_post_id`.
8. Metrics flow through the existing IG path. `video_views` is **already** plumbed end-to-end
   (column, worker mapping, export) — it has simply never had a video to describe.

## Error handling

- **Upload validation failures** → 4xx with the specific reason and the actual measured value.
  Nothing is written; no partial asset rows.
- **Header parse failure** → refusal, not silent acceptance (Decision 2).
- **A Reel targeted at a non-Instagram channel** → the worker's existing per-adapter
  `else: raise _NonRetryable` fails that publication **terminally** with a clear message, and the
  independence guarantee means sibling publications are untouched. The composer prevents this
  case; the worker enforces it regardless, matching how text-only posts are handled for Threads.
- **Container poll budget exhausted** → retryable, backed off, `last_error` set and visible in
  the dashboard. Never silently dropped.
- **IG quota exhausted** → the existing runtime gate defers the publication; no change.

## Testing

- **Unit (pure):** header parser against fixture files — a normal iPhone MOV, an MP4, a truncated
  file, a file with `moov` at the end; spec validator against each boundary (2.9s/3.0s,
  299 MB/301 MB, 14m59s/15m01s, aspect extremes).
- **Worker:** a Reel builds the right container call including `thumb_offset`; polling reuses
  `_poll_until_finished`; poll exhaustion is retryable not terminal; a Reel aimed at
  Facebook/Threads/Discord/Telegram fails terminally with a clear message and does not disturb a
  sibling publication; `'reel'` appears in autofill candidates; the platform-registry coverage
  test still passes.
- **Dashboard:** `tsc --noEmit` clean; a smoke script driving the real upload and cover routes
  against a **scratch copy** of the database, following `scripts/smoke-post-now.mjs`.
- **Browser:** upload a real iPhone video, see the cover scrubber, save a frame, schedule it, and
  confirm the worker's **dry-run** plan reports `post_type='reel'` with the right `thumb_offset`.
- **Live:** one real Reel to the owner's own account, following the established pattern —
  `DRY_RUN` flipped to `0` for exactly one `--once` cycle and restored immediately. Read the
  result back from the API rather than trusting our own DB.

## Known risk: the moov atom

Meta's container spec requires *"moov atom at the front of the file."* Video recorded on iPhone
frequently has it at the **end** (`faststart` not applied). If Meta enforces this strictly, some
of the owner's real footage will be rejected and Decision 1 cannot fix it in-app.

This is unfalsifiable from the documentation — it will be answered by the first real post.

**If it bites, the mitigation is a remux, not a transcode:** `ffmpeg -i in.mov -c copy -movflags
+faststart out.mp4` rewrites the container without touching the encoded video. It is lossless and
takes seconds. That would introduce ffmpeg for one narrow, cheap, well-understood job — a much
smaller commitment than Decision 2's rejected "conform" role, and worth revisiting *only* if the
real post proves it necessary.

The plan should therefore sequence the **live single-Reel test as early as it can be run**, so
this is discovered before the UI work is finished rather than after.

## Relationship to TikTok

This sub-project was scoped out of a request to add TikTok. Research on 2026-07-28 established
that TikTok is **not viable on the same terms as the other five platforms**, and it is deliberately
excluded:

- Unaudited API clients are restricted to `SELF_ONLY` visibility, and *the TikTok account itself
  must be private at the time of posting*.
- Lifting that requires app review (for the `video.publish` scope) **and** a separate audit, which
  demands consumer-app compliance UI (a privacy dropdown with no default, unchecked duet/stitch
  toggles, a verbatim music-usage string).
- OAuth redirect URIs must be static HTTPS — `http://localhost:3939/...` cannot be registered.
- App review explicitly rejects "beta or development versions, incomplete apps, and test versions."

A self-hosted, per-clone, no-hosted-anything tool does not fit that shape, whereas Meta permits
exactly this with an app in Development mode.

**What this design nonetheless preserves:** TikTok's cover parameter is
`video_cover_timestamp_ms` — milliseconds, identical in concept to `thumb_offset`. Storing the
cover as `assets.cover_frame_ms` (Decision 3) is therefore platform-neutral by construction and
would serve TikTok unchanged. The one plausible future path is TikTok's `/inbox/` endpoint
(`video.upload` scope), which lands a video in the account's drafts for the owner to publish
manually in the app. That is a separate investigation, not a committed build.

## Out of scope

- TikTok (above), Stories, Facebook video, video carousels.
- `cover_url` custom cover images (Decision 3).
- Any transcoding, trimming, cropping, or re-encoding (Decision 1).
- Generalising post-type support onto `PlatformCaps` (Decision 6).
- Persisting `remote_container_id` across worker cycles (Decision 5).
- Bulk import of video (the `/import` flow stays images-only for now).
