# Scheduled View Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an account / platform / status filter bar over the Overview's Publications table so the owner can see what's scheduled on any account or platform.

**Architecture:** Extract the existing Publications `<table>` into a client `<PublicationQueue>` that filters the already-loaded rows client-side (no query change). The Overview page passes it `pubs` + `channels`.

**Tech Stack:** Next.js 16 App Router + TypeScript + Tailwind v4.

## Global Constraints

- **No schema change, no query change, no new dependency.** Purely a client-side view over rows the page already fetches via `getPublicationsOverview`.
- **`export const runtime`/`dynamic` on the page is unchanged.** The new component is `"use client"`.
- **Do not change** the per-channel queue rails section, `RefreshAllMetrics`, row-level actions, metrics display, or the `pubs.length === 0` EmptyState. Only the Publications `<table>` moves into the component.
- Filters combine with AND; defaults all-"all" (initial view identical to today). This filters **publication** status (send lifecycle), not `content_status`.
- Match existing visual language (selects styled like other form controls; the table markup is moved verbatim). Spec: `docs/design-scheduled-view-filters.md`.

### Reused interfaces (verified)
- `PublicationRow` (from `@/lib/queries`) `extends Publication` and adds `post_caption`, `post_type`, `channel_name`, `channel_platform: string`, `channel_timezone`, `asset_count`, `first_asset_id`, `m_reach/m_saves/m_likes/m_fetched_at`. `Publication` has `id`, `channel_id`, `status: PublicationStatus`, `scheduled_at`, `is_dry_run`, `remote_post_id`, `last_error`, `attempt_count`.
- `PublicationStatus = "scheduled" | "pending_approval" | "publishing" | "posted" | "failed" | "canceled"`.
- UI from `@/components/ui`: `ChannelChip`, `StatusBadge`. `PublicationActions` from `@/components/publication-actions`. `formatInTz`, `tzAbbrev` from `@/lib/format`.
- The page already builds `const channels = getActiveChannels();` (each has `id`, `account_name`, `platform`) and `const pubs = getPublicationsOverview();`.

---

### Task 1: `<PublicationQueue>` filter component + page wiring

**Files:**
- Create: `dashboard/components/publication-queue.tsx` (client)
- Modify: `dashboard/app/page.tsx`

**Interfaces:**
- `PublicationQueue({ pubs: PublicationRow[]; channels: { id: number; account_name: string; platform: string }[] })`.

- [ ] **Step 1: Read the current table markup**

Open `dashboard/app/page.tsx` and locate the Publications `<table>…</table>` block (inside the `{pubs.length === 0 ? <EmptyState/> : ( <div className="overflow-hidden rounded-card ..."><table>…</table></div> )}`), roughly lines 104–195. You will MOVE the `<div className="overflow-hidden ...">…</table></div>` block verbatim into the new component, changing only the row iteration source from `pubs.map` to `shown.map`. Note every import the row markup uses: `ChannelChip`, `StatusBadge` (`@/components/ui`), `PublicationActions` (`@/components/publication-actions`), `formatInTz`, `tzAbbrev` (`@/lib/format`).

- [ ] **Step 2: Create `dashboard/components/publication-queue.tsx`**

Scaffold (fill the `{/* MOVED: … */}` marker with the table `<div>…</div>` block moved verbatim from the page, with `pubs.map` → `shown.map`):

```tsx
"use client";

import { useState } from "react";
import type { PublicationRow } from "@/lib/queries";
import type { PublicationStatus } from "@/lib/types";
import { ChannelChip, StatusBadge } from "@/components/ui";
import { PublicationActions } from "@/components/publication-actions";
import { formatInTz, tzAbbrev } from "@/lib/format";

type StatusFilter = "all" | PublicationStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "scheduled", label: "Scheduled" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "posted", label: "Posted" },
  { value: "failed", label: "Failed" },
];

const selectCls =
  "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-brand";

export function PublicationQueue({
  pubs,
  channels,
}: {
  pubs: PublicationRow[];
  channels: { id: number; account_name: string; platform: string }[];
}) {
  const [account, setAccount] = useState<"all" | number>("all");
  const [platform, setPlatform] = useState<"all" | "instagram" | "facebook">("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  const shown = pubs.filter((p) => {
    if (account !== "all" && p.channel_id !== account) return false;
    if (platform !== "all" && p.channel_platform !== platform) return false;
    if (status !== "all" && p.status !== status) return false;
    return true;
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={account === "all" ? "all" : String(account)}
          onChange={(e) => setAccount(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          <option value="all">All accounts</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.account_name}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={platform}
          onChange={(e) => setPlatform(e.target.value as "all" | "instagram" | "facebook")}
        >
          <option value="all">All platforms</option>
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
        </select>
        <select
          className={selectCls}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="data ml-auto text-[11px] text-muted">
          showing {shown.length} of {pubs.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-card border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
          No sends match these filters.
        </div>
      ) : (
        {/* MOVED: paste the existing <div className="overflow-hidden rounded-card border border-border bg-surface"><table>…</table></div> block here, verbatim, with pubs.map changed to shown.map */}
      )}
    </div>
  );
}
```

- [ ] **Step 3: Move the table into the component**

Cut the `<div className="overflow-hidden rounded-card border border-border bg-surface"> … </table></div>` block from `page.tsx` and paste it in place of the `{/* MOVED: … */}` marker. Change its `pubs.map((p) => (` to `shown.map((p) => (`. Leave every `<td>`/`<tr>` and the `PublicationActions`/`StatusBadge`/`ChannelChip`/metrics/error/attempt rendering exactly as-is.

- [ ] **Step 4: Wire the page `dashboard/app/page.tsx`**

Replace the `{pubs.length === 0 ? ( <EmptyState .../> ) : ( <div className="overflow-hidden ..."><table>…</table></div> )}` with:

```tsx
          {pubs.length === 0 ? (
            <EmptyState title="Nothing here yet">
              Composed posts and their scheduled sends show up here — failures float to the
              top so they&rsquo;re never silent.
            </EmptyState>
          ) : (
            <PublicationQueue pubs={pubs} channels={channels} />
          )}
```

Add `import { PublicationQueue } from "@/components/publication-queue";`. Remove imports that are now used ONLY inside the moved table (`ChannelChip`, `StatusBadge`, `PublicationActions`, `formatInTz`, `tzAbbrev`) **only if** nothing else in `page.tsx` still uses them — check first: `channelColor`/`tzAbbrev`/`formatInTz`/`ChannelChip` are likely still used by the per-channel rails section, so keep whatever the rails need. Keep `EmptyState` (still used) and `RefreshAllMetrics` (still in the header).

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean (exit 0). (If an import became unused, tsc under this project may or may not flag it; remove genuinely-unused imports to keep it clean.)

- [ ] **Step 6: Browser verification (controller runs this; list it)**

Note for the controller: on the Overview, a filter bar (All accounts / All platforms / All statuses selects + "showing N of M") sits above the Publications table; selecting Status = Scheduled hides non-scheduled rows and updates the count; selecting a Platform or Account narrows further; back to All restores the full list; the per-channel rails, Refresh-all, and row actions still work.

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/publication-queue.tsx dashboard/app/page.tsx
git commit -m "feat(dashboard): Overview publications filter (account / platform / status)"
```

---

## Self-Review

**Spec coverage** (spec `docs/design-scheduled-view-filters.md`):
- §2 filter bar (account/platform/status) + count + client-side over loaded rows → Task 1. ✅
- §3 extract table into `<PublicationQueue>`, page keeps rails/RefreshAllMetrics/EmptyState → Task 1 Steps 3–4. ✅
- §4 AND filters, all-"all" default = today's view, no data change, publication-status axis → Task 1 (defaults, filter logic). ✅
- §5 verification (tsc, browser narrowing/restore, rails+actions intact) → Steps 5–6. ✅

**Placeholder scan:** The only non-literal is the deliberate "MOVED" marker (Step 2/3) — an explicit instruction to move existing verbatim JSX rather than re-transcribe ~90 lines (re-transcription would risk silent drift in the row rendering). Everything else is full code.

**Type consistency:** `PublicationRow`/`PublicationStatus` imported from their real modules. The `channels` prop shape `{id, account_name, platform}` is a subset of what `getActiveChannels()` returns (the page passes the fuller object; structural typing accepts it). Filter state types match the option values.

---

## Out of scope (deferred, per spec §6)
- Dedicated Schedule/calendar page; date-range filter; server-side filtering/pagination.
