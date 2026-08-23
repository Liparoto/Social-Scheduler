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
  - Posting a **first comment** additionally needs `instagram_business_manage_comments` —
    a scope publishing does NOT require, so a token that posts fine can still fail to
    comment. This install's token appears to carry it (a `GET /{media-id}/comments` read,
    which needs the same scope, succeeds), but that is inference: `debug_token` cannot
    introspect an Instagram-Login token (it answers `(#2) Service temporarily unavailable`
    on every host/version — checked 2026-08-05, not a real outage). The only conclusive
    test is a real comment. If it fails on permissions, re-authorise with the scope added.
  - ⚠ The scope list above is what setup *asks for*; the live token clearly carries more
    (the messages edge reads too), so treat it as a minimum, not an inventory.
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

**`cover_url` vs `thumb_offset` — precedence (verified 2026-07-29, re-confirmed 2026-08-04).**
Instagram's REELS container accepts either `cover_url` (an actual image Meta downloads and
uses as the cover) or `thumb_offset` (a millisecond offset into the video; Meta extracts
that frame itself). Meta's docs state the rule outright: if both are specified, `cover_url`
is used and `thumb_offset` is ignored. Absent either field, the documented default is
frame 0.

**This project resolves the choice itself and sends exactly one, never both.**
`worker/publisher.py`'s `_build_plan` sets `cover_url` *or* `cover_frame_ms` and nulls the
other, so the dry-run plan shows what will actually happen rather than deferring to Meta's
precedence rule at request time. A dangling `cover_asset_id` falls back to `thumb_offset`
and logs it — a missing cover is cosmetic, and refusing to publish over it would be worse.

**Reels cover image spec** (from the IG User Media reference): **JPEG**, **8 MB maximum**,
**sRGB** (other colour spaces are converted). 9:16 is recommended; Meta's own wording is
that a non-9:16 image is cropped to the middle 9:16 rectangle.

⚠ **A cover is NOT conformed like a feed image.** `dashboard/lib/conform.ts` targets the
feed's 4:5–1.91:1 range; 9:16 is 0.5625, well outside it, so pushing a cover through that
path would crop it to 0.8 and silently destroy the chosen framing.
`dashboard/lib/conform-cover.ts` exists precisely to avoid this: it fixes colour space and
file size and **never touches the aspect ratio**, warning instead when the ratio is not
near 9:16. For the same reason `worker/publisher.py`'s `_resolve_rel` has a dedicated
`cover` surface that resolves to `storage_path` and never `publish_path` — a feed
derivative would be the cropped version.

**Changing the cover of an already-published Reel is out of scope** — Meta does not
document whether it is possible, and this project does not assume undocumented behaviour.

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
- **There is no comment edge.** A "first comment" on Threads is a **self-reply**: the same
  `POST /{threads-user-id}/threads` call with `reply_to_id=<published thread id>`, then the
  usual poll and `threads_publish`. Two consequences worth knowing before using it:
  the reply is a **real post in your feed**, not a hidden comment; and it costs a second
  publish (so it counts against the 250/24h quota, and the 500-character cap applies to it
  too). Scope-wise it needs only `threads_content_publish` — the one publishing already
  uses. `threads_manage_replies` governs OTHER people's replies, not your own.
  Token scopes confirmed live 2026-08-05 via `GET graph.threads.net/debug_token`:
  `threads_basic, threads_content_publish, threads_manage_replies, threads_manage_insights,
  threads_read_replies`.
- ⚠ **Hashtags and `topic_tag`.** Threads allows **one topic tag per post**, and if you
  don't name it, it takes "the first valid tag included in a post of any type" out of your
  text — and rewrites the body without that tag's `#`. Verified live 2026-08-06: sending
  `"#NationalParks #Waterfall #NatureLovers"` stored `topic_tag: "NationalParks"` and
  `text: "NationalParks #Waterfall #NatureLovers"`. Every *later* `#word` stays literal
  text, NOT a link — so a hashtag block does far less here than on Instagram, where they
  all work. Meta calls the in-text form "not preferred but kept for backwards
  compatibility"; the `topic_tag` parameter is the current method, and the worker now
  always names the tag explicitly (`publisher._topic_tag_for`).
- ⚠⚠ **An impermissible `topic_tag` fails the CONTAINER, not just the tag.** Verified live
  2026-08-06: `topic_tag=bad.tag` → `Invalid parameter` / `Topic Tag Not Permitted`
  (code 100, **subcode 4279071**), and no container is created. Meta does not publish the
  permitted set and it covers blocked topics, not merely punctuation, so **no local
  validation can guarantee a tag is acceptable**. `publisher._threads_container` therefore
  retries once with no tag when a container is refused for the tag — losing the `#` is
  cosmetic, losing the post is not. Never send a topic tag without that fallback.
- Container fields: an **unpublished** container exposes only `id` and `status`. Asking for
  `text` or `topic_tag` on one is an error (`Tried accessing nonexisting field`), so a
  container cannot be used to preview how Threads will parse your text — only a published
  post can.
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
2. **This install's own vendored ffmpeg** — `data/bin/ffmpeg` (`ffmpeg.exe` on Windows),
   the same gitignored, per-install folder `cloudflared` already uses. On Windows this is
   put there automatically by `worker/ffmpeg_setup.py` the first time the launcher runs
   (see below); nothing to install by hand.
3. **`ffmpeg` on PATH** — someone who already installed their own (e.g.
   `brew install ffmpeg` on macOS) keeps using it; nothing is copied over it.
4. **Refuse** — none of the above is present (or `VIDEO_CONVERTER=off`): 422, with the
   same convertible messages plus a platform-appropriate "get a converter" hint (see
   `dashboard/lib/converter-advice.ts`). No conversion is silently skipped.

`executableNames()`, `vendoredFfmpegPath()`, and `findOnPath()` (all in
`video-convert.ts`) take an optional `platform` parameter, defaulting to
`process.platform`, purely so the Windows `.exe` branch — which nobody here can run for
real — can still be exercised by the test suite on macOS.

### Automatic ffmpeg install on Windows (`worker/ffmpeg_setup.py`)

`imageio-ffmpeg` is declared in `requirements.txt` for Windows only; pip puts a suitable
binary inside the venv, and this module's job is to copy it to `data/bin/ffmpeg.exe` — the
one place `findConverter()` above looks. It is a no-op on macOS (`avconvert` covers it).
The copy is staged next to the destination with an `.exe` suffix and verified (`-version`
actually runs) *before* being renamed into place, so a half-written or truncated file is
never mistaken for a working install.

`shutil.which("ffmpeg")`, used to detect an ffmpeg the user already installed themselves,
honours Windows' `PATHEXT` and can resolve to a `.cmd`/`.bat` shim that the dashboard's
`findOnPath()` would never find. The two lookups must agree — otherwise this module skips
its own copy step (`find_existing()` reports success), the dashboard still finds nothing,
and the user is stuck re-running the launcher forever for no visible reason. `_which_ffmpeg()`
narrows the accepted hit to exactly what the dashboard also accepts: `ffmpeg.exe` or bare
`ffmpeg` on Windows, bare `ffmpeg` elsewhere.

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

## Verified: the 9:16 story canvas (2026-08-04)

A non-9:16 photo now gets a deliberate Story frame instead of whatever Instagram decides.

- **Media id** `18082754669308514` · **permalink**
  https://www.instagram.com/stories/liparoto/3956589157728578564
- **`media_product_type: STORY`**, read back from the API. Source 3024×4032 (3:4 portrait);
  what published was the **1080×1920 blurred-fill canvas**, not the original and not the feed
  derivative. **Confirmed by eye on the phone** — blurred fill reads as deliberate, which is
  the only test that could settle it.
- **~12 seconds** from tunnel-up to published.

### The two treatments

`blurred` (default) fits the whole photo over an enlarged, blurred, darkened copy of itself —
nothing is lost. `crop` covers the frame using sharp's `attention` region. For a 3:4 source
that costs 25% of the frame; for 4:3 landscape, 58%. The dialog states the number before you
choose, computed from the real dimensions.

**A source within 2% of 9:16 gets NO canvas** — `story_path` stays NULL and the untouched
original publishes, exactly as the first real Story did. Photos shot vertically for Stories
therefore take a zero-processing path.

### Traps this exposed

1. **sharp cannot be imported by a client component.** The framing dialog needed
   `needsStoryCanvas`, importing it from the sharp module dragged sharp into the browser
   bundle, and the page failed to compile. **Every test still passed** — they run in Node.
   Hence `lib/story-geometry.ts` (pure maths, client-safe) split from `lib/story-canvas.ts`
   (sharp, server only). Anything a client component needs belongs in the former.
2. **The dry-run marker lied.** It hardcoded `storage_path`, so a story dry run showed the
   ORIGINAL while `asset_paths` showed the canvas — the publish logic was right, the display
   was not. A dry run that names the wrong file is worse than none, since it invites signing
   off on something else. `_resolve_rel()` now owns the surface→file decision and both the
   URL and the marker read it.
3. **The test harness wrote into the real asset store.** `makeTestDb()` isolated
   `DATABASE_PATH` but not `ASSET_STORAGE_DIR`, harmless until a test wrote a FILE — then
   fixture JPEGs landed among real uploads. Isolated at the harness level.

### Verified: four Stories from one carousel (2026-08-04)

Scheduling post 5 for Stories through the normal path produced four publications — one per
slide, in sort_order — and all four published as genuine Stories, **in slide order**:

| slide | asset | media id | published |
|---|---|---|---|
| 1 | 13 | `18075669446696846` | 22:40:51 |
| 2 | 14 | `18110379457800975` | 22:41:03 |
| 3 | 15 | `18143522173480034` | 22:41:15 |
| 4 | 16 | `17987922704846817` | 22:41:29 |

All four `media_product_type: STORY`, read back from the API. Zero retries, no errors, ~12s
apart, and each sent its OWN 1080×1920 canvas.

**The ordering is the part worth noting.** All four slides share one `scheduled_at`, so slide
order depends entirely on `fetch_due_publications`' `ORDER BY scheduled_at ASC, id ASC` — the
tie-break added with the story surface. Before it, ordering came out right only because SQLite
happened to scan in rowid order. Timestamps ascending across slides 1→4 is that guard proven
against the live API rather than by luck.

## Verified: first real Story published (2026-08-04)

Stories were proven end to end against the live Instagram API — and, more usefully, so was
the rule that a Story is a **destination, not a post type** (`docs/design-instagram-stories.md`).

- **Media id** `18124888342757913` · **permalink**
  https://www.instagram.com/stories/liparoto/3956438103947229557
- **`media_product_type: STORY`** and `media_type: IMAGE`, read back from the API rather than
  trusted from our own DB — a genuine Story, not a feed post.
- **`media_type=STORIES` container, no caption field sent at all.** Container create → poll →
  publish took ~13s for an image after a ~8s cloudflared tunnel start.
- **The ORIGINAL image was sent, not the conformed derivative.** The source was 1320×2346
  (9:16); `publish_path` held a 1320×1650 (4:5) *crop* made for the feed. Sending that crop
  would have silently discarded ~30% of the image. `_resolve_url` prefers `storage_path` when
  `surface='story'` for exactly this reason.
- **Reading the media back needs `graph.instagram.com`, not `graph.facebook.com`** on this
  install: the channel token is an Instagram-Login token (`IGA…` prefix), and the Facebook host
  rejects it with `code 190 — Cannot parse access token`. `Config.graph_base` already holds the
  right host; use it rather than hardcoding a host in a one-off script.

### Story insights — the supported metric set (verified 2026-08-04, RESOLVED)

Story media **rejects the feed metric list outright** — HTTP 400, not partial results:

```
GET <media-id>/insights?metric=likes,comments,saved -> 400:
The Media Insights API does not support the likes, comments, saved metric for
this media product type.
```

So one wrong name costs the whole snapshot. The supported set was established by probing a
real published Story metric-by-metric against the live API — **not from docs, and not from
the plausible-sounding names, which were wrong**:

| Supported for a STORY | Rejected for a STORY |
|---|---|
| `reach`, `views`, `replies`, `shares` | `impressions` (use `views`) |
| `navigation`, `profile_visits`, `follows`, `total_interactions` | `taps_forward`, `taps_back`, `exits` (use `navigation`) |
| | `likes`, `comments`, `saved` |

`taps_forward` / `taps_back` / `exits` read like the obvious story metrics and are the ones
an LLM or an old doc will suggest. They are gone; `navigation` is their replacement.

Column mapping needed no change: `reach`→reach and `views`→impressions and `replies`→comments
already existed in `COLUMN_MAP` (added for Threads). The other four have no column and live in
`raw_json`. Verified end to end on the first real Story: `views: 6`, everything else 0.

**Stories expire after 24h**, so `publications_needing_metrics` stops auto-refreshing a story
past `STORY_LIFETIME_HOURS`. That cutoff sits INSIDE the automatic branch, beside the
platform exclusion — a manually-flagged row must still be selectable once, or `run_metrics`'
`finally` block never clears `metrics_refresh_requested_at` and the flag sticks forever.

### The bug this shipped with, and what actually prevented a repeat

The **first** attempt published a Story-designated post to the public **feed**. The row was
written `surface='feed'` because the post editor's sends panel still sent bare `channel_ids`,
which the request parser read as feed targets. The worker was never at fault — it published
exactly what the row said.

The durable fix was not converting that one component. It was making
`POST /api/posts/[id]/schedule` **refuse** bare `channel_ids` (400), so a caller that forgets
the surface fails loudly instead of guessing a destination and publishing somewhere the
operator never chose. **On a route that publishes, a convenient default is a liability.**

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

## Verified: account-level insights, probed live (2026-08-05)

Established by running `python3 -m worker.insights_probe` against the live Liparoto
Instagram and Threads accounts — **one metric name per request**, so a rejection names the
specific metric rather than failing a batch. Not from docs, which are behind reality.

### `impressions` is GONE on Instagram

```
GET <ig-user-id>/insights?metric=impressions            -> 400  (period=day series)
GET <ig-user-id>/insights?metric=impressions&metric_type=total_value -> 400
```

This is the 2026-06-15 deprecation landing. **`views` is the replacement** and returns a
real number (613 where `reach` returned 207). Any code still asking for account-level
`impressions` gets a 400 that kills the whole call — which is exactly why per-metric
probing exists.

### Two envelopes, and a metric can work in one but not the other

| Metric | `period=day` series | `metric_type=total_value` |
|---|---|---|
| `reach` | works | works |
| `follower_count` | works | n/a (use the node field) |
| `profile_views` | accepted, returns NO data | works (9) |
| `website_clicks` | accepted, returns NO data | works (0) |
| `impressions` | **400** | **400** |
| `views`, `accounts_engaged`, `total_interactions`, `likes`, `comments`, `saves`, `shares`, `replies`, `profile_links_taps` | — | work |
| `email_contacts`, `get_directions_clicks`, `phone_call_clicks`, `text_message_clicks` | **400** | — |

"Accepted but returns no data" is a third state distinct from both success and 400, and it
is the trap: the call succeeds, so naive code records a null and reports zero forever.

`follows_and_unfollows` is accepted and returns `None` — present in the API, no value.

**Follower/following/media counts come from the account NODE** (`?fields=followers_count,
follows_count,media_count`), not from insights. Those field names have never been renamed,
which is why the hub reads growth from there rather than from `follower_count` insights.

### Demographics work fully, on both platforms

All three IG audiences × all four breakdowns returned data:
`follower_demographics`, `engaged_audience_demographics`, `reached_audience_demographics`
× `age`, `gender`, `city`, `country`. Threads supports `follower_demographics` × the same
four. City and country cap at **45 buckets**; age returns 6-7; gender returns 3 (`F`/`M`/`U`).

Requires `period=lifetime` + `metric_type=total_value` + `timeframe`. The response nests
three levels deep — `data[].total_value.breakdowns[].results[].dimension_values[]` — and
`dimension_values` is a LIST because compound breakdowns exist.

The documented "needs 100+ followers" floor was NOT exercised: both accounts are well past
it (IG 13,727 · Threads 1,938). Empty-result handling there remains unverified against a
real small account, and is treated as a normal state rather than an error.

### Threads

`views`, `likes`, `replies`, `reposts`, `quotes`, `followers_count` all work.
**`shares` returns HTTP 500**, not 400 — a server error rather than a clean rejection, so
it must not be read as "temporarily unavailable, retry later". `clicks` is accepted and
returns `None`. Neither belongs in the configured metric set.

### Scale finding

The Liparoto IG account holds **988 media**. A full historical backfill is therefore ~10
pages of media listing plus ~1 insights call per post. Rate limiting on the sync job is a
real constraint, not a precaution — hence reading `X-Business-Use-Case-Usage` off every
response (`GraphClient._record_usage`) rather than guessing a safe call rate.

### Account insight day-bucketing — the two envelopes cross-checked (2026-08-05)

The `since`/`until` semantics are not what the field names suggest, and getting them wrong
shifts every chart by a day without erroring. Settled by making the two envelopes agree:

```
SERIES  since=2026-07-29 until=2026-08-06   ->  points with end_time 07-29 .. 08-05
        end_time=2026-08-04T07:00:00+0000   ->  reach 157
TOTAL   since=2026-08-04 until=2026-08-04   ->  {}          <- EMPTY, not an error
TOTAL   since=2026-08-04 until=2026-08-05   ->  reach 157   <- same value as the series point
```

Three consequences:

1. **A single day is `[D, D+1)`, never `since=D&until=D`.** The same-day form returns an
   empty dict rather than an error, so code written that way records nulls forever and
   looks like a platform limitation instead of a bug.
2. **The series returns points whose `end_time` falls in `[since, until)`** — so
   consecutive chunks must abut (`window_end = window_start`), with no overlap and no gap.
3. **`end_time` marks the START of the local day, despite the name.** 07:00Z is midnight
   Pacific for this account, and the point stamped `2026-08-04T07:00Z` carries the same
   value as the total for day 2026-08-04.

`_day_from_end_time` therefore adds **12 hours** before taking the UTC date, rather than
using that date directly. The midpoint of the local day cannot be pushed across a date
boundary by either a positive or negative UTC offset; the naive form happens to be right
for a Pacific account and is silently wrong east of Greenwich.

Also confirmed: with no `since`/`until` at all, the total envelope returns a MULTI-day
window (reach 208 against a best single day of 189), so it must never be recorded as
"today".


---

## TikTok (Content Posting API + Display API)

Verified against TikTok's documentation on 2026-08-22. Base URL `https://open.tiktokapis.com`;
authorisation happens at `https://www.tiktok.com/v2/auth/authorize/`.

**The body is the success signal.** Every response carries an `error` object and a rejection
arrives as HTTP 200 with `error.code != "ok"`. Checking the status code alone reads a refusal
as a success — the same trap Telegram's `ok` field sets.

| Call | Shape |
|---|---|
| Authorize | `GET https://www.tiktok.com/v2/auth/authorize/` — `client_key`, `scope` (COMMA-separated), `response_type=code`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256` |
| Token / refresh | `POST /v2/oauth/token/`, **form-encoded** (not JSON). `grant_type=authorization_code` needs `code`+`code_verifier`; `grant_type=refresh_token` needs `refresh_token` |
| Identity | `GET /v2/user/info/?fields=open_id,display_name`, `Authorization: Bearer` |
| Inbox init | `POST /v2/post/publish/inbox/video/init/` with `source_info: {source: FILE_UPLOAD, video_size, chunk_size, total_chunk_count}` → `{publish_id, upload_url}`. **No `post_info`** — this endpoint has no caption field |
| Upload | `PUT <upload_url>` per chunk, `Content-Range: bytes <start>-<end>/<total>` (end INCLUSIVE), `Content-Type: video/mp4` |
| Status | `POST /v2/post/publish/status/fetch/` with `{publish_id}` → `status`, `fail_reason`, `publicaly_available_post_id` |
| Metrics | `POST /v2/video/query/?fields=...` with `{filters: {video_ids: [...]}}`, max 20 ids, scope `video.list` |

**Token lifetimes.** Access token 24 hours (`expires_in`), refresh token 365 days
(`refresh_expires_in`) — and the refresh token **rotates**: each refresh returns a new one
and invalidates the one sent. Storing it is mandatory.

**Chunk rules.** 5 MB minimum, 64 MB maximum, 1–1000 chunks; the final chunk carries the
remainder up to 128 MB. A whole file under 5 MB is a legal single chunk. A trailing chunk
below the 5 MB floor is rejected, so a short remainder is folded into the last chunk — and
the number of chunks sent must equal the `total_chunk_count` declared at init.

**App type must be Desktop.** Desktop apps may use an `http://localhost:PORT` redirect URI
and must use PKCE; Web apps are forced to HTTPS. This is what lets a localhost-only tool run
the OAuth flow at all.

**`publicaly_available_post_id`** is TikTok's own misspelling. It appears only once a post is
public *and* through moderation, which is what makes its arrival proof the creator published
the video.

**Statuses:** `PROCESSING_UPLOAD` / `PROCESSING_DOWNLOAD` → `SEND_TO_USER_INBOX` (delivered —
this integration's "done") → `PUBLISH_COMPLETE`; `FAILED` carries `fail_reason`.

**Unaudited clients** may only post `SELF_ONLY`, and up to 5 users may post in any 24 hours.
Inbox delivery is unaffected — the creator publishes it themselves, at whatever visibility
they choose.
