# Platform Foundation — Design

**Date:** 2026-07-24
**Phase:** 6 — Part 1 of 2. Part 2 is the Threads adapter (its own spec).
**Goal:** Make adding a social platform **safe and mechanical**: widen the two enum `CHECK`
constraints without destroying data, and replace every silent platform fallthrough with explicit
dispatch that fails loudly. **No new platform, no new feature, nothing user-visible.**

## Why this exists (both findings verified, not assumed)

### 1. The obvious migration silently deletes data

Adding `threads` requires widening `channels.platform`'s `CHECK`, and SQLite cannot `ALTER` a
`CHECK` — the table must be rebuilt. Tested against this repo's actual runner
(`migrate.py`: `BEGIN` then `executescript`), on SQLite 3.40.1:

```
TEST 1 — naive rebuild (CREATE new / INSERT / DROP / RENAME), foreign_keys ON:
  before: posts=1 publications=1
  after:  posts=1 publications=0      <-- child row destroyed, migration reported success

TEST 2 — same, with PRAGMA foreign_keys=OFF inside the script:
  before: posts=1 publications=1
  after:  posts=1 publications=1      <-- preserved; new CHECK active; FK enforcement restored
```

`DROP TABLE` with FK enforcement on performs an implicit delete that **fires
`ON DELETE CASCADE`**. Python's `executescript` issues an implicit `COMMIT` before running, which
ends `migrate.py`'s `BEGIN` — which is why a `PRAGMA` inside the script does take effect.

The blast radius is large. Exact inbound cascading FKs (from the live DB, not reconstructed):

| Rebuilt table | Cascading children |
|---|---|
| `channels` (3) | `publications.channel_id`, `publish_limits.channel_id`, `post_targets.channel_id` |
| `posts` (6) | `post_assets`, `publications`, `post_tags`, `post_periods`, `post_targets`, `caption_variants` |

There are **no triggers, no views, and no indexes** on `channels` or `posts`, so a rebuild has
nothing else to recreate. (`idx_post_targets_channel` is on the *child* table and is unaffected.)

### 2. A third platform would silently behave like Instagram

Platform branching is written as two-way ternaries and bare `else`, so an unrecognised platform
inherits Instagram's or Facebook's behavior with no error:

| Site | Silent result for a new platform |
|---|---|
| `worker/clients.py:25` | returns the install's `graph_base` — the wrong host |
| `worker/publisher.py:302` | falls into Instagram's container→publish flow |
| `worker/preflight.py:51` | calls Instagram's `content_publishing_limit` — **the exact bug just fixed for Facebook, reintroduced** |
| `dashboard/components/ui.tsx:69` | `platform === "instagram" ? "IG" : "FB"` → labelled **"FB"** everywhere |
| `publication-queue.tsx:162` | renders Instagram's metric strip, including a meaningless "Saves" |
| `channel-form.tsx:114`, `channel-credentials.tsx:63`, `app/channels/page.tsx:55` | field labelled "Page id" |
| `composer.tsx:391` | channel labelled "Facebook" |
| `worker/tests/conftest.py:178` | fixture silently builds an Instagram-shaped channel |

Exactly one site degrades well — `worker/metrics.py`'s `_FETCHERS.get(platform)` plus an explicit
log. That is the pattern the rest should adopt.

## Global constraints (from CLAUDE.md — apply throughout)

- LOCAL-ONLY, no cloud/paid services. Per-install `.env` + SQLite; worker↔dashboard share the DB.
- Migrations live in `/migrations` as numbered `.sql` and are the schema's single source of truth.
- Never log tokens, PII, or full API responses.
- **Failures must be visible, never silent**, and per-publication: one publication failing must
  never crash the worker or affect another.
- Never hardcode a rate limit.
- Python worker in the repo `.venv`; tests in `worker/tests/`.

## Decisions

### Decision 1 — One migration rebuilds both tables, using the safe procedure

`migrations/0008_platform_foundation.sql` widens both enums in a single migration:
- `channels.platform` → `CHECK (platform IN ('instagram','facebook','threads'))`
- `posts.post_type` → `CHECK (post_type IN ('single','carousel','reel','story','text'))`

One dangerous operation, performed once, guarded by one regression test. Part 2 (Threads + text
posts) then needs **no migration at all** — it becomes pure application code.

The migration follows SQLite's documented table-rebuild procedure: `PRAGMA foreign_keys=OFF`,
create the replacement with the **complete current column set** (including the three columns
`0002` appended to `posts`), copy rows with explicit column lists, drop, rename, then
`PRAGMA foreign_keys=ON`. It must end with the same columns, defaults, `NOT NULL`s and other
`CHECK`s as today — widening the two target enums is the *only* semantic change.

Widening `posts.post_type` to allow `'text'` now, before anything writes it, is deliberate and
harmless: a `CHECK` that permits an unused value changes no behavior.

### Decision 2 — Keep the CHECK constraints (don't drop them)

The tempting alternative is to delete these `CHECK`s so no future platform needs a rebuild, and
validate only in application code. Rejected: given that an unrecognised platform silently
*behaves like Instagram* (finding 2), a database-level guard against a typo'd or stale platform
value has real value, and the schema is meant to be the source of truth. With the rebuild
procedure proven and covered by a regression test, a future widening is routine rather than
risky — which is the actual problem worth solving.

### Decision 3 — Loud failure, at the right blast radius

An unknown platform must fail **visibly and per-item**, never take the worker down:
- `clients.base_url_for` raises `UnknownPlatform` instead of falling back to a host.
- `publisher` rejects an unknown platform in `_validate`, producing a **terminal
  `_NonRetryable`** — the publication lands `failed` with a clear `last_error`, visible in the
  dashboard, and no other publication is touched. (Retrying can't fix an unsupported platform.)
- `preflight` reports that channel as failed with an explicit message rather than running
  Instagram's quota check against it.
- `metrics` keeps its existing graceful skip-and-log.
- `run.py`'s hardcoded default client stays but becomes explicitly commented as the
  platform-unaware fallback, since per-publication selection is what actually routes work.

### Decision 4 — Schema allows `threads`; the dashboard does not offer it yet

The migration permits `'threads'`, but Part 1 must **not** add it to the dashboard's platform
list. Offering a platform whose adapter doesn't exist would let someone create a channel that
can never publish. Part 2 adds it to the UI list in the same change that adds the adapter.

## Change surface

1. **`migrations/0008_platform_foundation.sql`** (new) — Decision 1.
2. **`worker/tests/test_migration_0008.py`** (new) — the regression test that makes this safe:
   build a DB from all migrations, seed a channel + post with rows in **all nine** cascading child
   tables, apply the migration the way `migrate.py` does, then assert every child row survives,
   `PRAGMA foreign_key_check` is empty, FK enforcement is back on, the new enum values are
   accepted, and a bogus value is still rejected.
3. **`worker/clients.py`** — explicit known-platform map; `UnknownPlatform` exception; no
   silent host fallback.
4. **`worker/publisher.py`** — platform validated in `_validate`; the `if facebook / elif single /
   else` chain replaced by an explicit `{platform: publish_fn}` registry with a uniform signature
   (each platform's function dispatches on `post_type` internally). Instagram and Facebook
   behavior must be unchanged.
5. **`worker/preflight.py`** — explicit `{platform: check_fn}` registry; unknown platform reported
   as a failure.
6. **`worker/metrics.py`** — source its platform list from the shared definition; behavior
   otherwise unchanged.
7. **`dashboard/lib/platforms.ts`** (new) — the single source of truth: for each supported
   platform, its value, full label ("Instagram"), short badge ("IG"), the account-id field label
   ("IG user id" / "Page id"), and whether it uses `linked_page_id`. Export a `Platform` type
   derived from it.
8. **Dashboard refactor** — the nine hardcoded sites in the table above plus
   `library-view.tsx:229`, `caption-variants-editor.tsx:47`, `queries.ts:38` and
   `app/api/channels/route.ts:17` all read from `platforms.ts`. Rendered output for Instagram and
   Facebook must be **identical to today**; this is a pure refactor.

## Out of scope (Part 2 and later)

Threads client/adapter · text-post composer, validation and worker path · the 500-character limit ·
Threads metrics · per-platform image conformance · per-platform carousel limits · X/Bluesky.

## Verification

- Full worker suite green (186 today), plus the new migration test.
- **The migration is exercised against a copy of the real database**, not only a synthetic one:
  copy `data/socialscheduler.db`, apply, and confirm row counts for all nine child tables are
  unchanged and `PRAGMA foreign_key_check` is empty. The live DB is never the test subject.
- `migrate.py` is idempotent afterwards: re-running applies nothing.
- Dashboard `tsc --noEmit` clean; Instagram and Facebook rows render exactly as before (verified
  in the browser, since the refactor touches shared UI).
- A publication on an unsupported platform lands terminally `failed` with a clear error, and a
  second publication in the same batch still publishes.
