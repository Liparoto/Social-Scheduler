# Post Management (Edit) Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post edit screen at `/library/[id]` that lets you change an existing post's content-model fields (kind, status, cooldown, targets, tags, periods, caption variants), reachable by clicking a Library post's title/thumbnail.

**Architecture:** A server page loads the post + its current state via existing getters (plus one small new `getPostAssets`), passes them to a new client `<PostEditor>` that reuses the composer's building blocks (`CaptionVariantsEditor`, `TagEditor`, `PeriodAttach`, a channel picker) pre-populated, and saves through the already-built `PATCH /api/posts/[id]/content` route. No new API, no schema change.

**Tech Stack:** Next.js 16 App Router + TypeScript + Tailwind v4 + better-sqlite3.

## Global Constraints

- **`content_status` (draft/ready/retired — automation eligibility) is SEPARATE from `posts.status` (publish lifecycle).** The editor edits `content_status`; the read-only strip shows `posts.status` and must be labeled distinctly ("Schedule status"). Never conflate.
- **All Next.js route handlers / server pages set `export const runtime = "nodejs"`** (better-sqlite3 is native).
- **No new dependencies. No schema/migration change. Exactly one new query function (`getPostAssets`).** All saves go through the existing `PATCH /api/posts/[id]/content`, whose field handlers are replace-semantics.
- **Reuse existing components** (`CaptionVariantsEditor`, `TagEditor`, `PeriodAttach`) and match the composer's visual language (segmented control = active `bg-brand-weak font-medium text-brand-ink`, inactive `text-muted`; `channelColor` for channel chips; thumbnails via `/api/media/{assetId}?variant=thumb`).
- **Filter empty caption variants before saving**, like the composer: `variants.filter(v => v.body.trim()).map((v,i) => ({platform: v.platform || null, body: v.body.trim(), sort_order: i}))`.
- **Do not alter Library bulk flows.** The title/thumbnail link must `stopPropagation` so it navigates without toggling bulk-select; the rest of the card must keep its current select behavior.
- Spec: `docs/design-post-management.md`.

### Reused interfaces (already in the codebase — verified)
- `CaptionVariantsEditor({ value: CaptionVariantDraft[]; onChange })`, where `CaptionVariantDraft = { platform: string; body: string }` (exported from `@/components/caption-variants-editor`).
- `TagEditor({ timeOfDayTags: Tag[]; topicTags: Tag[]; value: number[]; onChange })` (from `@/components/tag-editor`).
- `PeriodAttach({ periods: Period[]; value: Record<number, PeriodMode>; onChange })` (from `@/components/period-attach`).
- Getters: `getPost(id): Post | undefined`, `getPostTargets(id): number[]`, `getPostTags(id): Tag[]`, `getPostPeriods(id): { period_id: number; mode: PeriodMode }[]`, `getCaptionVariants(id): CaptionVariant[]`, `getChannels(): Channel[]`, `listPeriods(): Period[]`, `listTags(kind?): Tag[]`.
- `Post` has `content_kind`, `content_status`, `cooldown_days: number | null`, `post_type`, `status`, `caption`. `Asset` has `id`. `channelColor(id)` from `@/lib/format`.

---

### Task 1: `getPostAssets` query

**Files:**
- Modify: `dashboard/lib/queries.ts` (add one function)

**Interfaces:**
- Produces: `getPostAssets(postId: number): Asset[]` — the post's assets in carousel order.

- [ ] **Step 1: Add the query**

In `dashboard/lib/queries.ts`, near the other asset helpers (after `recentAssets`, ~line 144), add:

```typescript
/** A post's assets in carousel order (for the edit screen's read-only image strip). */
export function getPostAssets(postId: number): Asset[] {
  return getDb()
    .prepare(
      `SELECT a.* FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
        WHERE pa.post_id = ? ORDER BY pa.sort_order ASC`
    )
    .all(postId) as Asset[];
}
```

(`Asset` is already imported in `queries.ts`.)

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 3: Commit**

```bash
git add dashboard/lib/queries.ts
git commit -m "feat(dashboard): getPostAssets query for the post edit screen"
```

---

### Task 2: Edit page + `<PostEditor>`

**Files:**
- Create: `dashboard/app/library/[id]/page.tsx` (server)
- Create: `dashboard/components/post-editor.tsx` (client)

**Interfaces:**
- Consumes: `getPostAssets` (Task 1) + the existing getters and components listed in Global Constraints.
- `<PostEditor>` props:
  ```typescript
  {
    post: Post;
    assets: Asset[];
    channels: Channel[];
    periods: Period[];
    timeOfDayTags: Tag[];
    topicTags: Tag[];
    initialTargets: number[];
    initialTagIds: number[];
    initialPeriods: Record<number, PeriodMode>;
    initialCaptions: { platform: string; body: string }[];
  }
  ```

- [ ] **Step 1: Create the server page `dashboard/app/library/[id]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPost,
  getPostAssets,
  getPostTargets,
  getPostTags,
  getPostPeriods,
  getCaptionVariants,
  getChannels,
  listPeriods,
  listTags,
} from "@/lib/queries";
import { PostEditor } from "@/components/post-editor";

export const runtime = "nodejs";

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const postId = Number(id);
  const post = getPost(postId);
  if (!post) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/library" className="inline-block text-sm text-brand underline underline-offset-2">
        ← Back to Library
      </Link>
      <PostEditor
        post={post}
        assets={getPostAssets(postId)}
        channels={getChannels()}
        periods={listPeriods()}
        timeOfDayTags={listTags("time_of_day")}
        topicTags={listTags("topic")}
        initialTargets={getPostTargets(postId)}
        initialTagIds={getPostTags(postId).map((t) => t.id)}
        initialPeriods={Object.fromEntries(
          getPostPeriods(postId).map((l) => [l.period_id, l.mode])
        )}
        initialCaptions={getCaptionVariants(postId).map((c) => ({
          platform: c.platform ?? "",
          body: c.body,
        }))}
      />
    </div>
  );
}
```

- [ ] **Step 2: Create the client editor `dashboard/components/post-editor.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  Asset,
  Channel,
  ContentKind,
  ContentStatus,
  Period,
  PeriodMode,
  Post,
  Tag,
} from "@/lib/types";
import { channelColor } from "@/lib/format";
import { CaptionVariantsEditor } from "./caption-variants-editor";
import { TagEditor } from "./tag-editor";
import { PeriodAttach } from "./period-attach";

const card = "rounded-card border border-border bg-surface p-5";
const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-ink" : "text-muted hover:text-ink"
  }`;

export function PostEditor({
  post,
  assets,
  channels,
  periods,
  timeOfDayTags,
  topicTags,
  initialTargets,
  initialTagIds,
  initialPeriods,
  initialCaptions,
}: {
  post: Post;
  assets: Asset[];
  channels: Channel[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  initialTargets: number[];
  initialTagIds: number[];
  initialPeriods: Record<number, PeriodMode>;
  initialCaptions: { platform: string; body: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<ContentKind>(post.content_kind);
  const [status, setStatus] = useState<ContentStatus>(post.content_status);
  const [cooldown, setCooldown] = useState(
    post.cooldown_days === null ? "" : String(post.cooldown_days)
  );
  const [targets, setTargets] = useState<Set<number>>(new Set(initialTargets));
  const [tagIds, setTagIds] = useState<number[]>(initialTagIds);
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>(initialPeriods);
  const [captions, setCaptions] = useState(
    initialCaptions.length ? initialCaptions : [{ platform: "", body: "" }]
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleTarget = (id: number) =>
    setTargets((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  async function save() {
    setError(null);
    setNotice(null);
    const body = {
      content_kind: kind,
      content_status: status,
      cooldown_days: cooldown.trim() === "" ? null : Number(cooldown),
      target_channel_ids: Array.from(targets),
      tag_ids: tagIds,
      period_links: Object.entries(periodModes).map(([pid, mode]) => ({
        periodId: Number(pid),
        mode,
      })),
      caption_variants: captions
        .filter((v) => v.body.trim())
        .map((v, i) => ({ platform: v.platform || null, body: v.body.trim(), sort_order: i })),
    };
    const res = await fetch(`/api/posts/${post.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not save changes.");
      return;
    }
    setNotice("Changes saved.");
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-6">
      {/* Read-only context strip */}
      <section className={card}>
        <div className="flex items-start gap-4">
          <div className="flex gap-2">
            {assets.length ? (
              assets.slice(0, 4).map((a) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={a.id}
                  src={`/api/media/${a.id}?variant=thumb`}
                  alt=""
                  className="h-16 w-16 rounded-lg object-cover"
                />
              ))
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-surface-sunken text-xs text-faint">
                no image
              </div>
            )}
          </div>
          <div className="data text-xs text-ink-soft">
            <p>{post.post_type}{assets.length > 1 ? ` · ${assets.length} imgs` : ""}</p>
            <p className="mt-1 text-muted">Schedule status: {post.status}</p>
            <p className="mt-0.5 text-faint">Images and scheduling are managed elsewhere.</p>
          </div>
        </div>
      </section>

      {/* Kind */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Kind</h3>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button type="button" className={segBtn(kind === "evergreen")} onClick={() => setKind("evergreen")}>
            Evergreen
          </button>
          <button type="button" className={segBtn(kind === "one_time")} onClick={() => setKind("one_time")}>
            One-time
          </button>
        </div>
      </section>

      {/* Caption variants */}
      <section className={card}>
        <CaptionVariantsEditor value={captions} onChange={setCaptions} />
      </section>

      {/* Targets */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Target accounts</h3>
        <p className="mb-3 text-xs text-muted">Which accounts auto-fill can post this to.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {channels.map((c) => {
            const on = targets.has(c.id);
            const color = channelColor(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleTarget(c.id)}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  on ? "border-transparent" : "border-border hover:bg-surface-sunken"
                }`}
                style={on ? { backgroundColor: color.bg, boxShadow: `inset 0 0 0 2px ${color.dot}` } : undefined}
              >
                <span className="text-sm text-ink">{c.account_name}</span>
                <span className="ml-auto text-xs text-muted">{c.platform}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Tags */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Tags</h3>
        <TagEditor timeOfDayTags={timeOfDayTags} topicTags={topicTags} value={tagIds} onChange={setTagIds} />
      </section>

      {/* Periods */}
      <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />

      {/* Content status + cooldown + save */}
      <section className={card}>
        <h3 className="mb-1 font-display text-sm font-semibold text-ink">Content status</h3>
        <p className="mb-2 text-xs text-muted">Ready content is eligible for auto-fill; drafts and retired are not.</p>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button type="button" className={segBtn(status === "draft")} onClick={() => setStatus("draft")}>Draft</button>
          <button type="button" className={segBtn(status === "ready")} onClick={() => setStatus("ready")}>Ready</button>
          <button type="button" className={segBtn(status === "retired")} onClick={() => setStatus("retired")}>Retired</button>
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-ink-soft mb-1">
            Cooldown override (days) <span className="text-faint">— blank = channel default</span>
          </label>
          <input
            type="number"
            min={0}
            className="w-40 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
          />
        </div>

        {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-status-posted">{notice}</p> : null}

        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={pending}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-ink disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean. (If `ContentKind`/`ContentStatus`/`PeriodMode` names differ, fix the imports to match `@/lib/types`.)

- [ ] **Step 4: Browser verification (controller runs this; list it)**

Note for the reviewer/controller to click-test: navigate directly to `/library/1` (the Grand Teton post). Confirm the editor pre-populates its current caption, targets, kind, status; the read-only strip shows the image + "Schedule status"; change a field (e.g. add a target, set Ready, attach a green period) → Save → "Changes saved." → reload → values persist (cross-check DB). A 404 shows for a bad id like `/library/99999`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/library/[id]/page.tsx dashboard/components/post-editor.tsx
git commit -m "feat(dashboard): post edit screen (/library/[id]) — content-model fields"
```

---

### Task 3: Library title/thumbnail links to the edit screen

**Files:**
- Modify: `dashboard/components/library-view.tsx`

**Interfaces:**
- Consumes: the page from Task 2 (`/library/[id]`).
- Behavior: the post title and thumbnail become links to `/library/${p.id}`; clicking them does NOT toggle bulk-select (`stopPropagation`); the rest of the card keeps toggling select. Bulk-schedule / re-target unchanged.

- [ ] **Step 1: Add the import**

At the top of `dashboard/components/library-view.tsx`, add (if not already present):

```typescript
import Link from "next/link";
```

- [ ] **Step 2: Wrap the title and thumbnail in links that stop propagation**

The card is a clickable element that toggles selection via the card's own `onClick`. Find where the post title text and the `<img src={`/api/media/${p.first_asset_id}?variant=thumb`}>` are rendered (around lines 216-236 and the title heading below it). Wrap BOTH the thumbnail and the title in:

```tsx
<Link
  href={`/library/${p.id}`}
  onClick={(e) => e.stopPropagation()}
  className="hover:underline"
>
  {/* existing thumbnail <img> or title text */}
</Link>
```

- For the thumbnail: wrap the existing `<img>` (and its `no image` fallback branch) in the `<Link>`; keep the same classes on the `<img>`.
- For the title: wrap the existing title text node in the `<Link>` (the `hover:underline` signals it's clickable).
- Do NOT wrap the whole card, and do NOT change the card's existing `onClick` select handler. The `stopPropagation` is what preserves bulk-select on the rest of the card.

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Browser verification (controller runs this; list it)**

Note for the controller: on `/library`, clicking the Grand Teton title or thumbnail navigates to `/library/1` and does NOT add it to the bulk selection; clicking elsewhere on the card still toggles its selection (the "N posts selected" count changes) and bulk-schedule / re-target still work.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/library-view.tsx
git commit -m "feat(dashboard): open a post's editor from its Library title/thumbnail"
```

---

## Self-Review

**Spec coverage** (spec `docs/design-post-management.md`):
- §2 scope (content-model fields only; images/scheduling read-only) → Task 2 editor + read-only strip. ✅
- §3 route `/library/[id]` + title/thumbnail link w/ stopPropagation, bulk intact → Tasks 2, 3. ✅
- §4 load via existing getters + one new `getPostAssets`; 404 on bad id → Tasks 1, 2. ✅
- §5 editor controls (kind/status/cooldown/targets/captions/tags/periods) pre-populated, save via PATCH with empty-caption filter, stay-on-page + refresh, error surface → Task 2. ✅
- §6 content_status vs posts.status not conflated (labeled "Content status" vs "Schedule status") → Task 2. ✅
- §7 verification (tsc, browser round-trip, bulk regression, invalid-caption 400) → Task 2/3 verify steps. ✅

**Placeholder scan:** No TBD/TODO. Task 2 carries the full page + full component code. Task 3's wrap points are described against concrete existing line ranges (the exact surrounding markup lives in the file the implementer edits; inlining the whole card here would duplicate unrelated existing markup).

**Type consistency:** `getPostAssets` (Task 1) consumed by Task 2's page. `<PostEditor>` prop names match the page's props in Task 2. Reused component prop shapes (`CaptionVariantDraft{platform,body}`, `TagEditor value:number[]`, `PeriodAttach value:Record<number,PeriodMode>`) match the initial-value mapping in the page. PATCH body field names (`content_kind`, `content_status`, `cooldown_days`, `target_channel_ids`, `tag_ids`, `period_links[].periodId`, `caption_variants`) match the existing route's validators.

---

## Out of scope (deferred, per spec §8)
- Editing images (add/remove/reorder) on an existing post; rescheduling/canceling existing publications. ③ Bulk import and the rest of ④'s overview remain separate.
