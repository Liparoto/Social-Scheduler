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

### Reels — verified spec (verified 2026-07-28, IG User Media reference, `#reels-specs`)

| Limit | Value |
|---|---|
| Max file size | 300 MB |
| Duration | 3 seconds minimum, 15 minutes maximum |
| Max width | 1920 px |
| Aspect ratio | 0.01:1 to 10:1 (width:height) — 9:16 recommended, but anything in range is accepted |
| Container | MOV or MP4, no edit lists, **`moov` atom at the front of the file** |

⚠ **Widely-circulated third-party guides claiming a 4 GB cap and a 90-second maximum are
wrong.** These numbers were re-verified directly against the live docs (not carried over
from memory or a blog post) — see `dashboard/lib/video-spec.ts`'s `REEL_SPEC`, which is the
runtime source of truth the app validates against.

The `moov`-at-front requirement is a real container-format rule, not a performance
suggestion — Meta's own wording is *"moov atom at the front of the file."* iPhone camera
footage routinely fails it (moov written last, after the full `mdat`); see "Video
conversion on upload" above for how this project closes that gap on the convertible path,
and the "Verified: first real Reel" note below for what remains untested (an in-spec file
that skips conversion).

**`cover_url` vs `thumb_offset` — precedence.** Instagram's REELS container accepts either
`cover_url` (an actual image file Meta uses directly as the cover) or `thumb_offset` (a
millisecond offset into the video; Meta extracts that frame itself). Where both are
possible, an explicit `cover_url` image is the more direct instruction and takes
precedence over deriving one from `thumb_offset` — there is nothing to derive once a real
image is supplied. **This project only ever sends `thumb_offset`** (from
`assets.cover_frame_ms`, via `worker/graph_api.py`'s `create_video_container` →
`worker/publisher.py`) — a real, uploaded custom cover image via `cover_url` is not
implemented (deferred, see docs/tasks.md). Absent either field, Meta's documented default
is frame 0.

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

### Discord webhook publishing (verified against code 2026-07-25)
- **Not a Meta/Graph API at all.** Discord webhooks are a single POST endpoint per
  channel: **the webhook URL itself is the credential** — there is no separate token
  parameter and no account id. Never interpolate the webhook URL into an exception
  message or log line; `worker/discord_api.py` runs every error string through
  `redact()` before raising, since a `requests.RequestException`'s own `str()` embeds
  the request URL.
- **Text-only:** `POST <webhook_url>` with JSON body `{"content": "..."}`.
- **With attachments:** switch to `multipart/form-data` — one part named `payload_json`
  carrying the same JSON payload (`{"content": ...}`), plus one part per file named
  `files[0]`, `files[1]`, ... `files[n]`. A request must carry at least one of
  `content` or `files`.
- **Empty-body 204 is normal.** Discord replies with an empty 204 (not JSON) for a
  successful webhook post unless the webhook is asked to wait for the message, so
  response parsing must be defensive (`resp.json()` can raise `ValueError` on an empty
  body) rather than assuming a body is always present.
- **Preflight:** a plain `GET` on the webhook URL returns the webhook object (`id`,
  `name`, `channel_id`). This is read-only and proves reachability without posting
  anything — used as the preflight check instead of any publish-quota call, because
  webhooks have no publish quota to read.
- **Limits:** 2000 characters per message; up to 10 file attachments per message.
- **No metrics, no quota endpoint.** `worker/metrics.py`'s `_FETCHERS["discord"]` is
  explicitly `None` (not merely absent) — a Discord post's row shows no metrics strip,
  by design, not by omission.
- **Uploads bytes directly — no tunnel.** `PLATFORM_CAPS["discord"].uploads_media_bytes
  = True`, so `run.py`'s `_pub_needs_tunnel` check returns `False` for Discord
  publications regardless of whether the asset has a stored `public_url`; the worker
  never opens cloudflared for a Discord-only batch.

### Telegram Bot API publishing (verified against code 2026-07-25)
- **Base host:** `https://api.telegram.org/bot<token>/<method>`. The bot token lives in
  the URL **path**, not a header or body field — far easier to leak by accident than a
  normal credential. `worker/telegram_api.py` redacts the token out of every URL and
  error string before it can be raised or logged.
- **`{"ok": false}` on HTTP 200 — the real gotcha.** Telegram's success signal is the
  `ok` field in the JSON response body, **not the HTTP status code**: a request can
  come back `200 OK` with `{"ok": false, "description": "..."}` in the body (e.g. the
  bot isn't an admin of the target chat). The client checks `resp.ok` **and**
  `body.get("ok")` together — checking the status code alone would treat this as
  success.
- **Methods used:**
  - `getMe` — verifies the bot token is valid (preflight only, no chat needed).
  - `getChat` — verifies the bot can actually see `chat_id` (preflight; catches "bot
    exists but was never added to the channel or isn't an admin", the mistake people
    actually make — see `docs/other-platforms-setup.md`).
  - `sendMessage` — text-only post: `{"chat_id": ..., "text": ...}`.
  - `sendPhoto` — single image: `{"chat_id": ..., "caption": ...}` + a `photo` file
    part.
  - `sendMediaGroup` — album (2–10 photos): `media` is a JSON-encoded list of
    `{"type": "photo", "media": "attach://file0"}`-style objects, one per photo, with
    the caption set only on the **first** item; each `attach://<name>` refers to a
    same-named multipart file part (`files={"file0": ..., "file1": ..., ...}`) rather
    than a URL — this `attach://` naming is how Telegram matches a media-list entry to
    its uploaded bytes in the same request.
- **Limits:** 4096 characters for a text-only message, but only **1024** once a photo
  is attached (`sendPhoto`/`sendMediaGroup` caption limit) — a caption that fits a text
  post can still be rejected once media is attached. Albums need 2–10 items.
- **No metrics, no quota endpoint.** Same as Discord: `_FETCHERS["telegram"]` is
  explicitly `None`, and the Bot API has no publish-quota call to read, so
  `publisher._QUOTA_GATED["telegram"]` is `False` (a real absence of an endpoint, not
  an oversight).
- **Uploads bytes directly — no tunnel.** Same as Discord:
  `PLATFORM_CAPS["telegram"].uploads_media_bytes = True`, so Telegram publications never
  trigger the cloudflared tunnel.

### Schema note (Discord/Telegram)
No new tables. `migrations/0009_discord_telegram.sql` widened `channels.platform`'s
check constraint to accept `'discord'` and `'telegram'` alongside the existing
platforms — that is the only schema change either platform needed. Both are registered
in every platform registry (`clients._BASE_URLS`/`_API_VERSIONS`/`PLATFORM_CAPS`/
`_CLIENT_FACTORIES`, `publisher._PUBLISHERS`/`_QUOTA_GATED`, `preflight._CHECKS`,
`metrics._FETCHERS`), each guarded by an assert against `SUPPORTED_PLATFORMS`.

### Open items to resolve at implementation time
1. Confirm the **actual** `quota_total` per account at runtime (50 vs 100).
2. Confirm the exact **Facebook Page** publish + metrics endpoints when we build that adapter
   (out of scope for the first IG-only milestone; verify against live docs then).
3. Confirm current **video/Reels** required params against live docs when we build that
   adapter.
4. ~~Threads API version~~ — resolved: Threads now resolves its own `THREADS_API_VERSION`
   (default `v1.0`) via `clients._API_VERSIONS`, independent of `META_GRAPH_VERSION`.

---

## Video conversion on upload (dashboard, added 2026-07-28)

The upload route (`dashboard/app/api/assets/upload/route.ts`) no longer refuses every
out-of-spec Reel. It classifies each Reels-spec failure as **convertible** (re-encoding
genuinely fixes it) or **fatal** (nothing can), and only converts on the convertible path.
This matters in practice, not in theory: an iPhone's default camera setting **is** 4K
(2160×3840), which is over Instagram's 1920px width cap — so the "failing" case this
feature handles is the *normal* case for footage shot on a phone, not an edge case.

### Convertible versus fatal (`dashboard/lib/video-spec.ts`, `classifyReelErrors`)

| Failure | Bucket | Why |
|---|---|---|
| Wrong container (not MP4/MOV) | convertible | Re-encoding changes the container. |
| Over 300 MB | convertible | Re-encoding at a lower bitrate shrinks the file. |
| Width over 1920px | convertible | Downscaling fixes this exactly — see below. |
| Under 3 seconds | **fatal** | Nothing to trim *to* — there's no footage to add back. |
| Over 15 minutes | **fatal** | The only fix is trimming, and trimming is an **editorial**
  decision — which seconds to cut is a choice about content, not a technical transform. The
  app converts pixels and containers; it does not decide what a Reel is *about*. Refuse and
  tell the owner to trim in Photos and re-upload. |

Off-vertical aspect ratio and no audio track remain **warnings** in both cases — Instagram
publishes and letterboxes a landscape Reel, so there's nothing to convert or refuse.

The route checks `fatal` before ever looking at `convertible`: a video that's both 40
minutes long *and* 4K is refused for length without wasting a 300-second conversion
attempt on a file that's getting rejected regardless.

### Converter probe order (`dashboard/lib/video-convert.ts`, `findConverter`)

1. **`avconvert`** — `/usr/bin/avconvert`, ships with every macOS install, zero extra
   dependency. Preferred.
2. **`ffmpeg`** — fallback for a clone not on macOS, or where `avconvert` is somehow
   missing. Probed on `PATH`.
3. **Refuse** — neither is present (or `VIDEO_CONVERTER=off`): 422, with the same
   convertible messages plus an "install ffmpeg" hint. No conversion is silently skipped.

Exact command lines (`buildArgs`):

```
avconvert -s <input> -p Preset1920x1080 -o <output> --replace

ffmpeg -y -nostdin -loglevel error -nostats -i <input> \
  -vf scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2 \
  -c:v h264 -c:a aac -movflags +faststart <output>
```

Both fit the video inside a 1920×1920 box without cropping, padding, or upscaling
(`force_original_aspect_ratio=decrease`), rounded to even pixel dimensions
(`force_divisible_by=2`, required by h264) — this is deliberately equivalent to what
`avconvert`'s `Preset1920x1080` does for both landscape and portrait input, so the two
converters produce the same shape from the same source regardless of which one a given
install has.

### Measured result — the real 4K fixture (`~/Downloads/IMG_3707.MOV`)

Verified via the composer, end to end, using `avconvert` (this Mac has it) on
2026-07-29:

| | Original | Converted |
|---|---|---|
| Dimensions | 2160×3840 (portrait; sensor stores 3840×2160 landscape + a rotation matrix — see `video-meta.ts`'s tkhd matrix parsing) | 1080×1920 |
| File size | 51,798,715 bytes (49.4 MB) | 15,512,907 bytes (14.8 MB) |
| Duration | 7.637 s (unchanged — conversion never touches duration) | 7.637 s |
| Container | `mdat` before `moov` — `moov` at offset 51,778,986, right after a 51.8 MB `mdat` (typical of an unprocessed phone recording: the player must read to the end for metadata) | `moov` at offset 28, immediately after `ftyp` and *before* `mdat` |

That last row is a side effect neither converter's Reels-facing docs advertise but both
produce: `avconvert`'s export and ffmpeg's explicit `-movflags +faststart` both relocate
the `moov` atom to the front. This isn't why the video is converted, but it's a genuine,
measured improvement — a player (or Meta's own ingestion) can start reading metadata
without seeking to the end of a 50 MB file first.

The original file is retained untouched at `storage_path`; only the derivative at
`publish_path` is what actually gets published (`worker/publisher.py`'s `_resolve_url`
prefers `publish_path`). The asset row gets `conform_mode: "downscale"` and
`needs_review: 1`, and the composer surfaces `converted: { from, to }` next to the
existing Reels warnings so the owner is told plainly what happened — see
`dashboard/components/composer.tsx`.

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

## Verified: first real Reel published (2026-07-29)

The full video pipeline was proven end to end against the live Instagram API.

- **Media id** `17983260633046217` · **permalink** https://www.instagram.com/reel/DbYtd48ADWu/
- **`media_product_type: REELS`** and `media_type: VIDEO`, read back from the API rather than
  trusted from our own DB — it is a genuine Reel, not a plain video post.
- **60 seconds end to end.** Cloudflared tunnel live in ~21s; container create → poll →
  publish took a further ~37s for a 7.6s clip. The Reels poll budget
  (`REELS_STATUS_POLL_INTERVAL=10` × `REELS_STATUS_POLL_MAX_TRIES=90`, a 15-minute ceiling)
  is therefore generous rather than tight — leave it, but there is no evidence it needs raising.
- **Source was a 4K HEVC iPhone camera original** (2160×3840, 49.4 MB, `moov` atom LAST),
  automatically converted on upload to 1080×1920 H.264, 15 MB, `moov` FIRST. The worker sent
  the derivative (`publish_path`), never the original.
- **`thumb_offset=2600`** was sent from `assets.cover_frame_ms`, exercising cover-frame selection.
- `DRY_RUN` was flipped to `0` for exactly one `--once` cycle and restored to `1` immediately,
  guarded by a shell trap so an interrupted run could not leave it live.

**The moov-atom risk recorded in the Reels design spec is now closed for the conversion path.**
Conversion relocates `moov` to the front as a side effect, so any file that goes through it
satisfies Meta's container requirement regardless of how the camera wrote it. An in-spec video
that skips conversion could still carry a trailing `moov`; that path remains untested.
