# Media page — design

**Date:** 2026-07-29
**Status:** approved, not yet implemented

## Problem

There is no way to delete an uploaded asset. This has blocked cleanup twice: once after the
export/backup work (orphan assets left behind by deleted posts) and again after the video/Reels
work, which left seven test assets in the store — roughly 100 MB, including a 51 MB personal
photo and a real personal video.

Deleting is not the whole problem. The dashboard has **no asset-browsing surface at all**. The
page called "Library" lists *posts*; assets appear only inside a post. `recentAssets()` exists in
`dashboard/lib/queries.ts` and is called by nothing — dead code. So the feature needs a home
before it needs a delete button.

## What already protects us

- `post_assets.asset_id` is `REFERENCES assets(id) ON DELETE RESTRICT` (`0001_init.sql`).
- `PRAGMA foreign_keys = ON` in both `dashboard/lib/db.ts:17` and `worker/db.py:17`.

An asset attached to a post therefore *cannot* be deleted out from under a pending publish. The
database is the enforcement point; the UI only has to explain it.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Surface | A `/media` page listing every asset | A cleanup-only screen needs ~the same UI; the extra cost is showing used assets too, and it answers "what is eating my disk" |
| Deletion | Hard delete — row + files | Reclaiming space is the point. A trash folder defers the problem and grows its own empty-trash UI |
| Bulk delete | Out of scope | Seven files is seven clicks; easy to add later |
| Force-delete a used asset | Never | `RESTRICT` settles it |
| Migration | None | No schema change |
| New dependencies | None | |

## Architecture

### Surface

- `dashboard/app/media/page.tsx` — server component, loads data.
- `dashboard/components/media-manager.tsx` — client component, renders the grid.

Same server/client split as Library. Sidebar gains `{ href: "/media", label: "Media", hint:
"Stored files & cleanup" }` after Library, in `dashboard/components/sidebar.tsx`.

Each card shows a thumbnail, filename, size, dimensions or duration, and a kind badge. Existing
`MediaBadge` / `MediaLightbox` are reused, so click-to-view comes free. A header summary reads
e.g. `9 items · 110 MB · 7 unused (100 MB)`.

- **Used** asset: an `In post #2 (scheduled)` chip and **no delete button** — absent, not
  disabled, since a greyed button invites clicking.
- **Unused** asset: an `Unused` chip and a Delete button.

### Data

`listAssetsWithUsage()` in `dashboard/lib/queries.ts`, **replacing** the dead `recentAssets()`.
A `LEFT JOIN` on `post_assets` returns each asset plus its post count and first post id/status.

### Delete endpoint

`DELETE /api/assets/[id]` → `dashboard/app/api/assets/[id]/route.ts`.

The guard lives **on** the `DELETE`, mirroring `deletePost` (`queries.ts:428`):

```sql
DELETE FROM assets
 WHERE id = @id
   AND NOT EXISTS (SELECT 1 FROM post_assets WHERE asset_id = @id)
```

so it cannot lose a race with a compose that attaches the asset moments earlier. Zero rows
changed means "in use", not a crash.

The handler additionally catches `SQLITE_CONSTRAINT_FOREIGNKEY` and reports it as in-use. This is
deliberate: **any** foreign key becomes the authority, including ones this page has never heard
of. Concretely, the owner's local DB has `0012_cover_asset.sql` applied (from the
`custom-cover-image` branch) adding `assets.cover_asset_id`, while `main/migrations` stops at
`0011`. This design means that branch will not need to touch the delete endpoint when it lands.

**Order of operations — DB row first, then files.**

1. Run the guarded `DELETE`. Refused → return 409, touch nothing on disk.
2. Row gone → unlink `storage_path`, `publish_path`, `thumbnail_path`.

A missing file is ignored; the row is gone, which is what the UI reads. The reverse order is
forbidden — files-gone-row-present renders a permanently broken card.

Each path is resolved against `config.assetStorageDir` and **verified to still resolve inside it**
before unlinking. The strings come from the database, so the check is cheap insurance against a
path escaping the asset store.

Responses: `200` deleted · `404` not found · `409` in use.

### Confirmation

A plain `confirm()` naming the file and its size, matching the existing pattern at
`dashboard/components/period-manager.tsx:245`. No new modal component for one destructive action.

## Verification

The dashboard has **no test framework** — all 339 tests are pytest under `worker/`, and the
worker plays no part in deleting assets. Adding vitest is a separate decision, not smuggled in
here. Verification is therefore browser plus direct DB/disk inspection:

1. `/media` loads; 9 items, the correct 7 marked unused, sizes sum to the header total.
2. Delete one test asset → card disappears; row gone from `assets`; file gone from
   `data/assets`; `du -sh data/assets` drops by that file's size.
3. `curl -X DELETE` against asset 1 and asset 8 (both in posts) → `409`, rows intact.
4. Delete an asset with a `publish_path` and `thumbnail_path` (asset 5 or 6) → all three files
   removed.
5. Screenshot of the finished page.

## Out of scope

Bulk/multi-select delete, an empty-trash flow, force-deleting a used asset, deduplicating the
store, and any worker-side change.
