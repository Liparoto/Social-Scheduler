# Custom Cover Image for Reels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a real image as a Reel's cover instead of only picking a frame from the video.

**Architecture:** The cover is an ordinary image asset row referenced by the video asset via a new `assets.cover_asset_id`. It gets a **cover-specific** conform that touches colour space and file size only — never the aspect ratio, because Instagram center-crops a non-9:16 cover itself and cropping locally would mangle deliberately-chosen framing. The worker sends `cover_url` **instead of** `thumb_offset`, never both.

**Tech Stack:** Next.js 16 App Router + TypeScript + `sharp` (already a dependency); Python worker. **No new dependencies.**

Design spec: `docs/superpowers/specs/2026-07-29-custom-cover-image-design.md`

## Global Constraints

- **No new dependencies** (npm or pip). `sharp` is already used by `dashboard/lib/conform.ts`.
- Migrations are additive numbered `.sql` in `/migrations`, the single source of truth. No schema inline in TS or Python.
- **Never modify the live `data/socialscheduler.db`.** It contains a **real published Reel** (publication 4, `posted`, remote id `17983260633046217`) which must never be touched, and there is **no delete-asset API**, so a stray write is painful to undo. Use scratch copies via `DATABASE_PATH` (**not** `DB_PATH`) plus `ASSET_STORAGE_DIR` where files are written. Report counts before/after and `PRAGMA foreign_key_check`.
- **Never change `DRY_RUN` or `KILL_SWITCH`** in `.env` (currently `1` / `0`). **The worker daemon is running** in dry-run — do not stop it, and do not create publications.
- **Theme tokens:** 7 theme families × light/dark = **14 palettes**. Every utility class must already exist in `dashboard/app/globals.css` — an invented one renders invisible in some themes. The error token is `text-status-failed`; there is no `text-danger`.
- Smoke scripts cannot plainly import `lib/queries.ts` (it pulls in `"server-only"` and `@/` imports) — follow the re-exec + loader pattern in `dashboard/scripts/smoke-post-now.mjs`.
- Verified cover spec, from Meta's live docs — use these exact values: **JPEG**, **8 MB maximum**, **sRGB**, 9:16 recommended and *"if the aspect ratio of the original image is not 9:16, we crop the image and use the middle most 9:16 rectangle."* And the precedence rule: *"If you specify both `cover_url` and `thumb_offset`, we use `cover_url` and ignore `thumb_offset`."*
- Checks at the end of every task: `cd dashboard && npx tsc --noEmit`; `.venv/bin/python -m pytest worker/tests -q` (**339 passing**); the `dashboard/scripts/smoke-*.mjs` scripts — note `smoke-content-model.mjs` has a **pre-existing unrelated failure**, confirm it is identical rather than assuming it is yours.

---

### Task 1: Migration, query layer, and the cover conform engine

**Files:**
- Create: `migrations/0012_cover_asset.sql`, `dashboard/lib/conform-cover.ts`
- Modify: `dashboard/lib/types.ts` (`Asset`), `dashboard/lib/queries.ts`
- Test: `dashboard/scripts/test-conform-cover.mjs` (create)

**Interfaces:**
- Produces `assets.cover_asset_id INTEGER REFERENCES assets(id)` (nullable); `Asset.cover_asset_id: number | null`; `setAssetCoverImage(videoAssetId: number, coverAssetId: number | null): void`.
- Produces `conformCover(input: Buffer): Promise<{ buffer: Buffer; width: number; height: number; warnings: string[] }>`.

- [ ] **Step 1: Write the migration**

Create `migrations/0012_cover_asset.sql`:

```sql
-- 0012_cover_asset.sql
-- Let a VIDEO asset point at an IMAGE asset to use as its Reels cover:
--   assets.cover_asset_id  (new, nullable, references assets(id))
--
-- Instagram's cover_url takes a public image URL and OVERRIDES thumb_offset entirely
-- ("If you specify both cover_url and thumb_offset, we use cover_url and ignore
-- thumb_offset"). So a cover image and a cover frame are alternatives, not a stack --
-- assets.cover_frame_ms stays populated while an image overrides it, so removing the
-- image restores the previously chosen frame rather than losing it.
--
-- The cover is an ordinary assets row (media_kind='image') so it inherits content-hash
-- dedup, the local store, and the worker's URL resolution for free. The Library lists
-- POSTS rather than assets, so a cover does not show up as a spurious library entry.
--
-- Purely additive: a nullable column with no CHECK, so SQLite can ALTER TABLE ADD COLUMN
-- and no table rebuild is needed.

ALTER TABLE assets ADD COLUMN cover_asset_id INTEGER REFERENCES assets(id);
```

- [ ] **Step 2: Apply to a scratch copy and verify**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && cp data/socialscheduler.db /tmp/c.db && DATABASE_PATH=/tmp/c.db python3 migrate.py && sqlite3 /tmp/c.db "PRAGMA table_info(assets);" | grep cover_asset_id; rm -f /tmp/c.db*
```

Expected: one row naming `cover_asset_id|INTEGER`.

- [ ] **Step 3: Write the failing test for `conformCover`**

Create `dashboard/scripts/test-conform-cover.mjs`. **Read `dashboard/scripts/test-video-spec.mjs` first** for this repo's plain-`node` test style — `conform-cover.ts` is pure apart from `sharp`, so no loader or re-exec is needed. Generate inputs with `sharp` itself rather than shipping binary fixtures (see how `dashboard/lib/conform.ts` is used for reference).

Assert:
- A **9:16** input (e.g. 1080×1920) → **no warnings**, dimensions **unchanged**, output is JPEG.
- A **1:1** input → exactly one warning, and its text mentions that Instagram will crop to the middle 9:16. Dimensions still **unchanged** — we do not crop.
- A **16:9** input → warns likewise, dimensions unchanged.
- A PNG input → output is JPEG.
- A deliberately large input → output is **≤ 8 MB** (8 × 1024 × 1024).
- Output colour space is sRGB (read it back with `sharp(...).metadata()`).

The dimensions-unchanged assertions are the point of the whole task — they are what stops this silently becoming a feed conform.

- [ ] **Step 4: Run it, expect failure** (module does not exist).

- [ ] **Step 5: Implement `dashboard/lib/conform-cover.ts`**

Model it on `dashboard/lib/conform.ts` — same `sharp` idioms, same quality-stepping approach for the size ceiling — but **do not reuse `conformImage`**, whose entire purpose is the 0.8–1.91 feed range. Deliberately:

- EXIF-rotate and convert to sRGB.
- Encode JPEG, stepping quality down until ≤8 MB.
- **Never resize or crop.** No aspect logic beyond producing the warning.
- Warn when `width / height` is outside a small tolerance of 0.5625, naming what Instagram will do.

Add a file-header comment stating explicitly that this is not the feed conform and why, so nobody later "simplifies" the two together.

- [ ] **Step 6: Extend the types and query layer**

`Asset` gains `cover_asset_id: number | null`. Add to `dashboard/lib/queries.ts`, beside `updateAssetCoverFrame`:

```typescript
/** Point a video asset at an image asset to use as its Reels cover, or clear it. */
export function setAssetCoverImage(videoAssetId: number, coverAssetId: number | null): void {
  getDb()
    .prepare("UPDATE assets SET cover_asset_id = ? WHERE id = ?")
    .run(coverAssetId, videoAssetId);
}
```

- [ ] **Step 7: Run tests, typecheck, commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/test-conform-cover.mjs && npx tsc --noEmit
```

```bash
git add migrations/0012_cover_asset.sql dashboard/lib/conform-cover.ts dashboard/lib/types.ts dashboard/lib/queries.ts dashboard/scripts/test-conform-cover.mjs && git commit -m "feat(db): cover_asset_id + a cover conform that never touches aspect ratio"
```

---

### Task 2: The cover-image upload endpoint

**Files:**
- Create: `dashboard/app/api/assets/[id]/cover-image/route.ts`
- Test: `dashboard/scripts/smoke-cover-image.mjs` (create)

**Interfaces:**
- Consumes `conformCover`, `setAssetCoverImage`, `upsertAssetByHash` (Task 1 and existing).
- Produces `POST /api/assets/[id]/cover-image` (multipart file) → `{ asset, cover, warnings }`; `DELETE` → `{ asset }`.

**Read `dashboard/app/api/assets/[id]/cover/route.ts` first** — the sibling cover-*frame* route. Match its shape, its 404/409 guards and its error style.

- [ ] **Step 1: Write the smoke test**

Create `dashboard/scripts/smoke-cover-image.mjs`, following `dashboard/scripts/smoke-video-upload.mjs` (which already has the re-exec, loader, scratch `DATABASE_PATH` **and** scratch `ASSET_STORAGE_DIR` setup — this route writes files, so you need both). Cover:

1. POST a 1080×1920 JPEG to a **video** asset → **200**, a new image asset row is created, the video's `cover_asset_id` points at it, `warnings` is empty.
2. POST a 1:1 image → 200 with one warning about Instagram cropping to the middle 9:16.
3. **`cover_frame_ms` is left untouched** by both — the frame must survive being overridden, so removing the image can restore it.
4. `DELETE` → `cover_asset_id` is NULL again and `cover_frame_ms` is **still** its original value.
5. POST to an **image** asset → **409** (mirrors the cover-frame route's guard).
6. POST to an unknown asset id → **404**.
7. POST a non-image (e.g. a text file) → **422**, and **no rows written and no files left in the asset store**.
8. **Dedup:** POST the same cover bytes twice → the second reuses the existing asset row rather than creating a duplicate.

- [ ] **Step 2: Run it, expect failures.**

- [ ] **Step 3: Implement the route**

`POST`: load the target asset (404 if missing, 409 if `media_kind !== "video"`), read the file, refuse non-images with 422 **before writing anything**, `conformCover` it, hash the **conformed** bytes and `upsertAssetByHash` as an image asset (so dedup works on what is actually stored), write it to the asset store, then `setAssetCoverImage`. Return the updated video asset, the cover asset, and the warnings.

`DELETE`: `setAssetCoverImage(id, null)`. **Do not delete the cover asset row or its file** — dedup means another post may reference the same bytes, and this project has no asset-delete path precisely because deletion is not safe to do casually.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && node scripts/smoke-cover-image.mjs && npx tsc --noEmit
```

```bash
git add dashboard/app/api/assets/\[id\]/cover-image/route.ts dashboard/scripts/smoke-cover-image.mjs && git commit -m "feat(dashboard): upload a custom Reels cover image"
```

---

### Task 3: The worker sends `cover_url` instead of `thumb_offset`

**Files:**
- Modify: `worker/graph_api.py` (`create_video_container`), `worker/publisher.py` (`_build_plan`, `_publish_reel`), `worker/db.py` if an asset lookup helper is needed
- Test: `worker/tests/test_reels_publish.py` (extend)

**Interfaces:**
- Consumes `assets.cover_asset_id` (Task 1).
- Produces: the plan dict carries **either** `cover_url` **or** `cover_frame_ms`, never both.

Meta's rule is that `cover_url` wins and `thumb_offset` is ignored. We resolve that **explicitly in our own plan** rather than sending both and relying on Meta's behaviour — the dry-run plan is one of this project's main debugging surfaces and must show what will actually happen.

- [ ] **Step 1: Write the failing tests**

Extend `worker/tests/test_reels_publish.py`, matching its existing fake-client style. Assert:
- With `cover_asset_id` set, the plan has `cover_url` and **`cover_frame_ms` is absent or None**, and `create_video_container` receives `cover_url` and **no `thumb_offset`**.
- With no `cover_asset_id`, behaviour is exactly as today: `thumb_offset` from `cover_frame_ms`, no `cover_url`.
- **A dangling `cover_asset_id`** (points at a row that does not exist) **falls back to `thumb_offset`** and does **not** raise. A missing cover is cosmetic; refusing to publish over it would be worse. Assert the publish still succeeds.
- `thumb_offset=0` is still sent when it is the explicit choice (the existing falsy-zero guard must not regress).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`create_video_container` gains an optional `cover_url`; send it only when not `None`, mirroring the existing `thumb_offset` handling (explicit `is not None`, not truthiness).

In `_build_plan`, resolve the cover once. Use the same `"key" in row.keys()` guard the file already uses for `publish_path` and `cover_frame_ms` — many existing tests build asset fixtures as plain dicts without the new column, and a bare subscript would `KeyError` across the suite.

- [ ] **Step 4: Full suite, commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests -q
```

Expected: all green, count raised by your new tests. If a pre-existing test fails, the `.keys()` guard is the first suspect.

```bash
git add worker/graph_api.py worker/publisher.py worker/tests/test_reels_publish.py && git commit -m "feat(worker): send cover_url for a Reel when a cover image is set"
```

---

### Task 4: The Frame-or-Image choice in the picker, and verification

**Files:**
- Modify: `dashboard/components/cover-frame-picker.tsx`, and whichever server component supplies its asset if the cover asset needs loading

**Interfaces:** consumes everything above.

Per the spec's Decision 3: **one visible choice — "Frame from the video" or "Uploaded image"** — because Meta's precedence is fixed and two controls that silently fight would be worse than one that is explicit.

- [ ] **Step 1: Build the control**

- A two-option toggle, following the idiom of the existing crop/pad toggle in `dashboard/components/conform-control.tsx` so there is one pattern to learn.
- **Uploaded image** mode: a file input, a preview of the current cover, and a Remove control.
- When an image is set, the frame scrubber stays **visible but visibly marked as overridden** — not hidden. Hiding it would lose the information that a frame was chosen, and the owner may want to go back to it.
- Surface the ratio warning returned by the upload.
- Note the component already takes an `overlay` slot used by the post editor's lightbox badge; do not disturb it.

- [ ] **Step 2: Verify in the browser**

A dev server is running on port **3939** — reuse it. The worker is running in dry-run — **do not create publications.** Use the Reel at `/library/2`.

Confirm and report individually:
- Uploading a 9:16 cover shows it, with no warning; the frame scrubber is marked overridden.
- Uploading a 1:1 cover warns about Instagram cropping to the middle 9:16.
- Remove restores the frame — the scrubber is live again **and still shows the previously chosen frame**.
- Switching back and forth does not lose `cover_frame_ms`.
- The lightbox badge still works (it shares this component).
- Both light and dark themes; every class used exists in `globals.css`.
- Console free of errors and React warnings.

Then **clean up anything you created through the app's own API**, and report live-DB counts before/after plus `PRAGMA foreign_key_check`. Note the cover asset row itself cannot be removed (no asset-delete API) — say so plainly rather than leaving it unmentioned.

- [ ] **Step 3: Confirm the dry-run plan**

With a cover image set on post 2, run the worker once against a **scratch copy** of the database so the real publication is untouched:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && SP=$(mktemp -d) && sqlite3 data/socialscheduler.db ".backup '$SP/dry.db'" && DATABASE_PATH="$SP/dry.db" DRY_RUN=1 .venv/bin/python -m worker.run --once 2>&1 | tail -20; rm -rf "$SP"
```

Note publication 4 is already `posted`, so it will not appear — create a scheduled send **on the scratch copy** if you need a due reel, or assert on `_build_plan` directly in a unit test instead. **Do not schedule anything on the real database.**

- [ ] **Step 4: Docs and commit**

Add a short `reference.md` note: `cover_url` overrides `thumb_offset` (quoted), the cover spec (JPEG / 8 MB / sRGB / 9:16-or-Meta-crops), and that we deliberately do not crop locally. Record the sub-project in `docs/tasks.md` in the established style, including that changing the cover of an already-published Reel is out of scope because Meta does not document it.

```bash
git add dashboard/components/cover-frame-picker.tsx reference.md docs/tasks.md && git commit -m "feat(dashboard): choose a frame or upload a cover image; document it"
```

---

## Self-review notes

**Spec coverage.** Decision 1 (cover as an asset row) → Task 1. Decision 2 (colour/size only, never aspect) → Task 1, pinned by the dimensions-unchanged assertions. Decision 3 (frame or image, override visible) → Task 4. Decision 4 (worker sends one, not both) → Task 3. Decision 5 (Instagram only, no capability flag) → nothing to build. Decision 6 (own endpoint) → Task 2.

**The riskiest task is 3**, because `_build_plan` is shared by every platform and a missing `.keys()` guard would break the suite broadly — the same trap that was hit when `cover_frame_ms` was added.

**Task 4's verification names the frame-survives-override behaviour explicitly**, because that is the one thing a reasonable implementer might "simplify" away by clearing `cover_frame_ms` when an image is set.
