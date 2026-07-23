# Design — Post management (edit) screen

**Status:** approved 2026-07-23, ready for implementation planning
**Part of:** ④ Library overview (the per-post management piece)
**Depends on:** ① Content model + ② Tagging taxonomy (both shipped) — this screen is the UI that
drives the edit API they already produced.

---

## 1. Purpose

There is currently **no way to edit an existing post.** The composer only *creates*; Library
cards only select for bulk actions. So a post like the Grand Teton post can't be reopened to add
tags, change targets, attach periods, or flip it Ready. This screen fills that gap.

The backend is already done: `PATCH /api/posts/[id]/content` accepts every content-model field,
and getter queries exist for the load side. This is almost entirely a **UI assembly** task —
reuse the composer's building blocks on an existing post.

Guiding principle (per project rules): make the post *legible* — one screen that shows how a
piece of content is assembled and where it's headed, and lets you change it.

---

## 2. Scope

**In scope — the content-model fields** (exactly what the PATCH route supports):
- Kind: evergreen / one-time
- Content status: draft / ready / retired
- Cooldown override (per-post; blank = channel default)
- Target accounts
- Caption variants (generic + per-platform)
- Tags (time_of_day bands + topics)
- Green/blackout periods

**Out of scope** (deliberately deferred — owner's call):
- Editing the post's **images** (add/remove/reorder) — the composer's upload flow only runs at
  create time; adding it here needs a new asset-management API.
- **Rescheduling** existing publications (change times, cancel a send) — overlaps the queue flows.

These appear on the screen **read-only** (see §5) so the screen is still legible, but are not
editable in this iteration.

---

## 3. Route + navigation

- **Route:** `/library/[id]` (nested under Library, where it's reached from). A server component.
- **Entry point:** in `dashboard/components/library-view.tsx`, the post's **title and thumbnail
  become a `<Link href={`/library/${p.id}`}>`**. Their click handler calls
  `e.stopPropagation()` so navigating does NOT toggle the card's bulk-select state. Clicking
  anywhere else on the card keeps its current behavior (toggle select for bulk-schedule /
  re-target). The existing bulk flows must remain byte-for-byte unchanged in behavior.
- A **"← Back to Library"** link on the edit page returns to `/library`.

---

## 4. Load (server page)

`dashboard/app/library/[id]/page.tsx` (server component):
- Parse `id`; if `getPost(id)` is undefined → Next.js `notFound()` (404).
- Gather current state with existing getters (no new query functions needed for load):
  - `getPost(id)` → caption, first_comment, post_type, content_kind, content_status,
    cooldown_days, status.
  - `getPostTargets(id)` → `number[]` of channel ids.
  - `getPostTags(id)` → `Tag[]` (both kinds).
  - `getPostPeriods(id)` → `{ periodId, mode }[]`.
  - `getCaptionVariants(id)` → `CaptionVariant[]`.
  - Load the post's assets for the read-only strip. No ordered-asset getter exists yet
    (`listPosts` only fetches the first thumbnail id), so add **one small new query**
    `getPostAssets(postId: number): Asset[]` — `SELECT a.* FROM post_assets pa JOIN assets a ON
    a.id = pa.asset_id WHERE pa.post_id = ? ORDER BY pa.sort_order ASC` — following the existing
    asset-query style. This is the only new query the feature needs.
  - Reference data: `getChannels()`, `listPeriods()`, `listTags("time_of_day")`,
    `listTags("topic")`.
- Pass everything to a client `<PostEditor>`.

---

## 5. The editor (`dashboard/components/post-editor.tsx`, new client component)

A form **pre-populated** with the post's current values, reusing the composer's components so it
looks and behaves identically. Controls:

| Field | Control | Initial value |
|---|---|---|
| Kind | segmented Evergreen / One-time (composer's `bg-brand-weak` active pattern) | `post.content_kind` |
| Status | segmented Draft / Ready / Retired | `post.content_status` |
| Cooldown | number input, empty allowed | `post.cooldown_days` (null → empty) |
| Targets | channel toggle picker (composer's "Where does this go?" pattern) | `getPostTargets` |
| Caption variants | `<CaptionVariantsEditor>` | `getCaptionVariants` mapped to `{platform, body}` |
| Tags | `<TagEditor>` | `getPostTags` ids |
| Periods | `<PeriodAttach>` | `getPostPeriods` as `Record<number,"green"\|"blackout">` |

**Read-only context strip** (top of the screen): the post's image thumbnails, `post_type`, and a
one-line summary of its current publications/schedule status (from `post.status` — the
publication lifecycle, SEPARATE from `content_status`). Clearly non-editable.

**Save:** one **"Save changes"** button →
`PATCH /api/posts/[id]/content` with a body containing all editable fields:
`content_kind`, `content_status`, `cooldown_days` (number or null), `target_channel_ids`,
`caption_variants` (empties filtered out, like the composer:
`variants.filter(v => v.body.trim()).map((v,i) => ({platform: v.platform || null, body: v.body.trim(), sort_order: i}))`),
`tag_ids`, and `period_links`.
- On success: a success notice; STAY on the page (so multiple edits are easy); `router.refresh()`
  to reflect saved state.
- On error: show `body.error` from the route (e.g. an invalid caption variant → 400).

The PATCH route's field handlers are all replace-semantics
(`setPostTargets`/`setPostTags`/`setPostPeriods`/`setCaptionVariants`), so sending the full set
each save is correct and idempotent.

---

## 6. Copy / UX rules

- `content_status` (Draft/Ready/Retired) is automation eligibility — SEPARATE from `posts.status`
  (the publish lifecycle shown in the read-only strip). The UI must not conflate them: label the
  editable one "Content status" / "Ready for auto-fill", and the read-only one "Schedule status".
- Retiring a post is a valid manual action here (sets `content_status='retired'`), distinct from
  the worker's automatic one-time retirement.
- Match the composer's existing visual language (labels, field classes, segmented/chip patterns,
  section cards). No new dependencies.

---

## 7. Verification

- `cd dashboard && npx tsc --noEmit` clean.
- Browser round-trip (controller runs): open the Grand Teton post from the Library via its title;
  the editor shows its current caption/target/kind/status; add a tag + a target + set Ready +
  attach a green period; Save → success notice; reload → values persisted (cross-check the DB).
- Regression: Library bulk-select + bulk-schedule + re-target still work (the title/thumbnail
  link must not toggle selection; the rest of the card must).
- Invalid case: clear all caption variants to empty → Save → route returns 400 → editor shows the
  error, nothing partially saved for that field.

---

## 8. Out of scope (deferred)

- Image add/remove/reorder on an existing post; reschedule/cancel existing publications
  (both listed in §2). ③ Bulk import and the rest of ④'s overview remain separate.
