# Content Model — Phase B (dashboard UI) Implementation Plan

**Goal:** Surface the content model in the dashboard so the owner can actually set a post's kind, status, target accounts, caption variants, and in-season periods — and manage the reusable period library.

**Architecture:** Next.js App Router (server components + client islands), `better-sqlite3` via `dashboard/lib/queries.ts` (the only DB layer), thin route handlers under `dashboard/app/api/*`. The DB schema already exists (migration `0002`, applied). Phase B is app-layer only — no schema changes.

**Tech Stack:** TypeScript, Next.js 16, Tailwind v4 (`@theme` tokens), better-sqlite3. Design tokens: `--color-brand` (pine, nav/primary), `--color-accent` (signal orange, submit), status tokens, `.data` mono utility for dates/ids. Reuse `ui.tsx` primitives and the composer's channel-toggle multi-select pattern.

## Global Constraints

- SQLite is the only contract; all DB access goes through `dashboard/lib/queries.ts` (server-side). No new DB deps.
- `content_status` (draft/ready/retired — automation eligibility) is SEPARATE from the existing coarse `posts.status` (draft/scheduled/posted/failed). Never conflate them in types, queries, or UI copy.
- "All accounts" targeting = **snapshot**: expand to the accounts existing at set-time into explicit `post_targets` rows. New accounts are folded in later via bulk re-target (B4), never automatically.
- Blackout periods win over green (already enforced in the worker; UI must not imply otherwise).
- Match the existing "publishing control room" look: reuse `ui.tsx` components, the composer field classes, and the design tokens. No new color hues without reason.
- Verify each slice: `npx tsc --noEmit` clean, plus the slice's own check (smoke script for B1; browser verification for B2–B4).

## Build order (each slice is its own reviewed unit)

**B1 → B3 → B2 → B4.** Periods must exist before the composer can attach them, so the Periods manager (B3) precedes the composer upgrade (B2). B1 (data layer) underlies everything.

---

## Slice B1 — Data layer (types + queries + API)

Non-visual foundation. All new reads/writes for the content-model tables, following the exact patterns already in `queries.ts` (dynamic `SET` builders, `db.transaction`, one function per operation).

### B1 deliverables

**`dashboard/lib/types.ts`** — add interfaces/types:
- Extend `Post` with `content_kind: "one_time" | "evergreen"`, `content_status: "draft" | "ready" | "retired"`, `cooldown_days: number | null`.
- `ContentKind`, `ContentStatus` union types.
- `Period { id; name; recurs_yearly: 0|1; start_month; start_day; end_month; end_day; start_date; end_date }`.
- `PeriodMode = "green" | "blackout"`.
- `CaptionVariant { id; post_id; platform: string | null; body; sort_order }`.

**`dashboard/lib/queries.ts`** — add functions (mirror existing style; all synchronous better-sqlite3):
- Periods library CRUD: `listPeriods()`, `getPeriod(id)`, `createPeriod(input)`, `updatePeriod(id, fields)`, `deletePeriod(id)`.
- Post targeting: `getPostTargets(postId): number[]`, `setPostTargets(postId, channelIds: number[])` (transaction: delete-all then insert the set — the snapshot).
- Post periods: `getPostPeriods(postId): {period_id; mode}[]`, `setPostPeriods(postId, links: {periodId; mode}[])` (transaction: replace).
- Caption variants: `getCaptionVariants(postId): CaptionVariant[]`, `setCaptionVariants(postId, variants: {platform: string|null; body: string; sort_order: number}[])` (transaction: replace).
- Post content-model fields: `updatePostContentModel(postId, {content_kind?, content_status?, cooldown_days?})` (dynamic SET, same pattern as `updateChannel`).
- Extend `createPostWithPublications` and `createDraftPost` inputs to optionally accept `target_channel_ids`, `content_kind`, `content_status`, `cooldown_days`, `caption_variants`, `period_links`, writing the join rows in the same transaction. Keep existing callers working (all new fields optional with today's defaults).
- Extend `listPosts()` read model to include `content_kind`, `content_status`, target count, and season summary (used by B4).

**`dashboard/app/api/periods/route.ts`** (GET list, POST create) and **`dashboard/app/api/periods/[id]/route.ts`** (PATCH, DELETE) — thin handlers with inline validation like the existing `channels` routes (validate name non-empty; for yearly require month/day 1–12 / 1–31; for one-off require ISO `start_date`/`end_date`).
- **`dashboard/app/api/posts/[id]/content/route.ts`** (PATCH) — save a post's kind/status/cooldown/targets/periods/caption-variants in one call, for the composer + future edit UI.

### B1 verification
- `npx tsc --noEmit` from `dashboard/` is clean.
- Smoke script `dashboard/scripts/smoke-content-model.mjs`: set `DATABASE_PATH` to a temp file, run `migrate.py` against it (or apply the two migration SQL files directly with better-sqlite3), then exercise: create a period; create a post with targets + a green period + two caption variants; read them back and assert; update content_status; assert. Run with `node scripts/smoke-content-model.mjs` and print PASS/FAIL. (Set `DATABASE_PATH` BEFORE importing queries, since `lib/db.ts` resolves the path at import.)

---

## Slice B3 — Periods manager screen  (outline; detailed after B1 review)

- New route `dashboard/app/periods/page.tsx` + `dashboard/components/period-form.tsx`, styled like `channel-form.tsx`.
- Create/edit/delete named windows: a toggle between **Recurring yearly** (month + day start/end selects) and **One-off** (two date inputs). Show a plain-English preview ("Dec 15 – Jan 5, every year").
- Add `{ href: "/periods", label: "Periods", hint: "In-season windows" }` to `sidebar.tsx`'s `NAV`.
- Uses B1's periods CRUD API.

## Slice B2 — Composer upgrade  (outline; detailed after B3 review)

- Add to `dashboard/components/composer.tsx`: a **kind** selector (one-time/evergreen), a **status** choice (save as draft vs ready), **account targeting** (reuse the channel-toggle multi-select — targeting is who the content is *for*, distinct from the immediate schedule), a **caption-variants** editor (repeatable list of textareas each with an optional platform select; one is fine), and a **periods** attach control (multi-select of library periods, each tagged green/blackout). Preview resolves which caption to show.
- Submit posts through the extended `/api/posts` (+ `/api/posts/[id]/content`).

## Slice B4 — Library upgrades  (outline; detailed after B2 review)

- `dashboard/components/library-view.tsx`: multi-select rows → **bulk re-target** bar (add/remove an account across selected; an "add current 'all'" affordance = snapshot-expand). Add columns: kind, content_status, season (green/blackout summary), targets.
- Uses B1's `setPostTargets` + a new `bulkAddTarget(postIds, channelId)` query.

## Out of scope (later sub-projects)
Tag kinds/taxonomy (②), bulk import + AI suggestions (③), full library-overview UX + asset-folder organization (④), non-Instagram platform adapters (Phase 6).
