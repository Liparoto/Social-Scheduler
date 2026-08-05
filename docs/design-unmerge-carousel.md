# Design — Unmerge a carousel into separate posts

**Status:** approved 2026-08-05, ready for implementation planning
**Depends on:** `lib/merge-plan.ts` + `mergePostsIntoCarousel` (the model this follows),
`lib/queries.ts` as the sole data-access layer, the post detail screen
(`app/library/[id]/page.tsx` → `components/post-editor.tsx`), and queue control
(cancel/hold a send) — all shipped.
**Feeds:** the return trip for merge. Splitting a carousel back into singles was explicitly
out of scope of the merge feature (2026-07-30); this is that operation.

---

## 1. Purpose

Merge folds N posts into one carousel. There is no way back. If five photos are merged and it
turns out three of them should have gone out separately, the only recovery today is to delete
the carousel and re-upload the photos in Compose — which loses the post's id, its tags, its
seasons, its channel targets, and any metrics history attached to it.

This sub-project adds one operation: **open a carousel post and split it into one post per
slide.**

### Current shape of the data (measured 2026-08-05)

| | count |
|---|---|
| posts, total | 110 |
| carousel posts | 36 |
| carousels with a `posted` or `publishing` publication | 2 |
| carousels with a `scheduled` or `pending_approval` publication | 0 |
| `post_assets` rows, total | 167 |
| carousels containing a video slide | 0 |

The two published carousels are the ones §5 refuses outright. Nothing is currently queued, so
the scheduled-send guard has no live subject today — it exists for the case that will arrive.

No carousel contains a video slide today, but nothing in the schema or in `createDraftPost`
prevents one, so §4 derives each child's type rather than assuming images.

---

## 2. No schema change

Everything this needs already exists. Splitting a carousel writes:

- new rows in `posts` (one per slide after the first),
- new rows in `post_assets` (one per new post),
- copies of the original's `caption_variants`, `post_targets`, `post_tags`, `post_periods`.

No new column, no new table, no migration. `assets` is not touched at all.

---

## 3. The invariants that actually matter

**Assets are shared, never copied.** Assets are deduped by content hash, so every child
references the same `assets` row the carousel referenced. Nothing is written to `/data`, and no
asset row is created, modified, or deleted by this operation. `assets` is
`ON DELETE RESTRICT` from `post_assets`, which backstops that.

**`post_type` is frozen at write time and only re-validated at publish.** `worker/publisher.py`
checks the declared type against the real asset count when it sends, and fails **non-retryably**
on a mismatch. A child left as `carousel` with one asset looks perfect in the dashboard and then
dies at send with `carousel needs 2-10 assets, has 1`. So every child's `post_type` is set
explicitly, derived from its own asset's `media_kind` — see §4.

**The original post is kept, never consumed.** It holds the post id, any `posted` or `failed`
publications, and the metrics rows that hang off them. Deleting it and creating N fresh posts
would destroy real published records. It survives and keeps slide 1.

**`posts.caption` and `caption_variants` move together.** The worker reads `caption_variants`
in preference to `posts.caption`. Copying one without the other would publish text the post
record says isn't there. Both are copied to every child, always in the same statement pair.

---

## 4. Behaviour

### Entry point

The post detail screen, `app/library/[id]` → `components/post-editor.tsx`. A
**"Split into separate posts"** action, rendered only when the post's `post_type` is `carousel`
and it has 2 or more slides. Merge's entry point is the Library multi-select bulk bar because
merge acts on many posts; unmerge acts on exactly one, so it belongs on that post's own screen.

### Review step

A confirm modal, stating plainly and in this order:

1. how many posts result — "This will split into 5 separate posts.",
2. what each one inherits — "Each keeps the caption, channels, tags, and seasons.",
3. what happens to this post — "This post keeps the first photo, along with its history."

There is **no slide-reorder step.** The split is total and the existing slide order is
preserved, so there is no ordering decision left for the owner to make. (`components/slide-reorder.tsx`
would be the component to reach for if partial extraction is ever added — see §9.)

### On confirm

One `.immediate()` transaction. In order:

1. **Load and plan.** Read the post, its slides in `sort_order`, each slide's `media_kind`, and
   its publication statuses. Run `planUnmerge` (§5). On rejection, return the problem and
   commit nothing.
2. **Rebuild the original's slides.** `DELETE FROM post_assets WHERE post_id = ?` for every one
   of its rows, then `INSERT` a single row for slide 1 at `sort_order = 0`.
3. **Retype the original.** `UPDATE posts SET post_type = <derived>, updated_at = ...` — derived
   from slide 1's own `media_kind`, not assumed to be `single`.
4. **Create one post per remaining slide.** For each slide 2..N, in order: `INSERT` a `posts`
   row copying `caption`, `first_comment`, `content_kind`, `content_status`, `cooldown_days`,
   and `created_by`, with `status = 'draft'` and `post_type` derived from that slide's own
   `media_kind`. Then one `post_assets` row at `sort_order = 0`. Then copy the original's
   `caption_variants` (all rows, `platform` and `sort_order` preserved), `post_targets`
   (`surface` preserved), `post_tags`, and `post_periods` (`mode` preserved).
5. Return `{ ok: true, post_ids: [originalId, ...newIds] }`.

Children are created `status = 'draft'` because they have no publications — that is what
`draft` means here, and it is the honest value.

**Everything on the original except its slides and `post_type` is left alone.** Its `status`,
`caption`, `caption_variants`, `post_targets`, `post_tags`, `post_periods`, `content_kind`,
`content_status`, `cooldown_days`, `created_by`, and every publication row it owns are untouched
— steps 2 and 3 are the only writes against it. The children are *copies of* those values, not
moves, so the original and each child end up holding the same thing independently. Editing one
later does not change the others; that divergence is intended, and is why the confirm modal says
"each keeps" rather than "these are shared".

#### Deriving `post_type`

```
media_kind = 'video'  →  'reel'
otherwise             →  'single'
```

Instagram Stories are a **per-target surface**, not a `post_type` — a story target is carried on
the `post_targets` row and copies across untouched. `story` is never derived here.

This deliberately does **not** call `createDraftPost`, which derives `post_type` from asset count
alone and ignores `media_kind` — a known open bug (logged under the merge section of
`docs/tasks.md`, confirmed live 2026-07-30). Unmerge writes its own `INSERT` with an explicit
`post_type` and so never hits it. Fixing `createDraftPost` stays out of scope; see §9.

#### The `sort_order` trap

`post_assets` has `UNIQUE (post_id, sort_order)`, and SQLite checks it **per-row and
immediately** — there is no deferred check to hide behind. Renumbering slides in place would
collide with itself partway through.

The original's `sort_order` values are also not guaranteed contiguous from zero. So rather than
reasoning about which rows can safely stay, step 2 deletes **all** of the original's join rows
and rebuilds the one it keeps. A `post_assets` row is `(id, post_id, asset_id, sort_order)` and
nothing references its id, so it carries nothing worth preserving. This is the same resolution
`mergePostsIntoCarousel` uses, for the same reason.

#### Why `.immediate()`

This function reads the rows it validates and then writes based on what it read. A deferred
transaction takes the write lock on the first write statement, so it holds together only thanks
to WAL snapshot isolation — and under a concurrent writer it surfaces as an opaque `SQLITE_BUSY`
partway through the split rather than a clean rejection. `.immediate()` takes the lock at
`BEGIN`. Same reasoning, verbatim, as merge.

---

## 5. Guards

All of them live in `dashboard/lib/unmerge-plan.ts`, which imports nothing but `./platforms` —
no database, no `server-only`, no Node built-ins — so the whole chain is exhaustively unit
testable without SQLite. This mirrors `lib/merge-plan.ts` exactly.

Checked in this order, so the message the owner sees is always the most specific one that
applies:

| # | Condition | Status | Message |
|---|---|---|---|
| 1 | Post does not exist | 404 | That post no longer exists. |
| 2 | `post_type` is not `carousel` | 400 | Only a carousel can be split into separate posts. |
| 3 | Fewer than 2 slides | 400 | That carousel only has one photo — there's nothing to split. |
| 4 | Any publication `posted` or `publishing`, or `posts.status = 'posted'` | 409 | That carousel has already been published — splitting it would break the record of what went out. |
| 5 | Any publication `scheduled` or `pending_approval` | 409 | That carousel has a send in the queue. Cancel or hold that send first, then split. |

**Guard 4 — why refuse rather than adapt.** A published carousel has real Instagram media
attached to it and metrics rows accumulating against it. It is a historical record of something
that actually happened. Rewriting its slides would make the record describe something other than
what was posted.

**Guard 5 — why block rather than cancel or retarget.** One carousel with a queued send becomes
N posts, and there is no non-surprising answer to where that send should land. Canceling it
silently kills something the owner scheduled; letting it follow the original silently changes
what publishes. Blocking hands the decision back: queue control already offers cancel and hold,
so the owner resolves it explicitly and then splits. `pending_approval` is included because it
is a real pending send, not a draft.

Guard 4 is checked before guard 5 so a carousel that is both published and re-queued reports the
published problem, which is the one that can never be resolved.

**Publish-in-flight is already handled.** As of 2026-08-05 the worker claims a publication
conditionally before loading anything, so a row being sent reads `publishing` from the first
moment. Guard 4 sees it, and `.immediate()` means the check and the writes cannot be split by a
concurrent claim. Unmerge inherits that protection for free.

---

## 6. Components

| File | Change |
|---|---|
| `dashboard/lib/unmerge-plan.ts` | **new** — `UnmergeCandidate`, `planUnmerge`, `derivePostType`. Pure; imports only `./platforms`. |
| `dashboard/lib/queries.ts` | **new fn** — `unmergeCarousel(postId)`, one `.immediate()` transaction, modelled on `mergePostsIntoCarousel`. Plus a `loadUnmergeCandidate` reader beside `loadMergeCandidate`. |
| `dashboard/app/api/posts/[id]/unmerge/route.ts` | **new** — thin passthrough. Validates that the id parses; every real guard lives below it. Matches `app/api/posts/merge/route.ts`. |
| `dashboard/components/post-editor.tsx` | **edit** — the action, shown only for a carousel with 2+ slides. |
| `dashboard/components/unmerge-modal.tsx` | **new** — the confirm modal from §4. |

Only theme classes that already exist in `app/globals.css`. There are 7 theme families × light
and dark = **14 palettes**, and an invented class renders invisible in some of them.

---

## 7. Testing

### Cases — `dashboard/test/unmerge-plan.test.ts`

Pure, no SQLite, following the existing harness in `dashboard/test/`.

| Case | Expect |
|---|---|
| Post not found | 404 `post_not_found` |
| `post_type` is `single` | 400 `not_a_carousel` |
| `post_type` is `reel` | 400 `not_a_carousel` |
| Carousel with 1 slide | 400 `too_few_slides` |
| Carousel with a `posted` publication | 409 `already_published` |
| Carousel with a `publishing` publication | 409 `already_published` |
| `posts.status = 'posted'`, no publication rows | 409 `already_published` |
| Carousel with a `scheduled` publication | 409 `send_queued` |
| Carousel with a `pending_approval` publication | 409 `send_queued` |
| Both published **and** queued | 409 `already_published` (order matters) |
| Carousel with `failed`/`canceled` publications only | ok — those are not live |
| 3 image slides | ok — 3 children, all `single` |
| Slide 2 is a video | ok — child 2 is `reel`, children 1 and 3 are `single` |
| Slide 1 is a video | ok — the **original** is retyped `reel` |
| 10 slides | ok — 10 children |
| Non-contiguous `sort_order` (0, 3, 7) | ok — rebuilt as 0 on each child |

### Verification, before this is called done

- `cd dashboard && npm test`, `npx tsc --noEmit`, `npm run lint` — all at **0 errors**. Lint is
  currently at 0 and stays there.
- **Transaction, against a scratch copy only.** Make it with `sqlite3 .backup`, never `cp` — the
  DB is in WAL mode and a plain copy reads torn. On the scratch copy: split a carousel, then
  `PRAGMA foreign_key_check` clean, and report `posts` / `post_assets` / `assets` /
  `caption_variants` / `post_targets` / `post_tags` / `post_periods` row counts before and after.
- **`assets` row count must be identical** before and after. If it moved, assets were copied.
- **`listAssetsWithUsage()` and `/media` must be unaffected.** Usage is counted via
  `post_assets`, and unmerge changes *which* posts reference an asset without changing how many
  join rows exist — N rows on one post become N rows across N posts. Confirm the "unused" count
  and the reclaim total are byte-identical before and after.
- **UI in a real browser, with Playwright** — not the in-app browser. `renderToStaticMarkup`
  strips event handlers and cannot measure layout, and a destructive confirm flow needs
  `browser_handle_dialog`. Use a throwaway draft carousel, never real content, and confirm the DB
  is unchanged afterward.
- Check the action renders correctly in at least one light and one dark theme.

---

## 8. Kill switch and dry run

Neither applies. This operation touches only the local SQLite file, makes no Graph API call, and
creates nothing the worker will act on — every child is a `draft` with no publications. There is
nothing here for `KILL_SWITCH` to stop or for `DRY_RUN` to simulate.

---

## 9. Deliberately out of scope

- **Pulling a single slide out** and leaving the rest a carousel. It needs a second transaction
  path and a slide-picker UI, and the total split is the operation actually wanted. Layer it on
  later once this transaction is proven.
- **Fixing `createDraftPost`'s `media_kind` bug.** Unmerge writes its own `INSERT` with an
  explicit `post_type`, so it does not hit it. The bug stays open in `docs/tasks.md`.
- **Re-splitting a published carousel**, in any form. See §5, guard 4.
- **Undo.** There is no dedicated undo. Merge is *close* to an inverse — re-selecting the
  children in the Library and merging returns the same assets to one post — but it is not an
  exact one: merge refuses carousels containing video, so a split that produced a `reel` child
  cannot be re-merged, and merge's caption step replaces the survivor's variants rather than
  restoring what each child had. Splitting is reversible in the common all-images case and not
  in general. The confirm modal should not promise otherwise.
- **Deciding what a queued send should become.** See §5, guard 5 — the owner resolves it in
  queue control first.
