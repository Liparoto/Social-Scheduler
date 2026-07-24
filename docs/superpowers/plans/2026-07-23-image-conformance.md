# Image Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conform every uploaded image to Instagram's feed-image spec on upload, so the worker always sends Meta a valid file; make the framing decision once and remember it per-asset.

**Architecture:** A pure `sharp`-based engine (`dashboard/lib/conform.ts`) produces a conformed JPEG derivative at upload time. The asset row gains `publish_path` / `conform_mode` / `needs_review` (migration `0006`). The worker's publisher prefers `publish_path` over the original. The dashboard flags out-of-range (auto-cropped) images and offers a crop⇄pad toggle whose choice re-derives the file and persists.

**Tech Stack:** Next.js (App Router, TS) + `sharp` (already a dependency); SQLite via `better-sqlite3`; Python worker; `.sql` migrations.

## Global Constraints

- **IG feed images only.** Reels/Stories/video and Facebook Pages are Phase 6 — do not implement them here.
- **`sharp` is already installed** — add **no** new npm dependency. The dashboard has no unit-test runner by project convention; verify dashboard code via a **node smoke script** (using the installed `sharp`) against the dev server + in-browser, exactly like prior dashboard phases. The worker change is verified with `pytest`.
- **Working spec numbers** (⚠ verify live in Task 0): JPEG, sRGB, ≤ 8 MB, width ≤ 1440 px (≥ 320 px), aspect ratio between 4:5 (0.8) and 1.91:1.
- **Migrations are additive**, applied by `migrate.py` / the launcher to each install's own DB.
- **Never change framing silently** — out-of-range images are auto-cropped *and* flagged.
- Original file (`storage_path`) is always preserved; `publish_path` is a regenerable derivative.
- Dev server runs on **port 3939** (long-running `next dev`); worker daemon is running.

---

### Task 0: Verify the live Instagram feed-image spec

**Files:** none (research; update `reference.md` if numbers differ).

- [ ] **Step 1:** Confirm against current Meta docs (via Context7 `resolve-library-id`/`query-docs` for "instagram graph api content publishing", or the live docs): max file size, max/min width, allowed aspect-ratio bounds, required color space, accepted formats for **feed** images.
- [ ] **Step 2:** If any working value in this plan is wrong, update the constants in Task 2's code and add a short verified note to `reference.md` §6. If they match, note "verified 2026-07-23" in `reference.md`.

---

### Task 1: Migration `0006` — conformance columns

**Files:**
- Create: `migrations/0006_image_conformance.sql`

**Interfaces:**
- Produces: `assets.publish_path TEXT`, `assets.conform_mode TEXT DEFAULT 'none'`, `assets.needs_review INTEGER NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the migration**

```sql
-- 0006_image_conformance.sql
-- Store a Meta-conformed publish derivative per image asset, plus the framing decision.
-- The worker serves publish_path (falling back to storage_path for legacy rows). Additive.
ALTER TABLE assets ADD COLUMN publish_path TEXT;                       -- conformed JPEG the worker serves; NULL -> use storage_path
ALTER TABLE assets ADD COLUMN conform_mode TEXT NOT NULL DEFAULT 'none'; -- 'none' | 'crop' | 'pad'
ALTER TABLE assets ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;   -- 1 = framing auto-decided, awaiting user confirm
```

- [ ] **Step 2: Apply and verify**

Run:
```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && worker/.venv/bin/python migrate.py
```
Expected: `Applying 0006_image_conformance.sql ... done.`

- [ ] **Step 3: Confirm columns + back-compat**

Run:
```bash
sqlite3 data/socialscheduler.db "SELECT publish_path, conform_mode, needs_review FROM assets;"
```
Expected: existing rows show `|none|0` (publish_path NULL). No error.

- [ ] **Step 4: Confirm the worker test DB picks it up** — `worker/tests/conftest.py` globs all migrations, so no change needed; just run `worker/.venv/bin/python -m pytest worker/tests/ -q` and expect the current suite still green (78 passed).

- [ ] **Step 5: Commit**

```bash
git add migrations/0006_image_conformance.sql && git commit -m "feat(schema): 0006 image conformance columns on assets"
```

---

### Task 2: Conformance engine — `dashboard/lib/conform.ts`

**Files:**
- Create: `dashboard/lib/conform.ts`
- Create (smoke): `dashboard/scripts/conform-smoke.mjs`

**Interfaces:**
- Produces: `conformImage(input: Buffer, mode?: ConformMode): Promise<ConformResult>` and the exported constants + `ConformMode` / `ConformResult` types (see spec §5). Consumed by Tasks 3 and 5.

- [ ] **Step 1: Write the engine**

```ts
import sharp from "sharp";

export const IG_MAX_BYTES = 8 * 1024 * 1024;
export const IG_MAX_WIDTH = 1440;
export const IG_MIN_WIDTH = 320;
export const IG_MIN_RATIO = 4 / 5; // 0.8 (portrait bound)
export const IG_MAX_RATIO = 1.91; // landscape bound

export type ConformMode = "none" | "crop" | "pad";

export interface ConformResult {
  buffer: Buffer;
  mode: ConformMode;
  needsReview: boolean;
  width: number;
  height: number;
  lowRes: boolean;
}

/** Nearest in-range ratio for an out-of-range image (w/h). */
function targetRatio(ratio: number): number {
  return ratio < IG_MIN_RATIO ? IG_MIN_RATIO : IG_MAX_RATIO;
}

async function encodeUnderLimit(pipe: sharp.Sharp): Promise<Buffer> {
  for (const quality of [90, 82, 74, 66, 58, 50]) {
    const out = await pipe.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= IG_MAX_BYTES) return out;
  }
  return pipe.clone().jpeg({ quality: 45, mozjpeg: true }).toBuffer();
}

export async function conformImage(
  input: Buffer,
  mode: ConformMode = "crop",
): Promise<ConformResult> {
  // Normalize: honor EXIF rotation, strip to sRGB, cap width at 1440.
  const base = sharp(input).rotate().toColourspace("srgb");
  const meta = await base.metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  const ratio = srcH === 0 ? 1 : srcW / srcH;
  const lowRes = srcW < IG_MIN_WIDTH;

  let pipe = base.clone();
  if (srcW > IG_MAX_WIDTH) pipe = pipe.resize({ width: IG_MAX_WIDTH });

  const inRange = ratio >= IG_MIN_RATIO && ratio <= IG_MAX_RATIO;
  let resolvedMode: ConformMode = "none";

  if (!inRange) {
    resolvedMode = mode === "pad" ? "pad" : "crop";
    const tr = targetRatio(ratio);
    // Work from the (possibly downscaled) current dimensions.
    const curMeta = await pipe.clone().metadata();
    const w = curMeta.width ?? srcW;
    const h = curMeta.height ?? srcH;
    if (resolvedMode === "crop") {
      // Center-crop to target ratio.
      let cw = w;
      let ch = Math.round(w / tr);
      if (ch > h) {
        ch = h;
        cw = Math.round(h * tr);
      }
      pipe = pipe.extract({
        left: Math.floor((w - cw) / 2),
        top: Math.floor((h - ch) / 2),
        width: cw,
        height: ch,
      });
    } else {
      // Pad (letterbox) to target ratio on a white background.
      let pw = w;
      let ph = Math.round(w / tr);
      if (ph < h) {
        ph = h;
        pw = Math.round(h * tr);
      }
      pipe = pipe.extend({
        top: Math.floor((ph - h) / 2),
        bottom: Math.ceil((ph - h) / 2),
        left: Math.floor((pw - w) / 2),
        right: Math.ceil((pw - w) / 2),
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      });
    }
  }

  const buffer = await encodeUnderLimit(pipe);
  const outMeta = await sharp(buffer).metadata();
  return {
    buffer,
    mode: resolvedMode,
    needsReview: !inRange,
    width: outMeta.width ?? 0,
    height: outMeta.height ?? 0,
    lowRes,
  };
}
```

- [ ] **Step 2: Write the smoke script** (dependency-free; uses installed `sharp`)

```js
// dashboard/scripts/conform-smoke.mjs — run: node dashboard/scripts/conform-smoke.mjs
import sharp from "sharp";
import { conformImage, IG_MAX_WIDTH, IG_MAX_BYTES } from "../lib/conform.ts";

const mk = (w, h) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .png()
    .toBuffer();

function assert(name, cond) {
  if (!cond) throw new Error("FAIL: " + name);
  console.log("ok:", name);
}

const ratioOf = (r) => r.width / r.height;

// In-range square: safe fixes only, no review.
let r = await conformImage(await mk(2000, 2000));
assert("square: downscaled to <=1440", r.width <= IG_MAX_WIDTH);
assert("square: mode none", r.mode === "none");
assert("square: no review", r.needsReview === false);
assert("square: under 8MB", r.buffer.length <= IG_MAX_BYTES);

// Too wide (3:1) -> crop by default, flagged, ratio pulled into range.
r = await conformImage(await mk(3000, 1000));
assert("wide: mode crop", r.mode === "crop");
assert("wide: needs review", r.needsReview === true);
assert("wide: ratio <= 1.91", ratioOf(r) <= 1.92);

// Too tall (9:16) -> pad option keeps full height, ratio pulled up to 0.8.
r = await conformImage(await mk(900, 1600), "pad");
assert("tall pad: mode pad", r.mode === "pad");
assert("tall pad: ratio >= 0.8", ratioOf(r) >= 0.79);

console.log("\nALL CONFORM SMOKE CHECKS PASSED");
```

- [ ] **Step 3: Run the smoke script**

Run:
```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node --experimental-strip-types scripts/conform-smoke.mjs
```
Expected: every `ok:` line prints, ending `ALL CONFORM SMOKE CHECKS PASSED`.
(If `--experimental-strip-types` is unavailable on the installed Node, fall back: `npx tsc lib/conform.ts --outDir /tmp/conform-js --module esnext --moduleResolution bundler --target es2022` and import the compiled `.js` in the smoke script.)

- [ ] **Step 4: Typecheck** — `cd dashboard && npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/conform.ts dashboard/scripts/conform-smoke.mjs && git commit -m "feat(dashboard): image conformance engine (sharp) + smoke checks"
```

---

### Task 3: Conform on upload

**Files:**
- Modify: `dashboard/app/api/assets/upload/route.ts`
- Modify: `dashboard/lib/queries.ts` (extend `upsertAssetByHash` to accept the 3 new fields)
- Modify: `dashboard/lib/types.ts` (Asset type gains `publish_path`/`conform_mode`/`needs_review`)

**Interfaces:**
- Consumes: `conformImage` (Task 2).
- Produces: upload response now includes the conform fields on `asset`.

- [ ] **Step 1:** Add the 3 fields to the `Asset` type in `lib/types.ts` (`publish_path: string | null; conform_mode: "none" | "crop" | "pad"; needs_review: number;`).

- [ ] **Step 2:** Extend `upsertAssetByHash` in `lib/queries.ts` to insert `publish_path`, `conform_mode`, `needs_review` (default `null`/`'none'`/`0` when omitted for back-compat).

- [ ] **Step 3:** In `upload/route.ts`, after computing `hash` and before the DB upsert, for `media_kind === 'image'`:
  - `const conformed = await conformImage(buf, "crop");`
  - write `conformed.buffer` to `publishAbs = path.join(config.assetStorageDir, publishRel)` where `publishRel = \`pub/${hash}.jpg\``; `mkdir` the `pub/` dir.
  - pass `publish_path: publishRel, conform_mode: conformed.mode, needs_review: conformed.needsReview ? 1 : 0` to `upsertAssetByHash`.
  - keep writing the original `buf` to `storage_path` and the thumbnail as today.
  - wrap conform in try/catch: on failure, log, set `publish_path: null` (worker falls back to original) — never fail the upload over conformance.

- [ ] **Step 4: Verify via endpoint smoke** — with the dev server (3939) running, POST a crafted wide image and a normal image through `/api/assets/upload`, then assert the DB row has `publish_path` set, correct `conform_mode`/`needs_review`, and that `sharp(publish file).metadata()` is within spec. Add these cases to `scripts/conform-smoke.mjs` (guarded behind an env flag so the pure-function run stays offline), or a short `scripts/upload-smoke.mjs`.

Run:
```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && sqlite3 data/socialscheduler.db "SELECT id, conform_mode, needs_review, publish_path FROM assets ORDER BY id DESC LIMIT 3;"
```
Expected: newest uploads show a `pub/<hash>.jpg` publish_path; the wide one shows `crop|1`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/api/assets/upload/route.ts dashboard/lib/queries.ts dashboard/lib/types.ts && git commit -m "feat(dashboard): conform images on upload; store publish derivative + framing decision"
```

---

### Task 4: Worker serves the conformed file

**Files:**
- Modify: `worker/publisher.py` (`_resolve_url`)
- Modify: `worker/tests/test_publisher.py` (or `test_delivery.py`) — add a precedence test
- Check: the SELECT that loads assets includes `publish_path` (it's `SELECT *` in `db.get_ordered_assets` — confirm)

**Interfaces:**
- Consumes: `assets.publish_path` (Task 1).
- Produces: URL precedence `public_url` → `publish_path` → `storage_path`.

- [ ] **Step 1: Write the failing test** — craft an asset row with `public_url=None`, `publish_path='pub/abc.jpg'`, `storage_path='abc.png'`; assert `_resolve_url(asset, "https://t.example")` returns `https://t.example/pub/abc.jpg`. Add a second: `publish_path=None` falls back to `storage_path`. A third: external `public_url` still wins over `publish_path`.

- [ ] **Step 2: Run it, expect FAIL** — `worker/.venv/bin/python -m pytest worker/tests/ -k resolve -q` → the publish_path case fails (still uses storage_path).

- [ ] **Step 3: Implement** — in `_resolve_url`, between the external check and the storage_path branch:

```python
    external = asset["public_url"]
    if external:
        return external
    if asset_base_url:
        rel = None
        # keys() guard: legacy rows / tests may not carry publish_path.
        if "publish_path" in asset.keys() and asset["publish_path"]:
            rel = asset["publish_path"]
        elif asset["storage_path"]:
            rel = asset["storage_path"]
        if rel:
            return f"{asset_base_url.rstrip('/')}/{rel}"
    return None
```

- [ ] **Step 4: Run tests, expect PASS** — `worker/.venv/bin/python -m pytest worker/tests/ -q` → all green (81+).

- [ ] **Step 5: Commit**

```bash
git add worker/publisher.py worker/tests && git commit -m "feat(worker): publish the conformed derivative (publish_path) when present"
```

---

### Task 5: Set-mode API — `POST /api/assets/[id]/conform`

**Files:**
- Create: `dashboard/app/api/assets/[id]/conform/route.ts`
- Modify: `dashboard/lib/queries.ts` (`getAssetById`, `updateAssetConform`)

**Interfaces:**
- Consumes: `conformImage` (Task 2), the original file at `storage_path`.
- Produces: `POST { mode: 'crop' | 'pad' }` → re-derives `publish_path`, sets `conform_mode`, clears `needs_review`; returns the updated asset.

- [ ] **Step 1:** Add `getAssetById(id)` and `updateAssetConform(id, { publish_path, conform_mode, needs_review })` to `lib/queries.ts`.

- [ ] **Step 2:** Implement the route: validate `mode ∈ {crop,pad}` (else 400); load the asset (404 if missing); read the original from `path.join(config.assetStorageDir, asset.storage_path)`; `conformImage(original, mode)`; overwrite `pub/<hash>.jpg`; `updateAssetConform(id, { publish_path, conform_mode: mode, needs_review: 0 })`; return `{ asset }`.

- [ ] **Step 3: Verify** — via smoke: upload a wide image (auto `crop|1`), POST `{mode:'pad'}`, assert row becomes `pad|0` and the publish file's ratio ≥ 0.8; POST `{mode:'crop'}`, assert it flips back. Idempotent (repeat → same result).

- [ ] **Step 4: Typecheck** — `cd dashboard && npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add "dashboard/app/api/assets/[id]/conform" dashboard/lib/queries.ts && git commit -m "feat(dashboard): API to set an image's framing (crop/pad), re-derives publish file"
```

---

### Task 6: Dashboard UX — flag badge + crop/pad toggle

**Files:**
- Create: `dashboard/components/conform-control.tsx` (`"use client"`)
- Modify: the asset-thumbnail render in `dashboard/components/composer.tsx`, `dashboard/components/bulk-import.tsx`, and `dashboard/components/post-editor.tsx` to mount `<ConformControl>` when `asset.needs_review` (and a soft low-res note).

**Interfaces:**
- Consumes: `POST /api/assets/[id]/conform` (Task 5), the asset's `needs_review`/`conform_mode`.

- [ ] **Step 1:** Build `<ConformControl asset={...} />`: shows an **"Auto-cropped — review framing"** badge, a **Crop ⇄ Pad** segmented toggle, and a small preview of each (`/api/media` of the publish file after switching). On toggle → `fetch('/api/assets/'+id+'/conform', {method:'POST', body: JSON.stringify({mode})})` → `router.refresh()`. Reflects `conform_mode`; hides once `needs_review` is 0 (or shows a subtle "framing set" note).

- [ ] **Step 2:** Mount it under the thumbnail in the composer, `/import` grid, and post editor. In-range images render nothing new.

- [ ] **Step 3: Verify in browser** (dev server 3939): upload a 9:16 image in the composer → badge appears, default is Crop; click Pad → preview updates to letterboxed, badge clears to "framing set"; reload → choice persisted. Confirm an in-range image shows no badge. Screenshot the composer with the control for the summary.

- [ ] **Step 4:** `cd dashboard && npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components && git commit -m "feat(dashboard): flag out-of-range images with a crop/pad framing toggle"
```

---

### Task 7: Docs + memory

- [ ] **Step 1:** Update `docs/tasks.md` — add an "Image conformance" section marked done with the verification results, and clear the Phase 5.5 gap note (`tasks.md:166`).
- [ ] **Step 2:** Add a memory file `image-conformance.md` (type project): conform-on-upload, `publish_path`/`conform_mode`/`needs_review`, worker precedence, per-asset persistence for evergreen. Link `[[metrics-refresh-needs-worker]]` neighborhood. Add the MEMORY.md index line.
- [ ] **Step 3: Commit** `docs: image conformance shipped — tasks + memory`.

---

## Self-Review notes

- **Spec coverage:** engine (T2) ↔ spec §5; data model (T1) ↔ §4; worker (T4) ↔ §6; UX (T5/T6) ↔ §7; scope guards carried into Global Constraints. Task 0 covers the §2 "verify live" caveat.
- **Type consistency:** `ConformMode` = `'none'|'crop'|'pad'` and `ConformResult` used identically across T2/T3/T5; `needs_review` stored as INTEGER (0/1), surfaced as boolean in the engine only.
- **Testing reality:** dashboard has no unit runner → engine verified by a `sharp`-based smoke + endpoint checks + in-browser (matches prior phases); the worker change gets real `pytest` cases.
