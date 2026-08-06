# First-Comment Automation — Implementation Plan

Closes `docs/tasks.md:627` — "First-comment automation (post-publish comment endpoint)."

## The problem

The first comment has never been implemented. This is not a hashtag bug and not an
Instagram/Threads-specific bug — **nothing in this codebase posts a comment to anything.**

Traced end to end:

| Layer | State today |
|---|---|
| Composer UI | Field exists, labelled "auto-posted after publish — good for hashtags" (`dashboard/components/composer.tsx:504`) |
| Create routes | Persist it (`app/api/posts/route.ts:146`, `app/api/posts/draft/route.ts:144`) |
| Update route | **Does not accept it** — `PATCH /api/posts/[id]/content` handles content_kind, content_status, cooldown_days, targets, period_links, caption_variants, and nothing else |
| Post editor / quick-edit | **No field at all** |
| Bulk import | Hardcodes `first_comment: ""` (`lib/queries.ts:773`) |
| Worker plan | Carries it (`worker/publisher.py:374`) — the only line in the worker that mentions it |
| Worker publish | **Never reads it.** No comment method exists in `graph_api.py` or `clients.py` |
| `publications.first_comment_status` | Defined in `migrations/0001_init.sql:120`, never written by any code |

Live DB confirms it: of 111 posts, **zero** have `first_comment` set, and all 25 publications
read `first_comment_status = 'none'` — the insert default.

Two independent gaps, both need fixing:
1. **The worker never posts the comment** (the headline bug).
2. **The value can only be set at creation time on /compose.** For anything created by bulk
   import or the Notes/extract path — which is most of the library — there is currently no
   way to add a first comment at all.

## Verified platform facts

Checked against the live API on 2026-08-05, not from memory.

**Threads** — `debug_token` returns `threads_basic, threads_content_publish,
threads_manage_replies, threads_manage_insights, threads_read_replies`. Valid, expires
~2027-01. A first comment is a **self-reply**: create a TEXT container with `reply_to_id`
set to the published thread id, poll it, publish it. Uses `threads_content_publish` — the
same scope already used to publish, so no new permission is required.

**Instagram** — `POST /{ig-media-id}/comments` with `message`, on `graph.instagram.com`.
Requires `instagram_business_manage_comments`. App-token introspection is unavailable for
Instagram-Login tokens (`debug_token` → `(#2) Service temporarily unavailable` across all
hosts/versions), so the scope could not be listed directly. Behavioural probe: `GET
/{media-id}/comments` succeeds, which requires that same scope — strong evidence it is
granted. **Not conclusive.** Phase 4 resolves it with one real comment on the personal
account. If it fails there, the fix is re-authorising the token with the scope added, not
a code change.

**Facebook Pages** — `POST /{post-id}/comments`, requires `pages_manage_engagement`. No FB
channel exists on this install, so this is written but unverifiable here. See Phase 2.

**Discord / Telegram** — out of scope. Neither has a "first comment" concept that maps
cleanly; a follow-up message is a different feature. They record `first_comment_status`
as `'none'`.

## Global constraints

- **A failed comment must never fail the publish.** The post is already live and cannot be
  unpublished. The comment attempt sits *after* the publication is marked `posted`, in its
  own try/except that cannot alter the publish outcome.
- **A failed comment must be visibly failed, never silent** — `first_comment_status='failed'`
  plus the error text, surfaced in the UI (Phase 3).
- **Stories get no comment.** Follows the existing precedent at `publisher.py:373`, where
  the caption is nulled in the *plan* rather than skipped at the call site, so dry-run shows
  the truth.
- **Dry run posts nothing** and shows the intended comment in the plan output.
- **No migration.** `first_comment_status` and `first_comment_remote_id` already exist with
  the right CHECK constraint. Adding columns here would risk the renumbering trap in
  `docs/tasks.md` for zero gain.
- **TDD** per `superpowers:test-driven-development` — failing test first, on every task.

## Phase 1 — Worker: plumbing + Instagram

**Task 1.1 — Null the comment for stories in `_build_plan`.**
`worker/publisher.py:374`. Mirror the caption line directly above it:
`"first_comment": None if surface == "story" else post["first_comment"]`.
Also normalise empty string to `None` so a blank field is never treated as work to do.

**Task 1.2 — `create_comment()` on `GraphClient`.**
`worker/graph_api.py`. `POST /{media_id}/comments` with `message`, returns the comment id.
Instagram caps a comment at 2200 characters; reject over-length before the call rather than
letting Meta return an opaque error.

**Task 1.3 — A `_COMMENTERS` registry in `publisher.py`.**
Mirrors the existing `_PUBLISHERS` registry and its consistency assert, so a newly added
platform cannot silently inherit the wrong comment behaviour. Platforms with no support map
to `None`.

**Task 1.4 — Wire it into `publish_one`, after the publish succeeds.**
`worker/publisher.py:797-801`, immediately after the row is marked `posted`:

```
set first_comment_status='pending'
try:
    remote_id = _COMMENTERS[platform](client, plan, media_id, token, ...)
    set first_comment_status='posted', first_comment_remote_id=remote_id
except Exception:
    set first_comment_status='failed', first_comment_error=<text>
    log it — never re-raise
```

`pending` is written *before* the call so a worker crash mid-attempt leaves a visible
`pending` rather than a false `none`.

**Retry policy: one attempt, no automatic retry.** The publication is already `posted`, so
the existing `next_retry_at` backoff machinery does not apply to it. A failed comment
becomes a visible `failed` that Phase 3 exposes with a manual retry. Automatic retry here
risks double-posting the comment, which is worse than a visible failure.

**Verification:** unit tests for the story skip, the empty-string skip, a successful comment,
and — most importantly — a commenter that raises must leave the publication `posted` with
`first_comment_status='failed'`. Then a dry run showing `first_comment` in the plan with
nothing sent.

## Phase 2 — Worker: Threads (and optionally Facebook)

**Task 2.1 — `reply_to_id` on `create_threads_container()`.**
`worker/graph_api.py`. New optional param, omitted from the payload when absent so existing
publish calls are byte-identical.

**Task 2.2 — The Threads commenter.**
Create a TEXT container with `reply_to_id=<published thread id>`, poll it with the existing
`_poll_until_finished(..., status_fn=client.get_threads_container_status)`, then publish it.
Reuses the poll loop rather than duplicating it — the docstring at `publisher.py:388` already
anticipates exactly this reuse.

**Task 2.3 — Facebook (optional, defer if you prefer).**
`POST /{post-id}/comments`. Small, but unverifiable without a FB channel, and shipping
unverified code contradicts the "never merge unverified work to look finished" rule.
**Recommendation: skip it for now** and add it alongside the FB Pages adapter already in
flight, where it can actually be tested.

**Verification:** unit tests per platform, then dry run.

## Phase 3 — Dashboard: make it editable and make failures visible

**Task 3.1 — Accept `first_comment` in `PATCH /api/posts/[id]/content`.**
Follow the existing field-by-field validation style in that route. Trim, and store empty as
`NULL` so it matches what the create routes already write.

**Task 3.2 — Add the field to the post editor.**
`dashboard/components/post-editor.tsx`, matching the composer's label and helper text so
the two surfaces describe the same feature identically.

**Task 3.3 — Surface the status on the publication.**
Show `posted` / `failed` / `pending` wherever a publication's outcome is shown, with the
error text on failure and a manual retry action. This is the "visibly failed" requirement —
without it, a failed comment is only discoverable by reading the DB.

**Verification:** lint stays at 0 errors, plus a real browser pass — per the harness notes,
`renderToStaticMarkup` cannot catch handlers, so the edit-and-save round trip gets verified
in the browser against a scratch DB copy on port 3940.

## Phase 4 — Live verification

Order matters; do not reorder.

1. **Restart the worker.** A live heartbeat proves the daemon is running, not that it is
   running current code.
2. **Dry run first** (`DRY_RUN=1` at launch, which now outranks `.env`). Confirm the plan
   shows the comment and nothing is sent.
3. **One real Instagram post** on the personal account with a short first comment. This is
   the conclusive `instagram_business_manage_comments` test. If it fails on permissions,
   re-authorise the token with the scope added — no code change.
4. **One real Threads post**, same shape.
5. **Deliberate failure test** — point a commenter at a bad media id and confirm the
   publication still reads `posted` with `first_comment_status='failed'`. This is the
   constraint most worth proving, since it is the one that protects live posts.
6. Update `docs/tasks.md:627`, and correct the stale scope note at `reference.md:85`.

## Risks

- **IG scope unconfirmed until Phase 4.3.** Mitigated by it being a re-auth, not a rebuild.
- **Comment ordering is not guaranteed.** Meta does not promise your own comment stays
  first if others comment within the same second. Not solvable via API; worth knowing.
- **Threads self-reply is a real post in your feed**, not a hidden comment. That is how
  Threads works, but it is different from Instagram's behaviour and you should see one
  before deciding to use it on the business account.
- **Existing published posts are unaffected.** The 21 already-posted publications keep
  `first_comment_status='none'`; this feature is forward-only.
