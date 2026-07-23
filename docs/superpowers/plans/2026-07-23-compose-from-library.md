# Compose from Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "From library" mode to Compose: pick an existing post, choose channels + a date/time, and create scheduled sends for that post (no duplication).

**Architecture:** A new thin `POST /api/posts/[id]/schedule` reuses `bulkCreatePublications` + `intervalSlots`. A client `<ComposeSwitcher>` toggles between the existing `<Composer>` and a new `<ScheduleFromLibrary>` picker; the Compose page feeds it the library posts.

**Tech Stack:** Next.js 16 App Router + TypeScript + Tailwind v4 + better-sqlite3.

## Global Constraints

- **No schema/migration change. No new dependencies.**
- **All Next.js route handlers / server pages: `export const runtime = "nodejs"`.**
- **Reuse existing machinery:** `bulkCreatePublications(entries: BulkEntry[])` (`BulkEntry = { post_id, channel_id, scheduled_at, status: "scheduled"|"pending_approval" }`), `intervalSlots(startDate, time, everyDays, count, tz): string[]` (returns UTC ISO), `getPost`, `getChannel`, `listPosts`. No new scheduling logic.
- **Time is interpreted per-channel timezone** (matching `/api/posts/bulk`): `intervalSlots(date, time, 1, 1, channel.timezone)[0]` for each channel.
- **`content_status` (auto-fill eligibility) is untouched by scheduling** — do not conflate with `posts.status` (which `bulkCreatePublications` flips out of `draft`).
- **No caption/content editing in this flow** — schedule the post as-is.
- Match the composer's visual language (segmented control active = `bg-brand-weak font-medium text-brand-ink`; channel toggle pattern). Spec: `docs/design-compose-from-library.md`.

### Reused interfaces (verified)
- `bulkCreatePublications(entries: BulkEntry[]): number`; `BulkEntry` exported from `@/lib/queries`.
- `intervalSlots(startDate: string, time: string, everyDays: number, count: number, timeZone: string): string[]` from `@/lib/scheduling`.
- `getPost(id): Post | undefined`; `getChannel(id): Channel | undefined` (`Channel.timezone: string`, `Channel.requires_approval: number` 0/1).
- `listPosts(): PostLibraryRow[]` — `PostLibraryRow extends Post` and adds `first_asset_id: number | null`. `Post` has `id`, `caption`, `content_kind`, `content_status`.
- `<Composer>` props: `channels: {id; platform; account_name; timezone; requires_approval: boolean}[]`, `defaultTimezone: string`, `periods: Period[]`, `timeOfDayTags: Tag[]`, `topicTags: Tag[]`.

---

### Task 1: `POST /api/posts/[id]/schedule` endpoint

**Files:**
- Create: `dashboard/app/api/posts/[id]/schedule/route.ts`

**Interfaces:**
- Consumes: `getPost`, `getChannel`, `bulkCreatePublications`, `BulkEntry`, `intervalSlots`.
- `POST` body: `{ channel_ids: number[], date: "YYYY-MM-DD", time: "HH:MM" }` → `{ created: number }`.

- [ ] **Step 1: Create the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { bulkCreatePublications, getChannel, getPost, type BulkEntry } from "@/lib/queries";
import { intervalSlots } from "@/lib/scheduling";

export const runtime = "nodejs";

/** Schedule ONE existing post to one or more channels at a date/time (per-channel tz). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const postId = Number(id);
  if (!getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const date: string = body.date || "";
  const time: string = body.time || "";

  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Pick a date." }, { status: 400 });
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return NextResponse.json({ error: "Enter a time as HH:MM." }, { status: 400 });
  }

  const entries: BulkEntry[] = [];
  for (const channelId of channelIds) {
    const channel = getChannel(channelId);
    if (!channel) {
      return NextResponse.json({ error: `Unknown channel ${channelId}.` }, { status: 400 });
    }
    const scheduledAt = intervalSlots(date, time, 1, 1, channel.timezone)[0];
    entries.push({
      post_id: postId,
      channel_id: channelId,
      scheduled_at: scheduledAt,
      status: channel.requires_approval ? "pending_approval" : "scheduled",
    });
  }

  const created = bulkCreatePublications(entries);
  return NextResponse.json({ created }, { status: 201 });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 3: Reason through (record in report)**

Confirm: unknown post → 404; empty `channel_ids` → 400; bad date/time → 400; unknown channel → 400 (nothing created — validation precedes `bulkCreatePublications`); a valid call creates one publication per channel at that channel's local time; `bulkCreatePublications` flips the post out of `draft`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/api/posts/[id]/schedule/route.ts
git commit -m "feat(dashboard): POST /api/posts/[id]/schedule — schedule an existing post"
```

---

### Task 2: `<ScheduleFromLibrary>` + `<ComposeSwitcher>` + Compose page

**Files:**
- Create: `dashboard/components/schedule-from-library.tsx` (client)
- Create: `dashboard/components/compose-switcher.tsx` (client)
- Modify: `dashboard/app/compose/page.tsx`

**Interfaces:**
- Consumes: `POST /api/posts/[id]/schedule` (Task 1), `listPosts`.
- `LibraryPickItem = { id: number; first_asset_id: number | null; caption: string | null; content_kind: string; content_status: string }`.
- `ChannelLite = { id: number; platform: string; account_name: string; timezone: string; requires_approval: boolean }`.

- [ ] **Step 1: Create `dashboard/components/schedule-from-library.tsx`**

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";

export type LibraryPickItem = {
  id: number;
  first_asset_id: number | null;
  caption: string | null;
  content_kind: string;
  content_status: string;
};
export type ChannelLite = {
  id: number;
  platform: string;
  account_name: string;
  timezone: string;
  requires_approval: boolean;
};

const card = "rounded-card border border-border bg-surface p-5";

export function ScheduleFromLibrary({
  posts,
  channels,
  defaultDate,
  defaultTime,
}: {
  posts: LibraryPickItem[];
  channels: ChannelLite[];
  defaultDate: string;
  defaultTime: string;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [targets, setTargets] = useState<Set<number>>(new Set());
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = posts.find((p) => p.id === selectedId) ?? null;
  const shown = posts.filter((p) =>
    query.trim() ? (p.caption ?? "").toLowerCase().includes(query.trim().toLowerCase()) : true
  );
  const toggleTarget = (id: number) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function schedule() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const res = await fetch(`/api/posts/${selected.id}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_ids: Array.from(targets), date, time }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not schedule.");
      return;
    }
    const b = await res.json();
    setNotice(`Scheduled to ${b.created} account${b.created === 1 ? "" : "s"}.`);
    setTargets(new Set());
  }

  if (!selected) {
    return (
      <div className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Pick a post to schedule</h3>
        <input
          className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand"
          placeholder="Search captions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {shown.length === 0 ? (
          <p className="text-sm text-muted">No posts. Create one in “New post” or the Library.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className="flex gap-3 rounded-lg border border-border p-2 text-left hover:bg-surface-sunken"
              >
                {p.first_asset_id ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${p.first_asset_id}?variant=thumb`}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-surface-sunken text-[10px] text-faint">
                    no image
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{p.caption || "(no caption)"}</p>
                  <p className="data mt-1 text-[11px] text-muted">
                    {p.content_kind} · {p.content_status}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className={card}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            {selected.first_asset_id ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/${selected.first_asset_id}?variant=thumb`}
                alt=""
                className="h-20 w-20 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-xs text-faint">
                no image
              </div>
            )}
            <div>
              <p className="text-sm text-ink">{selected.caption || "(no caption)"}</p>
              <p className="data mt-1 text-[11px] text-muted">
                {selected.content_kind} · {selected.content_status}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="shrink-0 text-xs text-brand underline underline-offset-2"
          >
            Change
          </button>
        </div>
        <p className="mt-3 text-xs text-faint">
          Scheduling reuses this post as-is. To change wording or targets, edit it in the{" "}
          <Link href={`/library/${selected.id}`} className="text-brand underline underline-offset-2">
            Library
          </Link>{" "}
          first.
        </p>
      </div>

      <div className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Where & when</h3>
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
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
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1">Date</label>
            <input type="date" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1">Time (each account’s local)</label>
            <input type="time" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
        {notice ? (
          <p className="mt-3 text-sm text-status-posted">
            {notice} <Link href="/" className="underline underline-offset-2">View queue →</Link>
          </p>
        ) : null}

        <div className="mt-4 flex justify-end">
          <button
            onClick={schedule}
            disabled={busy || targets.size === 0}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-ink disabled:opacity-50"
          >
            {busy ? "Scheduling…" : `Schedule to ${targets.size} account${targets.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `dashboard/components/compose-switcher.tsx`**

```tsx
"use client";

import { useState } from "react";
import type { Period, Tag } from "@/lib/types";
import { Composer } from "./composer";
import { ScheduleFromLibrary, type LibraryPickItem, type ChannelLite } from "./schedule-from-library";

const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-ink" : "text-muted hover:text-ink"
  }`;

export function ComposeSwitcher({
  channels,
  defaultTimezone,
  periods,
  timeOfDayTags,
  topicTags,
  libraryPosts,
  defaultDate,
  defaultTime,
}: {
  channels: ChannelLite[];
  defaultTimezone: string;
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  libraryPosts: LibraryPickItem[];
  defaultDate: string;
  defaultTime: string;
}) {
  const [mode, setMode] = useState<"new" | "library">("new");
  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-lg border border-border p-0.5">
        <button type="button" className={segBtn(mode === "new")} onClick={() => setMode("new")}>New post</button>
        <button type="button" className={segBtn(mode === "library")} onClick={() => setMode("library")}>From library</button>
      </div>
      {mode === "new" ? (
        <Composer
          channels={channels}
          defaultTimezone={defaultTimezone}
          periods={periods}
          timeOfDayTags={timeOfDayTags}
          topicTags={topicTags}
        />
      ) : (
        <ScheduleFromLibrary
          posts={libraryPosts}
          channels={channels}
          defaultDate={defaultDate}
          defaultTime={defaultTime}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire the Compose page `dashboard/app/compose/page.tsx`**

Replace the `<Composer ... />` render with `<ComposeSwitcher ... />`, and add the library posts + defaults. Keep the existing `channels`/`timeOfDayTags`/`topicTags` fetch. Add:

```tsx
import { getActiveChannels, listPeriods, listTags, listPosts } from "@/lib/queries";
import { ComposeSwitcher } from "@/components/compose-switcher";
// ...
  const libraryPosts = listPosts().map((p) => ({
    id: p.id,
    first_asset_id: p.first_asset_id,
    caption: p.caption,
    content_kind: p.content_kind,
    content_status: p.content_status,
  }));
  const defaultDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow (UTC)
  const defaultTime = "09:00";
```

And render (inside the existing `channels.length === 0 ? <EmptyState/> :` branch):

```tsx
        <ComposeSwitcher
          channels={channels}
          defaultTimezone={config.defaultTimezone}
          periods={listPeriods()}
          timeOfDayTags={timeOfDayTags}
          topicTags={topicTags}
          libraryPosts={libraryPosts}
          defaultDate={defaultDate}
          defaultTime={defaultTime}
        />
```

(Remove the now-unused direct `Composer` import if the switcher replaces it; keep everything else on the page.)

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Browser verification (controller runs this; list it)**

Note for the controller: on `/compose`, the "New post" / "From library" toggle appears; "New post" shows the unchanged composer; "From library" shows a searchable post picker; picking a post shows its image/caption read-only + a channel picker + date/time; selecting a channel and clicking Schedule shows "Scheduled to 1 account" and the Overview queue gains a scheduled send for that post at the chosen local time. Toggling back to "New post" restores the composer.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/schedule-from-library.tsx dashboard/components/compose-switcher.tsx dashboard/app/compose/page.tsx
git commit -m "feat(dashboard): Compose 'From library' — schedule an existing post"
```

---

## Self-Review

**Spec coverage** (spec `docs/design-compose-from-library.md`):
- §2 mode toggle + picker + read-only preview + schedule controls → Task 2. ✅
- §3 per-channel-tz time via `intervalSlots`, reuse `bulkCreatePublications` → Task 1. ✅
- §4 route + `ScheduleFromLibrary` + `ComposeSwitcher` + page wiring → Tasks 1, 2. ✅
- §5 flips out of draft (via bulkCreatePublications), content_status untouched, no-asset posts still pickable → Tasks 1, 2 (picker shows all posts; placeholder for no image). ✅
- §6 verification (tsc, round-trip, invalid → 400/disabled) → Task 1 Step 3 + Task 2 Step 5. ✅
- No caption editing in flow (§2 out of scope) — the flow only schedules; a "edit in Library" link is provided. ✅

**Placeholder scan:** No TBD/TODO. Tasks 1–2 carry full code; the page edit is described against the concrete existing page structure.

**Type consistency:** `BulkEntry`/`intervalSlots` signatures used verbatim in Task 1. `LibraryPickItem`/`ChannelLite` defined in `schedule-from-library.tsx` and imported by `compose-switcher.tsx` (Task 2); the page maps `listPosts()` rows to `LibraryPickItem` and the channels to `ChannelLite` (same shape the page already builds for `<Composer>`). The POST body `{channel_ids, date, time}` matches Task 1's route.

---

## Out of scope (deferred, per spec §7)
- Inline caption/target editing while scheduling; recurrence/cadence in this flow; multi-post scheduling from Compose.
