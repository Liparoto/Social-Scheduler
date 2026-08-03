# Library quick edit — design

**Date:** 2026-08-02
**Status:** draft — awaiting owner review
**Related:** shares its field set with bulk edit (`2026-08-02-library-bulk-edit-design.md`) —
same fields, one post instead of many. Build either order; the second is cheaper.

## Problem

Changing one field on one post costs a full navigation to `/library/[id]` and back. At 139 posts,
routine cleanup — flipping a status, adding a tag, attaching a season — is dominated by
navigation, not by the edit. The owner wants an edit control on the card that opens a small
dialog and stays on the page.

## What already exists

**No new API is needed.** `PATCH /api/posts/[id]/content` already accepts the entire field set,
and `<PostEditor>` already composes the sub-editors this dialog needs:

| Reused as-is | From |
|---|---|
| `PATCH /api/posts/[id]/content` | existing route |
| `<TagEditor>` | existing component |
| `<PeriodAttach>` | existing component |
| `parseTagIds` / `parsePeriodLinks` | `lib/content-model-validation.ts` |

This is a repackaging job.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Endpoint | **Reuse** `PATCH /api/posts/[id]/content` | It already accepts these fields; a second write path would be two places to keep correct |
| Field scope | `content_status`, `content_kind`, `cooldown_days`, tags, periods | Safe scalars and links; no publishing side effects |
| Captions | **Out of v1** | They are `1..N` variants (generic + per-platform). "Edit the caption" is ambiguous when several exist |
| Images, sends, targets | **Out** | Real consequences, and they already have considered UI in the full editor. A modal is the wrong container |
| Dirty state | **Explicitly decided, never defaulted** | See the trap below |
| After save | Refresh the card **in place** | A full reload defeats the purpose of not navigating |
| Migration | **None** | |
| New dependencies | **None** | |

### ⚠️ The dirty-state trap — this project has already paid for it once

`docs/tasks.md` records, from the Post-now work:

> Post now publishes what's **saved**, so an unsaved caption edit could be silently discarded and
> the old text posted for real. `PostEditor` now blocks the Post-now submit while dirty.

A modal makes this **easier** to hit, not harder: click-outside, Esc, and scrolling the card list
can all dismiss it. An edit that looks made but was never saved is exactly the failure that got
caught once already.

Pick one and implement it deliberately:

- **confirm-on-dismiss** — "Discard changes?" on any dismissal path, or
- **save-then-close** — dismissal commits.

**Never silently drop an edit.** Whichever is chosen goes in the component's header comment and
in `docs/tasks.md`, so the next person does not have to re-derive it.

### The `closest('a')` regression risk

`library-view.tsx` already guards the card's click handler with `closest('a')`, because the card
is a `div role=button` that contains a link to `/library/[id]` — without the guard, clicking the
title would toggle bulk-selection. A new edit trigger inside the card needs the same treatment,
or **bulk-select breaks**. This is a known, previously-fixed trap in this exact file.

## Architecture

`dashboard/components/quick-edit-modal.tsx` — a client component rendered from the Library card.
Loads the post's current values, composes `<TagEditor>` and `<PeriodAttach>` plus status / kind /
cooldown controls, and `PATCH`es on save.

Where the values come from: the Library list already carries status, kind, and tags; periods
arrive with the period-visibility work, or via `getPostPeriods()` on open. Either is fine — a
single fetch on open is acceptable here because it is one post, not 139.

## Out of scope

- Captions, images, scheduled sends, targets.
- Creating posts.
- Keyboard-driven bulk workflows (open next / previous).
- Any new endpoint.

## Risks

| Risk | Mitigation |
|---|---|
| Silently discarded edits | Explicit dirty handling, chosen in the design phase, documented in code and tasks.md |
| Bulk-select breaking | Apply the existing `closest('a')` guard pattern; explicit regression check |
| Drift from the full editor's validation | Reuse the same route and the same shared validators |
| Modal becoming a second full editor | Field scope fixed above; images/sends/targets explicitly excluded |
