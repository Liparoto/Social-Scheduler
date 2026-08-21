# Design — Archiving a post out of the Library

**Status:** shipped 2026-08-20
**Filed by:** Brittany Liparoto (Windows clone), as a feature request against `/library/20`
**Part of:** ④ Library overview
**Touches:** `migrations/0023_archive_library.sql`, `dashboard/lib/queries.ts`,
`dashboard/app/api/posts/[id]/archive/route.ts`, `post-editor.tsx`, `library-view.tsx`

---

## 1. The problem

`deletePost()` refuses to delete any post with a publication in `posted` or `publishing`, and
the guard sits **on the DELETE statement itself** so it cannot race the worker. That is
correct and stays: erasing such a post would erase the local record of something that is live
on Instagram, and a send that goes live between a check and a write would otherwise destroy
the row describing it.

The cost is that the block is all-or-nothing. Once **any** send reaches `posted`, that post is
permanent in the Library. Test posts, duplicates and mistakes accumulate forever, which works
directly against the Library's job: showing what is actually available to schedule. Retiring a
post (Content status → Retired) keeps it out of auto-fill but leaves it in the list.

Three options were on the table (archive / typed-delete override / detach-but-keep-publications).
**Archive was chosen** — it solves the complaint (clutter) without introducing a second,
irreversible path next to a deliberately reversible one, and it destroys no history.

## 2. What archiving is

`posts.archived_at` — NULL, or a UTC ISO timestamp. **A local visibility flag, and nothing
else.**

Archived means:
- absent from the Library grid and from Compose's reuse-from-library picker.

Archived does **not** mean:
- deleted — the post row, its publications, its metrics and its insights are all untouched;
- unpublished — anything live on Instagram stays live, and this never calls the Graph API;
- unscheduled — a send already on the calendar still goes out (see §4);
- ineligible for auto-fill (see §3, the important one).

## 3. The decision worth defending: archive is not an automation gate

The obvious implementation is for auto-fill to skip archived posts. **It deliberately does
not**, and `worker/tests/test_migration_0023.py` pins that.

Auto-fill eligibility already runs on `content_status` (`draft`/`ready`/`retired`), which is
visible and editable on the post page and in quick edit. Teaching `archived_at` to *also* gate
selection would put one decision behind two switches, and the second one would be invisible
from the very screen the owner reaches for when asking "why isn't this posting?".

Instead, **the Archive action offers to set `content_status` in the same step** — defaulting to
Retired, with Draft and "Leave as is" available, plus the same for `content_kind`. The post
lands in a bucket you can see, and the worker is untouched by this feature.

The one bad combination — archived but still `ready`, so a post you can't see in the Library
can still be scheduled — is handled by making it loud rather than impossible:
- the Archive dialog says so directly if you pick "Leave as is" on a Ready post;
- the Archived view counts them: "N archived posts are still set to Ready…".

That is a deliberate trade: legibility over enforcement. If it ever proves wrong in practice,
changing it means editing this section and a failing worker test, not a silent tweak.

## 4. Already-scheduled sends

Archiving does **not** cancel queued (`scheduled`/`pending_approval`) publications. A scheduled
send is a decision someone made on purpose, and silently cancelling it as a side effect of a
visibility change is the wrong default. The Archive dialog states the count and points at the
Scheduled sends panel above it, so cancelling stays one deliberate action.

Consequently there is **no live-send guard on `setPostArchived()`**, unlike `deletePost()`.
Nothing is destroyed and nothing mid-flight changes, so there is no race to lose.

## 5. Unarchiving

Restores visibility and nothing else. `content_status` is **not** rolled back — there is no
record of what it was, and quietly turning a retired post back to Ready would put it in
auto-fill's reach without anyone asking. Unarchive from the post page, or from the card in the
Library's Archived view.

## 6. UI

- **Post page:** an "Archive post" card directly above Delete. On an archived post the card is
  replaced by a strip at the top of the page (every control below it still works, so an
  archived post must not look identical to a live one) carrying "Unarchive".
- **Delete card:** on a post with a live send it now explains why delete is blocked and points
  at Archive, instead of only saying so after a failed 409.
- **Library:** a "Library / Archived (N) / Library + archived" select, offered only once
  something is archived. It is a **view**, not a filter — the summary counts, the format
  counts and "showing N of M" are all computed over the chosen side. The mixed view badges
  archived cards; the Archived view gives each card an Unarchive button.
- Emptying the archive falls the view back to the Library automatically. Without that,
  unarchiving the last post left an empty grid with the view select gone and no way back —
  caught in browser verification, not by tests.

## 7. Deliberately not done

- **Bulk archive from the Library selection.** The bulk bar is for scheduling and metadata;
  archiving one clutter post at a time is the actual use case described in the request.
- **Auto-archiving** anything, ever. This is a person's decision, like the BPP mark.
- **A typed-DELETE override** (the request's option 2). Still available if the owner wants a
  real delete later, but archiving removes the reason to reach for one.
