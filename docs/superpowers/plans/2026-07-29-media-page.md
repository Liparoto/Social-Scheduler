# Media Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/media` page that lists every stored asset with its size and usage, and lets the owner permanently delete the unused ones.

**Architecture:** A server page loads one new query (`listAssetsWithUsage()`) and hands it to a client grid component. Deletion goes through `DELETE /api/assets/[id]`, which removes the database row under a guard that lives on the `DELETE` statement itself, then unlinks the files. No schema change, no new dependency, no worker change.

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, better-sqlite3. Existing components only.

## Global Constraints

- **Branch:** `media-page`. Do not commit to `main`.
- **No new dependencies.** Nothing added to `dashboard/package.json`.
- **No migration.** The schema does not change.
- **No test framework exists in the dashboard.** All 339 tests are pytest under `worker/`, and the worker is not involved. Do not add vitest/jest. Each task is verified by typecheck + lint + a real browser or `curl` check, exactly as written in its steps.
- **Delete order is DB row first, then files.** Never the reverse.
- **Only delete inside the asset store.** Every path is resolved against `config.assetStorageDir` and checked with `abs.startsWith(base + path.sep)` before unlinking, matching `dashboard/app/api/media/[id]/route.ts:46`.
- **Never force-delete a used asset.** `post_assets.asset_id` is `ON DELETE RESTRICT`; the UI explains, it does not override.
- Dev server runs on **port 3939**.
- Every task ends with a commit. Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/lib/queries.ts` (modify) | Add `listAssetsWithUsage()` + `deleteAsset()`; remove dead `recentAssets()` |
| `dashboard/app/media/page.tsx` (create) | Server component: load assets, render header + empty state |
| `dashboard/components/media-manager.tsx` (create) | Client component: the grid, the delete button, the lightbox |
| `dashboard/components/sidebar.tsx` (modify) | One nav entry |
| `dashboard/app/api/assets/[id]/route.ts` (create) | `DELETE` handler: guard, row, files |

---

### Task 1: The Media page, read-only

Deliverable: `/media` lists all assets with size and usage. No delete anywhere yet — this task cannot destroy anything.

**Files:**
- Modify: `dashboard/lib/queries.ts` (replace `recentAssets()` at line 188)
- Create: `dashboard/app/media/page.tsx`
- Create: `dashboard/components/media-manager.tsx`
- Modify: `dashboard/components/sidebar.tsx:12` (add entry after Library)

**Interfaces:**
- Consumes: `getDb()` from `dashboard/lib/db.ts`; `humanBytes`, `videoPreviewSrc` from `dashboard/lib/format.ts`; `PageHeader`, `EmptyState` from `dashboard/components/ui.tsx`; `MediaBadge`, `MediaLightbox`, `LightboxAsset` from `dashboard/components/media-lightbox.tsx`.
- Produces: `AssetWithUsage` interface and `listAssetsWithUsage(): AssetWithUsage[]`, both consumed by Task 3. `MediaManager({ assets }: { assets: AssetWithUsage[] })`.

- [ ] **Step 1: Replace the dead query in `dashboard/lib/queries.ts`**

Delete `recentAssets()` entirely (lines 188-192 — nothing calls it; confirm with `grep -rn "recentAssets" dashboard --include="*.ts" --include="*.tsx"`) and put this in its place:

```ts
export interface AssetWithUsage {
  id: number;
  content_hash: string;
  media_kind: "image" | "video";
  original_filename: string | null;
  storage_path: string;
  publish_path: string | null;
  thumbnail_path: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  duration_ms: number | null;
  cover_frame_ms: number | null;
  created_at: string;
  post_count: number;
  first_post_id: number | null;
  first_post_status: string | null;
}

/**
 * Every asset with how many posts use it. The nested SELECT does the GROUP BY, then the
 * outer join resolves the post's status — an aggregate (MIN) can't be referenced from a
 * correlated subquery in the same SELECT list, so it has to happen one level up.
 */
export function listAssetsWithUsage(): AssetWithUsage[] {
  return getDb()
    .prepare(
      `SELECT u.*, p.status AS first_post_status
         FROM (
           SELECT a.*,
                  COUNT(pa.post_id) AS post_count,
                  MIN(pa.post_id)   AS first_post_id
             FROM assets a
             LEFT JOIN post_assets pa ON pa.asset_id = a.id
            GROUP BY a.id
         ) u
         LEFT JOIN posts p ON p.id = u.first_post_id
        ORDER BY u.created_at DESC, u.id DESC`
    )
    .all() as AssetWithUsage[];
}
```

- [ ] **Step 2: Create `dashboard/components/media-manager.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { humanBytes, videoPreviewSrc } from "@/lib/format";
import { MediaBadge, MediaLightbox, type LightboxAsset } from "@/components/media-lightbox";
import type { AssetWithUsage } from "@/lib/queries";

function durationLabel(ms: number | null): string | null {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function MediaManager({ assets }: { assets: AssetWithUsage[] }) {
  const [openMedia, setOpenMedia] = useState<{ asset: LightboxAsset; label: string } | null>(
    null
  );

  const summary = useMemo(() => {
    const unused = assets.filter((a) => a.post_count === 0);
    const bytes = (list: AssetWithUsage[]) =>
      list.reduce((sum, a) => sum + (a.byte_size ?? 0), 0);
    return {
      count: assets.length,
      total: bytes(assets),
      unusedCount: unused.length,
      unusedBytes: bytes(unused),
    };
  }, [assets]);

  return (
    <div>
      <p className="mb-6 text-sm text-faint">
        {summary.count} {summary.count === 1 ? "item" : "items"} · {humanBytes(summary.total)}
        {summary.unusedCount > 0 ? (
          <>
            {" "}
            · {summary.unusedCount} unused ({humanBytes(summary.unusedBytes)})
          </>
        ) : null}
      </p>

      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((a) => {
          const name = a.original_filename ?? `Asset ${a.id}`;
          const used = a.post_count > 0;
          return (
            <li
              key={a.id}
              className="overflow-hidden rounded-card border border-border bg-surface"
            >
              <div className="relative aspect-square bg-surface-sunken">
                {a.media_kind === "video" ? (
                  // No thumbnail file exists for video (no ffmpeg dependency by design) —
                  // render the real file with preload="metadata" so the browser decodes
                  // just one frame. Same approach as library-view.tsx.
                  <video
                    src={videoPreviewSrc(a.id, a.cover_frame_ms)}
                    preload="metadata"
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${a.id}?variant=thumb`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                <MediaBadge
                  mediaKind={a.media_kind}
                  label={name}
                  onOpen={() =>
                    setOpenMedia({
                      label: name,
                      asset: {
                        id: a.id,
                        media_kind: a.media_kind,
                        cover_frame_ms: a.cover_frame_ms,
                        width: a.width,
                        height: a.height,
                      },
                    })
                  }
                />
              </div>

              <div className="space-y-1 p-3">
                <p className="truncate text-sm font-medium" title={name}>
                  {name}
                </p>
                <p className="text-xs text-faint">
                  {humanBytes(a.byte_size)}
                  {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
                  {durationLabel(a.duration_ms) ? ` · ${durationLabel(a.duration_ms)}` : ""}
                </p>
                {used ? (
                  <p className="text-xs text-faint">
                    In{" "}
                    <Link
                      href={`/library/${a.first_post_id}`}
                      className="text-brand underline underline-offset-2"
                    >
                      post #{a.first_post_id}
                    </Link>
                    {a.first_post_status ? ` (${a.first_post_status})` : ""}
                    {a.post_count > 1 ? ` +${a.post_count - 1} more` : ""}
                  </p>
                ) : (
                  <p className="text-xs text-faint">Unused</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {openMedia ? (
        <MediaLightbox
          asset={openMedia.asset}
          label={openMedia.label}
          onClose={() => setOpenMedia(null)}
        />
      ) : null}
    </div>
  );
}
```

The classes above are the project's real theme tokens (`rounded-card`, `border-border`, `bg-surface`, `bg-surface-sunken`, `text-faint`), verified against `library-view.tsx` and `period-manager.tsx`. **Do not invent new class names and never hardcode a hex value** — this project has a token-based theme system covering 7 families × light/dark, and a raw colour will look wrong in six of them. If you need a token that isn't listed here, copy one from an existing component rather than guessing.

- [ ] **Step 3: Create `dashboard/app/media/page.tsx`**

```tsx
import Link from "next/link";
import { listAssetsWithUsage } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/ui";
import { MediaManager } from "@/components/media-manager";

export const dynamic = "force-dynamic";

export default function MediaPage() {
  const assets = listAssetsWithUsage();

  return (
    <div>
      <PageHeader
        title="Media"
        subtitle="Every file in your asset store. Anything not attached to a post can be deleted to reclaim disk space."
      />
      <div className="px-8 py-6">
        {assets.length === 0 ? (
          <EmptyState title="No media yet">
            Upload something on{" "}
            <Link href="/compose" className="text-brand underline underline-offset-2">
              Compose
            </Link>
            .
          </EmptyState>
        ) : (
          <MediaManager assets={assets} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the sidebar entry**

In `dashboard/components/sidebar.tsx`, after the `/library` line (line 12):

```ts
  { href: "/media", label: "Media", hint: "Stored files & cleanup" },
```

- [ ] **Step 5: Typecheck and lint**

```bash
cd dashboard && npx tsc --noEmit && npm run lint
```

Expected: both clean. `tsc` will flag it if `AssetWithUsage` and the component props disagree.

- [ ] **Step 6: Verify in the browser**

Start the dev server (port 3939) and load `http://localhost:3939/media`. Confirm all of:
- 9 cards render, newest first.
- The summary line reads `9 items · ~110 MB · 7 unused (~100 MB)`.
- Assets **1** and **8** show "In post #…"; the other seven show "Unused".
- Video cards paint a real frame, not a black box.
- Clicking a card's play/view badge opens the lightbox; Escape closes it.
- The Media entry appears in the sidebar and highlights when active.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/app/media/page.tsx dashboard/components/media-manager.tsx dashboard/components/sidebar.tsx
git commit -m "feat(dashboard): a Media page listing every stored asset

Replaces the never-called recentAssets() with listAssetsWithUsage(), which
reports how many posts use each asset. Read-only for now — the delete path
lands next.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: The delete endpoint

Deliverable: `DELETE /api/assets/:id` works from `curl` — 409 for a used asset, 200 plus files gone for an unused one. No UI yet.

**This task deletes real files. It is implemented by the main model, not delegated.**

**Files:**
- Modify: `dashboard/lib/queries.ts` (add `deleteAsset()` after `listAssetsWithUsage()`)
- Create: `dashboard/app/api/assets/[id]/route.ts`

**Interfaces:**
- Consumes: `getAsset(id)` from `dashboard/lib/queries.ts:108`; `config.assetStorageDir` from `dashboard/lib/config.ts`.
- Produces: `deleteAsset(id: number): "ok" | "not_found" | "in_use"`, and the endpoint Task 3 calls.

- [ ] **Step 1: Add `deleteAsset()` to `dashboard/lib/queries.ts`**

```ts
/**
 * Delete an asset row. The guard lives ON the DELETE so it can't race a compose that
 * attaches this asset a millisecond from now: if a post_assets row appears in between,
 * NOT EXISTS fails and the DELETE no-ops (0 rows) instead of the FK throwing.
 *
 * The catch is deliberate and broader than post_assets. Any foreign key pointing at
 * assets gets to veto — including assets.cover_asset_id, which exists on the
 * custom-cover-image branch (migration 0012) but not on main. That branch will not need
 * to touch this function.
 */
export function deleteAsset(id: number): "ok" | "not_found" | "in_use" {
  const db = getDb();
  const row = db.prepare("SELECT id FROM assets WHERE id = ?").get(id);
  if (!row) return "not_found";
  try {
    const info = db
      .prepare(
        `DELETE FROM assets
          WHERE id = @id
            AND NOT EXISTS (SELECT 1 FROM post_assets WHERE asset_id = @id)`
      )
      .run({ id });
    return info.changes > 0 ? "ok" : "in_use";
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code.startsWith("SQLITE_CONSTRAINT")) return "in_use";
    throw err;
  }
}
```

- [ ] **Step 2: Create `dashboard/app/api/assets/[id]/route.ts`**

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { deleteAsset, getAsset } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * Unlink a stored file, but only if it really resolves inside the asset store — these
 * paths come out of the database, and a path that escapes the store must never be
 * deleted. Same containment check as api/media/[id]/route.ts:46.
 * Returns the path if it could NOT be removed, so the caller can report leftovers.
 */
async function unlinkInsideStore(rel: string | null): Promise<string | null> {
  if (!rel) return null;
  const base = path.resolve(config.assetStorageDir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) return rel;
  try {
    await fs.unlink(abs);
    return null;
  } catch (err) {
    // Already gone is success — the row is what the UI reads.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return rel;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Read the paths BEFORE the row disappears — after the DELETE there is nothing to
  // read them from.
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }

  const result = deleteAsset(Number(id));
  if (result === "not_found") {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  if (result === "in_use") {
    return NextResponse.json(
      {
        error:
          "This file is attached to a post, so it can't be deleted. Remove it from the post first.",
      },
      { status: 409 }
    );
  }

  // Row is gone — now the files. Order matters: a failed row delete must never leave
  // files deleted, but a failed file delete only leaves harmless bytes behind.
  const leftover = (
    await Promise.all([
      unlinkInsideStore(asset.storage_path),
      unlinkInsideStore(asset.publish_path),
      unlinkInsideStore(asset.thumbnail_path),
    ])
  ).filter((p): p is string => p !== null);

  if (leftover.length > 0) {
    console.warn(`Asset ${id} row deleted, but these files remain: ${leftover.join(", ")}`);
  }
  return NextResponse.json({ ok: true, leftover });
}
```

- [ ] **Step 3: Typecheck and lint**

```bash
cd dashboard && npx tsc --noEmit && npm run lint
```

Expected: both clean.

- [ ] **Step 4: Prove the guard blocks a used asset**

With the dev server running, asset 1 is attached to post 1:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:3939/api/assets/1
```

Expected: `409`. Then confirm the row survived:

```bash
sqlite3 data/socialscheduler.db "SELECT count(*) FROM assets WHERE id = 1;"
```

Expected: `1`. Repeat both for asset `8` (attached to the Reel).

- [ ] **Step 5: Prove a real delete removes row and files**

Asset 3 is `clean-portrait.mp4`, a test file, unused. Record the state first:

```bash
sqlite3 data/socialscheduler.db "SELECT id, storage_path FROM assets WHERE id = 3;" && du -sh data/assets
```

Delete it and check:

```bash
curl -s -X DELETE http://localhost:3939/api/assets/3
sqlite3 data/socialscheduler.db "SELECT count(*) FROM assets WHERE id = 3;"
ls data/assets | grep 8016b3fc || echo "file gone"
```

Expected: `{"ok":true,"leftover":[]}`, then `0`, then `file gone`.

- [ ] **Step 6: Prove all three file variants are removed**

Asset 5 (`red-square.png`) is unused and has all of `storage_path`, `publish_path`, and `thumbnail_path`:

```bash
curl -s -X DELETE http://localhost:3939/api/assets/5
ls data/assets/pub data/assets/thumbs 2>/dev/null | grep bd60047917 || echo "derivatives gone"
```

Expected: `{"ok":true,"leftover":[]}` and `derivatives gone`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/app/api/assets/\[id\]/route.ts
git commit -m "feat(dashboard): DELETE /api/assets/:id — remove an unused asset

The guard lives on the DELETE statement, so an asset attached to a post in
the moment between check and delete no-ops rather than throwing. A caught
SQLITE_CONSTRAINT lets any foreign key veto, including the cover_asset_id
that exists on the custom-cover-image branch but not here.

Row first, then files: a refused delete touches no bytes, and each path is
verified to resolve inside the asset store before it's unlinked.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Wire the delete button into the page

Deliverable: an unused asset can be deleted by clicking, with a confirm dialog; a used asset has no button.

**Files:**
- Modify: `dashboard/components/media-manager.tsx`

**Interfaces:**
- Consumes: `DELETE /api/assets/:id` from Task 2 (`200 {ok, leftover}` / `404 {error}` / `409 {error}`); `AssetWithUsage` from Task 1.
- Produces: nothing further.

- [ ] **Step 1: Add the delete state and handler to `MediaManager`**

Add these imports to the existing import block:

```tsx
import { useTransition } from "react";
import { useRouter } from "next/navigation";
```

Add inside the component, next to the existing `openMedia` state:

```tsx
  const router = useRouter();
  const [pending, startT] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function remove(a: AssetWithUsage) {
    const name = a.original_filename ?? `Asset ${a.id}`;
    if (
      !confirm(
        `Delete “${name}” (${humanBytes(a.byte_size)})?\n\n` +
          `The file is removed from disk permanently. This cannot be undone.`
      )
    )
      return;
    setError(null);
    setBusyId(a.id);
    try {
      const res = await fetch(`/api/assets/${a.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not delete that file.");
        return;
      }
      startT(() => router.refresh());
    } catch {
      setError("Could not reach the server. Is the dashboard still running?");
    } finally {
      setBusyId(null);
    }
  }
```

- [ ] **Step 2: Render the error banner**

Immediately before the `<ul className="grid ...">`:

```tsx
      {error ? (
        <p className="mb-4 rounded-lg bg-accent-weak px-3 py-2 text-sm text-accent-strong">
          {error}
        </p>
      ) : null}
```

Those are the exact classes `composer.tsx:679` uses for its error banner. Keep them identical so errors look the same everywhere in the app.

- [ ] **Step 3: Render the button on unused assets only**

Replace the `Unused` paragraph from Task 1 with:

```tsx
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-faint">Unused</span>
                    <button
                      type="button"
                      onClick={() => remove(a)}
                      disabled={busyId === a.id || pending}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-status-failed hover:bg-surface-sunken disabled:opacity-50"
                    >
                      {busyId === a.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
```

The used branch keeps its "In post #…" paragraph and gets **no button** — absent, not disabled. A greyed-out button invites clicking and then has to explain itself.

- [ ] **Step 4: Typecheck and lint**

```bash
cd dashboard && npx tsc --noEmit && npm run lint
```

- [ ] **Step 5: Verify in the browser**

On `http://localhost:3939/media`:
- Used assets (1 and 8) show **no** Delete button.
- Click Delete on an unused asset → confirm dialog names the file and its size.
- Cancel → nothing happens; the card is still there.
- Accept → the card disappears, the summary count and total drop.
- Confirm on disk: `ls data/assets` no longer lists that hash, and `du -sh data/assets` has shrunk.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/media-manager.tsx
git commit -m "feat(dashboard): delete unused media from the Media page

Confirm dialog names the file and size, matching period-manager.tsx. Used
assets get no button at all rather than a disabled one.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Clean up the test assets and close out

Deliverable: the leftover test assets are gone, the docs are updated, the branch is ready to merge.

**Files:**
- Modify: `docs/tasks.md`

- [ ] **Step 1: Delete the remaining test assets through the UI**

Through `/media`, delete every remaining unused test asset (originally ids 2, 4, 6, 7, 9 — ids 3 and 5 went during Task 2). Asset 9 is the 8 MB wedding photo and asset 7 is a real personal video; both are unused copies, but **confirm with the owner before deleting those two.**

- [ ] **Step 2: Verify the store shrank**

```bash
du -sh data/assets && sqlite3 data/socialscheduler.db "SELECT count(*) FROM assets;"
```

Expected: 2 assets remaining (1 and 8), and roughly **45 MB reclaimed** — corrected from the estimate written before Task 1 ran. The live page reports the unused set as 45.3 MB, not ~100 MB, because the 49.4 MB `IMG_3707.MOV` is asset 8 and is *in use* by the Reel. `du -sh data/assets` will not fall as far as the byte_size total suggests, since asset 8's converted derivative under `pub/` stays too.

- [ ] **Step 3: Confirm nothing else broke**

Load `/`, `/library`, and `/compose`. The scheduled post and the Reel must still render their media. Then run the worker's suite, which must be untouched:

```bash
cd worker && .venv/bin/python -m pytest -q
```

Expected: 339 passed.

- [ ] **Step 4: Check for orphaned files**

Every file left in the store should belong to a surviving row:

```bash
sqlite3 data/socialscheduler.db "SELECT storage_path FROM assets UNION SELECT publish_path FROM assets WHERE publish_path IS NOT NULL UNION SELECT thumbnail_path FROM assets WHERE thumbnail_path IS NOT NULL;"
find data/assets -type f | sed "s|^data/assets/||"
```

Compare the two lists. Any extra file is a pre-existing orphan, not something this work created — report it, don't silently delete it.

- [ ] **Step 5: Update `docs/tasks.md`**

Add the Media page to the completed list, following the existing format in that file.

- [ ] **Step 6: Commit and report**

```bash
git add docs/tasks.md
git commit -m "docs: record the Media page in tasks.md

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Then take a screenshot of the finished page for the owner and report the reclaimed disk space. Do not merge to `main` without the owner's say-so.

---

## Notes for the implementer

- **The 8 MB image has no thumbnail.** Assets 1 and 9 have `thumbnail_path` NULL, so their cards load the full-size original — `/api/media/:id?variant=thumb` falls back to `storage_path`. On a local install over loopback this is fine; generating missing thumbnails is deliberately out of scope.
- **`humanBytes(null)`** already handles a null `byte_size`; check its output format in `dashboard/lib/format.ts:52` before assuming units.
- **Do not touch the worker.** It never deletes assets and has no part in this.
