# Library quick edit — captions — design

**Date:** 2026-08-03
**Status:** approved
**Related:** extends `2026-08-02-library-quick-edit-design.md`, which deferred captions from
v1. That deferral is now lifted deliberately, with the full variants editor rather than a
single box.

## Problem

Quick edit covers status, kind, cooldown, tags and periods. The caption — the field most
likely to need a small fix — still costs a round trip to `/library/[id]`. The owner wants
captions in the dialog, including per-platform variants.

## What the data actually says

Measured against the live install before designing:

| Question | Answer |
|---|---|
| Posts with caption variants | 139 of 139 |
| Variants per post | exactly 1, every post |
| Platform-specific variants | **none** — all 139 are generic ("Any") |
| Posts where `posts.caption` ≠ the generic variant | **7** |

So per-platform variants are a capability being built ahead of use, which is fine and
intended. The drift, however, is a live bug (see below).

## The `posts.caption` drift

`setCaptionVariants()` replaces `caption_variants` and never touches `posts.caption`.
Nothing else writes that column after creation except the merge path. But `posts.caption`
is what the Library card renders, what the caption search box filters on, and what
`captionsForPlatform()` falls back to when a platform has no matching variant.

The two have already diverged on 7 posts. Post 86 is a genuine split: the card reads
"The lights are just brighter with the Superbo…" while the publisher would send
"Quite the View!". A caption editor in the Library makes this impossible to ignore —
you would edit a caption, save, and watch the card keep the old text.

**Decision: `PATCH /api/posts/[id]/content` syncs `posts.caption` whenever it writes
caption variants.** In the shared route, so the full editor is fixed by the same change.

| Saved variants | `posts.caption` becomes |
|---|---|
| A generic ("Any") variant exists | that variant's body |
| Only platform-specific variants | **unchanged** — still the live fallback for any targeted platform with no variant of its own |
| No variants at all | `null` — the caption was genuinely removed |

The middle row is the one that is easy to get wrong: overwriting `posts.caption` there
would silently change what publishes to a platform the user never edited.

**Not in scope:** the 7 already-drifted posts. They heal as they are edited. Post 86 stays
split until someone touches it. A one-off reconcile was offered and deferred.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Caption scope | **Full variants editor** — reuse `<CaptionVariantsEditor>` | Owner's call; matches the full editor exactly, no second caption UI to keep correct |
| Where variants load from | **`GET /api/posts/[id]/content`, fetched on open** | See below |
| Write path | Still the existing `PATCH /api/posts/[id]/content` | One write path, one set of validators — unchanged from v1 |
| `posts.caption` | Synced in the shared route | Above |
| Generic-caption counter | Count against the strictest limit among the post's target platforms | `captionLimit("")` is null, so every post today types with no feedback at all |
| Migration | **None** | |
| New dependencies | **None** | |
| Worker changes | **None** | |

### Why a new read endpoint, when v1 banned new endpoints

The v1 plan's "no new endpoint" rule existed to stop a second **write** path competing with
`PATCH .../content`. That still holds — this adds no write path.

The alternative was carrying variants in the Library list query. Captions are the bulk of a
post's text, and the whole point of adding variants is that there will be more of them:
139 posts × 3 platforms × up to 2,200 chars is roughly 900 KB shipped on every Library load
to serve a dialog that opens one post at a time. A single fetch on open — which the v1
design already sanctioned for periods — is the cheaper shape.

`GET /api/posts/[id]/content` returns that post's caption variants and nothing else.

### ⚠️ A pending or failed load must never wipe captions

`PATCH` replaces caption variants wholesale. If the dialog saved while the fetch was still
in flight, or after it failed, it would send an empty list and delete every caption on the
post.

**Rule: until captions have loaded, the PATCH body omits `caption_variants` entirely.** The
route only writes fields present in the body, so status, kind, cooldown, tags and periods
still save normally and the captions are simply not part of that write. A load failure is
shown in the captions section, and the section is read-only until a retry succeeds.

This is the caption-shaped version of the trap this dialog already guards against
elsewhere: never let something the UI could not display get destroyed by a save the user
made for another reason.

## Architecture

`dashboard/components/quick-edit-modal.tsx` gains a captions section directly under the
header, above status/kind/cooldown — it is what the dialog is opened for. The panel stays
`max-w-2xl` and scrolls inside `max-h-[90vh]`.

| Piece | Responsibility |
|---|---|
| `<CaptionVariantsEditor>` (reused as-is) | rows, platform picker, add/remove, per-platform counter |
| New `GET` in `app/api/posts/[id]/content/route.ts` | return this post's caption variants |
| `PATCH` in the same file (modified) | sync `posts.caption` per the table above |
| New `lib/quick-edit-captions.ts` | pure logic: normalization for the dirty check, strictest-limit resolution, and the sync rule |
| `lib/queries.ts` | a small `updatePostCaption()` alongside `setCaptionVariants()` |

The generic-caption counter needs no new data: `target_platforms` and `post_type` are
already on the Library list row. Two details that decide what "strictest" means:

- **Only platforms that would actually publish the generic caption count.** Per
  `captionsForPlatform()`, a platform with its own variant never falls back to the generic
  one, so a targeted platform that has a specific variant in the current draft is excluded
  from the generic row's limit.
- **Platforms with no limit are skipped**, not treated as zero. If every remaining platform
  is unlimited, or the post has no targets at all, the generic row gets no counter — the
  same "no limit applies yet" state the editor already shows for "Any" today.

## Validation and dirty state

- Client blocks Save when any row is over its limit — platform-specific rows via the
  existing `overLimitCaptionVariants()`, generic rows via the strictest-target rule.
- The route's cross-field `captionLimitError()` remains the real gate; the client check is
  for feedback, not authority.
- Blank rows are dropped before sending, as `PostEditor` already does.
- Captions join `isDirty` using the same normalization `PostEditor` uses: trim, drop empty
  bodies, `""` platform → `null`. Captions cannot read dirty before they have loaded.
- Confirm-on-dismiss is unchanged and now covers caption edits too.

## Testing

Pure logic in `lib/quick-edit-captions.ts` with `node:test`, matching how bulk edit keeps
its form logic testable:

- the sync rule's three cases (generic present, only platform-specific, no rows);
- strictest-limit resolution across several target platforms, including a post with no
  targets and a platform whose limit depends on `post_type`;
- dirty normalization: reordering, blank rows and whitespace read as clean.

Browser verification, against the real database with the post restored afterwards:

- opening shows the post's actual caption, not a blank box;
- editing and saving persists, and the **card text updates in place** (this is what the
  `posts.caption` sync buys);
- an over-limit caption blocks Save with the limit named;
- a failed variants load leaves the captions alone while a status change still saves;
- dismissing with an edited caption prompts, and dismissing untouched does not.

## Out of scope

- Reconciling the 7 already-drifted posts.
- Images, scheduled sends, targets — still the full editor's job.
- Caption rotation behaviour (multiple generic variants) beyond what the editor already
  exposes.

## Risks

| Risk | Mitigation |
|---|---|
| A save wiping captions that never loaded | Omit `caption_variants` from the PATCH until loaded; save stays available for the other fields |
| Overwriting `posts.caption` for a platform-only post | Explicit middle row in the sync table, covered by a test |
| The dialog becoming a second full editor | Acknowledged, and accepted deliberately: the v1 design named this risk, and captions are where the owner drew the line. Images, sends and targets stay out |
| Client and server disagreeing on limits | Both read `captionLimit()`; the server check stays authoritative |
