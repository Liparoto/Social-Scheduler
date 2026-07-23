# Bulk Import (Manual) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner select many images at once on a Bulk import page and create one Draft post per image with shared batch defaults (targets, kind, status, tags, periods), reusing the existing upload + draft machinery.

**Architecture:** A new `/import` page uploads each image through the existing `/api/assets/upload`, then POSTs the asset ids + per-image captions + shared defaults to a new `POST /api/posts/bulk-import`, which creates all drafts in ONE transaction via a new `createDraftPostsBulk` query wrapping the existing `createDraftPost`. No schema change; no new external dependency.

**Tech Stack:** Next.js 16 App Router + TypeScript + Tailwind v4 + better-sqlite3.

## Global Constraints

- **No schema/migration change. No new dependencies. Fully local — no cloud/LLM.** (AI captioning is explicitly out of scope; see spec §7.)
- **All Next.js route handlers / server pages set `export const runtime = "nodejs"`** (better-sqlite3 is native).
- **`content_status` (draft/ready/retired — automation eligibility) is SEPARATE from `posts.status` (publish lifecycle).** Bulk import writes `content_status`, defaulting to `draft`. Never conflate.
- **Batch is all-or-nothing:** one transaction around all N drafts; any validation failure creates nothing (validate fully before writing).
- **Reuse existing pieces:** `/api/assets/upload` (hash/dedup/store — dedup by content hash, never filename), `createDraftPost`, the validators in `dashboard/lib/content-model-validation.ts` (`parseTagIds`, `parsePeriodLinks`), `getChannel`/`getAsset`/`getPeriod`, and the UI components `TagEditor` / `PeriodAttach` / the composer's channel-picker pattern / `/api/media/{id}?variant=thumb`.
- **Batch cap: ≤ 100 images per request** → 400 if exceeded (never silently truncate).
- Match the composer/edit visual language (segmented control active = `bg-brand-weak font-medium text-brand-ink`; `card = rounded-card border border-border bg-surface p-5`). Spec: `docs/design-bulk-import.md`.

### Reused interfaces (verified in the codebase)
- `createDraftPost(input: CreateDraftInput): number`, where `CreateDraftInput extends ContentModelInput` and adds `caption: string; first_comment: string; asset_ids: number[]; created_by?: string`. `ContentModelInput` = `{ target_channel_ids?: number[]; content_kind?: ContentKind; content_status?: ContentStatus; cooldown_days?: number|null; caption_variants?: {platform: string|null; body: string; sort_order: number}[]; period_links?: {periodId: number; mode: PeriodMode}[]; tag_ids?: number[] }`. It writes the post with `status='draft'` and calls `insertContentModelRows` for the side tables.
- `POST /api/assets/upload` returns `{ asset: Asset, deduped: boolean }` (asset has `id`).
- `parseTagIds(input, tagExists): number[] | "invalid" | undefined`; `parsePeriodLinks(input, getPeriod): {periodId, mode}[] | "invalid" | undefined`.
- `getAsset(id)`, `getChannel(id)`, `getPeriod(id)`, `getChannels()`, `listPeriods()`, `listTags(kind?)`.
- `TagEditor({ timeOfDayTags: Tag[]; topicTags: Tag[]; value: number[]; onChange })`; `PeriodAttach({ periods: Period[]; value: Record<number, PeriodMode>; onChange })`.

---

### Task 1: `createDraftPostsBulk` query

**Files:**
- Modify: `dashboard/lib/queries.ts` (add types + one function)

**Interfaces:**
- Consumes: existing `createDraftPost`.
- Produces:
  - `BulkDraftItem = { asset_id: number; caption: string }`
  - `BulkDraftShared = { target_channel_ids?: number[]; content_kind?: ContentKind; content_status?: ContentStatus; tag_ids?: number[]; period_links?: { periodId: number; mode: PeriodMode }[] }`
  - `createDraftPostsBulk(items: BulkDraftItem[], shared: BulkDraftShared): number[]`

- [ ] **Step 1: Add the function**

In `dashboard/lib/queries.ts`, after `createDraftPost` (~line 300), add:

```typescript
export interface BulkDraftItem {
  asset_id: number;
  caption: string;
}
export interface BulkDraftShared {
  target_channel_ids?: number[];
  content_kind?: ContentKind;
  content_status?: ContentStatus;
  tag_ids?: number[];
  period_links?: { periodId: number; mode: PeriodMode }[];
}

/**
 * Create one single-image draft post per item, ALL in one transaction (better-sqlite3
 * nests createDraftPost's own transaction via savepoints, so the batch commits or rolls
 * back together). A non-empty caption becomes the post's single generic caption variant.
 * Returns the new post ids.
 */
export function createDraftPostsBulk(items: BulkDraftItem[], shared: BulkDraftShared): number[] {
  const db = getDb();
  const tx = db.transaction((rows: BulkDraftItem[]) => {
    const ids: number[] = [];
    for (const item of rows) {
      const caption = item.caption.trim();
      ids.push(
        createDraftPost({
          caption,
          first_comment: "",
          asset_ids: [item.asset_id],
          target_channel_ids: shared.target_channel_ids,
          content_kind: shared.content_kind,
          content_status: shared.content_status,
          tag_ids: shared.tag_ids,
          period_links: shared.period_links,
          caption_variants: caption
            ? [{ platform: null, body: caption, sort_order: 0 }]
            : undefined,
        })
      );
    }
    return ids;
  });
  return tx(items);
}
```

(`ContentKind`, `ContentStatus`, `PeriodMode` are already imported in `queries.ts`.)

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 3: Commit**

```bash
git add dashboard/lib/queries.ts
git commit -m "feat(dashboard): createDraftPostsBulk — N single-image drafts in one transaction"
```

---

### Task 2: `POST /api/posts/bulk-import` route

**Files:**
- Create: `dashboard/app/api/posts/bulk-import/route.ts`

**Interfaces:**
- Consumes: `createDraftPostsBulk` (Task 1), `getAsset`, `getChannel`, `getPeriod`, `listTags`, `parseTagIds`, `parsePeriodLinks`.
- `POST` body: `{ items: { asset_id: number; caption?: string }[], target_channel_ids?, content_kind?, content_status?, tag_ids?, period_links? }` → `{ created: number }`.

- [ ] **Step 1: Create the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createDraftPostsBulk, getAsset, getChannel, getPeriod, listTags } from "@/lib/queries";
import type { ContentKind, ContentStatus } from "@/lib/types";
import { parsePeriodLinks, parseTagIds } from "@/lib/content-model-validation";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  // --- items (one per image) ---
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "Add at least one image." }, { status: 400 });
  }
  if (body.items.length > 100) {
    return NextResponse.json({ error: "A batch can hold at most 100 images." }, { status: 400 });
  }
  const items: { asset_id: number; caption: string }[] = [];
  for (const it of body.items) {
    const assetId = Number(it?.asset_id);
    if (!Number.isInteger(assetId) || !getAsset(assetId)) {
      return NextResponse.json({ error: `Unknown asset ${it?.asset_id}.` }, { status: 400 });
    }
    if (it.caption !== undefined && typeof it.caption !== "string") {
      return NextResponse.json({ error: "caption must be a string." }, { status: 400 });
    }
    items.push({ asset_id: assetId, caption: typeof it.caption === "string" ? it.caption : "" });
  }

  // --- shared defaults (same rules as /api/posts/draft) ---
  let contentKind: ContentKind | undefined;
  if (body.content_kind !== undefined) {
    if (body.content_kind !== "evergreen" && body.content_kind !== "one_time") {
      return NextResponse.json({ error: "Invalid content_kind." }, { status: 400 });
    }
    contentKind = body.content_kind;
  }

  let contentStatus: ContentStatus | undefined;
  if (body.content_status !== undefined) {
    if (body.content_status !== "draft" && body.content_status !== "ready") {
      return NextResponse.json({ error: "Invalid content_status." }, { status: 400 });
    }
    contentStatus = body.content_status;
  }

  let targetChannelIds: number[] | undefined;
  if (body.target_channel_ids !== undefined) {
    if (!Array.isArray(body.target_channel_ids)) {
      return NextResponse.json({ error: "Invalid target_channel_ids." }, { status: 400 });
    }
    for (const cid of body.target_channel_ids) {
      if (typeof cid !== "number" || !getChannel(cid)) {
        return NextResponse.json({ error: `Unknown channel ${cid}.` }, { status: 400 });
      }
    }
    targetChannelIds = body.target_channel_ids;
  }

  const validTagIds = new Set(listTags().map((t) => t.id));
  const tagIds = parseTagIds(body.tag_ids, (id) => validTagIds.has(id));
  if (tagIds === "invalid") {
    return NextResponse.json({ error: "Invalid tag_ids." }, { status: 400 });
  }

  const periodLinks = parsePeriodLinks(body.period_links, getPeriod);
  if (periodLinks === "invalid") {
    return NextResponse.json({ error: "Invalid period_links." }, { status: 400 });
  }

  const ids = createDraftPostsBulk(items, {
    target_channel_ids: targetChannelIds,
    content_kind: contentKind,
    content_status: contentStatus,
    tag_ids: tagIds ?? undefined,
    period_links: periodLinks ?? undefined,
  });
  return NextResponse.json({ created: ids.length }, { status: 201 });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Reason through the validation (record in report)**

Confirm: empty/missing `items` → 400; >100 → 400; unknown `asset_id` → 400 (nothing created); non-string caption → 400; bad `content_kind`/`content_status`/`target_channel_ids`/`tag_ids`/`period_links` → 400 BEFORE any write; a valid batch with only `items` (no shared defaults) creates N drafts with schema defaults (evergreen/draft). All validation runs before `createDraftPostsBulk`, so a 400 leaves zero rows.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/api/posts/bulk-import/route.ts
git commit -m "feat(dashboard): POST /api/posts/bulk-import — validated batch draft creation"
```

---

### Task 3: `/import` page + `<BulkImport>` component + nav

**Files:**
- Create: `dashboard/app/import/page.tsx` (server)
- Create: `dashboard/components/bulk-import.tsx` (client)
- Modify: `dashboard/components/sidebar.tsx` (add Import nav item)
- Modify: `dashboard/app/library/page.tsx` (add a "Bulk import" link near the header)

**Interfaces:**
- Consumes: `/api/assets/upload`, `POST /api/posts/bulk-import` (Task 2), `TagEditor`, `PeriodAttach`, `getChannels`/`listPeriods`/`listTags`.

- [ ] **Step 1: Create the server page `dashboard/app/import/page.tsx`**

```tsx
import { getChannels, listPeriods, listTags } from "@/lib/queries";
import { BulkImport } from "@/components/bulk-import";

export const runtime = "nodejs";

export default function ImportPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold text-ink">Bulk import</h1>
        <p className="mt-1 text-sm text-muted">
          Add many images at once — each becomes a Draft you can tag, target, and schedule.
        </p>
      </header>
      <BulkImport
        channels={getChannels()}
        periods={listPeriods()}
        timeOfDayTags={listTags("time_of_day")}
        topicTags={listTags("topic")}
      />
    </div>
  );
}
```

- [ ] **Step 2: Create the client component `dashboard/components/bulk-import.tsx`**

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import type { Channel, ContentKind, ContentStatus, Period, PeriodMode, Tag } from "@/lib/types";
import { TagEditor } from "./tag-editor";
import { PeriodAttach } from "./period-attach";

type Item = { assetId: number; name: string; caption: string; deduped: boolean };

const card = "rounded-card border border-border bg-surface p-5";
const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-ink" : "text-muted hover:text-ink"
  }`;

export function BulkImport({
  channels,
  periods,
  timeOfDayTags,
  topicTags,
}: {
  channels: Channel[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [uploading, setUploading] = useState(false);
  const [targets, setTargets] = useState<Set<number>>(new Set());
  const [kind, setKind] = useState<ContentKind>("evergreen");
  const [status, setStatus] = useState<ContentStatus>("draft");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<number | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);
    setResult(null);
    setUploading(true);
    let dedup = 0;
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Couldn't upload ${file.name}.`);
        continue;
      }
      if (body.deduped) dedup += 1;
      setItems((prev) => [
        ...prev,
        { assetId: body.asset.id, name: file.name, caption: "", deduped: body.deduped },
      ]);
    }
    if (dedup > 0) setNotice(`${dedup} image(s) already existed (matched by content) — reused.`);
    setUploading(false);
  }

  const setCaption = (i: number, caption: string) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, caption } : it)));
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const toggleTarget = (id: number) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function create() {
    setError(null);
    setResult(null);
    setCreating(true);
    const res = await fetch("/api/posts/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map((it) => ({ asset_id: it.assetId, caption: it.caption })),
        target_channel_ids: Array.from(targets),
        content_kind: kind,
        content_status: status,
        tag_ids: tagIds,
        period_links: Object.entries(periodModes).map(([pid, mode]) => ({
          periodId: Number(pid),
          mode,
        })),
      }),
    });
    setCreating(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not create drafts.");
      return;
    }
    const b = await res.json();
    setResult(b.created);
    setItems([]);
  }

  return (
    <div className="space-y-6">
      {/* Upload */}
      <section className={card}>
        <label className="inline-flex cursor-pointer items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-ink">
          {uploading ? "Uploading…" : "Add images"}
          <input
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
        </label>
        <p className="mt-2 text-xs text-muted">
          Each image becomes its own Draft. Dedup is by content — the same file won’t be stored twice.
        </p>
        {notice ? <p className="mt-2 text-xs text-status-posted">{notice}</p> : null}
      </section>

      {/* Grid of selected images */}
      {items.length > 0 ? (
        <section className={card}>
          <h3 className="mb-3 font-display text-sm font-semibold text-ink">
            {items.length} image{items.length === 1 ? "" : "s"} — add captions (optional)
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {items.map((it, i) => (
              <div key={it.assetId} className="flex gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${it.assetId}?variant=thumb`}
                  alt=""
                  className="h-20 w-20 shrink-0 rounded-lg object-cover"
                />
                <div className="flex-1">
                  <textarea
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand"
                    rows={2}
                    placeholder="Caption (optional)…"
                    value={it.caption}
                    onChange={(e) => setCaption(i, e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    className="mt-1 text-xs text-muted hover:text-status-failed"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Batch defaults */}
      <section className={card}>
        <h3 className="mb-1 font-display text-sm font-semibold text-ink">Batch defaults</h3>
        <p className="mb-3 text-xs text-muted">Applied to every image in this batch. Refine each later in the Library.</p>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Target accounts</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {channels.map((c) => {
              const on = targets.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleTarget(c.id)}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    on ? "border-brand bg-brand-weak" : "border-border hover:bg-surface-sunken"
                  }`}
                >
                  <span className="text-sm text-ink">{c.account_name}</span>
                  <span className="ml-auto text-xs text-muted">{c.platform}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Kind</p>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <button type="button" className={segBtn(kind === "evergreen")} onClick={() => setKind("evergreen")}>Evergreen</button>
            <button type="button" className={segBtn(kind === "one_time")} onClick={() => setKind("one_time")}>One-time</button>
          </div>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Status</p>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <button type="button" className={segBtn(status === "draft")} onClick={() => setStatus("draft")}>Draft</button>
            <button type="button" className={segBtn(status === "ready")} onClick={() => setStatus("ready")}>Ready</button>
          </div>
          <p className="mt-1 text-xs text-faint">Ready content is eligible for auto-fill; drafts are not.</p>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Tags</p>
          <TagEditor timeOfDayTags={timeOfDayTags} topicTags={topicTags} value={tagIds} onChange={setTagIds} />
        </div>

        <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />
      </section>

      {error ? <p className="text-sm text-status-failed">{error}</p> : null}
      {result !== null ? (
        <p className="text-sm text-status-posted">
          Created {result} draft{result === 1 ? "" : "s"}.{" "}
          <Link href="/library" className="underline underline-offset-2">View in Library →</Link>
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          onClick={create}
          disabled={creating || uploading || items.length === 0}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-ink disabled:opacity-50"
        >
          {creating ? "Creating…" : `Create ${items.length} draft${items.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the Import nav item to `dashboard/components/sidebar.tsx`**

In the `NAV` array, add this entry immediately after the `/compose` entry:

```typescript
  { href: "/import", label: "Import", hint: "Bulk add images" },
```

- [ ] **Step 4: Add a "Bulk import" link to the Library header in `dashboard/app/library/page.tsx`**

Near the Library page's header (the "Library" heading / description block), add a link to `/import`:

```tsx
<Link href="/import" className="text-sm text-brand underline underline-offset-2">
  Bulk import →
</Link>
```

Add `import Link from "next/link";` to that file if it isn't already imported. Do not otherwise change the Library page.

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Browser verification (controller runs this; list it)**

Note for the controller: at `/import`, "Add images" (select 3) shows a 3-tile grid with caption boxes; caption one; pick a target + a tag; leave Status = Draft; "Create 3 drafts" → "Created 3 drafts" + Library link; Library shows 3 new Draft cards with the tag/target badges, the captioned one carrying its caption (cross-check DB). Re-importing an already-imported image shows the dedup notice and still adds a tile. The Import sidebar item and the Library "Bulk import" link both reach `/import`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/app/import/page.tsx dashboard/components/bulk-import.tsx dashboard/components/sidebar.tsx dashboard/app/library/page.tsx
git commit -m "feat(dashboard): bulk import page — multi-image upload -> batch drafts"
```

---

## Self-Review

**Spec coverage** (spec `docs/design-bulk-import.md`):
- §2 flow (multi-select → upload → grid + captions → batch defaults → create N → Library) → Task 3. ✅
- §3 one-image-one-single-draft, default Draft status, caption→variant, shared defaults → Tasks 1, 3. ✅
- §4 reuses (upload route, createDraftPost, validators, TagEditor/PeriodAttach) + new (query, route, page, component, nav) → Tasks 1–3. ✅
- §5 all-or-nothing transaction, dedup, draft default, shared validators → Tasks 1, 2. ✅
- §6 verification (tsc, browser round-trip, dedup, invalid asset/tag → 400 nothing created) → Task 2 Step 3 + Task 3 Step 6. ✅
- §7 out of scope (AI, folder, CSV, carousel) — not built; endpoint's flat per-image `items` leaves the seam. ✅

**Placeholder scan:** No TBD/TODO. Tasks 1–2 carry full code; Task 3 carries the full page + component; the two nav edits (Steps 3–4) are one-line insertions described against concrete existing structure (`NAV` array; Library header).

**Type consistency:** `BulkDraftItem`/`BulkDraftShared`/`createDraftPostsBulk` (Task 1) consumed by Task 2's route. The route's response `{created}` and request `{items, target_channel_ids, content_kind, content_status, tag_ids, period_links}` match the component's fetch body (Task 3). `createDraftPost`'s `ContentModelInput` field names (`target_channel_ids`, `content_kind`, `content_status`, `tag_ids`, `period_links`, `caption_variants`) are used verbatim in Task 1. `TagEditor`/`PeriodAttach` prop shapes match Task 3's usage.

---

## Out of scope (deferred, per spec §7)
- AI-assisted captions/tags; folder-path import; CSV manifest; carousel grouping.
