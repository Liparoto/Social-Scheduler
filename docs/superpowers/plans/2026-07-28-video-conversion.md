# Automatic Video Conversion on Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept an out-of-spec video (notably 4K iPhone footage) and automatically produce a derivative Instagram will accept, instead of refusing the upload.

**Architecture:** Mirrors the existing image-conformance pipeline exactly — original stays at `assets.storage_path`, a converted derivative goes to `assets.publish_path`, `conform_mode` records the decision, `needs_review` flags it. The worker needs **no changes**: `_resolve_url` already prefers `publish_path`, and `PlatformCaps.needs_conformed_media` already gives Discord/Telegram the untouched original. Conversion uses macOS's built-in `/usr/bin/avconvert`, falling back to `ffmpeg` if present, and otherwise degrading to today's refusal.

**Tech Stack:** Next.js 16 (App Router, TS), `node:child_process` for the converter. **No new npm or pip dependencies.**

Design spec: `docs/superpowers/specs/2026-07-28-video-conversion-design.md`

## Global Constraints

- **No new dependencies.** The converter is an OS binary probed at runtime, never bundled or installed.
- **No migration.** `assets.conform_mode` has no CHECK constraint, so `'downscale'` is a legal new value. `publish_path` / `needs_review` already exist.
- **The worker must not change.** If you find yourself editing `worker/`, stop and report — the whole point is that `_resolve_url` already handles this.
- **Never modify the live `data/socialscheduler.db`** beyond removing rows you create. Tests use scratch copies via `DATABASE_PATH` (**not** `DB_PATH`) and `ASSET_STORAGE_DIR`. Report counts before/after plus `PRAGMA foreign_key_check`.
- **Never change `DRY_RUN` or `KILL_SWITCH`** in `.env`.
- Validate-then-write: no file written and no row created unless the upload will be usable.
- **The original is always retained** at `storage_path`. Never overwrite or delete the owner's footage.
- Verified Reels limits (do not substitute remembered values): **300 MB**, **3 s – 15 min**, **max 1920 horizontal pixels**, aspect 0.01:1–10:1, MP4/MOV.
- Checks that must pass at the end of every task:
  - `cd dashboard && npx tsc --noEmit`
  - `.venv/bin/python -m pytest worker/tests -q` (**336 passing**, and must stay there)
  - `dashboard/scripts/smoke-*.mjs` (note: `smoke-content-model.mjs` has a **pre-existing unrelated failure** — confirm it is identical before and after your change rather than assuming it is yours)

---

### Task 1: Split validation into fatal versus convertible

**Files:**
- Modify: `dashboard/lib/video-spec.ts`
- Test: `dashboard/scripts/test-video-spec.mjs` (extend)

**Interfaces:**
- Consumes: `VideoMeta` from `dashboard/lib/video-meta.ts`.
- Produces: `classifyReelErrors(meta: VideoMeta, byteSize: number, mime: string): ReelClassification` where `interface ReelClassification { fatal: string[]; convertible: string[]; warnings: string[] }`.

**`validateReel` must keep its exact current signature and behaviour** — it has existing callers and tests. Implement it in terms of the new function so there is one set of rules, not two.

Which bucket each failure goes in (from the design spec, Decision 2):

| Failure | Bucket | Why |
|---|---|---|
| Wider than 1920 px | `convertible` | Downscaling fixes it |
| Larger than 300 MB | `convertible` | Re-encoding fixes it |
| Not MP4/MOV | `convertible` | Remux/re-encode fixes it |
| Longer than 15 min | `fatal` | Trimming is editorial — the app must not choose what to cut |
| Shorter than 3 s | `fatal` | Nothing can add footage |
| Aspect ratio out of band | `warnings` | Unchanged — Instagram accepts and letterboxes |
| No audio track | `warnings` | Unchanged |

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/scripts/test-video-spec.mjs`:

```javascript
import { classifyReelErrors } from "../lib/video-spec.ts";

const ok = { duration_ms: 30_000, width: 1080, height: 1920, has_audio: true };
const MB2 = 1024 * 1024;

// 4K iPhone portrait — the case that motivated this work. Convertible, not fatal.
let c = classifyReelErrors({ ...ok, width: 2160, height: 3840 }, 50 * MB2, "video/quicktime");
assert.deepEqual(c.fatal, [], "4K must NOT be fatal — downscaling fixes it");
assert.equal(c.convertible.length, 1, "4K width must be convertible");
assert.match(c.convertible[0], /2160/, "must name the measured width");

// Oversize is convertible
c = classifyReelErrors(ok, 400 * MB2, "video/mp4");
assert.deepEqual(c.fatal, []);
assert.equal(c.convertible.length, 1);

// Wrong container is convertible
c = classifyReelErrors(ok, MB2, "video/x-matroska");
assert.deepEqual(c.fatal, []);
assert.equal(c.convertible.length, 1);

// Duration is FATAL — conversion cannot honestly fix it
c = classifyReelErrors({ ...ok, duration_ms: 964_000 }, MB2, "video/mp4");
assert.equal(c.fatal.length, 1, "too long must be fatal");
assert.deepEqual(c.convertible, [], "and must not offer conversion");
assert.match(c.fatal[0], /16m04s/, "must name the real duration");

c = classifyReelErrors({ ...ok, duration_ms: 2_000 }, MB2, "video/mp4");
assert.equal(c.fatal.length, 1, "too short must be fatal");

// A 16-minute 4K video has BOTH a fatal problem and convertible ones. The classifier
// reports both honestly; the upload route is what guarantees the fatal check runs first
// so no time is wasted transcoding a video that will be refused for length anyway.
c = classifyReelErrors({ ...ok, duration_ms: 964_000, width: 2160 }, 400 * MB2, "video/mp4");
assert.equal(c.fatal.length, 1, "duration is fatal");
assert.ok(c.convertible.length >= 1, "and the width/size problems are still reported");

// Warnings are unchanged and never block
c = classifyReelErrors({ ...ok, width: 1920, height: 1080, has_audio: false }, MB2, "video/mp4");
assert.deepEqual(c.fatal, []);
assert.deepEqual(c.convertible, []);
assert.equal(c.warnings.length, 2, "landscape + silent both warn");

// A clean video classifies as entirely clean
c = classifyReelErrors(ok, 40 * MB2, "video/mp4");
assert.deepEqual([c.fatal, c.convertible, c.warnings], [[], [], []]);

console.log("OK — classifyReelErrors splits fatal from convertible");
```

Every existing assertion in that file must continue to pass unchanged.

- [ ] **Step 2: Run it, expect failure**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/test-video-spec.mjs
```

Expected: FAIL — `classifyReelErrors` is not exported.

- [ ] **Step 3: Implement**

Add `classifyReelErrors` to `dashboard/lib/video-spec.ts`, moving the existing checks into it and bucketing them per the table above. Then reimplement `validateReel` as a thin wrapper so the rules live in exactly one place:

```typescript
export function validateReel(meta: VideoMeta, byteSize: number, mime: string): ReelCheck {
  const c = classifyReelErrors(meta, byteSize, mime);
  return { errors: [...c.fatal, ...c.convertible], warnings: c.warnings };
}
```

Keep every existing message string byte-identical — tests assert on their text, and they are what the owner reads.

**The classifier applies no cross-suppression.** `fatal` and `convertible` are reported independently — a 16-minute 4K video has both. An earlier draft of this plan had `convertible` come back empty whenever anything was `fatal`, which (a) contradicted an existing test pinning that `validateReel` reports *every* problem rather than just the first, and (b) duplicated a guarantee that belongs in Task 3's route ordering. **The "never transcode a video that will be refused anyway" guarantee lives solely in Task 3's ordering** — checking `fatal` first and returning immediately. There is no second net under it, so Task 3 must get that ordering right.

- [ ] **Step 4: Run tests, expect pass**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/test-video-spec.mjs && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/video-spec.ts dashboard/scripts/test-video-spec.mjs && git commit -m "feat(dashboard): classify Reels failures as fatal vs convertible"
```

---

### Task 2: The converter module

**Files:**
- Create: `dashboard/lib/video-convert.ts`
- Test: `dashboard/scripts/test-video-convert.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `findConverter(override?: string): Converter | null` where `type Converter = "avconvert" | "ffmpeg"`; `convertVideo(inputPath: string, outputPath: string, opts: { converter: Converter; timeoutMs: number }): Promise<void>` — resolves on success, rejects with `ConvertError` (exported) otherwise.

**Converter selection** (design spec, Decision 3), in order: `avconvert` (macOS, always present, preferred) → `ffmpeg` (if on `PATH`) → `null`. An explicit override of `"off"` returns `null`; `"avconvert"`/`"ffmpeg"` force that one. Probe with something cheap that does not depend on a shell (e.g. checking `/usr/bin/avconvert` exists, and running `ffmpeg -version`), and **cache the result** — this is called on every video upload.

**Command lines:**
- `avconvert -s <input> -p Preset1920x1080 -o <output> --replace` — verified working on this Mac; it preserves the aspect ratio (a 2160×3840 portrait becomes 1080×1920, not letterboxed) and writes `moov` at the front.
- `ffmpeg -y -i <input> -vf "scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2" -c:v h264 -c:a aac -movflags +faststart <output>` — fits the video *inside* a 1920x1920 box preserving aspect, which reproduces `avconvert`'s behaviour in **both** orientations (portrait 2160x3840 -> 1080x1920; landscape 3840x2160 -> 1920x1080). `force_divisible_by=2` keeps both dimensions even, which h264 requires. `+faststart` puts `moov` at the front, matching Meta's spec.

  **An earlier draft of this plan used `scale='min(1920,iw)':-2`, which is wrong.** It caps the *width* only, so a portrait 4K video became 1920x3414 — legal under Meta's "max 1920 horizontal pixels" rule but the wrong shape and a needlessly huge file, and materially different from what `avconvert` produces on macOS. The two converters must agree, or a Mac clone and a Windows clone would publish different output from the same source.

Use `execFile` (not `exec`) so arguments are passed as an array and a path containing spaces or quotes cannot be interpreted by a shell. **Paths here are attacker-influenced only via filenames, but the repo's rule is to validate and never interpolate** — pass arguments, never build a command string.

On timeout, kill the process, delete any partial output, and reject.

- [ ] **Step 1: Write the failing test**

Create `dashboard/scripts/test-video-convert.mjs`. It must not depend on a specific machine having `ffmpeg`, so assert on *behaviour under an override* plus a real conversion only when a converter is genuinely available:

```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findConverter, convertVideo, ConvertError } from "../lib/video-convert.ts";
import { readVideoMeta } from "../lib/video-meta.ts";

// "off" must disable conversion entirely, whatever is installed
assert.equal(findConverter("off"), null, "off disables conversion");

// On macOS avconvert is always present
if (process.platform === "darwin") {
  assert.equal(findConverter(), "avconvert", "macOS must find avconvert");
}

// A garbage input must reject with the typed error, not hang or resolve
const conv = findConverter();
if (conv) {
  const bad = path.join(os.tmpdir(), `bad-${process.pid}.mov`);
  const out = path.join(os.tmpdir(), `out-${process.pid}.mov`);
  fs.writeFileSync(bad, Buffer.from("definitely not a video"));
  await assert.rejects(
    () => convertVideo(bad, out, { converter: conv, timeoutMs: 60_000 }),
    ConvertError,
    "garbage input must reject with ConvertError"
  );
  assert.ok(!fs.existsSync(out), "no partial output may be left behind");
  fs.rmSync(bad, { force: true });

  // Real conversion, if the 4K fixture is present on this machine
  const REAL = path.join(os.homedir(), "Downloads", "IMG_3707.MOV");
  if (fs.existsSync(REAL)) {
    const dst = path.join(os.tmpdir(), `conv-${process.pid}.mov`);
    await convertVideo(REAL, dst, { converter: conv, timeoutMs: 300_000 });
    const m = readVideoMeta(fs.readFileSync(dst));
    assert.ok(m.width <= 1920, `converted width must be <=1920, got ${m.width}`);
    assert.equal(m.width, 1080, "2160x3840 must become 1080x1920");
    assert.equal(m.height, 1920);
    // Meta's spec wants moov at the front; conversion should deliver that.
    const b = fs.readFileSync(dst);
    assert.ok(b.indexOf(Buffer.from("moov")) < b.indexOf(Buffer.from("mdat")), "moov must be first");
    fs.rmSync(dst, { force: true });
  } else {
    console.log("  (skipped real-file conversion — IMG_3707.MOV not present)");
  }
}
console.log("OK — converter probe and conversion behave");
```

- [ ] **Step 2: Run it, expect failure** (module does not exist).

- [ ] **Step 3: Implement `dashboard/lib/video-convert.ts`** per the interfaces and command lines above. Keep it pure of database and HTTP concerns — it takes paths and returns nothing.

- [ ] **Step 4: Run it, expect pass.** Note the real-file conversion takes several seconds; that is expected.

- [ ] **Step 5: `npx tsc --noEmit`, then commit**

```bash
git add dashboard/lib/video-convert.ts dashboard/scripts/test-video-convert.mjs && git commit -m "feat(dashboard): video converter probe (avconvert, then ffmpeg) with timeout"
```

---

### Task 3: Convert on upload

**Files:**
- Modify: `dashboard/app/api/assets/upload/route.ts` (the video branch, currently ~lines 60-100), `dashboard/lib/config.ts`, `.env.example`
- Test: `dashboard/scripts/smoke-video-convert-upload.mjs` (create)

**Interfaces:**
- Consumes: `classifyReelErrors` (Task 1), `findConverter`/`convertVideo` (Task 2).
- Produces: the upload response gains `converted?: { from: string; to: string }` when a conversion happened.

**Config:** add `videoConvertTimeoutMs` (env `VIDEO_CONVERT_TIMEOUT`, seconds, default `300`) and `videoConverter` (env `VIDEO_CONVERTER`, one of `auto`|`avconvert`|`ffmpeg`|`off`, default `auto`) to `dashboard/lib/config.ts`, and document both in `.env.example`. Follow how the existing config values are read there.

**The new video branch, in order** — the ordering is the point, do not rearrange:

1. Parse headers (`readVideoMeta`). Parse failure → 422, unchanged.
2. `classifyReelErrors`.
3. **`fatal` non-empty → 422 immediately.** No conversion attempted, so a 16-minute video is refused in milliseconds rather than after a long transcode.
4. `convertible` empty → today's path exactly: write original, `publish_path` NULL, no `conform_mode` change.
5. `convertible` non-empty:
   - `findConverter(config.videoConverter)`. `null` → 422 with the convertible messages **plus** a line noting that installing `ffmpeg` would let the app handle this automatically.
   - Write the upload to a temp file, convert to a second temp file, bounded by the timeout.
   - Convert throws → delete temps → 422 saying conversion failed.
   - **Re-parse and re-validate the derivative** with the same `readVideoMeta` + `classifyReelErrors`. Still failing → delete temps → 422 naming what remains. Never trust the converter's output.
   - Write the **original** bytes to `storage_path` and the **derivative** to `pub/<hash>.mp4`.
   - Insert with `conform_mode: "downscale"`, `needs_review: 1`, and **`width`/`height`/`duration_ms`/`has_audio` taken from the DERIVATIVE** — that is what gets published, and the cover scrubber must be bounded by its duration.
   - Return `converted: { from: "2160×3840", to: "1080×1920" }` alongside the asset.

**Dedup is checked before all of this and is unchanged** — re-uploading the same bytes must return the existing asset without re-converting.

- [ ] **Step 1: Write the smoke test**

Create `dashboard/scripts/smoke-video-convert-upload.mjs`, following `dashboard/scripts/smoke-video-upload.mjs` (read it first — it has the re-exec, loader, scratch `DATABASE_PATH` **and** scratch `ASSET_STORAGE_DIR` setup you need). Cover:

1. **The real 4K file** (`~/Downloads/IMG_3707.MOV`) uploads → **200**, `asset.width === 1080`, `asset.height === 1920`, `conform_mode === "downscale"`, `needs_review === 1`, `publish_path` non-null, `storage_path` present, and the file at `publish_path` exists on disk and re-parses to 1080×1920. **Skip with a printed notice if the file is absent**, so the script still runs elsewhere.
2. The **original is retained** — the file at `storage_path` still parses as 2160×3840.
3. An **in-spec** video (build one synthetically, as `test-video-meta.mjs` does) → 200, `publish_path` **null**, `conform_mode === "none"`, no `converted` key.
4. **Dedup**: upload the same 4K file twice → second returns `deduped: true` and does **not** re-convert (assert only one asset row exists).
5. A **too-long** video → 422 whose message names the duration, and assert **no conversion was attempted** (e.g. it returns fast, and no file appears in the asset store).
6. **`VIDEO_CONVERTER=off`** → the 4K file is refused with the width message plus the ffmpeg hint, and nothing is written.
7. **Regression:** a JPEG still uploads with a thumbnail and a `publish_path`, exactly as before.

- [ ] **Step 2: Run it, expect failures.**

- [ ] **Step 3: Implement** the config values and the route changes above.

- [ ] **Step 4: Run the smoke test, `npx tsc --noEmit`, the other smoke scripts, and the worker suite.**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/smoke-video-convert-upload.mjs && npx tsc --noEmit && cd .. && .venv/bin/python -m pytest worker/tests -q
```

Expected: smoke passes, tsc clean, **336 passed**. The worker must be untouched.

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/api/assets/upload/route.ts dashboard/lib/config.ts .env.example dashboard/scripts/smoke-video-convert-upload.mjs && git commit -m "feat(dashboard): convert out-of-spec video on upload instead of refusing it"
```

---

### Task 4: Tell the owner what happened, and verify end to end

**Files:**
- Modify: `dashboard/components/composer.tsx`
- Test: browser verification

**Interfaces:**
- Consumes: the `converted` field from Task 3.

Silently rewriting someone's footage is not acceptable (design spec, Decision 7). The composer already renders the upload's `warnings`; add the conversion notice beside them, in the same visual language.

Wording should say plainly what happened and that the original is safe — e.g. *"Converted to 1080×1920 so Instagram will accept it. Your original is untouched."* Match the existing notice styling; **verify every utility class exists in `dashboard/app/globals.css`** (this codebase has 7 theme families × light/dark = 14 palettes, and a previous task's sample code used a fictional `text-danger`).

- [ ] **Step 1: Thread `converted` through the composer's asset state** alongside `warnings`, and render the notice.

- [ ] **Step 2: Browser-verify the whole flow.** A dev server is already running on port **3939** — reuse it. **A worker daemon may be running; check first (`ps aux | grep worker.run`) and do NOT create a scheduled publication if it is.**

  - Drop `~/Downloads/IMG_3707.MOV` — the 4K original — into the composer.
  - Confirm it is **accepted**, not refused, and that the conversion notice appears.
  - Confirm the cover scrubber appears and seeks, bounded by the converted duration (~7.6 s).
  - Confirm the preview and library thumbnail render as video, not a broken image.
  - Screenshot it.

- [ ] **Step 3: Clean up.** Delete anything you created **through the app's own API, never raw SQL** (Python's `sqlite3` has foreign keys OFF by default and a raw `DELETE FROM posts` has corrupted this database once already). Report row counts before and after plus `PRAGMA foreign_key_check`.

  Note: the live database already contains asset rows from earlier testing; leave anything you did not create.

- [ ] **Step 4: Update the docs.**
  - `reference.md` — a short section on video conversion: which failures convert versus refuse, the converter probe order, the exact `avconvert`/`ffmpeg` command lines, and the measured result on the real 4K file.
  - `docs/tasks.md` — record this sub-project and **note explicitly that it reverses Decision 1 of the Reels spec**, with the reason (iPhone shoots 4K by default, so the failing case is the normal case).

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/composer.tsx reference.md docs/tasks.md && git commit -m "feat(dashboard): surface video conversion in the composer; document it"
```

---

## Self-review notes

**Spec coverage.** Decision 1 (convert at upload) → Task 3. Decision 2 (fatal vs convertible) → Task 1, with the ordering enforced in Task 3 Step 3. Decision 3 (converter probe) → Task 2. Decision 4 (re-validate the derivative) → Task 3, step 5 of the branch ordering. Decision 5 (refuse rather than half-succeed) → Task 3, all failure paths. Decision 6 (synchronous + timeout) → Task 2's `timeoutMs` and Task 3's config. Decision 7 (tell the owner) → Task 4.

**Ordering.** Tasks 1 and 2 are independent and could run in either order; Task 3 needs both; Task 4 needs Task 3.

**The riskiest task is 3**, because it rewrites a route that already has a working image path and a working in-spec-video path. Both must be provably untouched — hence smoke scenarios 3 and 7.

**Deliberately not planned:** any worker change. If a task appears to need one, that is a signal the design's claim (`_resolve_url` already prefers `publish_path`) is wrong, and it should be escalated rather than worked around.
