# Facebook Pages Publishing Adapter — Design

**Date:** 2026-07-23
**Phase:** 6 (Extend adapters) — sub-project 1 of several.
**Goal:** Publish **single-image** and **multi-photo** posts to a **Facebook Page**, and fetch
their performance metrics, reusing the existing publication lifecycle so every queue control
(hold / reschedule / cancel / retarget) works for Facebook exactly as it does for Instagram.

## Why this is small

A codebase map (2026-07-23) confirmed the schema, config, caption variants, post→channel
fan-out, and the **entire dashboard** already treat Facebook as a first-class platform:
- `channels.platform` CHECK already allows `'facebook'`; `remote_account_id` already means
  "IG user id **or FB Page id**"; the channel-creation UI already offers "Facebook Page".
- A post already fans out to **one `publications` row per target channel**, each with its own
  status/retry/remote id. A mixed IG+FB post already produces one IG and one FB publication.
- `_select_caption` already prefers `caption_variants` rows matching the channel's platform, so
  `"facebook"` captions already work once FB channels publish.

The gap is entirely in three worker files: `worker/graph_api.py`, `worker/publisher.py`,
`worker/metrics.py`.

## Global constraints (from CLAUDE.md / reference.md — apply to every task)

- LOCAL-ONLY, no cloud/paid SaaS. Per-install `.env` + SQLite; worker↔dashboard share the DB,
  no HTTP between them.
- Migrations are additive, numbered `.sql` in `/migrations` (single source of truth). **This
  sub-project needs no schema change** — the schema is already FB-ready.
- Never hardcode secrets; never log tokens, PII, or full API responses containing them.
- **Failed publishes must be visibly failed, never silent.** Each channel target is an
  independent publication; a failure on one must never roll back or block the others.
- **Never hardcode a rate limit** (IG reads `content_publishing_limit` at runtime; FB Pages
  have no such endpoint — see Decision 2).
- Python worker runs in the `.venv`; add tests alongside existing `worker/tests/`.

## Decisions

### Decision 1 — Scheduling model: mirror Instagram (worker publishes at due time)

The worker publishes FB posts at their scheduled time via the same poll-and-publish flow as
IG (`status='scheduled' AND scheduled_at<=now AND is_held=0`). **FB inherits every queue
control already built, with zero changes**, because those controls operate per-publication and
are platform-agnostic. Facebook's native scheduling (`published=false` +
`scheduled_publish_time`) is deliberately **out of scope** here — it would give FB a different
lifecycle (Meta owns the pending post; cancel/reschedule would have to call Meta to edit it),
breaking the single unified queue model. It is captured as a later item ("fire with the Mac
off"), not built now.

### Decision 2 — Graph API base URL: select the client per platform (no schema change)

Today `META_GRAPH_BASE` is **per-install** — one `GraphClient` built in `run.py:main` from
`config.graph_base`. But IG-via-Instagram-Login uses `https://graph.instagram.com` while FB
Pages **always** use `https://graph.facebook.com`. Resolution:

- The worker selects the Graph client **by channel platform**: `facebook` → always
  `https://graph.facebook.com`; `instagram` → the install's `config.graph_base` (unchanged).
- Implemented as a tiny per-base client cache/selector in `run.py`, passed to `publish_one`
  and `run_metrics`, which pick by `channel["platform"]`. No new columns; mixed IG+FB installs
  (the likely event-business case) just work.

## Facebook publish mechanics (verified against Meta docs, 2026-07)

A Page access token (`pages_manage_posts`) is required; on the owner's **own** Page this works
in the app's **Development mode** with an admin role — no App Review — the same arrangement IG
uses. FB photo endpoints fetch the image URL server-side, exactly like IG, so the existing
short-lived cloudflared tunnel logic in `run_once` (which only opens for assets lacking a
public `public_url`) is reused **unchanged**.

**Single image** — one synchronous call, no container/status polling (simpler than IG):
```
POST /{page_id}/photos
  url=<public asset url>   caption=<caption>   access_token=<page token>   published=true
→ { "id": <photo_id>, "post_id": <page_post_id> }
```
Store `remote_post_id = post_id` (the feed post id — needed for insights); fall back to `id`.

**Multi-photo** (FB's carousel-equivalent) — upload unpublished, then one feed post:
```
for each asset:  POST /{page_id}/photos  url=<url> published=false access_token=<t> → { "id": <media_fbid> }
POST /{page_id}/feed  message=<caption>  attached_media=[{"media_fbid": id1}, …]  access_token=<t>
→ { "id": <page_post_id> }
```
Store `remote_post_id = <page_post_id>`. (FB can't mix photos + videos this way — irrelevant
here; carousels are photos-only.)

**Rate limit:** skip the IG-only `content_publishing_limit` gate for FB entirely (Pages have no
such quota endpoint). Do **not** invent a hardcoded number.

## Metrics — fail-soft, deprecation-resistant

⚠️ Meta deprecated many Page/post **reach & impressions** insight metrics on **2026-06-15**;
old names (e.g. `post_impressions`) now return an "invalid metric" error and the set is still
churning (shifting to "views / unique media viewers"). Design accordingly:

- **Primary signal = stable summary fields** (not part of the insights deprecation):
  ```
  GET /{page_post_id}?fields=reactions.summary(total_count),comments.summary(total_count),shares
  ```
  → `m_likes` = reactions total, `m_comments`, `m_shares`. Reliable.
- **Reach/views = best-effort, fail-soft:** a separate `/{post_id}/insights` call for the
  currently-valid metric (the implementer verifies the exact name against Meta's changelog at
  build time). If it returns an invalid-metric / permission error, **store null, log a warning,
  and continue** — never crash, never fail the whole fetch. Map into `m_reach` (and
  `m_impressions` if a valid impressions/views metric exists).
- One metric failing must not fail the post's other metrics; one post's fetch failing must not
  block other posts (existing `run_metrics` behavior — keep it).

FB writes the **same `post_metrics` columns** IG uses (`reach, impressions, likes, comments,
saves, shares, video_views, raw_json`); `saves` stays null for FB (IG-only concept).

## Change surface (implementation units)

1. **`worker/graph_api.py`** — add FB Page methods to `GraphClient` (it already defaults to
   `graph.facebook.com`): `create_page_photo(page_id, image_url, token, *, caption=None,
   published=True) -> dict`, `create_page_feed_post(page_id, token, *, message=None,
   attached_media=None) -> str`, `get_page_post_summary(post_id, token) -> dict` (reactions/
   comments/shares), `get_page_post_insights(post_id, token, metrics) -> dict` (fail-soft).
2. **`worker/publisher.py`** — dispatch on `plan["platform"]` at the publish step (`:275`);
   FB path calls the new methods (single vs multi-photo by `post_type`); **skip the rate-limit
   gate for FB** (`:257`); generalize the IG-centric `plan["ig_user_id"]` name (value is
   already `remote_account_id` = the Page id for FB).
3. **`worker/metrics.py`** — branch on `channel["platform"]` at `:104`; FB path uses summary
   fields + fail-soft insights and the FB→column mapping.
4. **`worker/run.py`** — per-platform Graph client selection (Decision 2), threaded into
   `publish_one` / `run_metrics`.
5. **Tests** (`worker/tests/`) — extend `FakeGraphClient` with FB methods (recording new call
   kinds like `page_photo` / `page_feed`, honoring `fail_on`); extend `make_publication` to
   accept `platform="facebook"` with a Page-id `remote_account_id`; add publisher cases (FB
   single call-sequence has **no** `limit` step; FB multi-photo sequence; failure write-back)
   and metrics cases (summary mapping; a deprecated-insight error → null + still records
   summary fields).
6. **Docs** — `docs/meta-setup.md`: how to get a long-lived **Page access token** + the Page
   id, and the own-Page/Development-mode note. Channel creation UI already supports entering
   them; add helper copy only if needed.

## Out of scope (each a later Phase 6 item)

FB video/Reels · FB Stories · IG Reels/video · IG Stories · first-comment automation ·
approval-workflow UI · FB native scheduling ("fire with the Mac off") · BPP (best-performing-
post recycling).

## Testing / verification

- Worker unit tests green (existing + new FB cases), run in the `.venv`.
- Dry-run: a FB publication in `DRY_RUN=1` logs the intended calls and posts nothing.
- Real (owner-gated): one real photo + one real multi-photo post to a test Page, then a
  metrics fetch, verified against the live post — before relying on automation.
- Confirm a mixed IG+FB post fans out and each publishes independently (one failing doesn't
  block the other).

## Known limitations

- **Autofill's "prefer top performers" ranking scores every Facebook post as 0.**
  `worker/autofill.py` ranks recycling candidates by
  `MAX(IFNULL(pm.reach,0) + IFNULL(pm.saves,0))`. Facebook posts almost never have a
  non-null `reach` (best-effort, frequently rejected by Meta) and never have `saves` (an
  Instagram-only concept), so that sum is 0 for essentially every FB post — the
  "prefer top performers" tier silently collapses to a tie, and FB recycling falls back to
  age/staleness order. This is a known gap, not a bug to hot-fix here: changing the formula
  would also change Instagram's ranking, and best-performing-post recycling is its own
  planned sub-project (see `docs/tasks.md`, Phase 6+ backlog) that should revisit the
  ranking formula for both platforms together.
