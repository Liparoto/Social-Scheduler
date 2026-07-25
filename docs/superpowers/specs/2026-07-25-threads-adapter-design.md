# Threads Adapter — Design

**Date:** 2026-07-25
**Phase:** 6 — Part 2 of 2. Part 1 (platform foundation) shipped in `c5a6757`.
**Goal:** Publish **text**, **image** and **carousel** posts to Threads, fetch their metrics, and
introduce the **`text` post type** end-to-end so a post can carry a caption and no image.

## What Part 1 already did for us

- `channels.platform` accepts `'threads'` and `posts.post_type` accepts `'text'` — **no migration
  needed here.**
- The worker has four registries — `clients._BASE_URLS`, `publisher._PUBLISHERS`,
  `preflight._CHECKS`, `metrics._FETCHERS` — each asserted against `clients.SUPPORTED_PLATFORMS`,
  with a coverage test. Adding Threads means adding one entry to each; miss one and the import
  fails.
- The dashboard reads every platform label and validation from `dashboard/lib/platforms.ts`.
- An unsupported platform already fails one publication terminally and visibly.

## Threads API (verified against Meta docs, 2026-07-25)

Free, no paid tier. Scopes `threads_basic` + `threads_content_publish`. Own host and own OAuth
("Threads Login"), independent of the Instagram/Facebook credentials.

| | |
|---|---|
| Base URL | `https://graph.threads.net/v1.0` |
| Create container | `POST /{threads-user-id}/threads` |
| Publish | `POST /{threads-user-id}/threads_publish` (`creation_id`) |
| Readiness | poll the container until status is `FINISHED` — same shape as Instagram |
| Quota | `GET /{threads-user-id}/threads_publishing_limit` → `quota_usage` (+ reply/delete quotas). **250 API-published posts per rolling 24h** |
| Insights | `GET /{media-id}/insights?metric=views,likes,replies,reposts,quotes` |

Container parameters by type:
- **TEXT** — `media_type=TEXT`, `text` (**max 500 characters**)
- **IMAGE** — `media_type=IMAGE`, `image_url`, optional `text`
- **CAROUSEL** — children created with `is_carousel_item=true`, then
  `media_type=CAROUSEL`, `children=<comma-separated ids>`, optional `text`. **2–20 children**
  (Instagram allows 10).

Threads fetches `image_url` server-side exactly like Instagram, so the existing cloudflared
tunnel logic applies unchanged for image/carousel posts. **A TEXT post has no assets, so it needs
no public URL and no tunnel at all** — `_pub_needs_tunnel` already returns False for an empty
asset list, so this works with no change.

## Global constraints (from CLAUDE.md — apply throughout)

- LOCAL-ONLY, no cloud/paid services. Per-install `.env` + SQLite; worker↔dashboard share the DB.
- **No migration in this sub-project** — Part 1 widened both enums.
- Never hardcode a publish quota: Threads *has* a real quota endpoint, so it must be **read at
  runtime** through the existing gate, exactly like Instagram.
- Never log tokens, PII, or full API responses.
- Failures stay visible and per-publication; one failing never affects another.
- No new dependencies. Python worker in the repo `.venv`.

## Decisions

### Decision 1 — Platform capabilities become data, not hardcoded rules

Threads accepts text posts; Instagram and Facebook do not. Threads allows 20 carousel children;
Instagram allows 10. Rather than scatter `if platform ==` checks, each platform **declares its
capabilities**, and validation reads them:

- `supports_text: bool`
- `max_carousel: int`
- `max_caption_chars: int | None` (Threads 500; `None` = no limit we enforce)

In the worker this lives beside `SUPPORTED_PLATFORMS` in `clients.py` as a **fifth registry**,
asserted against it and added to the coverage test — so a future platform can't be added without
declaring what it can do. This replaces the module-level `MAX_CAROUSEL = 10` constant in
`publisher.py`.

The dashboard mirrors the same three fields in `platforms.ts` for UX (disabling channels, showing
the character counter). That is a deliberate second copy: **the worker is authoritative** and
validates at publish time regardless of what the UI allowed; the dashboard's copy only shapes the
form. Any drift shows up as a publish-time failure, never as a bad post.

### Decision 2 — Text posts get an explicit toggle in the composer

A **"Text only"** switch at the top of the composer. When on: the image area is hidden, a
**500-character counter** appears, and channels whose platform has `supports_text: false` are
disabled in the picker with a short reason. When off, the composer behaves exactly as today.
Inferring "no images means text" was rejected — a half-finished image post is indistinguishable
from a deliberate text post, and the picker couldn't warn until save.

### Decision 3 — Text posts are blocked in the UI *and* rejected at publish

`_validate` gains three rules, each a terminal `_NonRetryable` (retrying can't fix them):
- `post_type='text'` on a platform with `supports_text: false` → rejected, naming the platform.
- `post_type='text'` with any assets attached, or with an empty caption → rejected.
- a caption longer than the platform's `max_caption_chars` → rejected.

The composer prevents all three, but a post can be retargeted later, restored from a backup, or
hand-edited — so the worker never trusts the UI.

### Decision 4 — Metrics: map to existing columns, keep the rest in `raw_json`

Threads returns `views, likes, replies, reposts, quotes`. Mapping into `post_metrics`:

| Threads | Column | Why |
|---|---|---|
| `views` | `impressions` | Threads documents views as total impressions, not unique reach |
| `likes` | `likes` | direct |
| `replies` | `comments` | semantically the same thing |
| `reposts` | `shares` | closest existing column |
| `quotes` | *(none)* | kept in `raw_json` rather than conflated into `shares` |

`reach` and `saves` stay NULL — Threads exposes no unique-reach metric and has no saves concept.
The metric names go in a `THREADS_INSIGHT_METRICS` setting mirroring `FB_POST_INSIGHT_METRICS`,
because Meta renames insight metrics without warning (it retired a batch of Page metrics on
2026-06-15). A rejected metric name must **fail soft**: log, store NULL, keep whatever else came
back.

**Known limitation, carried forward:** auto-fill ranks candidates by `reach + saves`, both of
which are NULL for Threads — so Threads posts score 0 and recycling falls back to age order,
exactly as for Facebook. The planned best-performing-post work revisits ranking; this sub-project
does not change the formula.

## Change surface

**Worker**
1. `clients.py` — `THREADS_BASE`, `'threads'` in `SUPPORTED_PLATFORMS` and `_BASE_URLS`, plus the
   new `PLATFORM_CAPS` registry and its assert.
2. `graph_api.py` — `create_threads_container`, `get_threads_container_status`,
   `publish_threads_container`, `get_threads_publishing_limit`, `get_threads_insights`.
   The insights envelope may differ from Instagram's; parse defensively and fail soft.
3. `publisher.py` — `_publish_threads` (text / image / carousel) registered in `_PUBLISHERS`;
   `_QUOTA_GATED["threads"] = True`; `_validate` reads `PLATFORM_CAPS` for the text, carousel-size
   and caption-length rules; `MAX_CAROUSEL` retired.
4. `preflight.py` — `_check_threads` via `threads_publishing_limit`.
5. `metrics.py` — `_fetch_threads`, `COLUMN_MAP` additions, `THREADS_INSIGHT_METRICS` in `config`
   and `.env.example`.

**Dashboard**
6. `platforms.ts` — the Threads entry plus the three capability fields on every platform.
7. `composer.tsx` — the "Text only" toggle, character counter, and channel disabling.
8. `publication-queue.tsx` — a Threads metrics strip (views / likes / replies / reposts).

**Docs** — `docs/meta-setup.md` gets a Threads section (Threads Login is its own OAuth flow, not
the Facebook one); `reference.md` records the verified endpoints; `docs/tasks.md` status.

## Out of scope

Threads video/Reels · replies and quote-posts · Threads profile-level insights · the `reach`
ranking limitation (BPP work) · X, Discord, Telegram, Pinterest · Facebook's parked real-post
verification.

## Verification

- Full worker suite green, including new Threads publish/validate/metrics tests and an updated
  five-registry coverage test.
- Dashboard `tsc --noEmit` clean; the composer verified in the browser in both modes, and existing
  Instagram/Facebook composing verified unchanged.
- A Threads text post and a Threads image post both dry-run end-to-end; the live DB is returned to
  its exact prior state afterwards.
- A text post targeted at Instagram fails terminally with a clear message, and a sibling
  publication in the same batch still publishes.
- Real posting is **owner-gated** and not attempted: it needs a Threads account plus a long-lived
  token, recorded as a follow-up like Facebook's.
