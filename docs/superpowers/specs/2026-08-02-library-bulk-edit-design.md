# Library bulk edit — design

**Date:** 2026-08-02
**Status:** draft — awaiting owner review
**Related:** period visibility (`2026-08-02-library-period-visibility-design.md`) makes the
period filter that turns this into "filter to a season → select all → apply". Independent, but
better together.

## Problem

Tags, periods, status, kind and cooldown can only be changed **one post at a time**, through
`/library/[id]`. The library holds 139 posts. Two concrete costs already recorded in
`docs/tasks.md`:

- Only **3 of 139** posts are `content_status='ready'`. Promoting the rest is a 136-click job.
- On 2026-08-02 the owner needed 36 football posts attached to Football Season. It was done in
  **raw SQL against the live database**, because the UI offers no path.

Reaching past the app to do routine metadata work is the signal this is missing.

## What already exists

This is mostly assembly. The Library already has an **ordered multi-select** (`selected` in
`dashboard/components/library-view.tsx`) and a bulk action bar. Only three actions were ever
wired to it:

| Existing bulk action | Endpoint |
|---|---|
| Bulk schedule | `POST /api/posts/bulk` |
| Bulk re-target | `POST /api/posts/targets/bulk` |
| Merge into carousel | merge modal |

Everything else is still per-post. Validators (`parseTagIds`, `parsePeriodLinks` in
`lib/content-model-validation.ts`) and the field editors (`<TagEditor>`, `<PeriodAttach>`)
already exist and are reused as-is.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Write shape | **add / remove verbs** for tags and periods | Set/replace across a multi-select silently wipes values the *other* selected posts had — destructive and invisible. Mirrors `/api/posts/targets/bulk` |
| Scalars | `content_status`, `content_kind`, `cooldown_days` are **set**, not add/remove | They are single-valued; there is nothing to merge |
| Atomicity | Validate the **entire batch**, then write in **one transaction** | See the counter-example below |
| Field scope | tags, periods, status, kind, cooldown | Pure local metadata: no Meta call, no worker interaction, nothing publishes |
| Excluded | captions, images, targets, sends | Targets already have a bulk route; the rest have real publishing consequences and considered per-post UI |
| Idempotency | Re-adding an existing tag is a **no-op, not an error** | A bulk action will routinely overlap with what some posts already have |
| Migration | **None** | `post_tags` / `post_periods` already hold everything |
| New dependencies | **None** | |

### The atomicity counter-example — do not copy `targets/bulk`

`docs/tasks.md` records that `POST /api/posts/targets/bulk` *"returns 400 on the first
over-caption-limit post and abandons the whole batch"*. That leaves a **partially applied bulk
edit** — some posts changed, some not, with a 400 suggesting nothing happened. That is the worst
outcome for a bulk operation.

`POST /api/posts/bulk-import` gets it right: it validates up to 100 items *fully* before writing,
so any 400 creates zero rows. **Follow bulk-import, not targets/bulk.**

## Architecture

### Endpoint

`POST /api/posts/bulk-edit` → `dashboard/app/api/posts/bulk-edit/route.ts`

```jsonc
{
  "post_ids": [7, 17, 18],
  "tags":    { "add": [13], "remove": [] },
  "periods": { "add": [{ "periodId": 6, "mode": "green" }], "remove": [] },
  "content_status": "ready",        // optional
  "content_kind": "evergreen",      // optional
  "cooldown_days": 90               // optional; null clears to channel default
}
```

Every field optional except `post_ids`. Omitted fields are left alone — an omitted field and an
empty add/remove are both no-ops, and neither means "clear".

**Validation order (all before any write):** every `post_id` exists → every tag id exists →
every period id exists → scalars pass the same CHECK-constraint values the schema enforces
(`content_status IN ('draft','ready','retired')`, `content_kind IN ('one_time','evergreen')`).
Reuse `parseTagIds` / `parsePeriodLinks` so the rules cannot drift from the per-post route.

### Query layer

`bulkEditPosts()` in `dashboard/lib/queries.ts`, wrapped in a single `better-sqlite3`
transaction. `INSERT OR IGNORE` for tag/period adds gives idempotency for free against the
existing primary keys (`post_tags(post_id, tag_id)`, `post_periods(post_id, period_id, mode)`).

### UI

Extend the existing bulk bar in `library-view.tsx` — same `selected` array, no new selection
model. A confirm step showing **"apply X to N posts"**: at 36+ posts a misclick is expensive to
undo by hand, and unlike bulk-schedule there is no queue to inspect afterwards.

## Out of scope

- Bulk caption editing (captions are `1..N` variants — ambiguous across a selection).
- Bulk targeting (already exists, separately).
- Undo. The confirm step is the guard; a real undo needs a change log this project does not have.
- Applying to a *filtered* set without selecting — select-all is enough.

## Risks

| Risk | Mitigation |
|---|---|
| Partial write on a bad batch | One transaction + validate-all-first; explicit regression test asserting **zero** rows changed |
| Replace semantics wiping other posts' data | Add/remove verbs only — no set-semantics path exists to misuse |
| Misclick across 36+ posts | Confirm step naming the change and the count |
| Drift from per-post validation rules | Reuse the same shared validators, do not re-implement |
