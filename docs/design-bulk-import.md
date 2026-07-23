# Design — Sub-project ③ Bulk import (manual)

**Status:** approved 2026-07-23, ready for implementation planning
**Depends on:** ① Content model + ② Tagging taxonomy (shipped) + the post edit screen (shipped).
**Feeds:** faster content loading; drafts land ready to tag/target/schedule and to refine in the
edit screen.

---

## 1. Purpose

Loading content one post at a time through the composer is slow when you have a batch of images
(a shoot, an event, a campaign). Bulk import lets you select **many images at once**, turn each
into a **Draft** post with shared batch defaults, and then refine/schedule them from the Library
and edit screen.

This is the **manual** path — fully local, no cloud, no new external dependency. AI-assisted
captioning is deliberately deferred (see §7); the design leaves a clean seam for it.

Guiding principle (project rules): keep it simple and legible; nothing auto-posts until the owner
reviews and marks it Ready.

---

## 2. The flow

1. Open **Bulk import** (`/import`, linked from the sidebar and a Library button).
2. **Select multiple images.** Each uploads through the existing `/api/assets/upload`
   (sha256 hash → dedup → store + thumbnail). Re-importing the same photo is safe (dedup by
   content hash, never filename).
3. The uploaded images appear as a **thumbnail grid**, each with an **optional caption field**.
4. Fill a **Batch defaults** panel applied to every image: target accounts, kind, status
   (defaults to **Draft**), tags, periods.
5. Click **"Create N drafts"** → one request creates **one Draft post per image** in a
   transaction.
6. See **"Created N drafts"** with a link to the Library, where they appear as Draft cards.

---

## 3. Decisions baked in

- **One image = one single-image Draft post.** Carousel grouping (several images → one post) is
  **deferred** — it needs a selection/grouping UI. The endpoint takes a flat per-image list, so
  grouping can be added later without breaking the contract.
- **Everything lands as `content_status = 'draft'`** by default so nothing is auto-fill-eligible
  until reviewed. (The status control still lets the owner choose Ready for the batch if they
  want.)
- **Per-image caption** is optional. A non-empty caption becomes the post's single generic
  caption variant (`platform = null`); blank means no caption yet (fill later in the edit
  screen). This keeps captions in the same `caption_variants` model everything else uses.
- **Shared batch defaults** (targets / kind / status / tags / periods) apply identically to every
  post in the batch — a snapshot at import time, editable per-post afterward.

---

## 4. Components

### Reuses (no rebuild)
- `POST /api/assets/upload` — the upload/hash/dedup/thumbnail route (client uploads each file to
  it, exactly like the composer's `onFiles` loop).
- `createDraftPost(input: CreateDraftInput)` — the per-post draft writer (assets + content-model
  side tables in a transaction). `CreateDraftInput extends ContentModelInput` (targets, kind,
  status, tags via `tag_ids`, periods via `period_links`, caption variants) plus `caption`,
  `first_comment`, `asset_ids`.
- Validators in `dashboard/lib/content-model-validation.ts`: `parseTagIds`, `parsePeriodLinks`
  (and `parseCaptionVariants` if needed). `getChannel` / `getAsset` for existence checks.
- UI components: `TagEditor`, `PeriodAttach`, the composer's channel-picker pattern,
  `/api/media/{id}?variant=thumb` thumbnails.
- The Library's Draft filtering (drafts show up immediately with their badges/chips).

### New (this sub-project)
1. **Query** `createDraftPostsBulk(items, shared): number[]` (`dashboard/lib/queries.ts`).
   - `items: { asset_id: number; caption: string }[]` — one per image.
   - `shared: { target_channel_ids?: number[]; content_kind?: ContentKind;
     content_status?: ContentStatus; tag_ids?: number[];
     period_links?: { periodId: number; mode: PeriodMode }[] }`.
   - Wraps N `createDraftPost` calls in **one** `db.transaction` (better-sqlite3 nests via
     savepoints — the whole batch commits or rolls back together). For each item: `asset_ids =
     [asset_id]`; `caption = item.caption.trim()`; `caption_variants = caption ? [{platform:
     null, body: caption, sort_order: 0}] : []`; spread the shared defaults. Returns the new
     post ids.

2. **Route** `POST /api/posts/bulk-import` (`dashboard/app/api/posts/bulk-import/route.ts`),
   `export const runtime = "nodejs"`.
   - Body: `{ items: { asset_id: number; caption?: string }[], target_channel_ids?,
     content_kind?, content_status?, tag_ids?, period_links? }`.
   - Validate: `items` is a non-empty array (400) with a sane cap (**≤ 100** per batch — `log`/error
     if exceeded, never silently truncate); each `asset_id` is a number that exists via
     `getAsset` (400 on unknown); each `caption` is a string or absent. Validate shared defaults
     with the SAME rules the draft route uses: `content_kind` ∈ {evergreen, one_time};
     `content_status` ∈ {draft, ready}; every `target_channel_ids` exists via `getChannel`;
     `tag_ids` via `parseTagIds`; `period_links` via `parsePeriodLinks`. Any invalid → 400 with a
     clear message; nothing is created (validate fully before writing).
   - On success: `createDraftPostsBulk(...)` → `{ created: ids.length }` (200/201).

3. **Page** `dashboard/app/import/page.tsx` (server) — fetches `getChannels()`, `listPeriods()`,
   `listTags("time_of_day")`, `listTags("topic")`; renders the client `<BulkImport>`.

4. **Component** `dashboard/components/bulk-import.tsx` (client):
   - Multi-file `<input type="file" multiple accept="image/*">`; an `onFiles` loop uploading each
     via `/api/assets/upload` (mirror the composer's loop, incl. dedup notice), building
     `items: { assetId, name, caption }[]`.
   - Thumbnail grid (`/api/media/{assetId}?variant=thumb`); each tile has a caption `<textarea>`
     and a remove-from-batch control.
   - Batch-defaults panel: channel picker (targets), Kind segmented (default evergreen), Status
     segmented (default **Draft**), `<TagEditor>`, `<PeriodAttach>`.
   - "Create N drafts" button (disabled while uploading or when the batch is empty) → POST
     `/api/posts/bulk-import` → on success show "Created N drafts" + a `<Link href="/library">`;
     on error show `body.error`.

5. **Navigation:** add an **Import** item to `dashboard/components/sidebar.tsx`, and a
   "Bulk import" link/button on the Library (`/import`).

---

## 5. Data integrity / correctness

- Batch is **all-or-nothing**: one transaction around all N drafts. A bad item fails the whole
  batch with a clear error rather than leaving a partial import.
- Assets are deduped by content hash at upload time; importing the same image twice reuses the
  asset (the drafts still each get their own post row — that's intended; two draft posts can
  share one asset).
- `content_status` default `draft` keeps everything out of auto-fill until reviewed — consistent
  with ① (never silently auto-post).
- Reuses the shared validators so bulk import can't accept anything the composer/edit paths would
  reject (same tag/period/channel existence rules).

---

## 6. Verification

- `cd dashboard && npx tsc --noEmit` clean.
- Browser round-trip (controller runs): open `/import`, select 3 images, give one a caption, set a
  target + a tag + status Draft, "Create 3 drafts" → success → Library shows 3 new Draft cards
  with the tag/target badges; the captioned one carries its caption (check the edit screen / DB).
- Dedup: re-importing an already-imported image reuses the asset (dedup notice), still creating a
  new draft.
- Invalid case: an unknown `asset_id` or `tag_id` → 400, nothing created (verify no partial rows).

---

## 7. Out of scope (deferred — the seam for later)

- **AI-assisted captions/tags.** Drafts are exactly the unit a future "suggest" step would operate
  on: it would fill the `caption_variants`/`tag_ids` of existing draft posts, needing no schema
  change and no change to this endpoint. Requires the owner to opt into an LLM dependency
  (own API key or a local model) — explicitly out of this build.
- **Folder-path import** and **CSV manifest** — alternative input sources; the endpoint's flat
  per-image `items` shape leaves room to add them as new front-ends over the same writer.
- **Carousel grouping** (multiple images → one post) — needs grouping UI; the per-image list keeps
  the door open.
