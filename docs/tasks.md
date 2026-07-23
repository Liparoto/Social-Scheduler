# SocialScheduler — Tasks

Phased breakdown. **One phase at a time**; each phase must pass its verification before the next
begins. Mark items `[x]` as completed and update status as we go.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 1 — Foundation & schema  `[x] done`
Everything downstream shares this. Get the schema and repo skeleton right.

### Implementation
- [x] Repo skeleton: `/dashboard`, `/worker`, `/migrations`, `/data` (gitignored), `/docs`.
      (dashboard/ and worker/ arrive with their phases; migrations/, data/, docs/ exist now.)
- [x] `.env.example` documenting every per-install var (Meta app id/secret, per-channel token
      placeholders, `DRY_RUN`, `KILL_SWITCH`, DB path, install-wide default timezone).
- [x] Migration `0001_init.sql` creating all core tables:
      `assets`, `posts`, `post_assets`, `channels`, `publications`, `post_metrics`,
      `tags`, `post_tags`, `publish_limits`. Foreign keys ON; sensible indexes
      (`assets.content_hash` unique, `publications(channel_id, scheduled_at, status)`, etc).
- [x] Language-agnostic migrate script (`migrate.py`, stdlib only) applying pending `.sql`,
      tracking applied versions in `schema_migrations`. Runs from a fresh clone.
- [x] Inspect/seed helper (`inspect_db.py`) to dump tables/counts and seed a test channel.

### Verification (all passed — see commit)
- [x] Fresh migrate on empty DB → all tables + indexes exist.
- [x] Re-run migrate → idempotent, nothing re-applied.
- [x] Duplicate `content_hash` insert → rejected by UNIQUE constraint.
- [x] WAL mode + foreign keys confirmed; bad FK insert rejected; CHECK + ON DELETE CASCADE
      verified.

---

## Phase 2 — Instagram publish worker (image + carousel)  `[~] code complete; awaits live-account check`
Highest-risk API surface, proven first against a **test** account.

### Implementation
- [x] Python `venv` (`worker/.venv`) + `requirements.txt` (requests) / `requirements-dev.txt`
      (pytest), each dep justified inline.
- [x] Graph API client (`graph_api.py`): create container, poll `?fields=status_code` until
      `FINISHED`, publish via `media_publish`. Carousel = child containers → parent → publish.
- [x] Runtime **rate-limit gate** (`publisher.py`): read `content_publishing_limit`, refuse
      when `quota_usage >= quota_total`; cache into `publish_limits`.
- [x] **Dry-run mode** (`DRY_RUN`, read live): logs the full plan, publishes nothing.
- [x] Independent per-`publication` status writes; **retry with exponential backoff**; terminal
      `failed` after `max_attempts`; **kill switch** (`KILL_SWITCH`, read live) halts the loop.
- [x] Poller (`run.py`): `--once` and run-forever, graceful SIGINT/SIGTERM, crash-safe logging.

### Verification
- [x] Dry-run single image → correct plan logged, nothing posted (unit + real entrypoint).
- [x] Dry-run 3-image carousel → correct child/parent/publish sequence (unit test asserts
      exact call order); real entrypoint logged the ordered plan.
- [ ] **Real single image to a test account → appears on IG, `remote_post_id` stored.**
      ⏳ BLOCKED on real Meta app + test IG account credentials (owner to provide).
- [x] Forced failure → publication retries with backoff then lands terminal `failed`; a second
      publication is provably untouched (independence test).
- [x] Kill switch active → `run_once` publishes nothing, rows untouched.
- [x] Rate-limit gate blocks when quota exhausted (simulate) → no publish, deferred with backoff.

All 10 automated tests pass (`worker/tests`). Only the single live-account post remains,
which needs credentials.

---

## Phase 3 — Dashboard composer + overview  `[x] done`
Make the process legible; compose → schedule → watch it publish.

### Implementation
- [x] Next.js 16 app (App Router, TS, Tailwind v4) reading/writing SQLite via
      `better-sqlite3` (WAL). Shared repo-root `.env` (single install config).
- [x] Asset upload → content-hash (sha256) dedup → local store + `public_url` + `sharp`
      thumbnail; media route serves previews.
- [x] Composer: caption, `first_comment`, drag-to-order carousel (+ arrow fallback),
      **per-channel select buttons with obvious color-coded targeting + live preview + "Headed
      to"**, schedule picker converted from channel timezone → UTC.
- [x] Overview: per-channel **queue rail** (signature) + publications table with status,
      per-channel times, dry-run flag, errors, and manual retry / approve actions.
- [x] Channel config: add form (credentials, timezone, IG/Page ids, approval), inline
      approval + active toggles.
      (Cadence config is Phase 4; a dashboard kill-switch toggle deferred — env switch works.)

### Verification (all passed — via the real API endpoints the UI calls)
- [x] Compose a post → two channels → two `publications` at the same instant; TZ converted
      (12:00 EDT → 16:00 UTC); approval-required channel correctly landed `pending_approval`.
- [x] Upload same bytes twice AND a renamed copy → all deduped to one asset (content, not name).
- [x] Dashboard-created publication picked up + dry-run published by the Phase 2 worker
      (cross-component). Approve → worker then publishes it.
- [x] Force a publication to failed → retry from the API resets it to scheduled (attempts
      cleared); retry on a non-failed publication returns 409.
- [x] `tsc --noEmit` clean; `npm run build` succeeds (all 11 routes); UI verified in browser.

---

## Phase 4 — Scheduling + auto-fill  `[x] done`

### Implementation
- [x] Bulk schedule: N posts at a fixed interval (every N days @ time) to N channels, slots
      in each channel's TZ. Draft posts (compose "Save as draft") + Library page to pick them.
      (`lib/scheduling.ts`, `/api/posts/bulk`, `/api/posts/draft`, Library view.)
- [x] Per-channel cadence config (weekly days + time), min/target queue depth, reuse-age —
      editable in the Channels page (`AutofillConfig`), stored in `channels.cadence_config`.
- [x] Auto-fill top-up (`worker/autofill.py`) honoring the selection order as one ranking:
      never-posted (tier 0) → recyclable by age (tier 1, recently-posted excluded) → per-channel
      top performers (reach+saves) first. Weekly slot generation in `worker/scheduling.py`.
      Wired into the worker poll loop.

### Verification (all passed)
- [x] Bulk-schedule 5 posts every 2 days @ 18:00 EDT → Aug 1/3/5/7/9 @ 22:00 UTC. Correct.
- [x] Auto-fill selection tiers (unit tests, crafted data): never-posted first; recently-posted
      (<N days) excluded; top performer preferred among recyclable; performance is per-channel;
      already-queued not reselected.
- [x] Live: queue 5/8 → worker added 3 never-posted at next Mon/Wed/Fri 18:00 slots; second run
      added 0 (no over-fill).
- [x] 23 worker tests pass; dashboard `tsc` clean; Library + auto-fill config UIs verified.

---

## Phase 5 — Metrics fetch job  `[x] done`

### Implementation
- [x] Per-`publication` metrics fetch (`worker/metrics.py`): pulls reach/likes/comments/
      saved/shares from the Graph media-insights endpoint → time-series `post_metrics` rows.
      Throttled (only posts < metrics_max_age_days; refreshed at most every
      metrics_min_interval_hours). Skips dry-run / unpublished. Wired into the poll loop.
- [x] Feeds the per-channel performance ranking already used by auto-fill.
- [x] Latest reach/saves/likes surfaced per posted publication in the Overview table.

### Verification (all passed)
- [x] Fetch writes a mapped snapshot ("saved"→saves etc.); live seed → reach/saves/likes
      shown in the Overview.
- [x] Throttle honored (no double-fetch within interval; refetches after it); old posts and
      dry-run/unpublished excluded; fetch failure is non-fatal.
- [x] Metrics feed ranking → higher performer selected (per-channel) on seeded data.
- [x] 29 worker tests pass; dashboard `tsc` clean; Overview metrics verified in browser.

---

## Phase 5.5 — Publish delivery (public URL for Meta)  `[x] done`
Meta downloads images from a public URL; our assets live on a local Mac. Solved with a
short-lived, worker-managed Cloudflare quick tunnel. Design: `docs/design-publish-delivery.md`.

### Implementation
- [x] `worker/asset_server.py` — read-only localhost server for `data/assets`, addressed by
      content hash; path-traversal guarded; no listing; stdlib only.
- [x] `worker/tunnel.py` — `cloudflared` quick-tunnel manager (spawn, parse public URL,
      teardown) + `publish_endpoint()` context manager composing server + tunnel. Missing
      binary raises a clear `TunnelError` with install guidance.
- [x] `worker/publisher.py` — build each image URL at publish time from the live tunnel base
      + `storage_path`; external `public_url` (paste escape hatch) still wins. No stored URL.
- [x] `worker/run.py` — open the tunnel ONLY when a due asset needs local serving; tunnel
      failure is visible (per-publication `last_error`) and non-fatal (daemon keeps running,
      publication stays scheduled to retry).
- [x] Config knobs (`ASSET_PORT`, `CLOUDFLARED_PATH`, `TUNNEL_STARTUP_TIMEOUT`) + `.env.example`.
- [x] `requirements.txt` / `requirements-dev.txt` added; `.venv` set up.

### Verification
- [x] 41 worker tests pass (10 new): asset server serves bytes + blocks traversal (real HTTP);
      tunnel URL parsing; missing-binary error; URL-resolution precedence; publish builds the
      tunnel URL; tunnel-unavailable is visible-not-fatal; external URL publishes without a tunnel.
- [x] Real worker `--once` against the live DB is a clean no-op in dry-run.
- [x] **Live (2026-07-22):** cloudflared installed; posted a real JPEG to Liparoto. Tunnel
      live in ~8s, media id `18015397358720320`, permalink `instagram.com/p/DbHvdnEEUEr`,
      `is_dry_run=0`, no errors; DRY_RUN restored to 1 after. FULL PIPELINE VALIDATED.
      Gap found: dashboard uploads are stored as-is, so images must be conformed to Meta
      specs (≤8 MB, aspect 4:5–1.91:1, ≤1440px wide, sRGB) — address in image management.

---

## Content management — sub-project ① Content model  `[x] Phase A done`
Design: `docs/design-content-model.md` · Plan: `docs/superpowers/plans/2026-07-23-content-model-phase-a.md`

### Phase A — data + automation logic  `[x] done`
- [x] Migration `0002_content_model.sql`: `posts.content_kind`/`content_status`/`cooldown_days`
      + tables `periods`, `post_periods`, `post_targets`, `caption_variants`; additive backfill
      (existing posts → ready/evergreen, targets from non-failed publications, caption → variant).
- [x] `worker/periods.py`: yearly (wrap-around) + one-off window math, evaluated in channel tz.
- [x] Auto-fill eligibility gates: content_status, per-account targeting, one-time (once per
      account), evergreen cooldown (per-post override), green/blackout periods (blackout wins).
- [x] One-time auto-retirement once all targets have posted; dry-runs don't count.
- [x] Caption-variant rotation at publish (platform-specific → generic rotated → fallback).
- [x] Verified: 61 worker tests pass; each task TDD + reviewed; whole-branch review clean.
- [ ] **Owner action:** run `python3 migrate.py` on the live DB to apply `0002` (the launcher
      does this automatically). Backfills the existing Grand Teton post to ready/targeted.

### Phase B — dashboard UI  `[x] done`
Plan: `docs/superpowers/plans/2026-07-23-content-model-phase-b.md`. All verified in-browser.
- [x] B1 — data layer: types + queries + API for periods/targets/caption_variants/kind/status;
      shared validation; smoke test. (reviewed + fixed)
- [x] B3 — Periods manager (`/periods`): create/edit/delete named windows; yearly (wrap-around)
      vs one-off picker with live plain-English preview; **single-day option** (July 4th).
- [x] B2 — Composer: content_kind, account targeting, 1..N caption variants (generic + per-
      platform), green/blackout period attach, library Draft/Ready status. Verified: fields
      persist + validate (invalid period → 400).
- [x] B4 — Library: bulk re-target (add/remove an account across selected posts, idempotent) +
      overview badges (kind / content_status / targets / season). Verified round-trip.
- [x] Whole-Phase-B capstone review (fixed dup-channel-id 500 + cooldown validation → `e0ba600`).

---

## Content management — sub-project ② Tagging taxonomy  `[x] done`
Design: `docs/design-tag-taxonomy.md` · Plan: `docs/superpowers/plans/2026-07-23-tag-taxonomy.md`
Two tag kinds: `time_of_day` (fixed morning/afternoon/evening/anytime — steers scheduling) and
`topic` (free-form — organizes + fuels bulk import ③). Platform is derived from targets, not a tag.

### ②-A — engine  `[x] done`
- [x] Migration `0003_tag_taxonomy.sql`: `tags.kind` (default topic) + seed 4 time_of_day bands
      + `idx_post_tags_tag`. Additive.
- [x] `worker/time_of_day.py` + band-time config: resolve a post's band → clock time (earliest
      specific band wins; anytime/untagged → the channel's own cadence time).
- [x] `scheduling.weekly_date_slots`: one auto-post per active cadence day, each slot's time from
      its own band. Auto-fill wired to use it — cadence sets the days, the tag sets the time.
- [x] Verified: 72 worker tests pass; each task TDD + reviewed; whole-branch review clean.

### ②-B — dashboard UI  `[x] done`
- [x] Tag types + query layer (`listTags`/`createTopicTag`/`getPostTags`/`setPostTags`); `tag_ids`
      threaded through create + edit; `listPosts` gains tag + derived-platform columns.
- [x] `parseTagIds` validator + `/api/tags` route (create-or-get topics; reserved band names → 400).
- [x] Composer `<TagEditor>`: time-of-day band chips + free-form topic adder.
- [x] Library: per-card tag chips + tag filter + computed platform (instagram/facebook) filter;
      existing bulk-schedule / re-target untouched. Verified in-browser (chips, both filters).
- [x] Owner action done: `0003` applied to the live DB (4 bands seeded).

Deferred (per spec §6): ③ bulk import, ④ full Library overview, per-channel band-time overrides,
topic rename/merge/delete UI.

---

## Phase 6 — Extend adapters  `[ ]`
Built only after 1–5 are solid. **Re-verify live Meta docs** for each before building.
- [ ] Facebook Pages publish + metrics adapter.
- [ ] Reels/video (async container, status polling, `video_url`).
- [ ] Stories.
- [ ] First-comment automation (post-publish comment endpoint).
- [ ] Approval-workflow UI (activates the `requires_approval` flag).

### Verification
- [ ] Each adapter dry-run first, then one real post to a test account, before automation.
