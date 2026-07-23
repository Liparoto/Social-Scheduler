# Design — Compose from Library (schedule an existing post)

**Status:** approved 2026-07-23, ready for implementation planning
**Part of:** the "post workflow" batch (item 1 of 4). Depends on ① content model + the Library
(shipped).

---

## 1. Purpose

Today the Compose page only *creates* fresh posts. There's no way to take an existing library
post (a draft you prepared, or evergreen content you want to run again) and schedule it. This
adds a **"From library"** mode to Compose: pick an existing post, choose channels + a date/time,
and it creates scheduled sends **for that post** — no duplication, honoring the reuse model
(one post → many scheduled sends over time).

---

## 2. Scope

**In scope:**
- A mode toggle on Compose: **New post** (today's composer, unchanged) | **From library**.
- A library picker (thumbnail + caption snippet + kind/status badges, searchable) to select ONE
  post.
- A read-only preview of the picked post (its images + caption) — this is the post being
  scheduled.
- Channel picker + date/time controls → creates one scheduled send per channel for that post.

**Out of scope (deliberate):**
- **No caption/content editing in this flow.** Scheduling reuses the post as-is; its caption
  variants are what publish. To change wording/targets/tags, use the **edit screen** first
  (`/library/[id]`). This keeps the reuse model clean — one post, not near-duplicates.
- No new cadence/recurrence UI here (single date/time; the worker's auto-fill handles recurring
  cadence separately).

---

## 3. Mechanism (reuses existing machinery)

Scheduling an existing post already exists as `bulkCreatePublications(entries: BulkEntry[])`
(`BulkEntry = { post_id, channel_id, scheduled_at, status }`) — it inserts publications and flips
the post out of `draft`. And `intervalSlots(startDate, time, everyDays, count, tz)` computes
per-timezone UTC slots. So the only new backend is a thin single-post endpoint.

**Time is interpreted in each channel's own timezone** (matching `/api/posts/bulk`): "9:00 AM"
means 9 AM local to each targeted account. So one post scheduled to an IG account (America/
New_York) and a FB page (America/Chicago) at 09:00 lands at each account's local 9 AM.

---

## 4. Components

### New
1. **Route** `POST /api/posts/[id]/schedule` (`dashboard/app/api/posts/[id]/schedule/route.ts`),
   `export const runtime = "nodejs"`.
   - Body: `{ channel_ids: number[], date: "YYYY-MM-DD", time: "HH:MM" }`.
   - Validate: `getPost(id)` exists (404 if not); `channel_ids` non-empty (400); each channel
     exists via `getChannel` (400); `date` matches `^\d{4}-\d{2}-\d{2}$` and `time` matches
     `^\d{2}:\d{2}$` (400). For each channel: `scheduled_at = intervalSlots(date, time, 1, 1,
     channel.timezone)[0]`; `status = channel.requires_approval ? "pending_approval" :
     "scheduled"`. Build `BulkEntry[]` (one per channel) → `bulkCreatePublications(entries)` →
     `{ created }` (201).

2. **Client component** `dashboard/components/schedule-from-library.tsx`:
   - Props: `posts: LibraryPickItem[]` (id, first_asset_id, caption, content_kind,
     content_status), `channels: {id, platform, account_name, timezone, requires_approval}[]`,
     `defaultDate`, `defaultTime`.
   - **Picker view** (no post selected): a search `<input>` (filters by caption) + a grid of post
     cards — thumbnail (`/api/media/{first_asset_id}?variant=thumb`, or a placeholder), caption
     snippet, and kind/status micro-badges. Click a card → select it.
   - **Selected view**: the picked post's image + caption (read-only) with a "Change" link to
     reselect; a channel picker (reuse the composer's toggle pattern); a `date` + `time` input; a
     "Schedule" button (disabled until ≥1 channel). On success: "Scheduled to N account(s)" +
     a `<Link href="/">View queue →</Link>` (Overview shows the queue); on error show
     `body.error`.

3. **Mode wrapper** `dashboard/components/compose-switcher.tsx` (client): holds
   `mode: "new" | "library"`, renders a segmented toggle (**New post** / **From library**) and
   below it either the existing `<Composer>` (new) or `<ScheduleFromLibrary>` (library). Receives
   all the props both children need.

### Modified
- `dashboard/app/compose/page.tsx` — render `<ComposeSwitcher>` instead of `<Composer>`
  directly; additionally fetch the library posts via `listPosts()` and map to the picker's
  `LibraryPickItem` shape; pass through channels/periods/tags plus a sensible `defaultDate`
  (today or tomorrow) and `defaultTime`.

### Reused
- `bulkCreatePublications`, `intervalSlots`, `getPost`, `getChannel`, `listPosts`, the composer's
  channel-toggle visual pattern, `/api/media/{id}?variant=thumb`.

---

## 5. Correctness / UX

- Scheduling flips the post out of `draft` (via `bulkCreatePublications`) — a scheduled post is no
  longer a bare draft; it now has real sends. This matches the existing bulk-schedule behavior.
- A post with **no assets** can't be published; the picker should still show it, but the schedule
  action is the user's responsibility (the worker validates assets at publish and fails visibly).
  (Optional nicety: disable/annotate cards with 0 assets — keep simple, not required.)
- `content_status` (draft/ready/retired) is unaffected by scheduling — it governs *auto-fill*
  eligibility, a separate axis from a manual scheduled send. Do not conflate.

---

## 6. Verification

- `cd dashboard && npx tsc --noEmit` clean.
- Browser round-trip (controller): Compose → "From library" → pick the Grand Teton post → select
  a channel + a date/time → Schedule → success; the Overview queue shows a new scheduled send for
  that post at the chosen local time (cross-check DB `publications`). Toggling back to "New post"
  shows the unchanged composer.
- Invalid: schedule with no channel selected → button disabled; a bad date/time is rejected by the
  route with 400.

---

## 7. Out of scope (deferred)
- Inline caption/target editing while scheduling (use the edit screen); recurrence/cadence in this
  flow (auto-fill owns that); multi-post scheduling from Compose (the Library's bulk-schedule owns
  that).
