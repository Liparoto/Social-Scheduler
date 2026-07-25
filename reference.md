# References

Background material to know, not act on blindly. The Meta API section was **verified against
live Meta developer docs on 2026-07-22** (docs referenced API **v25.0**). Meta does not show
"last updated" dates on these pages, so re-check the version string periodically — they change
silently. Items that could **not** be pinned to an authoritative Meta URL are flagged
`⚠ UNVERIFIED`.

---

## Why this project exists
- **Problem:** posting and scheduling social content by hand is a bottleneck, and there's no
  cheap way to systematically *recycle* good content over time.
- **Users:** the owner (multiple own accounts) first; later anyone who clones it for their own
  accounts. Each install is fully independent.
- **Guardrails:** internal tool, not a product — favor simplicity and transparency over polish
  or scale. Local-only, no paid services, instantly stoppable.

---

## Meta / Instagram Graph API — Content Publishing (verified 2026-07-22, v25.0)

### Canonical docs (bookmark; re-check version string)
- Content Publishing guide: https://developers.facebook.com/docs/instagram-platform/content-publishing/
- `POST /media` reference: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- `media_publish` reference: https://developers.facebook.com/docs/instagram-api/reference/user/media_publish
- `content_publishing_limit` reference: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit/
- Instagram Platform Overview: https://developers.facebook.com/docs/instagram-platform/overview/

### 1. Two-step publishing flow (images)
1. **Create container:** `POST /{ig-user-id}/media`
   - `image_url` (required, images) — public URL returning raw image bytes
   - `caption` (optional), `alt_text` (optional, images), `access_token` (required)
   - `media_type` — set for `VIDEO`/`REELS`/`STORIES`/`CAROUSEL`; omit for a plain image
   - Returns `{"id": "<CONTAINER_ID>"}`
2. **Publish:** `POST /{ig-user-id}/media_publish`
   - `creation_id` = the container ID, `access_token` (required)
   - Returns `{"id": "<IG_MEDIA_ID>"}`

**Status check (required before publishing carousel/video):**
`GET /{ig-container-id}?fields=status_code` →
`EXPIRED` (not published within 24h) · `ERROR` · `FINISHED` (ready) · `IN_PROGRESS` ·
`PUBLISHED`. Meta's guidance: **poll once per minute, for no more than 5 minutes; publish only
when `FINISHED`.** Small images are usually ready immediately; video is always async.

### 2. Carousels
1. One **child** container per item: `POST /media` with `is_carousel_item=true` (+ `image_url`
   or `video_url`). Each returns a container ID.
2. **Parent** container: `POST /media` with `media_type=CAROUSEL` and
   `children="<ID_1>,<ID_2>,..."` (comma-separated child IDs).
3. Publish the parent via `media_publish`.

- **Max 10 items via the API** (verbatim: "up to 10 total images, videos, or a mix"). The
  Instagram app now allows 20, but **the API is still documented at 10 — do not assume 20.**
- A carousel counts as **one** post against the rate limit.

### 3. Public-URL requirement (CONFIRMED verbatim)
- `POST /media` ref: **"We will cURL the image using the URL that you specify so the image must
  be on a public server."**
- Content Publishing guide: **"We cURL media used in publishing attempts, so the media must be
  hosted on a publicly accessible server at the time of the attempt."**
- **Implication:** the URL must (a) need no auth, (b) return the actual image bytes with a
  correct image content-type, (c) not bounce through an HTML page or redirect.
- ⚠ UNVERIFIED (inference, not a Meta quote): standard **Google Drive / Dropbox *share*
  links** return an HTML preview page, not raw bytes, so they **fail**. Use a host that serves
  the raw file (own server, S3/R2, or a true direct-download link that streams bytes).
  For this project, the app hosts assets itself and exposes them at a public `public_url`.

### 4. Rate limit — ⚠ Meta's own docs CONFLICT
- Content Publishing guide (prose): **"limited to 100 API-published posts within a 24-hour
  moving period."**
- `content_publishing_limit` reference: `config.quota_total` is **"currently 50"**,
  `quota_duration` **86400s (24h)**.
- Historically 25 → 50; guide now says 100 while the reference example still says 50.
- **RULE: never hardcode this.** Query
  `GET /{ig-user-id}/content_publishing_limit` →
  `quota_usage`, `config.quota_total`, `config.quota_duration`. Gate publishing on
  `quota_usage < quota_total`. Window is a **rolling** 24h, not a calendar reset.
- Related caps: up to **50 unpublished containers** at once; general Graph API call limits
  (~200 calls/hour/user) apply on top.

### 5. Permissions & App Review
Two auth configurations:
- **Instagram API with Instagram Login** (`graph.instagram.com`, newer, since July 2024):
  scopes `instagram_business_basic` + `instagram_business_content_publish`. **No Facebook Page
  required.** Best for IG-only.
- **Instagram API with Facebook Login** (`graph.facebook.com`): scopes `instagram_basic` +
  `instagram_content_publish` + `pages_read_engagement` + `pages_show_list`. **Requires the IG
  account be linked to a Facebook Page.**

**Access levels — the key point:**
- **Standard Access** (default, app stays in **Development mode**): Meta states — *"If your app
  only serves your Instagram professional account or an account you manage, Standard Access is
  all your app needs."* **No App Review required for your own/managed accounts.**
- **Advanced Access:** required only to publish to accounts you **don't** own/manage. Requires
  **App Review + Business Verification**. ⚠ UNVERIFIED community-reported timeline ~2–4 weeks.

**For this project:** each install publishes to the owner's **own** professional accounts →
**Standard Access + Development mode is sufficient, no App Review.** App Review only becomes
necessary if an install lets *other people* connect *their* accounts (we don't).

**Account requirement (all paths):** an Instagram **professional** account (Business or
Creator). Personal accounts are unsupported.

**Decision (updated after live-setup research, 2026-07-22):** for publishing to your OWN
Instagram professional account, use the **Instagram-Login path** (`graph.instagram.com`,
**no Facebook Page required**) — it's markedly simpler (add account + generate token in one
dashboard panel, no Page-token juggling). The worker's API host is configurable via
`META_GRAPH_BASE` (default `https://graph.facebook.com`; set to `https://graph.instagram.com`
for the IG-Login path). The content-publishing endpoints are identical on both hosts; only
the host + token type differ. The **Facebook-Login path** (`graph.facebook.com`, Page-linked)
is retained for the Phase 6 **Facebook Pages** adapter. A mixed install (IG-Login IG channels
+ FB Page channels) will need a per-channel host — a Phase 6 refinement; today the host is
install-wide. Full step-by-step in **docs/meta-setup.md**.

### 6. Media-type differences & recent changes
- **Feed image spec (VERIFIED 2026-07-23, Meta docs):** max file size **8 MB**; aspect ratio
  **4:5 → 1.91:1**; width **min 320 / max 1440 px** (Meta auto-scales outside this); color
  **sRGB** (Meta auto-converts). We conform on upload anyway (see `docs/design-image-conformance.md`)
  so the framing decision (crop vs pad for out-of-range ratios) is explicit and Meta never
  silently crops. File size + aspect ratio are the rules Meta won't fix for us.
- **Reels/video:** `media_type=REELS` (or legacy `VIDEO`), pass `video_url` (not `image_url`),
  plus `cover_url`, `thumb_offset`, `audio_name`, `share_to_feed`. Containers are **async** —
  **must** poll `status_code` until `FINISHED`. Large uploads use resumable `upload_type`.
- **Stories:** `media_type=STORIES`.
- **First comment:** post-publish, add the first comment via the Graph API comments endpoint
  on the published media ID (this is how hashtags stay out of the caption).
- **Instagram Basic Display API:** fully shut down. ⚠ UNVERIFIED exact date (third-party
  summaries say Dec 4, 2024). It was read-only and never supported publishing.
- ⚠ UNVERIFIED: legacy scope rename `instagram_basic`→`instagram_business_basic` etc.
  (community cites Jan 27, 2025). Both naming sets currently appear in Meta docs mapped to
  their respective login configs.

### Facebook Pages publishing (verified 2026-07-23)
- Single photo: `POST /{page-id}/photos` with `url`, `caption`, `published=true`. The response
  carries both `id` (photo) and **`post_id`** (the feed post) — store `post_id`, since insights
  are read against the post.
- Multi-photo: upload each with `published=false`, collect each `id`, then
  `POST /{page-id}/feed` with `message` + `attached_media[i]={"media_fbid": <id>}`
  (indexed JSON fields on a form-encoded request). Photos and videos can't be mixed this way.
- **No container/status polling** and **no `content_publishing_limit`** on Pages — the IG quota
  gate is skipped for Facebook rather than replaced with a hardcoded number.
- Requires a **Page** access token (`pages_manage_posts`); works on your own Page with the app
  in Development mode + an admin role, no App Review.
- Metrics: reactions/comments/shares come from edge summaries on the post
  (`reactions.summary(total_count)`, `comments.summary(total_count)`, `shares`) and are stable.
  Post **insights** metric names are volatile — Meta deprecated a large batch on **2026-06-15**
  (reach/impressions moving to "views"/"unique media viewers"), so reach is fetched best-effort
  via `FB_POST_INSIGHT_METRICS` and stored null when the name is rejected.

### Threads publishing (verified 2026-07-25)
- **Base host:** `https://graph.threads.net`. Endpoints below are relative to
  `{base}/{version}/...` the same way IG/FB are — see the ⚠ note below on which version
  actually gets used at runtime.
- **Container → publish flow, same shape as Instagram's:**
  1. `POST /{threads-user-id}/threads` — create a container. `media_type` is `TEXT`
     (requires `text`, no `image_url`), `IMAGE` (requires `image_url`, `text` optional), or
     `CAROUSEL` (requires `children`, a comma-separated list of child container ids;
     `text` optional). Carousel children are created first as their own containers with
     `is_carousel_item=true`, `media_type=IMAGE`, `image_url=...`.
  2. `POST /{threads-user-id}/threads_publish` with `creation_id=<container id>`.
- **Status field is `status`, not Instagram's `status_code`.** `GET /{container-id}?fields=status`
  → poll until `FINISHED` before publishing (same polling discipline as IG carousels/video —
  Threads containers are not guaranteed synchronous). `ERROR`/`EXPIRED` are terminal.
- **Carousels: 2–20 children.** Below 2 or above 20 is rejected before any Graph API call is
  made. (Contrast with Instagram's documented cap of 10 — the two platforms' limits are
  independent; don't apply one to the other.)
- **Text posts are a Threads-only capability** among this project's three platforms — neither
  Instagram nor Facebook Pages can publish a post with no media, so `TEXT` containers have no
  IG/FB equivalent. Max **500 characters**.
- **Quota gate — `GET /{threads-user-id}/threads_publishing_limit`, fields
  `quota_usage,config`** → `config.quota_total` (**250**), `config.quota_duration` (**86400s /
  24h, rolling**). Unlike Facebook Pages, **Threads *is* gated at runtime** — the worker reads
  this endpoint before every publish and defers (retries later) rather than posting once the
  account hits `quota_usage >= quota_total`, the same pattern as Instagram's
  `content_publishing_limit`, just a different endpoint name and number.
- **Insights — two response envelopes, handled explicitly:** `GET /{media-id}/insights`
  returns each metric either as `{"total_value": {"value": N}}` (Threads' lifetime-metric
  shape) or `{"values": [{"value": N}]}` (Instagram/Facebook's shape). The client checks for
  `total_value` first and falls back to `values[0]`, kept as Threads-only parsing so an IG/FB
  envelope change can't regress from a Threads-specific fix, or vice versa.
- **Metric → column mapping** (`THREADS_INSIGHT_METRICS`, default
  `views,likes,replies,reposts,quotes`):
  - `views` → `impressions`
  - `likes` → `likes` (same column Instagram/Facebook use)
  - `replies` → `comments`
  - `reposts` → `shares`
  - **`quotes` is deliberately left unmapped.** There is no `quotes` column, and folding it
    into `shares` would silently inflate that number with a metric that means something
    different (a quote-post is new content referencing the original, not a share of it). It's
    preserved in the row's `raw_json` for anyone who wants it, but never aggregated into a
    named column.
  - `reach` and `saves` have no Threads source metric and stay `NULL` on Threads rows — this
    mirrors Facebook Pages' incomplete metric set (see above) rather than Instagram's full one.
- **API version is resolved per platform, not install-wide.** Threads versions its API
  independently of the Instagram/Facebook Graph API epoch, so it does not share
  `Config.graph_version`. `clients._API_VERSIONS` resolves Instagram and Facebook to
  `config.graph_version` (`META_GRAPH_VERSION`, default `v25.0`) and Threads to its own
  `config.threads_api_version` (`THREADS_API_VERSION`, default `v1.0`). `ClientRegistry`
  caches clients on the resolved `(base_url, version)` pair (not base URL alone), so a real
  Threads call correctly hits `https://graph.threads.net/v1.0/...` while Instagram/Facebook
  keep hitting the install's configured `v25.0` — verified by
  `worker/tests/test_clients.py::test_threads_resolves_to_its_own_api_version_through_the_registry`.
  Re-check `THREADS_API_VERSION` periodically against live docs, same as `META_GRAPH_VERSION`.

### Open items to resolve at implementation time
1. Confirm the **actual** `quota_total` per account at runtime (50 vs 100).
2. Confirm the exact **Facebook Page** publish + metrics endpoints when we build that adapter
   (out of scope for the first IG-only milestone; verify against live docs then).
3. Confirm current **video/Reels** required params against live docs when we build that
   adapter.
4. ~~Threads API version~~ — resolved: Threads now resolves its own `THREADS_API_VERSION`
   (default `v1.0`) via `clients._API_VERSIONS`, independent of `META_GRAPH_VERSION`.

---

## Stack references (fetch current docs before version-sensitive decisions)
- **Next.js (App Router):** use Context7 / official docs for route handlers, server actions,
  and `better-sqlite3` usage in server-side code.
- **better-sqlite3:** synchronous SQLite driver for Node; enable **WAL mode** on open.
- **Python worker:** `requests` (or `httpx`) for Graph API calls; `apscheduler` or a simple
  polling loop for the daemon; `python-dotenv` for `.env`. Keep deps minimal; justify each in
  `requirements.txt`.
- **SQLite:** WAL mode for concurrent readers + single writer; foreign keys ON.

## Notes
- Re-verify any Meta API specific before relying on it — these change without notice.
- Keep secrets in `.env` only; never commit `/data` or tokens.
- When building the Facebook, video, or Stories adapters, re-run the same live-docs
  verification we did for IG image/carousel — don't extrapolate from this doc alone.
