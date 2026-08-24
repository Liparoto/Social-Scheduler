# Facebook Page video — design spec

**Date:** 2026-08-23
**Status:** approved, pending implementation plan
**Scope:** Facebook Page **feed video** and **Reels**. Facebook Stories is explicitly deferred.

---

## Why

SocialScheduler cannot post video to Facebook at all. `_publish_facebook` branches only on
`single` and `carousel`, both of which call `create_page_photo` (the `/photos` edge); anything
else raises `_NonRetryable`. `PLATFORM_CAPS["facebook"]` leaves `supports_video` at its default
`False`, and `dashboard/lib/platforms.ts` mirrors that with `supportsVideo: false`, so the
composer actively deselects Facebook channels the moment a video is attached.

This was a deliberate scope cut, recorded in `docs/tasks.md`: *"Stories, Facebook video, and
video in bulk import are all out of scope, per the design spec."* The owner now wants it.

**The Meta side is not the blocker.** The Page token already publishes photos, which proves it
carries `pages_manage_posts`. Facebook's video endpoints all accept a hosted `file_url`, which
is precisely the "Meta fetches it from a public URL" model the existing photo path and the
cloudflared tunnel already serve. No new upload machinery is required.

## What Facebook actually allows (verified 2026-08-23)

| Destination | Endpoint | Hosted URL | Limits |
|---|---|---|---|
| Feed video | `POST /{page-id}/videos` | `file_url` | ≤1 GB, ≤20 min. **Any aspect ratio** |
| Reels | `POST /{page-id}/video_reels` (3-phase) | `file_url` header | 3–90 s, 16:9→9:16, ≥540×960, 24–60 fps |
| Video Story | `POST /{page-id}/video_stories` (3-phase) | `file_url` | ≤60 s, ≥540×960 — **deferred** |
| Photo Story | `/photos` unpublished → `/photo_stories` | — | ≤10 MB — **deferred** |

Permissions: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, plus
`CREATE_CONTENT` on the Page. Confirm with `debug_token` before building; do not assume.

Meta documents a rate limit of **30 API-published Reels per rolling 24 h**. Pages expose no
`content_publishing_limit` endpoint to read it from. Per the project rule against hardcoding
publishing limits, this is recorded in `reference.md` as documented-but-not-enforced — the same
treatment the existing Pages note already gives.

---

## The core decision: content shape is not destination

Today `post_type='reel'` does two jobs at once. It says **what the post is** (one video clip)
and **where it goes** (the Reels surface). On Instagram those coincide — all Instagram feed
video *is* Reels — so the conflation was invisible and harmless.

Facebook breaks it. The identical clip can go to the Page feed as an ordinary video, to Reels,
or to a Story. A field named `reel` cannot express that.

The fix is the pattern this codebase already proved for Instagram Stories (migration `0014`):
separate the two axes.

- **`post_type = 'video'`** — the content shape: this post is one video clip.
- **`surface`** — the destination, per channel target: `feed` · `reel` · `story`.

```
video ──> Instagram · feed  → REELS container
      ──> Facebook  · feed  → /videos        (any ratio, ≤20 min)
      ──> Facebook  · reel  → /video_reels   (vertical, ≤90 s)
      ──> TikTok    · feed  → inbox
```

One clip, retargetable per channel. Adding Facebook Stories later becomes a new *surface value*
on an existing axis, not a new concept.

This is the generalization `docs/tasks.md` deferred: *"`PlatformCaps.post_types` was never
generalised (Decision 6) … worth revisiting only if a second one ever lands."* A second
video-capable platform has landed.

### Rejected alternatives

**Keep `post_type='reel'`, add surfaces only.** No migration, cheaper today. Rejected because
the name would then be actively false: posts typed `reel` would deliberately publish to
Facebook's ordinary feed as normal videos, and auto-fill's SQL would keep asking "is this a
reel?" when it means "is this a video?" Saves a day once; costs clarity on every future read.

**Two content types, `video` and `reel`.** Clean-sounding, but it makes the same clip
un-retargetable — publishing to both IG Reels and FB feed video would require duplicating the
post. That directly undercuts evergreen recycling, a primary owner goal. Rejected.

### Deliberate asymmetry: `'reel'` is a Facebook-only surface

Instagram gets `{feed, story}`; Facebook gets `{feed, reel}`. Instagram has exactly one video
feed destination, so giving it a separate `reel` surface would be a distinction with no
difference — two values that always mean the same thing, which is how a model starts lying.
This asymmetry is recorded here so it reads as a decision rather than an oversight.

---

## Data model

One migration, `0027_video_surface.sql`. It is next in sequence after `0026_tiktok_account_stats.sql`
— **do not renumber any applied migration**, since `schema_migrations` is keyed by filename and
renumbering re-runs it.

1. Rebuild `posts` so `post_type` CHECK accepts `'video'`, then
   `UPDATE posts SET post_type='video' WHERE post_type='reel'`. **Affects 1 row** on the owner's
   install (`single` 75, `carousel` 35, `reel` 1).
2. Rebuild `post_targets` so `surface` CHECK becomes `IN ('feed','story','reel')`.
3. Rebuild `publications` so `surface` CHECK becomes `IN ('feed','story','reel')`.

SQLite cannot alter a CHECK in place; each requires the create-copy-drop-rename rebuild that
migration `0014` already performed on `post_targets`. `publications` is the heaviest of the
three — many columns appended by later `ALTER`s, three indexes, two foreign keys. The rebuilt
DDL must reproduce all of them.

**`('feed','story','reel')` is the complete set.** Facebook Stories, when it lands, reuses the
existing `'story'` value. This should therefore be the last surface rebuild, not the first of
several.

**Verification before it touches live data:** apply the migration to a `sqlite3 .backup` copy in
the scratch directory and diff `.schema` before/after, confirming no column, index, or foreign
key was dropped in the rebuild. Note that `worker/migrate.py` has no argument parser — even
`--help` applies migrations to the live DB — so this must be done against the copy, never by
invoking it hopefully.

## Capability model

`PlatformCaps.supports_video` is a bool and cannot say *which* video destinations exist. Replace
it with a declared set:

```python
video_surfaces: frozenset[str] = frozenset()   # instagram: {"feed", "story"}
                                               # facebook:  {"feed", "reel"}
                                               # tiktok:    {"feed"}
```

`supports_video` survives as a derived property (`bool(video_surfaces)`), so auto-fill's existing
`:supports_video` SQL binding keeps working untouched. Defaulting to the empty set preserves the
existing safe direction: a platform that does not declare video support gets none.

The registry asserts in `worker/clients.py` continue to guard drift between `PLATFORM_CAPS`,
`_BASE_URLS`, `_API_VERSIONS`, `_PUBLISHERS`, `_QUOTA_GATED`, `_CHECKS` and `_FETCHERS`.
`dashboard/lib/platforms.ts` remains the one hand-maintained copy with no assert behind it — it
must be updated in the same change, and its existing comment saying so stays accurate.

## Worker

### `graph_api.py`

**`create_page_video(page_id, file_url, token, description=None) -> str`**
Single `POST /{page-id}/videos` with `file_url` and `description`. Returns the video id.

**`create_page_reel(page_id, file_url, token, description=None) -> str`**
Three phases:

1. `POST /{page-id}/video_reels` with `upload_phase=start` → returns `video_id`, `upload_url`.
2. `POST https://rupload.facebook.com/video-upload/{version}/{video_id}` with headers
   `Authorization: OAuth {token}` and `file_url: {url}` — and **no request body**. Meta fetches
   the file itself.

   The hosted-file and local-file forms are alternatives, not a single shape with optional
   parts: the local-file form sends `offset` and `file_size` headers with the bytes as the body,
   and the hosted form sends neither. Only the hosted form is used here. This host is **not** the
   Graph base URL, so it needs its own request path in the client rather than going through the
   existing `_post` helper.
3. `POST /{page-id}/video_reels` with `upload_phase=finish`, `video_id`, `video_state=PUBLISHED`,
   and `description`.

Returns the video id.

**`get_page_video_status(video_id, token) -> str`**
`GET /{video-id}?fields=status`. Facebook's status is a nested object with lowercase values
(`video_status: ready | processing | uploading | upload_complete | error | upload_failed | expired`),
unlike Instagram's flat `status_code`. This method **normalizes** into the vocabulary the
existing poll loop already speaks:

| Facebook `video_status` | Normalized |
|---|---|
| `ready` | `FINISHED` |
| `error`, `upload_failed` | `ERROR` |
| `expired` | `EXPIRED` |
| `processing`, `uploading`, `upload_complete` | pass through — keep polling |

Normalizing at the client boundary means `_poll_until_finished` needs **no changes at all** — it
already accepts a `status_fn`, which is how Threads reuses it. The alternative (teaching the loop
a second vocabulary) would put platform trivia in shared code.

### `publisher.py`

`_publish_facebook` dispatches on surface when `post_type == 'video'`:

- `surface == 'feed'` → `create_page_video` → poll → resolve post id
- `surface == 'reel'` → `create_page_reel` → poll → resolve post id

Photo paths (`single`, `carousel`) are unchanged. Every unhandled combination keeps ending in
the existing `_NonRetryable` with a clear message, per the project's visible-failure rule.

**Poll budget:** reuse `reels_status_poll_interval` × `reels_status_poll_max_tries` (10 s × 90 =
15 minutes). Facebook transcodes server-side exactly as Instagram does; the image path's 5-minute
budget is too short. Budget exhaustion is **retryable**, never terminal.

### The id-resolution problem

Facebook metrics read against a **feed post id** — `_fetch_facebook` calls
`get_page_post_summary`, which needs the post node for its `reactions`/`comments`/`shares` edge
summaries. Both video endpoints return a **video id**, which is a different node.

Resolve via `GET /{video-id}?fields=post_id` after publishing, storing the resolved post id in
`remote_post_id` and falling back to the video id when `post_id` is absent — mirroring the
preference `_publish_fb_single` already applies to the photo response.

**This must be confirmed live against the owner's Page before the feature is called done.** It is
the single highest-risk assumption in this design: if `post_id` is unavailable on a video node,
metrics for Facebook video silently return nothing, and a metric that reads zero looks identical
to a post nobody engaged with.

## Framing: surface-aware media resolution

Facebook feed video accepts **any** aspect ratio; Facebook Reels requires vertical. So framing
must depend on the surface, not only the platform:

- Facebook **feed** video → the untouched original (`storage_path`)
- Facebook **reel** → the 9:16 conformed derivative (`publish_path`)

`PlatformCaps.needs_conformed_media` is currently a platform-wide bool. `_resolve_rel` and
`_resolve_local_path` already take `surface`, so this becomes a small, contained refactor: the
conformed-media decision consults surface alongside platform.

**This is an addition to the minimum viable change, included deliberately.** Without it a
landscape clip would be cropped to vertical for a Facebook feed post that never required it — a
visible quality regression, and exactly the kind of silent reframing the story picker's
"will be reframed" note exists to prevent.

## Validation

Facebook Reels limits are hard, and violating them fails terminally at publish time — long after
the composer could have said so. Enforce in **both** places:

- `publisher._validate` — the backstop that protects the worker regardless of entry point.
- The composer / channel-surface picker — so the refusal happens while scheduling.

Checks for `surface='reel'` on Facebook: duration 3–90 s (from `assets.duration_ms`), resolution
≥540×960, aspect ratio within 16:9–9:16. Facebook feed video needs only the far looser ≤20 min.

This mirrors how the existing picker already disables channels that cannot take text or video,
with the reason shown — one behaviour to learn, not two.

## Dashboard

- `dashboard/lib/platforms.ts` — Facebook declares video support and its surface set
  `{feed, reel}`. `supportsStory` stays `false` for Facebook (deferred).
- `dashboard/components/channel-surface-picker.tsx` — a **Reel** toggle beside Feed and Story,
  shown only for video posts on platforms declaring a `reel` surface.
- `dashboard/app/api/posts/route.ts` and `posts/draft/route.ts` — post-type derivation emits
  `'video'` instead of `'reel'`.
- `worker/autofill.py` — `_TYPE_CAPABILITY_SQL` renames `p.post_type = 'reel'` to `'video'`.

**Auto-fill must be tested on the channel-group path**, not only on solo channels: this install
runs its auto-fill through a channel group, so a selection change verified only against a single
channel is not verified for this install.

## Error handling

Unchanged in shape — each channel target is an independent `publication` with its own status, and
a Facebook video failure must not roll back or block the other targets.

- Poll-budget exhaustion → retryable, backoff, visible in `last_error`.
- `video_status: error` / `upload_failed` → terminal `_NonRetryable` carrying Meta's own message.
- Validation refusals → terminal, worded so the reason is legible without reading code.
- Never log the token, and never log full API responses. The `rupload` call puts the token in an
  `Authorization` header, which `worker/redact.py` must be confirmed to cover.

## Testing and verification

**Unit:** both new client methods (including the three-phase sequencing and the `rupload` host),
the status normalization table, surface dispatch in `_publish_facebook`, the Reels validation
limits, and the surface-aware framing resolution.

**Registry:** the existing dispatch tests already fail when a platform is added to one registry
but not another; the new `video_surfaces` field must be covered the same way.

**Live, in order, and not skipped:**
1. `DRY_RUN=1` — confirm the plan resolves the right URL and surface without publishing.
2. One real **feed video** to the owner's Page.
3. One real **Reel** to the owner's Page.
4. Read both back from the API — confirm the id stored in `remote_post_id` actually resolves,
   and that `_fetch_facebook` returns real counts against it.

Reading it back rather than trusting our own DB is the bar the first Instagram Reel had to clear,
and the id-resolution risk above makes it non-optional here.

**Restart the worker after code changes.** A live heartbeat proves the daemon is running, not
that it is running current code.

## Build order

Three phases, each verified before the next begins:

1. **Schema and capability model** — migration `0027`, `video_surfaces`, the `'reel'` → `'video'`
   rename through worker and dashboard. Verified against a scratch DB copy first.
2. **Worker publish paths** — the two client methods, status normalization, surface dispatch,
   framing, validation. Verified by unit tests and a dry run.
3. **Dashboard and live verification** — the Reel toggle, composer wiring, then the real posts.

**Commit the working tree before phase 1.** The migration rebuilds three live tables.

## Out of scope

- Facebook Stories (video and photo) — a follow-up; reuses the `'story'` surface already present.
- Scheduled/draft Reels via Meta's own `video_state=SCHEDULED` — this project schedules locally.
- Custom Reel thumbnails (`cover_url`); the existing `thumb_offset` behaviour is unchanged.
- Video in bulk import — `/import` stays images-only.
- Facebook video in `media_sync` backfill beyond what the existing Page feed read already returns.
