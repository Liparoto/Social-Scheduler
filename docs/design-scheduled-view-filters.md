# Design — Scheduled view: account / platform / status filters

**Status:** approved 2026-07-23, ready for implementation planning
**Part of:** the "post workflow" batch (item 3 of 4).

---

## 1. Purpose

The Overview shows every publication (scheduled + posted + failed) in one table, but there's no
way to answer "what's scheduled on *this* account?" or "everything queued on Facebook?" at a
glance. This adds a **filter bar** over the existing Publications table — by **account**,
**platform**, and **status** — so the owner can see exactly what's scheduled on any account or
platform.

---

## 2. Scope

**In scope:**
- Extract the Overview's Publications `<table>` into a client component `<PublicationQueue>` and
  add a filter bar above it:
  - **Account** — a select of the owner's channels (or "All accounts").
  - **Platform** — Instagram / Facebook / All.
  - **Status** — All / Scheduled / Pending approval / Posted / Failed (the useful subset of
    `PublicationStatus`).
  - A small count line: "showing N of M".
- Filtering is **client-side** over the already-loaded rows (instant, like the Library filters).

**Out of scope (deliberate):**
- A dedicated Schedule/calendar page — the scheduled data already lives on the Overview; a second
  surface is deferred.
- Server-side/URL-param filtering, pagination, date-range filtering — the current 200-row overview
  query is plenty for a single install; revisit only if it grows.
- Any change to the per-channel queue rails, `RefreshAllMetrics`, row actions, or metrics display
  — all unchanged.

---

## 3. Components

### Modified
- `dashboard/app/page.tsx` — replace the inline Publications `<table>…</table>` with
  `<PublicationQueue pubs={pubs} channels={channels} />`. Keep the section wrapper, the
  `Publications` heading, `RefreshAllMetrics`, and the `pubs.length === 0` EmptyState in the page.
  The per-channel rails section above is untouched.

### New
- `dashboard/components/publication-queue.tsx` (client):
  - Props: `pubs: PublicationRow[]`, `channels: { id: number; account_name: string; platform: string }[]`.
  - State: `account: number | "all"`, `platform: "all" | "instagram" | "facebook"`,
    `status: "all" | PublicationStatus-subset`.
  - `shown = pubs.filter(...)` applying all three (AND). Renders a filter bar (three `<select>`s +
    the "showing N of M" count) then the **existing table markup moved verbatim**, iterating
    `shown` instead of `pubs`. If `shown.length === 0` (but `pubs` is non-empty), show a small
    "No sends match these filters." row instead of the table body.
  - Reuses the same imports the table already uses: `ChannelChip`, `StatusBadge`,
    `PublicationActions`, `formatInTz`, `tzAbbrev`, and the `PublicationRow` type.

### Reused (unchanged)
- `getPublicationsOverview` (the page already calls it), `getActiveChannels`, all row-level
  rendering and actions.

---

## 4. Correctness / UX

- **No data/query change** — purely a client-side view over rows already fetched. The worker and
  DB are untouched.
- Filters combine with **AND**; defaults are all-"all" so the initial view is identical to today.
- Platform filter uses each row's `channel_platform`; account filter uses `channel_id`. Status
  filter maps directly to `PublicationStatus`.
- The count ("showing N of M") makes it obvious when a filter is hiding rows — no silent empty.
- `content_status` is unrelated here; this filters *publication* status (the send lifecycle),
  which is the correct axis for "what's scheduled".

---

## 5. Verification

- `cd dashboard && npx tsc --noEmit` clean.
- Browser (controller): on the Overview, the filter bar shows Account/Platform/Status selects;
  choosing Status = Scheduled hides non-scheduled rows and updates the count; choosing a Platform
  or Account narrows further; resetting to All restores the full table. The per-channel rails,
  Refresh-all, and row actions still work.

---

## 6. Out of scope (deferred)
- Dedicated Schedule/calendar page; date-range filter; server-side filtering/pagination.
