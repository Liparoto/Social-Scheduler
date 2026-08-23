# TikTok Adapter — Design

**Date:** 2026-08-22
**Phase:** 6 — sub-project 6 (after Facebook Pages, Threads, Discord/Telegram).
**Goal:** Publish **video** posts to **TikTok** as a first-class channel, scheduled and
auto-filled like every other platform.

## Why this one is different

Every platform so far publishes on command: the worker calls an endpoint and the post is live.
TikTok, for this install, **cannot**. Its API has two posting modes, and the one that publishes
outright is gated behind a review this project structurally cannot pass (Decision 1). What is
left is *delivery*: the worker puts the video into the creator's TikTok inbox at the scheduled
time, and the creator finishes the post in the TikTok app.

That single fact drives most of what follows — an honest status model, a follow-up watcher, and
a caption that does not travel.

| | Meta (IG/FB/Threads) | Discord/Telegram | **TikTok** |
|---|---|---|---|
| Auth | long-lived token, pasted | webhook URL / bot token | **OAuth + PKCE, 24h token** |
| Token upkeep | none (60-day) | none | **refresh every 24h, rotating** |
| Media transfer | Meta fetches a public URL | bytes in the request | **chunked byte upload** |
| Publishes on command | yes | yes | **no — delivers to inbox** |
| Caption sent by us | yes | yes | **no — creator writes it** |
| Post id known at publish | yes | yes | **no — learned later, or never** |
| Images | yes | yes | **no (see Decision 2)** |

## The two gates that shaped this design

Both were verified against TikTok's own docs on 2026-08-22. Neither is a limitation of this
codebase; both are properties of TikTok's platform.

**Gate 1 — the audit.** An unaudited API client may only post `SELF_ONLY` (private) content, and
every account posting through it must be set to private at the time of posting. Lifting that
requires TikTok's app review, which mandates *"a fully developed, externally facing site with
visible Privacy Policy and Terms of Service links"*, a demo video whose domain matches that site,
and which explicitly excludes *"private-use purposes"* and *"beta or development versions,
incomplete apps, and test versions"*. SocialScheduler is a self-hosted internal tool on
`localhost` with no website and no users — the exact category the review is written to reject.
Review takes several days to two weeks per submission.

**The audit is per API client (`client_key`), not per end user.** A clone that registers its own
TikTok app is unaffected by any other clone's status, and needs no audit for inbox delivery.

**Gate 2 — photos need a verified domain.** Video may be sent as raw bytes (`FILE_UPLOAD`, no
verification). Photo posts accept **only** `PULL_FROM_URL`, and that URL must sit on a domain or
prefix whose ownership is proven by DNS. This install serves assets from an ephemeral
`*.trycloudflare.com` address it does not own, so photo posting is not merely unbuilt — it is
unreachable without buying a domain.

## Decisions

### Decision 1 — Deliver to the inbox; do not build direct post

`MEDIA_UPLOAD` (inbox) is the only mode that produces a **public** post from this install. The
worker uploads the video; TikTok notifies the creator; the creator writes the caption and
publishes inside the TikTok app, choosing their own visibility.

`DIRECT_POST` is deliberately **not built**. It would require the whole Content Sharing
Guidelines compliance layer in the composer — a privacy dropdown with no default value, a live
`creator_info` fetch on render, comment/duet/stitch checkboxes defaulting to off, a
commercial-content disclosure toggle, and the exact string *"By posting, you agree to TikTok's
Music Usage Confirmation"* — none of which does anything until an audit this install cannot
obtain. Building it would be speculative work behind an external gate.

No `tiktok_post_mode` column is added either, for the same reason: a column with one possible
value is speculative schema. If TikTok's stance ever changes, direct post is a contained
follow-up — a second init endpoint, the compliance UI, and a migration.

### Decision 2 — Video only, which needs a new capability flag

`PLATFORM_CAPS` assumes every platform accepts images; `incompatibleChannelsForPost` says so
outright ("every other post_type carries assets and every platform we know about accepts
images/carousels"). TikTok is the first that does not, per Gate 2.

Add `PlatformCaps.supports_images: bool = True`, set `False` for TikTok only, and extend both
the worker's `_validate` and the dashboard's compatibility check to gate `single`/`carousel` on
it. Default `True` preserves today's behaviour for every existing platform. The composer must
refuse an image post targeted at TikTok the same way it already refuses a text post to
Instagram — before it becomes a scheduled publication that dies terminally.

### Decision 3 — OAuth as a **Desktop** app, so the redirect can be localhost

TikTok web apps must use HTTPS redirect URIs. **Desktop** apps may use `http://localhost` or
`127.0.0.1` with a port (wildcard ports allowed, no query or fragment on the registered URI) and
require PKCE. Registering as Desktop means the connect flow needs no tunnel, no domain and no
hand-pasted token:

**Channels → Add channel → TikTok → Connect** → `https://www.tiktok.com/v2/auth/authorize/`
→ creator approves → back to `http://localhost:3939/api/channels/tiktok/callback` → the
dashboard exchanges code + PKCE verifier at `https://open.tiktokapis.com/v2/oauth/token/` and
stores the tokens.

The dashboard owns this flow — it is the component with a browser. `TIKTOK_CLIENT_KEY` and
`TIKTOK_CLIENT_SECRET` live in `.env`, are read server-side only, and are added to `redact.py`.
The PKCE verifier is held server-side for the duration of the exchange, never sent to the client.

Scopes requested: `user.info.basic` (preflight + account naming), `video.upload` (delivery),
`video.list` (metrics). `video.publish` is not requested — it cannot be granted without the
audit, per Decision 1.

### Decision 4 — Token refresh is a worker responsibility, and it is new here

TikTok access tokens expire after **24 hours**. The refresh token lasts 365 days and **rotates**:
each refresh returns a new one, and failing to store it locks the channel out permanently. No
existing platform in this project needs upkeep like this — Meta's long-lived tokens simply sit
in the row.

`channels` gains `refresh_token` and `refresh_token_expires_at`. Before any TikTok API call the
worker refreshes if the access token is within one hour of expiry, writing back **both** tokens
and both expiries in one transaction. Preflight reports how long the refresh token has left, so
the 365-day cliff is visible well before it arrives rather than discovered by a failed post.

A refresh failure is retryable, not terminal — except when TikTok reports the grant is invalid
(revoked authorization), which is terminal and must say "reconnect this channel".

### Decision 5 — Chunked `FILE_UPLOAD`

`POST /v2/post/publish/inbox/video/init/` with `source_info: {source: FILE_UPLOAD, video_size,
chunk_size, total_chunk_count}` returns a `publish_id` and an `upload_url`; the bytes go by `PUT`
with `Content-Range` headers. Chunks are 5–64 MB (final chunk up to 128 MB, 1–1000 chunks); a
file under 5 MB is a single chunk. Converted 4K clips can exceed 64 MB, so multi-chunk is a real
path, not a theoretical one, and gets its own test.

Delivery is confirmed by polling `POST /v2/post/publish/status/fetch/` until
`SEND_TO_USER_INBOX`, reusing the publisher's existing poll-until-ready helper (the same one
Instagram containers use). `PROCESSING_*` means keep waiting; `FAILED` fails the publication
visibly with TikTok's own reason.

The video sent is the **untouched original**, not the Instagram-conformed derivative:
`needs_conformed_media=False`, same as Discord and Telegram. TikTok has its own aspect rules and
the review guidelines forbid apps adding watermarks, logos or promotional text to content.

### Decision 6 — `delivery_state`, not a new publication status

A video sitting in the inbox is **not posted**, and the queue must not say it is. This is the
same error as the Threads metrics bug: a value standing in for a fact it does not represent.

`publications.status` keeps its meaning — "the worker's job succeeded" — and gains no new enum
value. A new `delivery_state` column carries TikTok's post-delivery lifecycle:

| value | meaning | shown as |
|---|---|---|
| `NULL` | platform publishes directly (every other platform) | today's badge |
| `inbox` | delivered, waiting on the creator | **"In your TikTok inbox — open TikTok to publish"** |
| `published` | confirmed live on TikTok | **"Live on TikTok"** |
| `gave_up` | still unconfirmed after the watch window | **"Delivered — publication unconfirmed"** |

A new `status` value would ripple through the queue views, auto-fill depth counting and the
metrics due-query; a new column touches only what renders TikTok. `delivery_checked_at` records
the last watcher poll.

The post page keeps the composed caption visible with a copy button, since it must be retyped in
the TikTok app (Decision 9).

### Decision 7 — A watcher learns whether it went live; metrics follow for free

After delivery, a slow-cadence loop re-polls `status/fetch` for that `publish_id`. TikTok returns
`publicaly_available_post_id` **only once the post is public and through moderation** — so the
id's arrival *is* the proof it went live. On arrival: `delivery_state='published'` and
`remote_post_id` is set. The watcher gives up after 7 days → `gave_up`.

Metrics then need **no special-casing in the due-query at all**: it already requires
`remote_post_id IS NOT NULL`, so TikTok rows are invisible to it until the id exists. Metrics
come from `/v2/video/query/` (scope `video.list`) and are stored under TikTok's own vocabulary —
views, likes, comments, shares — never Instagram's, per the rule the Threads fix established.

`remote_container_id` holds the `publish_id`, exactly parallel to Meta's container id.

> **This decision rests on Risk R1 below and must not be built before R1 is probed live.**

### Decision 8 — "No first comment" and "no quota endpoint" are declared, not omitted

`_COMMENTERS['tiktok'] = None`: TikTok has no first-comment concept reachable here — and with the
creator completing the post themselves, there is no moment for the worker to comment on.

`_QUOTA_GATED['tiktok'] = False`: TikTok documents roughly 15 posts per day per creator but
exposes **no endpoint to read it**. The one endpoint that returns creator limits
(`creator_info/query`) requires the `video.publish` scope this install cannot hold. Inventing a
number would break the project's don't-hardcode-the-publish-limit rule; declaring `False` records
that the platform genuinely offers nothing to read.

TikTok's `spam_risk_too_many_posts` error is therefore treated as **retryable with backoff**, not
terminal — it is the quota signal arriving as an error instead of a number.

### Decision 9 — The caption does not travel, and the UI must say so

The inbox init endpoint accepts only `source_info`. There is no `post_info`, no title, no
description — TikTok's flow expects the creator to write the caption in its own editor. The
composer must state this plainly on any post targeting TikTok rather than letting the owner
assume their caption went with it. Caption-length validation is skipped for TikTok because
nothing is sent.

### Decision 10 — One app per clone; never a shared `client_key`

Each install registers its own TikTok app and holds its own `client_key`/`client_secret`, exactly
as it holds its own Meta credentials. Sharing one app across clones would mean distributing a
client secret, would make one owner accountable for another's posting, and would break the
project's foundational rule that installs are independent. It also buys nothing: inbox delivery
needs no audit, so a second clone gains nothing from the first's app.

## Global constraints (from CLAUDE.md)

- **Kill switch / dry run** — TikTok publications obey both, unchanged. A dry run performs no
  init, no upload and no status poll.
- **Secrets** — `client_key`, `client_secret`, access and refresh tokens are never logged; all
  are added to `redact.py` and covered by its test.
- **Failures are visible** — an upload or status failure fails that publication only, with
  TikTok's reason on the row. Other targets of the same post are untouched.
- **Schema lives in `/migrations`** — one file, `0025_tiktok.sql`.
- **HTTPS only**, and Python's missing CA store applies: TikTok calls go through the same
  `requests`-based client convention as every other adapter.
- **Windows-compatible** — no Unix-only imports at module scope in the new worker code.

## Change surface

**Migration `0025_tiktok.sql`**
- `channels.platform` CHECK gains `'tiktok'` — table rebuild, following `0009`'s pattern
  **including** its `PRAGMA foreign_keys = OFF` trap and explicit `BEGIN`/`COMMIT`.
- `channels` += `refresh_token`, `refresh_token_expires_at`.
- `publications` += `delivery_state`, `delivery_checked_at`.
- Filename is final once applied — renumbering an applied migration re-runs it and fails.

**Worker**
- New `worker/tiktok_api.py` — `TikTokClient`: OAuth token exchange/refresh, inbox init, chunked
  upload, status fetch, user info, video query. Same conventions as the other clients (raise on
  non-OK, never interpolate a token into an error, no retry logic of its own).
- The ten registries, all assert-guarded: `SUPPORTED_PLATFORMS`, `_BASE_URLS`, `_API_VERSIONS`,
  `PLATFORM_CAPS`, `_CLIENT_FACTORIES`, `_PUBLISHERS`, `_QUOTA_GATED`, `_COMMENTERS`,
  `preflight._CHECKS`, `metrics._FETCHERS`.
- `PlatformCaps` += `supports_images`; `_validate` gates on it.
- Token refresh step ahead of any TikTok call; delivery watcher in the worker cycle.
- Preflight check: `/v2/user/info/` — read-only, names the account, posts nothing, and reports
  the refresh token's remaining life.

**Dashboard**
- `lib/platforms.ts` — the TikTok entry, mirroring the worker's caps, plus `supportsImages`.
- Channel add/edit: a **Connect** button instead of token fields; OAuth callback route.
- Queue, post page and Insights render `delivery_state` and TikTok's metric vocabulary.
- Composer: TikTok refuses images; caption-does-not-travel notice; caption copy button.

**Docs**
- `docs/tiktok-setup.md` in the style of `other-platforms-setup.md`: create the app, add Login
  Kit + Content Posting API, set type Desktop, register the localhost redirect, connect, preflight,
  first real post.
- `reference.md` gains TikTok's verified request shapes.

## Risks — probe before building

- **R1 (load-bearing).** Does an **inbox** `publish_id` ever reach `PUBLISH_COMPLETE` with a
  `publicaly_available_post_id` after the creator publishes in-app? The status docs list both
  states for uploads, but this is inference, not a documented guarantee. **Probe it with one real
  upload before building the watcher (Decision 7).** If it does not hold, the fallback is matching
  the video via `/v2/video/list/` on `create_time` proximity — fuzzy, and worth its own decision
  rather than an assumption; failing that, TikTok ships with no metrics, like Discord/Telegram.
- **R2.** Video duration cannot be validated before upload: the endpoint exposing
  `max_video_post_duration_sec` needs `video.publish`. An over-long video therefore fails at
  TikTok's processing step and surfaces through the status poll. Acceptable and honest, but it
  means a failure mode the composer cannot pre-empt.
- **R3.** Chunk boundary rules (5 MB min, 64 MB max, 128 MB final) are unforgiving; the
  multi-chunk path needs a test with a genuinely oversized file, not a mocked size.

## Out of scope

- **Direct post** and its compliance layer (Decision 1); the audit application itself.
- **Photos and carousels** (Gate 2) — unblocked only by owning a domain.
- **TikTok's own scheduling**; drafts created in the TikTok app; comments/replies.
- Duration/format pre-validation beyond what the existing video pipeline already does.

## Verification

1. Migration applies to a scratch copy of the live DB, and re-applies idempotently.
2. Registry asserts + `test_platform_dispatch.py` pass with TikTok added everywhere.
3. Worker tests, each failing first: single-chunk upload, multi-chunk upload, refresh-token
   rotation (new token stored), refresh failure vs revoked grant, watcher promotion to
   `published`, watcher give-up at 7 days, `spam_risk_too_many_posts` retried not failed,
   image post to TikTok refused by `_validate`, redaction of every TikTok secret.
4. Dashboard tests: composer refuses an image targeted at TikTok, all four `delivery_state`
   renderings, TikTok metric vocabulary (and no borrowing of Instagram's).
5. Dry run: a scheduled TikTok post performs no network calls and records nothing.
6. Preflight against the real connected channel: names the account, posts nothing.
7. **One real video** with `DRY_RUN=0`, confirmed on the phone; then R1 probed by publishing it
   from the inbox and watching for `publicaly_available_post_id`.
8. Lint at 0 errors; the UI checked in a real browser, not only in tests.
