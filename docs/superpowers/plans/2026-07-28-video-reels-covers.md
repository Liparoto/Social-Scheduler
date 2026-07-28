# Video + Cover Frames on Instagram Reels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a video, choose which frame is its cover, and publish it as an Instagram Reel through the existing publication lifecycle.

**Architecture:** Video is accepted but never processed — duration/dimensions are parsed from the MP4/MOV container headers in ~60 lines of pure code (no ffmpeg, no new dependency), validated against Meta's verified Reels spec, and refused with a specific message if out of range. The cover is stored as a single integer (`assets.cover_frame_ms`) and sent as Meta's `thumb_offset`, so no cover image is ever generated. The worker adds one publish path that reuses the existing `_poll_until_finished` primitive with a longer budget.

**Tech Stack:** Next.js 16 (App Router, TS) + `better-sqlite3`; Python 3 worker in `.venv` + `requests`; SQLite WAL. **No new dependencies in either half.**

Design spec: `docs/superpowers/specs/2026-07-28-video-reels-covers-design.md`

## Global Constraints

- **No new dependencies**, either npm or pip. Specifically **no ffmpeg** (Decision 1).
- **Never modify the live `data/socialscheduler.db`** beyond removing test rows you create. Report before/after row counts and `PRAGMA foreign_key_check` output. WAL mode — a copy needs the `-wal`/`-shm` sidecars.
- **Never change `DRY_RUN` or `KILL_SWITCH`** in `.env`. They stay `1` and `0`, except for the single supervised `--once` cycle in Task 7.
- Migrations are additive numbered `.sql` in `/migrations` — the single source of truth. Never define schema inline in TS or Python.
- Never hardcode secrets; never log tokens, PII, or full API responses.
- **Failed publishes must be visibly failed, never silent.** Each publication is independent; one failure must never roll back or block a sibling.
- Verified Reels spec — use these exact values, do not substitute remembered ones:
  - Container MOV or MP4; video codec HEVC or H264; audio AAC
  - **Max file size 300 MB**; **duration 3 seconds minimum, 15 minutes maximum**
  - Aspect ratio 0.01:1 to 10:1 (9:16 recommended); max 1920 horizontal pixels; 23–60 FPS
- `thumb_offset` is **milliseconds**; default `0` = first frame; `cover_url` (not built here) would override it.
- Checks that must pass at the end of every task:
  - `cd dashboard && npx tsc --noEmit`
  - `.venv/bin/python -m pytest worker/tests -q` (currently **324 passing**)

---

### Task 1: Migration 0011 + asset type/query layer

**Files:**
- Create: `migrations/0011_video_assets.sql`
- Modify: `dashboard/lib/types.ts` (the `Asset` interface), `dashboard/lib/queries.ts:113-128` (`InsertAssetInput`) and `:129-153` (`upsertAssetByHash`)
- Test: `dashboard/scripts/smoke-video-asset.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `assets.duration_ms INTEGER | null`, `assets.cover_frame_ms INTEGER | null`, `assets.has_audio INTEGER` (0/1); `InsertAssetInput` gains the same three as optional fields.

- [ ] **Step 1: Write the migration**

Create `migrations/0011_video_assets.sql`:

```sql
-- 0011_video_assets.sql
-- Add the three video-only properties an asset needs:
--   assets.duration_ms      (new, nullable)  length in milliseconds; NULL for images
--   assets.cover_frame_ms   (new, nullable)  chosen cover frame; NULL = Meta's default frame 0
--   assets.has_audio        (new, 0/1)       whether a `soun` track is present
--
-- Stored on the ASSET, not the post, so an evergreen video that is recycled reuses the
-- cover frame chosen once — exactly the pattern 0006 established with conform_mode /
-- needs_review for image framing.
--
-- cover_frame_ms holds a MILLISECOND OFFSET, not an image. Instagram's thumb_offset and
-- TikTok's video_cover_timestamp_ms both take a millisecond offset and extract the frame
-- themselves, so no cover image is generated, stored, deduped or served anywhere.
--
-- Purely additive: assets.media_kind's CHECK already allows 'video' (0001_init.sql:55) and
-- posts.post_type already allows 'reel' (0001_init.sql:76), so no table rebuild is needed
-- and none of 0008/0009's cascade-delete risk applies.

ALTER TABLE assets ADD COLUMN duration_ms INTEGER;
ALTER TABLE assets ADD COLUMN cover_frame_ms INTEGER;
ALTER TABLE assets ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply it to a scratch copy and verify**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && cp data/socialscheduler.db /tmp/t.db && cp data/socialscheduler.db-wal /tmp/t.db-wal 2>/dev/null; cp data/socialscheduler.db-shm /tmp/t.db-shm 2>/dev/null; DB_PATH=/tmp/t.db python3 migrate.py && sqlite3 /tmp/t.db "PRAGMA table_info(assets);" | grep -E "duration_ms|cover_frame_ms|has_audio"
```

Expected: three rows printed — `duration_ms|INTEGER`, `cover_frame_ms|INTEGER`, `has_audio|INTEGER` with `dflt_value` `0` and `notnull` `1` on the last.

- [ ] **Step 3: Extend the TypeScript types**

In `dashboard/lib/types.ts`, add to the `Asset` interface (alongside `publish_path` / `conform_mode` / `needs_review`):

```typescript
  duration_ms: number | null;
  cover_frame_ms: number | null;
  has_audio: number;
```

In `dashboard/lib/queries.ts`, add to `InsertAssetInput` after `needs_review?: number;`:

```typescript
  duration_ms?: number | null;
  cover_frame_ms?: number | null;
  has_audio?: number;
```

- [ ] **Step 4: Extend the insert**

In `dashboard/lib/queries.ts`, `upsertAssetByHash` — extend the column list, the VALUES list, and the defaults:

```typescript
  const info = getDb()
    .prepare(
      `INSERT INTO assets
        (content_hash, media_kind, original_filename, storage_path, public_url,
         thumbnail_path, mime_type, width, height, byte_size,
         publish_path, conform_mode, needs_review,
         duration_ms, cover_frame_ms, has_audio)
       VALUES (@content_hash, @media_kind, @original_filename, @storage_path, @public_url,
         @thumbnail_path, @mime_type, @width, @height, @byte_size,
         @publish_path, @conform_mode, @needs_review,
         @duration_ms, @cover_frame_ms, @has_audio)`
    )
    .run({
      ...input,
      publish_path: input.publish_path ?? null,
      conform_mode: input.conform_mode ?? "none",
      needs_review: input.needs_review ?? 0,
      duration_ms: input.duration_ms ?? null,
      cover_frame_ms: input.cover_frame_ms ?? null,
      has_audio: input.has_audio ?? 0,
    });
```

- [ ] **Step 5: Write the smoke test**

Create `dashboard/scripts/smoke-video-asset.mjs`. It must operate on a scratch copy, never the live DB:

```javascript
// Verifies migration 0011 + the insert path: a video asset round-trips its three new
// columns, and an image asset still inserts with sane defaults (back-compat).
import { execSync } from "node:child_process";
import fs from "node:fs";

const SRC = "data/socialscheduler.db";
const TMP = "/tmp/smoke-video-asset.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (fs.existsSync(SRC + suffix)) fs.copyFileSync(SRC + suffix, TMP + suffix);
}
execSync(`DB_PATH=${TMP} python3 migrate.py`, { cwd: "..", stdio: "inherit" });

process.env.DB_PATH = TMP;
const { upsertAssetByHash, getAsset } = await import("../lib/queries.ts");

const vid = upsertAssetByHash({
  content_hash: "smoke-video-" + Date.now(),
  media_kind: "video",
  original_filename: "clip.mov",
  storage_path: "x.mov",
  public_url: null,
  thumbnail_path: null,
  mime_type: "video/quicktime",
  width: 1080,
  height: 1920,
  byte_size: 1234,
  duration_ms: 12_500,
  has_audio: 1,
}).asset;

if (vid.media_kind !== "video") throw new Error("media_kind not persisted as video");
if (vid.duration_ms !== 12_500) throw new Error(`duration_ms=${vid.duration_ms}`);
if (vid.has_audio !== 1) throw new Error(`has_audio=${vid.has_audio}`);
if (vid.cover_frame_ms !== null) throw new Error("cover_frame_ms should default to NULL");
if (vid.thumbnail_path !== null) throw new Error("video should have no thumbnail");

const img = upsertAssetByHash({
  content_hash: "smoke-image-" + Date.now(),
  media_kind: "image",
  original_filename: "p.jpg",
  storage_path: "p.jpg",
  public_url: null,
  thumbnail_path: "thumbs/p.jpg",
  mime_type: "image/jpeg",
  width: 1080,
  height: 1080,
  byte_size: 999,
}).asset;

if (img.duration_ms !== null) throw new Error("image duration_ms should be NULL");
if (img.has_audio !== 0) throw new Error("image has_audio should default to 0");

console.log("OK — video and image assets both round-trip correctly");
```

- [ ] **Step 6: Run it**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/smoke-video-asset.mjs
```

Expected: `OK — video and image assets both round-trip correctly`

- [ ] **Step 7: Typecheck and commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit
```

Expected: no output.

```bash
git add migrations/0011_video_assets.sql dashboard/lib/types.ts dashboard/lib/queries.ts dashboard/scripts/smoke-video-asset.mjs && git commit -m "feat(db): migration 0011 — video duration, cover frame, audio flag on assets"
```

---

### Task 2: MP4/MOV container header parser

**Files:**
- Create: `dashboard/lib/video-meta.ts`
- Test: `dashboard/scripts/test-video-meta.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `readVideoMeta(buf: Buffer): VideoMeta` where `interface VideoMeta { duration_ms: number; width: number; height: number; has_audio: boolean }`. Throws `VideoParseError` (exported) when the container cannot be read.

**Background — the box format.** MP4 and MOV are both ISO base media files: a flat tree of *boxes*, each `[4-byte big-endian size][4-byte ASCII type][payload]`. We need three:
- `moov` > `mvhd` — payload offset 12 is `timescale` (units per second), offset 16 is `duration` (in those units). Version 0 uses 32-bit fields; version 1 (first payload byte == 1) shifts both and uses 64-bit duration.
- `moov` > `trak` > `tkhd` — payload offsets 76 and 80 hold width and height as 16.16 fixed-point (divide by 65536).
- `hdlr` anywhere — payload offset 8 is a 4-char handler type; `soun` means an audio track exists.

- [ ] **Step 1: Write the failing test**

Create `dashboard/scripts/test-video-meta.mjs`. Fixtures are **synthetic buffers built in code** — no binary files in git, and precise control over each field:

```javascript
import assert from "node:assert/strict";
import { readVideoMeta, VideoParseError } from "../lib/video-meta.ts";

/** Build one MP4 box: [size][type][payload]. */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}

/** mvhd v0: version+flags(4), created(4), modified(4), timescale(4), duration(4), rest. */
function mvhd(timescale, duration) {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(0, 0);            // version 0 + flags
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box("mvhd", p);
}

/** tkhd v0: width at payload offset 76, height at 80, both 16.16 fixed-point. */
function tkhd(width, height) {
  const p = Buffer.alloc(84);
  p.writeUInt32BE(0, 0);
  p.writeUInt32BE(width * 65536, 76);
  p.writeUInt32BE(height * 65536, 80);
  return box("tkhd", p);
}

/** hdlr: version+flags(4), pre_defined(4), handler_type(4). */
function hdlr(kind) {
  const p = Buffer.alloc(24);
  p.write(kind, 8, "ascii");
  return box("hdlr", p);
}

function file({ timescale = 600, duration = 6000, w = 1080, h = 1920, audio = true, moovFirst = true } = {}) {
  const ftyp = box("ftyp", Buffer.from("isomiso2avc1mp41", "ascii"));
  const tracks = [box("trak", Buffer.concat([tkhd(w, h), hdlr("vide")]))];
  if (audio) tracks.push(box("trak", Buffer.concat([tkhd(0, 0), hdlr("soun")])));
  const moov = box("moov", Buffer.concat([mvhd(timescale, duration), ...tracks]));
  const mdat = box("mdat", Buffer.alloc(64));
  return moovFirst
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov]);   // iPhone-style: moov at the END
}

// 6000 units / 600 per second = 10 seconds
const m = readVideoMeta(file());
assert.equal(m.duration_ms, 10_000, "duration");
assert.equal(m.width, 1080);
assert.equal(m.height, 1920);
assert.equal(m.has_audio, true);

// No audio track
assert.equal(readVideoMeta(file({ audio: false })).has_audio, false, "silent video");

// A different timescale must still resolve to the same wall-clock duration
assert.equal(readVideoMeta(file({ timescale: 90_000, duration: 90_000 * 7 })).duration_ms, 7000);

// moov at the END of the file must still parse. This is the iPhone case, and the whole
// reason the parser walks boxes rather than assuming a layout.
assert.equal(readVideoMeta(file({ moovFirst: false })).duration_ms, 10_000, "moov-last");

// Landscape
const land = readVideoMeta(file({ w: 1920, h: 1080 }));
assert.equal(land.width, 1920);
assert.equal(land.height, 1080);

// Garbage must throw a typed error, never return junk
assert.throws(() => readVideoMeta(Buffer.from("this is not a video at all")), VideoParseError);

// Truncated: a valid header claiming more bytes than exist
const trunc = file().subarray(0, 40);
assert.throws(() => readVideoMeta(trunc), VideoParseError);

console.log("OK — video-meta parses duration, dimensions, audio; handles moov-last and rejects garbage");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/test-video-meta.mjs
```

Expected: FAIL — `Cannot find module '../lib/video-meta.ts'`

- [ ] **Step 3: Write the parser**

Create `dashboard/lib/video-meta.ts`:

```typescript
/**
 * Read duration, dimensions and audio presence straight out of an MP4/MOV container.
 *
 * Why hand-rolled: the alternatives are ffprobe (a large system binary every clone owner
 * would have to install) or trusting a duration the browser reported (unverifiable input,
 * and a wrong value fails hours later in the worker instead of at upload). Both MP4 and
 * MOV are ISO base media files — a tree of [4-byte size][4-byte type][payload] boxes — so
 * reading three of them is far cheaper than either alternative.
 *
 * Deliberately pure: bytes in, facts out. No I/O, no database, no config.
 */

export class VideoParseError extends Error {}

export interface VideoMeta {
  duration_ms: number;
  width: number;
  height: number;
  has_audio: boolean;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;   // payload end (exclusive)
}

/** Iterate the boxes directly inside [from, to). */
function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos + 8 <= to) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    // size 0 means "to end of file"; size 1 means a 64-bit size follows the type.
    let header = 8;
    let total = size;
    if (size === 1) {
      if (pos + 16 > to) return;
      total = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      total = to - pos;
    }
    if (total < header || pos + total > to) return; // truncated or nonsense — stop
    yield { type, start: pos + header, end: pos + total };
    pos += total;
  }
}

/** Depth-first search for the first box of `type`. */
function find(buf: Buffer, from: number, to: number, type: string): Box | null {
  for (const b of boxes(buf, from, to)) {
    if (b.type === type) return b;
    // Only these are containers; recursing into media data would be wasteful and wrong.
    if (["moov", "trak", "mdia", "minf", "stbl", "udta"].includes(b.type)) {
      const hit = find(buf, b.start, b.end, type);
      if (hit) return hit;
    }
  }
  return null;
}

function findAll(buf: Buffer, from: number, to: number, type: string, out: Box[] = []): Box[] {
  for (const b of boxes(buf, from, to)) {
    if (b.type === type) out.push(b);
    if (["moov", "trak", "mdia", "minf", "stbl", "udta"].includes(b.type)) {
      findAll(buf, b.start, b.end, type, out);
    }
  }
  return out;
}

export function readVideoMeta(buf: Buffer): VideoMeta {
  const moov = find(buf, 0, buf.length, "moov");
  if (!moov) {
    throw new VideoParseError(
      "Could not read this video's properties — no 'moov' header was found. " +
        "The file may be corrupt or still transferring."
    );
  }

  const mvhd = find(buf, moov.start, moov.end, "mvhd");
  if (!mvhd) throw new VideoParseError("Could not read this video's duration ('mvhd' missing).");

  const version = buf.readUInt8(mvhd.start);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    timescale = buf.readUInt32BE(mvhd.start + 20);
    duration = Number(buf.readBigUInt64BE(mvhd.start + 24));
  } else {
    timescale = buf.readUInt32BE(mvhd.start + 12);
    duration = buf.readUInt32BE(mvhd.start + 16);
  }
  if (!timescale) throw new VideoParseError("Could not read this video's duration (timescale is 0).");

  // Dimensions come from the first track that actually has them. An audio track's tkhd
  // carries 0x0, so a plain "first tkhd" read would report a 0x0 video on files that
  // happen to list audio first.
  let width = 0;
  let height = 0;
  for (const tkhd of findAll(buf, moov.start, moov.end, "tkhd")) {
    if (tkhd.end - tkhd.start < 84) continue;
    const w = buf.readUInt32BE(tkhd.start + 76) / 65536;
    const h = buf.readUInt32BE(tkhd.start + 80) / 65536;
    if (w > 0 && h > 0) {
      width = Math.round(w);
      height = Math.round(h);
      break;
    }
  }
  if (!width || !height) {
    throw new VideoParseError("Could not read this video's dimensions ('tkhd' missing or empty).");
  }

  const has_audio = findAll(buf, moov.start, moov.end, "hdlr").some(
    (h) => h.end - h.start >= 12 && buf.toString("ascii", h.start + 8, h.start + 12) === "soun"
  );

  return {
    duration_ms: Math.round((duration / timescale) * 1000),
    width,
    height,
    has_audio,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/test-video-meta.mjs
```

Expected: `OK — video-meta parses duration, dimensions, audio; handles moov-last and rejects garbage`

- [ ] **Step 5: Verify against a REAL file**

Synthetic fixtures prove the parser's logic, not that it matches reality. Ask the owner for one real iPhone video (or use any `.mov`/`.mp4` on the Mac), then:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node --input-type=module -e "import fs from 'node:fs'; const {readVideoMeta}=await import('./lib/video-meta.ts'); console.log(readVideoMeta(fs.readFileSync(process.argv[1])));" /path/to/real-video.mov
```

Expected: plausible values. **Sanity-check the duration against what the Finder/QuickTime reports** — a timescale bug shows up as a duration that is off by a large factor, and is otherwise invisible. Record the real file's `moov` position (first or last) in your report — it is direct evidence for the Task 7 risk.

- [ ] **Step 6: Typecheck and commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit
```

```bash
git add dashboard/lib/video-meta.ts dashboard/scripts/test-video-meta.mjs && git commit -m "feat(dashboard): parse video duration/dimensions/audio from MP4-MOV headers"
```

---

### Task 3: Reels spec validator

**Files:**
- Create: `dashboard/lib/video-spec.ts`
- Test: `dashboard/scripts/test-video-spec.mjs` (create)

**Interfaces:**
- Consumes: `VideoMeta` from Task 2.
- Produces: `validateReel(meta: VideoMeta, byteSize: number, mime: string): ReelCheck` where `interface ReelCheck { errors: string[]; warnings: string[] }`. Empty `errors` means acceptable. Also exports `REEL_SPEC` (the constants) and `REEL_MIME_TYPES`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/scripts/test-video-spec.mjs`:

```javascript
import assert from "node:assert/strict";
import { validateReel, REEL_SPEC } from "../lib/video-spec.ts";

const ok = { duration_ms: 30_000, width: 1080, height: 1920, has_audio: true };
const MB = 1024 * 1024;

// The happy path: a normal vertical iPhone clip
let r = validateReel(ok, 40 * MB, "video/quicktime");
assert.deepEqual(r.errors, [], "a normal vertical clip must pass");
assert.deepEqual(r.warnings, [], "and warn about nothing");

// Duration boundaries — 3s min, 15min max, both INCLUSIVE
assert.deepEqual(validateReel({ ...ok, duration_ms: 3_000 }, MB, "video/mp4").errors, [], "3.0s ok");
assert.equal(validateReel({ ...ok, duration_ms: 2_999 }, MB, "video/mp4").errors.length, 1, "2.999s too short");
assert.deepEqual(validateReel({ ...ok, duration_ms: 900_000 }, MB, "video/mp4").errors, [], "15m ok");
assert.equal(validateReel({ ...ok, duration_ms: 900_001 }, MB, "video/mp4").errors.length, 1, "15m+1ms too long");

// The error text must state the ACTUAL value, not just the rule
const long = validateReel({ ...ok, duration_ms: 964_000 }, MB, "video/mp4");
assert.match(long.errors[0], /16m04s/, `error should name the real duration, got: ${long.errors[0]}`);
assert.match(long.errors[0], /15 minutes/, "error should name the limit");

// File size — 300MB, inclusive
assert.deepEqual(validateReel(ok, 300 * MB, "video/mp4").errors, [], "300MB ok");
assert.equal(validateReel(ok, 300 * MB + 1, "video/mp4").errors.length, 1, "over 300MB refused");
assert.match(validateReel(ok, 512 * MB, "video/mp4").errors[0], /512(\.0)?\s?MB/, "names the real size");

// MIME
assert.equal(validateReel(ok, MB, "video/x-matroska").errors.length, 1, "mkv refused");

// Horizontal pixel cap
assert.equal(validateReel({ ...ok, width: 3840, height: 2160 }, MB, "video/mp4").errors.length, 1, "4K width refused");

// Aspect ratio WARNS, never refuses (Decision 4) — Instagram accepts and letterboxes it
const landscape = validateReel({ ...ok, width: 1920, height: 1080 }, MB, "video/mp4");
assert.deepEqual(landscape.errors, [], "landscape must NOT be refused");
assert.equal(landscape.warnings.length, 1, "landscape must warn");
assert.match(landscape.warnings[0], /letterbox/i);

// Silent video warns too
const silent = validateReel({ ...ok, has_audio: false }, MB, "video/mp4");
assert.deepEqual(silent.errors, []);
assert.match(silent.warnings.join(" "), /no audio/i);

// Multiple problems are ALL reported, not just the first
const bad = validateReel({ ...ok, duration_ms: 1_000, width: 3840 }, 400 * MB, "video/mp4");
assert.equal(bad.errors.length, 3, `expected 3 errors, got ${bad.errors.length}: ${bad.errors}`);

assert.equal(REEL_SPEC.maxBytes, 300 * MB);
assert.equal(REEL_SPEC.maxDurationMs, 900_000);

console.log("OK — reel spec validator enforces verified limits, warns on ratio/audio");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/test-video-spec.mjs
```

Expected: FAIL — `Cannot find module '../lib/video-spec.ts'`

- [ ] **Step 3: Write the validator**

Create `dashboard/lib/video-spec.ts`:

```typescript
/**
 * Instagram Reels publishing limits, re-verified against Meta's IG User Media reference
 * on 2026-07-28 (the `#reels-specs` section).
 *
 * These numbers contradict widely-circulated third-party "2026 guides" that claim a 4GB
 * cap and a 90-second maximum. Both are wrong. Do not "correct" these from memory —
 * re-read the live docs if they look surprising.
 */
import type { VideoMeta } from "./video-meta";

const MB = 1024 * 1024;

export const REEL_SPEC = {
  maxBytes: 300 * MB,
  minDurationMs: 3_000,
  maxDurationMs: 15 * 60 * 1000,
  maxWidth: 1920,
  // Instagram accepts 0.01:1 to 10:1. We warn — not refuse — outside a sensible vertical
  // band, because a landscape Reel is a valid post that simply letterboxes (Decision 4).
  warnBelowRatio: 0.5,   // width/height; 9:16 is 0.5625
  warnAboveRatio: 0.8,
} as const;

export const REEL_MIME_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export interface ReelCheck {
  errors: string[];
  warnings: string[];
}

function humanDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${(ms / 1000).toFixed(1)}s`;
}

function humanBytes(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Check a video against the Reels spec. Every problem is reported, not just the first —
 * being told "too long" then "too big" then "too wide" across three upload attempts is a
 * miserable way to find out.
 */
export function validateReel(meta: VideoMeta, byteSize: number, mime: string): ReelCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!REEL_MIME_TYPES[mime]) {
    errors.push(
      `Reels must be MP4 or MOV. This file is ${mime || "of an unknown type"}.`
    );
  }
  if (byteSize > REEL_SPEC.maxBytes) {
    errors.push(
      `This file is ${humanBytes(byteSize)}. Instagram caps Reels at 300 MB. ` +
        `Export it at a lower quality, or trim it.`
    );
  }
  if (meta.duration_ms < REEL_SPEC.minDurationMs) {
    errors.push(
      `This is ${humanDuration(meta.duration_ms)}. Reels must be at least 3 seconds.`
    );
  }
  if (meta.duration_ms > REEL_SPEC.maxDurationMs) {
    errors.push(
      `This is ${humanDuration(meta.duration_ms)}. Reels cap at 15 minutes. ` +
        `Trim it in Photos and upload again.`
    );
  }
  if (meta.width > REEL_SPEC.maxWidth) {
    errors.push(
      `This video is ${meta.width} pixels wide. Instagram caps Reels at 1920. ` +
        `Export it at 1080p and upload again.`
    );
  }

  const ratio = meta.width / meta.height;
  if (ratio < REEL_SPEC.warnBelowRatio || ratio > REEL_SPEC.warnAboveRatio) {
    warnings.push(
      `This video is ${meta.width}×${meta.height}. Reels are vertical (9:16), so this ` +
        `will letterbox — Instagram will still publish it.`
    );
  }
  if (!meta.has_audio) {
    warnings.push("This video has no audio track.");
  }

  return { errors, warnings };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/test-video-spec.mjs
```

Expected: `OK — reel spec validator enforces verified limits, warns on ratio/audio`

- [ ] **Step 5: Typecheck and commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit && git add dashboard/lib/video-spec.ts dashboard/scripts/test-video-spec.mjs && git commit -m "feat(dashboard): Reels spec validator (verified limits; ratio warns, never refuses)"
```

---

### Task 4: Accept video on upload, and serve it back

**Files:**
- Modify: `dashboard/app/api/assets/upload/route.ts` (whole flow), `dashboard/app/api/media/[id]/route.ts:9-14` (`MIME_BY_EXT`)
- Test: `dashboard/scripts/smoke-video-upload.mjs` (create)

**Interfaces:**
- Consumes: `readVideoMeta` / `VideoParseError` (Task 2), `validateReel` / `REEL_MIME_TYPES` (Task 3), the extended `InsertAssetInput` (Task 1).
- Produces: `POST /api/assets/upload` accepts video and returns `{ asset, deduped, warnings? }`; refuses with `{ error }` + status 415 (wrong type) or 422 (fails spec).

- [ ] **Step 1: Extend the media route's MIME map**

This is small but load-bearing: without it a video is served as `application/octet-stream`, so the browser **downloads** it instead of playing it, and the Task 8 cover scrubber cannot work at all.

In `dashboard/app/api/media/[id]/route.ts`, replace the `MIME_BY_EXT` map:

```typescript
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
};
```

- [ ] **Step 2: Rewrite the upload route to branch on kind**

Replace the top of `dashboard/app/api/assets/upload/route.ts` (imports and `EXT_BY_MIME`):

```typescript
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "@/lib/config";
import { getAssetByHash, upsertAssetByHash } from "@/lib/queries";
import { conformImage } from "@/lib/conform";
import { readVideoMeta, VideoParseError } from "@/lib/video-meta";
import { validateReel, REEL_MIME_TYPES } from "@/lib/video-spec";

export const runtime = "nodejs";

const THUMB_MAX = 480;
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
```

Then replace the type check (currently lines 25-32) with:

```typescript
  const mime = file.type;
  const imageExt = IMAGE_EXT_BY_MIME[mime];
  const videoExt = REEL_MIME_TYPES[mime];
  if (!imageExt && !videoExt) {
    return NextResponse.json(
      { error: "Only JPEG, PNG or WebP images, and MP4 or MOV video, are supported." },
      { status: 415 }
    );
  }
  const ext = imageExt ?? videoExt;
  const isVideo = Boolean(videoExt);
```

Then, immediately after the dedup early-return (currently line 40), insert the video branch. **Validation happens before anything is written to disk**, so a refused upload leaves no orphan file:

```typescript
  // ---- Video: validate, never process ------------------------------------------
  // No transcoding by design (see the design spec, Decision 1) — we check the file
  // against Instagram's Reels spec and refuse with a specific reason if it can't be
  // published, rather than silently rewriting the owner's footage.
  if (isVideo) {
    let meta;
    try {
      meta = readVideoMeta(buf);
    } catch (err) {
      if (err instanceof VideoParseError) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
      throw err;
    }
    const check = validateReel(meta, buf.length, mime);
    if (check.errors.length > 0) {
      return NextResponse.json({ error: check.errors.join(" ") }, { status: 422 });
    }

    const storageRel = `${hash}.${ext}`;
    await fs.mkdir(config.assetStorageDir, { recursive: true });
    await fs.writeFile(path.join(config.assetStorageDir, storageRel), buf);

    const { asset, deduped } = upsertAssetByHash({
      content_hash: hash,
      media_kind: "video",
      original_filename: file.name || null,
      storage_path: storageRel,
      public_url: config.publicAssetBaseUrl
        ? `${config.publicAssetBaseUrl.replace(/\/$/, "")}/${storageRel}`
        : null,
      // No thumbnail file: sharp cannot read video and ffmpeg is deliberately not a
      // dependency. Surfaces render a <video> element instead (design spec, Components).
      thumbnail_path: null,
      mime_type: mime,
      width: meta.width,
      height: meta.height,
      byte_size: buf.length,
      // No conform derivative — publish_path stays NULL, so the worker's existing
      // _resolve_url precedence falls through to storage_path with no worker change.
      publish_path: null,
      duration_ms: meta.duration_ms,
      has_audio: meta.has_audio ? 1 : 0,
    });
    return NextResponse.json({ asset, deduped, warnings: check.warnings });
  }
```

Leave the entire existing image path below this untouched.

- [ ] **Step 3: Write the smoke test**

Create `dashboard/scripts/smoke-video-upload.mjs`, modelled on `dashboard/scripts/smoke-post-now.mjs` — **read that file first** and follow its scratch-DB and server setup exactly. Cover:

1. A synthetic valid MP4 (reuse the `file()` builder from `scripts/test-video-meta.mjs` — import it or copy it) → **200**, `asset.media_kind === "video"`, `duration_ms` populated, `thumbnail_path === null`, `publish_path === null`.
2. The same bytes uploaded twice → second returns `deduped: true` and creates no second row (content-hash dedup must work identically for video).
3. A 20-second landscape video → **200** with a non-empty `warnings` array mentioning letterboxing.
4. A 2-second video → **422**, error names "3 seconds".
5. `text/plain` → **415**.
6. Garbage bytes with a `video/mp4` type → **422**, and **no file is left in the asset store** (assert the directory listing is unchanged).
7. **Regression:** a JPEG upload still returns `media_kind === "image"` with a thumbnail and a `publish_path`.

- [ ] **Step 4: Run it**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/smoke-video-upload.mjs
```

Expected: all seven scenarios pass.

- [ ] **Step 5: Typecheck and commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit && git add dashboard/app/api/assets/upload/route.ts dashboard/app/api/media/\[id\]/route.ts dashboard/scripts/smoke-video-upload.mjs && git commit -m "feat(dashboard): accept MP4/MOV uploads, validated against the Reels spec"
```

---

### Task 5: Worker — video container + Reels poll budget

**Files:**
- Modify: `worker/graph_api.py` (after `create_carousel_container`), `worker/config.py:72-74` and its loader (~line 129), `.env.example`
- Test: `worker/tests/test_reels_publish.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `GraphAPIClient.create_video_container(ig_user_id: str, video_url: str, token: str, caption: str | None = None, thumb_offset: int | None = None) -> str`; `Config.reels_status_poll_interval: int = 10`, `Config.reels_status_poll_max_tries: int = 90`.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_reels_publish.py`. **Read `worker/tests/test_platform_dispatch.py` first** for the fake-client style used throughout this suite.

```python
"""Reels publishing: container creation, cover offset, and the longer poll budget."""
import pytest

from worker.graph_api import GraphAPIClient


class _FakeSession:
    def __init__(self, response):
        self.response = response
        self.posts = []

    def post(self, url, data=None, timeout=None, **kw):
        self.posts.append((url, data))
        return self.response


class _Resp:
    ok = True
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def _client(payload):
    c = GraphAPIClient(base_url="https://graph.facebook.com", version="v25.0")
    c.session = _FakeSession(_Resp(payload))
    return c


def test_create_video_container_sends_reels_media_type():
    c = _client({"id": "CONTAINER1"})
    got = c.create_video_container("IG1", "https://x/v.mp4", "TOKEN", caption="hi")
    assert got == "CONTAINER1"
    url, data = c.session.posts[0]
    assert url.endswith("/IG1/media")
    assert data["media_type"] == "REELS"
    assert data["video_url"] == "https://x/v.mp4"
    assert data["caption"] == "hi"
    # Not chosen -> not sent at all, so Meta applies its own default (frame 0).
    assert "thumb_offset" not in data


def test_create_video_container_sends_thumb_offset_when_given():
    c = _client({"id": "C2"})
    c.create_video_container("IG1", "https://x/v.mp4", "TOKEN", thumb_offset=2400)
    _, data = c.session.posts[0]
    assert data["thumb_offset"] == 2400


def test_thumb_offset_zero_is_sent_not_dropped():
    """0 is a legitimate explicit choice (the first frame) and must survive the
    falsy check that `if thumb_offset:` would get wrong."""
    c = _client({"id": "C3"})
    c.create_video_container("IG1", "https://x/v.mp4", "TOKEN", thumb_offset=0)
    _, data = c.session.posts[0]
    assert data["thumb_offset"] == 0


def test_reels_poll_budget_is_longer_than_the_image_budget():
    from worker.config import Config
    import inspect

    sig = inspect.signature(Config)
    interval = sig.parameters["reels_status_poll_interval"].default
    tries = sig.parameters["reels_status_poll_max_tries"].default
    assert interval * tries >= 900, "Reels need at least a 15-minute ceiling"
    image_budget = (
        sig.parameters["status_poll_interval"].default
        * sig.parameters["status_poll_max_tries"].default
    )
    assert interval * tries > image_budget
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests/test_reels_publish.py -q
```

Expected: FAIL — `AttributeError: 'GraphAPIClient' object has no attribute 'create_video_container'`

- [ ] **Step 3: Add the container method**

In `worker/graph_api.py`, directly after `create_carousel_container`:

```python
    def create_video_container(
        self,
        ig_user_id: str,
        video_url: str,
        token: str,
        caption: str | None = None,
        thumb_offset: int | None = None,
    ) -> str:
        """Create a REELS container. Meta downloads video_url server-side, transcodes it,
        and the container is not publishable until its status_code reaches FINISHED —
        which for video takes far longer than for an image (see the Reels poll budget).

        thumb_offset is a MILLISECOND offset; Meta extracts that frame as the cover, so
        we never generate or upload a cover image. Meta's documented default is 0 (the
        first frame) when the field is absent.
        """
        data = {
            "media_type": "REELS",
            "video_url": video_url,
            "access_token": token,
        }
        if caption:
            data["caption"] = caption
        # Explicitly `is not None`: 0 means "the first frame, deliberately chosen", and a
        # truthiness check would silently drop it.
        if thumb_offset is not None:
            data["thumb_offset"] = thumb_offset
        return self._post(f"{ig_user_id}/media", data)["id"]
```

- [ ] **Step 4: Add the Reels poll budget**

In `worker/config.py`, after `status_poll_max_tries: int = 60`:

```python
    # Reels poll separately from images: Meta transcodes video server-side, which takes
    # far longer than an image container. 10s x 90 = a 15-minute ceiling, matching the
    # maximum Reel length. This is a considered guess, not a published figure — Meta
    # gives no transcode SLA. Revise from real observations.
    reels_status_poll_interval: int = 10
    reels_status_poll_max_tries: int = 90
```

In the loader (alongside `tunnel_startup_timeout` around line 142):

```python
            reels_status_poll_interval=int(os.environ.get("REELS_STATUS_POLL_INTERVAL", "10")),
            reels_status_poll_max_tries=int(os.environ.get("REELS_STATUS_POLL_MAX_TRIES", "90")),
```

In `.env.example`, near the other worker timings:

```bash
# How long to wait for Instagram to finish transcoding a Reel before giving up and
# retrying on a later cycle. 10s x 90 = 15 minutes. Raise if long Reels time out.
# REELS_STATUS_POLL_INTERVAL=10
# REELS_STATUS_POLL_MAX_TRIES=90
```

- [ ] **Step 5: Run the tests**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests/test_reels_publish.py -q && .venv/bin/python -m pytest worker/tests -q
```

Expected: 4 passed, then the full suite at **328 passed**.

- [ ] **Step 6: Commit**

```bash
git add worker/graph_api.py worker/config.py worker/tests/test_reels_publish.py .env.example && git commit -m "feat(worker): REELS video container + a longer Reels-specific poll budget"
```

---

### Task 6: Worker — publish a Reel

**Files:**
- Modify: `worker/publisher.py:26` (`SUPPORTED_POST_TYPES`), `:144` region (shape rules), `_build_plan` (~`:195-218`), and `_publish_instagram` (~`:286-293`); add `_publish_reel`
- Test: `worker/tests/test_reels_publish.py` (extend)

**Interfaces:**
- Consumes: `create_video_container` and `reels_status_poll_*` from Task 5; `assets.cover_frame_ms` from Task 1.
- Produces: `post_type='reel'` is publishable on Instagram; the plan dict gains a `"cover_frame_ms": int | None` key.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_reels_publish.py`:

```python
from worker import publisher


def test_reel_is_an_allowed_post_type():
    assert "reel" in publisher.SUPPORTED_POST_TYPES


def test_reel_needs_exactly_one_video_asset():
    post = {"post_type": "reel", "first_comment": None}
    caps_ok = [{"id": 1, "media_kind": "video", "storage_path": "a.mp4"}]
    # one video: fine
    publisher._validate(post, caps_ok, True, "https://x", "instagram", caption="hi")

    # two assets: refused
    with pytest.raises(publisher._NonRetryable, match="exactly 1"):
        publisher._validate(post, caps_ok * 2, True, "https://x", "instagram", caption="hi")

    # an IMAGE asset: refused. This is the guard that stops a mis-typed post from
    # sending a JPEG to the REELS endpoint.
    with pytest.raises(publisher._NonRetryable, match="video"):
        publisher._validate(
            post,
            [{"id": 1, "media_kind": "image", "storage_path": "a.jpg"}],
            True, "https://x", "instagram", caption="hi",
        )


@pytest.mark.parametrize("platform", ["facebook", "threads", "discord", "telegram"])
def test_reel_fails_terminally_on_every_other_platform(platform):
    """No platform except Instagram publishes Reels. Each must refuse TERMINALLY with a
    clear message — never retry forever, never silently drop the video."""
    plan = {"platform": platform, "post_type": "reel", "account_id": "X",
            "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
            "caption": "hi", "cover_frame_ms": None}
    with pytest.raises(publisher._NonRetryable, match="reel"):
        publisher._PUBLISHERS[platform](object(), plan, "TOKEN", object(), lambda _: None)


def test_publish_reel_passes_cover_offset_and_uses_the_reels_budget():
    calls = {}

    class _C:
        def create_video_container(self, ig, url, token, caption=None, thumb_offset=None):
            calls["container"] = (ig, url, caption, thumb_offset)
            return "CONT"

        def get_container_status(self, cid, token):
            calls.setdefault("polls", 0)
            calls["polls"] += 1
            return "FINISHED"

        def publish_container(self, ig, cid, token):
            calls["published"] = (ig, cid)
            return "MEDIA123"

    class _Cfg:
        status_poll_interval = 5
        status_poll_max_tries = 60
        reels_status_poll_interval = 10
        reels_status_poll_max_tries = 90

    plan = {"platform": "instagram", "post_type": "reel", "account_id": "IG1",
            "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
            "caption": "hello", "cover_frame_ms": 2400}
    got = publisher._publish_instagram(_C(), plan, "TOKEN", _Cfg(), lambda _: None)

    assert got == "MEDIA123"
    assert calls["container"] == ("IG1", "https://x/v.mp4", "hello", 2400)
    assert calls["published"] == ("IG1", "CONT")


def test_reel_poll_exhaustion_is_retryable_not_terminal():
    """A container still transcoding must come back on the next cycle, not burn the post."""
    class _C:
        def create_video_container(self, *a, **kw):
            return "CONT"

        def get_container_status(self, cid, token):
            return "IN_PROGRESS"

        def publish_container(self, *a):
            raise AssertionError("must not publish an unfinished container")

    class _Cfg:
        status_poll_interval = 0
        status_poll_max_tries = 1
        reels_status_poll_interval = 0
        reels_status_poll_max_tries = 2

    plan = {"platform": "instagram", "post_type": "reel", "account_id": "IG1",
            "asset_urls": ["https://x/v.mp4"], "asset_paths": [None],
            "caption": None, "cover_frame_ms": None}
    with pytest.raises(RuntimeError) as exc:
        publisher._publish_instagram(_C(), plan, "TOKEN", _Cfg(), lambda _: None)
    # RuntimeError (not _NonRetryable) is what publish_one treats as retryable.
    assert not isinstance(exc.value, publisher._NonRetryable)
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests/test_reels_publish.py -q
```

Expected: FAIL — `'reel' not in SUPPORTED_POST_TYPES`.

- [ ] **Step 3: Allow the post type and add the shape rule**

In `worker/publisher.py`, line 26:

```python
SUPPORTED_POST_TYPES = ("single", "carousel", "text", "reel")
```

In `_validate`, immediately after the `single` rule:

```python
    if post_type == "reel":
        if len(assets) != 1:
            raise _NonRetryable(f"a reel needs exactly 1 asset, has {len(assets)}")
        if assets[0]["media_kind"] != "video":
            raise _NonRetryable(
                f"a reel needs a video asset, got media_kind='{assets[0]['media_kind']}'"
            )
```

- [ ] **Step 4: Carry the cover offset into the plan**

In `_build_plan`, add to the returned dict (after `"post_type"`):

```python
        # The chosen cover frame travels with the plan so dry-run shows it too. It lives
        # on the ASSET, so a recycled evergreen video reuses the same choice.
        #
        # The `in .keys()` guard mirrors _resolve_url's handling of publish_path: many
        # existing tests build asset fixtures as plain dicts without this column, and a
        # bare assets[0]["cover_frame_ms"] would KeyError on every one of them.
        "cover_frame_ms": (
            assets[0]["cover_frame_ms"]
            if assets and "cover_frame_ms" in assets[0].keys()
            else None
        ),
```

`.keys()` works for both `sqlite3.Row` and `dict`, which is why the existing code uses it.

- [ ] **Step 5: Add the publish path**

In `worker/publisher.py`, after `_publish_carousel`:

```python
def _publish_reel(client, plan, token, config, sleep_fn) -> str:
    """Reels use the same container -> poll -> publish shape as an image, with two
    differences: media_type=REELS with a video_url, and a much longer poll budget
    because Meta transcodes the video server-side before the container is publishable.
    """
    ig = plan["account_id"]
    container = client.create_video_container(
        ig,
        plan["asset_urls"][0],
        token,
        caption=plan["caption"],
        thumb_offset=plan.get("cover_frame_ms"),
    )
    _poll_until_finished(
        client, container, token, config, sleep_fn,
        interval=config.reels_status_poll_interval,
        max_tries=config.reels_status_poll_max_tries,
    )
    return client.publish_container(ig, container, token)
```

Give `_poll_until_finished` the two optional overrides, defaulting to today's behaviour so every existing caller is untouched:

```python
def _poll_until_finished(client, container_id, token, config, sleep_fn, status_fn=None,
                         interval=None, max_tries=None) -> None:
    """Poll a container's status_code until FINISHED. Small images are usually ready
    immediately; carousels/video need this. ERROR/EXPIRED are terminal failures.

    status_fn lets other platforms reuse this same poll loop against their own status
    call (e.g. Threads' get_threads_container_status, whose field is named `status`
    rather than Instagram's `status_code`) without duplicating the loop.

    interval/max_tries let Reels poll on their own, longer budget without a second loop.
    """
    status_fn = status_fn or client.get_container_status
    interval = config.status_poll_interval if interval is None else interval
    max_tries = config.status_poll_max_tries if max_tries is None else max_tries
    for _ in range(max_tries):
        status = status_fn(container_id, token)
        if status == "FINISHED":
            return
        if status in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"container {container_id} status={status}")
        sleep_fn(interval)
    raise RuntimeError(f"container {container_id} not FINISHED after polling")
```

Add the arm to `_publish_instagram`:

```python
def _publish_instagram(client, plan, token, config, sleep_fn) -> str:
    post_type = plan["post_type"]
    if post_type == "single":
        return _publish_single(client, plan, token, config, sleep_fn)
    elif post_type == "carousel":
        return _publish_carousel(client, plan, token, config, sleep_fn)
    elif post_type == "reel":
        return _publish_reel(client, plan, token, config, sleep_fn)
    else:
        raise _NonRetryable(f"instagram adapter has no publish path for post_type '{post_type}'")
```

**Every other platform needs no change** — their existing `else: raise _NonRetryable(...)` already refuses a reel terminally with a clear message, which is what the parametrized test above pins.

- [ ] **Step 6: Run the full suite**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests -q
```

Expected: **333 passed**. If any pre-existing test fails, the `_poll_until_finished` signature change is the first suspect — its defaults must preserve today's behaviour exactly.

- [ ] **Step 7: Commit**

```bash
git add worker/publisher.py worker/tests/test_reels_publish.py && git commit -m "feat(worker): publish Instagram Reels with a chosen cover frame"
```

---

### Task 7: Live verification — the moov-atom gate

**Files:** none (verification only).

**Why here, and not at the end.** Meta's spec requires *"moov atom at the front of the file,"* and iPhone video often has it at the end. If Meta enforces that, real footage will be rejected and the no-ffmpeg decision (Decision 1) needs revisiting. **Finding that out now costs one test post; finding it out after the UI is built wastes the UI work.** Everything needed to publish a Reel exists as of Task 6 — the cover picker (Task 8) is not required, since `cover_frame_ms` may simply be NULL.

**This task requires the owner.** Do not flip `DRY_RUN` without them present.

- [ ] **Step 1: Dry-run first**

Upload a real iPhone video through the dashboard, create a `reel` post targeting the owner's Instagram channel (via the API directly if the composer doesn't offer it yet — Task 9 adds that), and run:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m worker.run --once
```

Expected: the logged plan reports `post_type='reel'`, the video's local marker, and `cover_frame_ms`. Nothing is published. Confirm `DRY_RUN=1` is still set.

- [ ] **Step 2: Record the moov position of the real file**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && python3 -c "
import sys
p = sys.argv[1]
data = open(p,'rb').read()
i = data.find(b'moov'); j = data.find(b'mdat')
print(f'moov at {i}, mdat at {j} -> moov is {\"FIRST\" if 0 <= i < j else \"LAST\"}')
" data/assets/<hash>.mov
```

Record the answer. If `LAST`, the next step is the real test of the risk.

- [ ] **Step 3: One real post, owner present**

Set `DRY_RUN=0` in `.env`, run **exactly one** cycle, then restore `DRY_RUN=1` immediately:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m worker.run --once
```

- [ ] **Step 4: Read the result back from the API, not from our DB**

Confirm the Reel exists on Instagram, note the media id and permalink, and record **how long the container took to reach FINISHED** — that is the evidence for whether the 15-minute budget in Task 5 is right.

- [ ] **Step 5: Record the outcome**

Add the verified facts to `reference.md` (media id, permalink, transcode duration, moov position, and whether it published). If it **failed** on the container spec, **stop and report** — do not proceed to Task 8. The remedy is a lossless remux (`ffmpeg -c copy -movflags +faststart`), which is a change to Decision 1 and needs the owner's agreement before any code is written.

```bash
git add reference.md && git commit -m "docs: record the first real Reel publish (moov position, transcode time)"
```

---

### Task 8: Cover frame picker

**Files:**
- Create: `dashboard/app/api/assets/[id]/cover/route.ts`, `dashboard/components/cover-frame-picker.tsx`
- Modify: `dashboard/lib/queries.ts` (add `updateAssetCoverFrame`)
- Test: `dashboard/scripts/smoke-cover-frame.mjs` (create)

**Interfaces:**
- Consumes: `assets.cover_frame_ms` and `duration_ms` (Task 1); `GET /api/media/[id]` serving `video/*` (Task 4).
- Produces: `POST /api/assets/[id]/cover` with body `{ cover_frame_ms: number }` → `{ asset }`; `<CoverFramePicker asset={asset} />`.

- [ ] **Step 1: Add the query**

In `dashboard/lib/queries.ts`, beside `updateAssetConform`:

```typescript
/** Persist the chosen cover frame. Assets have no updated_at column. */
export function updateAssetCoverFrame(id: number, coverFrameMs: number): void {
  getDb()
    .prepare("UPDATE assets SET cover_frame_ms = ? WHERE id = ?")
    .run(coverFrameMs, id);
}
```

- [ ] **Step 2: Write the route**

Create `dashboard/app/api/assets/[id]/cover/route.ts`. **Read `dashboard/app/api/assets/[id]/conform/route.ts` first** and mirror its shape, guards and error style:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAsset, updateAssetCoverFrame } from "@/lib/queries";

export const runtime = "nodejs";

/** Choose which frame of a video is its cover. Stored as a millisecond offset and sent
 *  to Instagram as thumb_offset — no cover image is generated. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  if (asset.media_kind !== "video") {
    return NextResponse.json(
      { error: "Only a video has a cover frame." },
      { status: 409 }
    );
  }

  const body = await req.json().catch(() => null);
  const ms = body?.cover_frame_ms;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0) {
    return NextResponse.json(
      { error: "cover_frame_ms must be a non-negative integer (milliseconds)." },
      { status: 400 }
    );
  }
  // Bound against the asset's own duration. Instagram silently falls back to frame 0 for
  // an out-of-range offset, so an unchecked value would look saved but do nothing.
  if (asset.duration_ms !== null && ms > asset.duration_ms) {
    return NextResponse.json(
      {
        error: `That frame is past the end of the video (${(asset.duration_ms / 1000).toFixed(1)}s).`,
      },
      { status: 400 }
    );
  }

  updateAssetCoverFrame(asset.id, ms);
  return NextResponse.json({ asset: getAsset(asset.id) });
}
```

- [ ] **Step 3: Write the picker component**

Create `dashboard/components/cover-frame-picker.tsx`. **Read `dashboard/components/conform-control.tsx` first** and match its visual language — badge, control row, muted helper text, and its save/pending pattern:

```tsx
"use client";

import { useRef, useState } from "react";
import type { Asset } from "@/lib/types";

/** Pick which frame of a video becomes its cover.
 *
 *  What is stored is a single millisecond offset — Instagram extracts the frame itself
 *  via thumb_offset, so nothing is uploaded. The <video> here is preview only.
 *  Because the choice lives on the asset, a recycled evergreen video reuses it. */
export function CoverFramePicker({ asset }: { asset: Asset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ms, setMs] = useState(asset.cover_frame_ms ?? 0);
  const [saved, setSaved] = useState(asset.cover_frame_ms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = asset.duration_ms ?? 0;
  const dirty = saved !== ms;

  function scrub(next: number) {
    setMs(next);
    if (videoRef.current) videoRef.current.currentTime = next / 1000;
  }

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/assets/${asset.id}/cover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cover_frame_ms: ms }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({})))?.error ?? "Could not save the cover frame.");
      return;
    }
    setSaved(ms);
  }

  return (
    <div className="space-y-2">
      <video
        ref={videoRef}
        src={`/api/media/${asset.id}`}
        preload="metadata"
        muted
        playsInline
        className="w-full max-w-xs rounded-md border border-border"
        onLoadedMetadata={(e) => {
          e.currentTarget.currentTime = ms / 1000;
        }}
      />
      <label className="block text-sm font-medium">
        Cover frame
        <input
          type="range"
          min={0}
          max={duration}
          step={100}
          value={ms}
          onChange={(e) => scrub(Number(e.target.value))}
          className="mt-1 w-full max-w-xs"
          aria-label="Cover frame position in the video"
        />
      </label>
      <p className="text-xs text-muted">
        {(ms / 1000).toFixed(1)}s of {(duration / 1000).toFixed(1)}s
        {saved === null && " — not chosen yet, Instagram would use the first frame"}
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
      <button
        type="button"
        onClick={save}
        disabled={busy || !dirty}
        className="rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50"
      >
        {busy ? "Saving…" : dirty ? "Save cover frame" : "Saved"}
      </button>
    </div>
  );
}
```

Check the exact utility class names against `conform-control.tsx` — this codebase uses theme tokens (`text-muted`, `border-border`), and inventing new ones would break the 14 palettes.

- [ ] **Step 4: Write the smoke test**

Create `dashboard/scripts/smoke-cover-frame.mjs` following `smoke-post-now.mjs`'s scratch-DB setup. Cover: a valid save persists and round-trips; `cover_frame_ms: 0` is accepted (explicitly choosing the first frame is not the same as "unset"); a value past `duration_ms` → 400; a negative or non-integer → 400; an **image** asset → 409; an unknown id → 404.

- [ ] **Step 5: Run it, typecheck, commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/smoke-cover-frame.mjs && npx tsc --noEmit
```

```bash
git add dashboard/app/api/assets/\[id\]/cover/route.ts dashboard/components/cover-frame-picker.tsx dashboard/lib/queries.ts dashboard/scripts/smoke-cover-frame.mjs && git commit -m "feat(dashboard): cover frame picker (stores a millisecond offset, not an image)"
```

---

### Task 9: Composer — create a Reel

**Files:**
- Modify: `dashboard/lib/platforms.ts` (add `supportsVideo` to every entry), `dashboard/components/composer.tsx:337` (file input) and its channel-gating logic, `dashboard/app/api/posts/route.ts:49` and `dashboard/app/api/posts/draft/route.ts:59` (post_type derivation), `dashboard/components/post-editor.tsx` (show the picker)
- Test: `dashboard/scripts/smoke-reel-post.mjs` (create)

**Interfaces:**
- Consumes: everything above.
- Produces: a composer that creates `post_type='reel'` posts and offers only video-capable channels.

- [ ] **Step 1: Add the capability flag**

In `dashboard/lib/platforms.ts`, add `supportsVideo: boolean` to the entry type and set it — `true` for `instagram` only; `false` for `facebook`, `threads`, `discord`, `telegram`.

**This file hand-mirrors the worker's `PLATFORM_CAPS` and has no assert guarding it** (unlike the nine worker registries, which fail at import time). Add a comment beside the new field pointing at `worker/publisher.py`'s `_publish_instagram` as the authority.

- [ ] **Step 2: Derive the post type from the asset kind**

In `dashboard/app/api/posts/route.ts` (line 49) and `dashboard/app/api/posts/draft/route.ts` (line 59), the post type is derived from asset count alone:

```typescript
const postType: PostType = isText ? "text" : assetIds.length > 1 ? "carousel" : "single";
```

**Neither route currently loads the assets at all** — only the channels (`const channels = channelIds.map((cid) => getChannel(cid))`). So the asset lookup has to be added, mirroring that exact pattern. Insert this immediately *before* the `postType` line, and add `getAsset` to the existing `@/lib/queries` import:

```typescript
  // Load the assets so post_type can reflect what they ACTUALLY are, not just how many
  // there are. Mirrors the channel lookup directly above.
  const postAssets = assetIds.map((aid) => getAsset(aid));
  const unknownAssetIdx = postAssets.findIndex((a) => !a);
  if (unknownAssetIdx !== -1) {
    return NextResponse.json(
      { error: `Unknown asset ${assetIds[unknownAssetIdx]}.` },
      { status: 400 }
    );
  }
  const chosenAssets = postAssets.map((a) => a!);

  // No platform publishes a carousel containing video. Caught here so it fails at
  // compose time with a clear reason, rather than terminally in the worker later.
  if (!isText && chosenAssets.length > 1 && chosenAssets.some((a) => a.media_kind === "video")) {
    return NextResponse.json(
      { error: "A carousel can only contain images. Post a video as its own Reel." },
      { status: 400 }
    );
  }
```

Then replace the `postType` line itself:

```typescript
  // A single VIDEO asset is a reel, not a "single". Everything else is unchanged.
  const isReel =
    !isText && chosenAssets.length === 1 && chosenAssets[0].media_kind === "video";
  const postType: PostType = isText
    ? "text"
    : isReel
      ? "reel"
      : assetIds.length > 1
        ? "carousel"
        : "single";
```

Note this adds unknown-asset validation the routes did not have. That is a genuine improvement (an unknown asset id currently produces a post with a dangling `post_assets` row), but it is **new behaviour** — the Task 9 smoke test must cover an unknown asset id returning 400, and you should confirm no existing smoke script depends on the old silent tolerance.

- [ ] **Step 3: Wire the composer**

- Extend the file input's `accept` at `composer.tsx:337` to `image/jpeg,image/png,image/webp,video/mp4,video/quicktime`.
- When the chosen asset is a video, render `<CoverFramePicker>` instead of `<ConformControl>` (a video has no crop/pad decision), and surface any `warnings` the upload returned.
- Disable **and deselect** channels whose platform has `supportsVideo: false`, with the reason shown — mirror exactly how the existing Threads text-only toggle disables channels that can't publish text, so there is one behaviour to learn.
- In `post-editor.tsx`, show `<CoverFramePicker>` for a video asset so an existing Reel's cover can be changed later.

- [ ] **Step 4: Write the smoke test**

Create `dashboard/scripts/smoke-reel-post.mjs`: a single video asset → a post with `post_type === "reel"`; a video + an image together → **400**; a reel targeted at a Threads channel → **400** from the existing platform-compatibility validation; two images still → `"carousel"` (regression).

- [ ] **Step 5: Verify in the browser**

Dev server on port **3939** — reuse it. Confirm: uploading a vertical video shows the cover scrubber and no crop/pad control; scrubbing moves the preview frame; saving persists across a reload; non-Instagram channels are visibly disabled with a reason; a landscape video shows the letterbox warning but is still postable; the composer still behaves identically for images.

**Then delete every row you created through the app's own UI/API** (not raw SQL — foreign keys are off by default in Python's `sqlite3`, and a raw `DELETE FROM posts` has corrupted this database once already). Report row counts before and after, plus `PRAGMA foreign_key_check`.

Save screenshots of the composer with a video selected and of the post editor's cover picker; reference the paths in your report.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit && node scripts/smoke-reel-post.mjs && cd .. && .venv/bin/python -m pytest worker/tests -q
```

```bash
git add dashboard/lib/platforms.ts dashboard/components/composer.tsx dashboard/components/post-editor.tsx dashboard/app/api/posts/route.ts dashboard/app/api/posts/draft/route.ts dashboard/scripts/smoke-reel-post.mjs && git commit -m "feat(dashboard): compose a Reel — video upload, cover picker, channel gating"
```

---

### Task 10: Auto-fill queues Reels; docs

**Files:**
- Modify: `worker/autofill.py:99-101`, `reference.md`, `docs/tasks.md`
- Test: `worker/tests/test_autofill.py` (extend)

**Interfaces:**
- Consumes: `post_type='reel'` posts (Task 9).
- Produces: Reels are eligible for evergreen auto-fill.

- [ ] **Step 1: Write the failing test**

Add to `worker/tests/test_autofill.py`, matching the existing crafted-data style in that file:

```python
def test_reels_are_eligible_for_autofill(tmp_path):
    """Recycling evergreen demo videos is a primary goal. Left out of the candidate
    query, a reel is publishable but never auto-queued — it just silently never
    appears, with no error anywhere."""
    # Build a channel with an open slot and ONE ready evergreen reel, using the same
    # helpers the neighbouring tests use, then:
    picked = autofill.select_candidates(conn, channel, needed=1)
    assert [p["post_type"] for p in picked] == ["reel"]
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests/test_autofill.py -q
```

Expected: FAIL — no candidate returned.

- [ ] **Step 3: Widen the candidate query**

In `worker/autofill.py` (~line 99), add `'reel'` to the `post_type IN (...)` list, keeping the existing `:supports_text` binding intact.

- [ ] **Step 4: Run the full suite**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests -q
```

Expected: all green.

- [ ] **Step 5: Update the docs**

- `reference.md` — a "Reels" section with the **verified** spec table (300 MB, 3s–15min, 0.01:1–10:1, 1920 max width, 23–60 FPS), the `thumb_offset`/`cover_url` precedence rule, and the note that third-party guides claiming 4 GB / 90 seconds are wrong. Include the Task 7 findings (real transcode time, moov position).
- `docs/tasks.md` — add a section for this sub-project in the established style, and tick the Phase 6 "Reels/video" line item. Record what was deferred: Stories, `cover_url` custom covers, video in bulk import, Facebook video, and the `PlatformCaps.post_types` generalisation.

- [ ] **Step 6: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill.py reference.md docs/tasks.md && git commit -m "feat(worker): include Reels in auto-fill; document the verified Reels spec"
```

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: Decision 1 → Tasks 3–4 (validate, never transcode); Decision 2 → Task 2; Decision 3 → Tasks 1, 6, 8; Decision 4 → Task 3 Step 1 (the landscape assertions pin warn-not-refuse); Decision 5 → Task 5; Decision 6 → Task 6 (nothing to build — pinned by the parametrized cross-platform test); Decision 7 → Task 10. Data model → Task 1. Every listed component has a task, including the two the self-review of the spec caught (`media/[id]` MIME map and video preview, both in Task 4). The moov risk → Task 7, deliberately sequenced before the UI work.

**Ordering.** Tasks 1–6 are strictly dependency-ordered. Task 7 is a **gate**: a failure there changes Decision 1 and must stop the plan. Tasks 8–10 assume it passed.

**Known deviation from the spec.** The spec's Components section lists `dashboard/lib/platforms.ts` as needing a video capability flag but does not name the post-type-derivation change in the two post-creation routes, nor the mixed video+image carousel refusal. Both are necessary for a Reel to be creatable at all, and are added in Task 9 Step 2.
