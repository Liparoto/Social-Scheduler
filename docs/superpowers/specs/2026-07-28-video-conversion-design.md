# Automatic Video Conversion on Upload — Design

**Date:** 2026-07-28
**Follows:** `docs/superpowers/specs/2026-07-28-video-reels-covers-design.md`
**Goal:** Accept the video the owner actually has, and produce a derivative each target platform
will accept — instead of refusing the file and telling them to go and fix it themselves.

## Why this reverses Decision 1 of the Reels spec

The Reels design chose **"validate and explain, never transcode"** and rejected an ffmpeg-based
conform step. The reasoning was that the owner's footage is "mostly vertical iPhone, occasionally
something else", so conversion would be heavy machinery for a rare case.

**That premise was wrong, and the first real file proved it.** `IMG_3707.MOV`, a straight iPhone
camera original, is **2160×3840** — 4K portrait. Instagram's Reels limit is **1920 horizontal
pixels**, so the validator correctly refused it. iPhone records 4K **by default**, so the failing
case is not occasional: it is the normal case. A scheduler that rejects most of what the owner
films is an obstacle, not a tool.

Two further facts changed the calculation:

1. **macOS ships `avconvert`** (`/usr/bin/avconvert`), an Apple-supported CLI with a
   `Preset1920x1080`. It is not a dependency to install — it is already on every Mac. Measured on
   the real file: 2160×3840 / 49.4 MB → **1080×1920 / 14.8 MB in a few seconds**.
2. **It also relocated the `moov` atom to the front.** The Reels spec recorded an unfalsifiable
   risk — Meta requires `moov` first, iPhone camera originals often have it last. Conversion
   closes that risk for every file that passes through it, rather than leaving it to chance.

## Why this is smaller than it looks

**The schema already models exactly this**, from the image-conformance sub-project. No migration
is needed:

| Concept | Column | Images (today) | Video (this design) |
|---|---|---|---|
| Untouched original | `assets.storage_path` | as uploaded | as uploaded |
| Platform-ready derivative | `assets.publish_path` | `pub/<hash>.jpg` | `pub/<hash>.mp4` |
| What was decided | `assets.conform_mode` | `none`/`crop`/`pad` | `none`/`downscale` |
| Needs a human look | `assets.needs_review` | 0/1 | 0/1 |

And the **worker needs no changes at all**:

- `_resolve_url` (`worker/publisher.py:78-98`) already prefers `publish_path` over
  `storage_path`, falling back when it is NULL.
- `PlatformCaps.needs_conformed_media` (`worker/clients.py`) already lets Discord and Telegram
  take the untouched original while Instagram/Facebook/Threads take the derivative — which *is*
  the "per-platform resolution" idea, already half-built for images.

`assets.conform_mode` has **no CHECK constraint** (confirmed in `migrations/0006`), so adding a
`downscale` value requires no migration.

## Decisions

### Decision 1 — Convert at upload, not at publish

Matches the image pipeline: the decision is made once, stored on the asset, and reused every time
an evergreen video is recycled. Converting at publish time would repeat the work on every reuse
and would block the worker's poll loop, which already has a 15-minute Reels transcode wait.

### Decision 2 — Only convert what conversion can actually fix

Failures split into two kinds, and conflating them would be dishonest:

| Failure | Convertible? | Behaviour |
|---|---|---|
| Wider than 1920 px | **Yes** — downscale | Convert |
| Larger than 300 MB | **Yes** — re-encode | Convert |
| Not MP4/MOV | **Yes** — remux/re-encode | Convert |
| `moov` atom at the end | **Yes** — incidental to re-encode | Convert |
| Longer than 15 minutes | **No** | Refuse, unchanged |
| Shorter than 3 seconds | **No** | Refuse, unchanged |
| Aspect ratio outside 9:16 | **Deliberately not** | Warn, unchanged |

Duration is an **editorial** decision — trimming means choosing what to cut, and the app must not
guess. Aspect ratio likewise: cropping video to 9:16 removes picture across the whole clip and can
cut someone's head off in motion. Instagram accepts 0.01:1–10:1 and letterboxes, so the existing
warn-don't-refuse behaviour stands.

**Order matters:** check the unconvertible failures *first* and refuse immediately. Converting a
16-minute video before telling the owner it is too long wastes minutes of their time.

### Decision 3 — `avconvert` on macOS, `ffmpeg` if present, otherwise today's refusal

Converter selection is a small ordered probe, resolved at runtime, never hardcoded:

1. **`avconvert`** — macOS only, always present there, zero setup. Preferred.
2. **`ffmpeg`** — used if found on `PATH`. Covers Windows and Linux clones where the owner has
   installed it.
3. **Neither** — fall back to exactly today's behaviour: refuse with the specific message
   (*"This video is 2160 pixels wide… Export it at 1080p and upload again."*), plus a line noting
   that installing `ffmpeg` would let the app handle it automatically.

This is **graceful degradation, not a new dependency**, and mirrors how `cloudflared` is already
handled: a missing binary produces a clear, actionable message rather than a crash.

The owner's own install is macOS, so their path needs nothing installed. A Windows clone (the
owner's wife) degrades to the current behaviour — no worse than today, and better if she installs
`ffmpeg`.

### Decision 4 — Re-validate the derivative; never trust the converter

After conversion the output is parsed and validated again with the **same**
`readVideoMeta` + `validateReel` used on the original. A converter that silently produced something
still out of spec must not slip through — the whole point is that what reaches Meta is known-good.

If the derivative still fails, the upload is **refused** and nothing is written.

### Decision 5 — A failed or impossible conversion refuses the upload; it does not half-succeed

This differs deliberately from the image path, where a conform failure falls back to the original
because the original is still publishable. **A video that failed the spec is not publishable**, so
storing it would create an asset that silently cannot be posted.

Validate-then-write is preserved: no file is written and no row is created unless the upload will
actually be usable.

### Decision 6 — Conversion is synchronous, with a timeout

The upload request waits. This keeps the flow simple and honest — when it returns, the asset is
ready. Reels are short by nature and the measured conversion was seconds.

A **timeout** (`VIDEO_CONVERT_TIMEOUT`, default 300s, env-overridable) bounds the worst case. On
timeout the partial output is deleted and the upload is refused with a message saying the video was
too large to convert automatically and suggesting exporting it smaller.

*Flagged for owner review: if conversion turns out to be slow enough to be annoying, the next step
is a background job with the asset in a "converting" state — materially more machinery, deliberately
not built now.*

### Decision 7 — Always tell the owner what happened

A silent rewrite of someone's footage is not acceptable. When a video is converted the upload
response reports it, the composer shows it plainly (*"Converted to 1080×1920 so Instagram will
accept it — your original is untouched"*), and `needs_review` is set so the asset carries the flag,
exactly as an auto-cropped image does today.

The original is always retained at `storage_path`.

## Components

**`dashboard/lib/video-convert.ts`** *(new)* — converter probe and invocation.
`findConverter(): Converter | null` returns which of `avconvert`/`ffmpeg` is available (cached);
`convertVideo(inputPath, outputPath, converter): Promise<void>` runs it. The only module that knows
converter command lines. No database, no HTTP.

**`dashboard/lib/video-spec.ts`** *(modify)* — split the existing check so callers can tell the two
failure kinds apart. Add `classifyReelErrors(meta, byteSize, mime)` returning
`{ fatal: string[]; convertible: string[]; warnings: string[] }`. `validateReel` keeps its current
signature and behaviour so existing tests and callers are untouched.

**`dashboard/app/api/assets/upload/route.ts`** *(modify)* — in the video branch: parse → classify →
refuse on `fatal` → if `convertible` is non-empty, convert to a temp file, re-parse, re-validate,
refuse if still bad → write original to `storage_path` and derivative to `pub/<hash>.mp4`, set
`conform_mode='downscale'` and `needs_review=1`. Return what happened.

**`dashboard/components/composer.tsx`** *(modify)* — surface the conversion notice alongside the
existing warnings block.

**Config** — `VIDEO_CONVERT_TIMEOUT` (default 300) and `VIDEO_CONVERTER` (`auto`|`avconvert`|
`ffmpeg`|`off`, default `auto`) in `dashboard/lib/config.ts` and `.env.example`. `off` restores
today's refuse-only behaviour for anyone who wants it.

## Data flow

1. Owner drops a 2160×3840 iPhone video.
2. Route hashes the bytes (dedup unchanged), parses headers, classifies failures.
3. Width 2160 > 1920 is **convertible**; nothing is fatal.
4. `avconvert -s <tmp-in> -p Preset1920x1080 -o <tmp-out>` runs, bounded by the timeout.
5. Output is re-parsed (**1080×1920**) and re-validated → clean.
6. Original → `storage_path`; derivative → `pub/<hash>.mp4`; `conform_mode='downscale'`;
   `needs_review=1`; `duration_ms`/`width`/`height` recorded **from the derivative**, since that is
   what will be published and what the cover scrubber must be bounded by.
7. Composer shows the conversion notice.
8. At publish, `_resolve_url` picks `publish_path` — **no worker change** — and Discord/Telegram
   still get the original via `needs_conformed_media=False`.

## Error handling

- **Fatal-only failures** (too long, too short) → 422 with today's message. No conversion attempted.
- **No converter available** → 422 with today's message plus the `ffmpeg` hint.
- **Converter fails or times out** → temp files deleted, 422, nothing written.
- **Derivative still out of spec** → temp files deleted, 422 naming the remaining problem.
- **A video already within spec** → no conversion, `publish_path` stays NULL, exactly as today.

## Testing

- **Unit (pure):** `classifyReelErrors` splits fatal vs convertible correctly at every boundary; a
  16-minute 4K video reports the duration as fatal and does **not** offer conversion.
- **Converter probe:** returns `avconvert` on this Mac; returns `null` with `VIDEO_CONVERTER=off`;
  honours an explicit override.
- **Integration (real conversion, real file):** the actual 2160×3840 `IMG_3707.MOV` uploads
  successfully, produces a 1080×1920 derivative, sets `conform_mode='downscale'` and
  `needs_review=1`, keeps the original, and the derivative re-validates clean. This is the case
  that motivated the work and must be covered by a real end-to-end test, not a synthetic one.
- **Regression:** an in-spec video still uploads with `publish_path` NULL and no conversion; image
  upload is entirely unaffected; content-hash dedup still returns the existing asset without
  re-converting.
- **Worker:** unchanged — confirm the existing suite still passes and that `_resolve_url` picks the
  video derivative, pinned by a test.

## Out of scope

- Trimming, cropping, or rotating — all editorial.
- Per-platform derivatives beyond the existing conformed/original split (e.g. a separate TikTok
  encode). The `needs_conformed_media` flag already covers what is needed today.
- Background/async conversion with a "converting" asset state (Decision 6).
- Converting on Windows without `ffmpeg` — it degrades to today's refusal by design.
- Audio normalisation, bitrate targeting, or codec selection beyond what the preset does.
