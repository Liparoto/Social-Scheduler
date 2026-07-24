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
      specs (≤8 MB, aspect 4:5–1.91:1, ≤1440px wide, sRGB). ✅ **CLOSED** by the Image
      conformance sub-project below.

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

## Content management — sub-project ④ (partial): Post management (edit) screen  `[x] done`
Design: `docs/design-post-management.md` · Plan: `docs/superpowers/plans/2026-07-23-post-management.md`
The "open a post and manage it" piece of ④ — unblocks editing existing posts (e.g. the Teton post).
- [x] `getPostAssets` query; `/library/[id]` server page (404s on bad id) loads current state via
      existing getters and passes to a client `<PostEditor>`.
- [x] `<PostEditor>`: pre-populated form reusing `CaptionVariantsEditor`/`TagEditor`/`PeriodAttach`
      + channel picker; edits kind/status/cooldown/targets/tags/periods/captions; saves via the
      existing `PATCH /api/posts/[id]/content`. Read-only image + "Schedule status" strip
      (posts.status kept separate from content_status).
- [x] Library card title + thumbnail link to `/library/[id]` (card → `div role=button` so the link
      nests validly; `closest('a')` guard keeps bulk-select intact). Verified in-browser
      (pre-populate, save round-trip persists, 404, bulk-select preserved).
- Scope note (deferred): editing images and rescheduling existing sends are NOT in this screen.

Note: ④'s full overview is now done — see the sub-project ④ section below.

---

## Content management — sub-project ③ Bulk import (manual)  `[x] done`
Design: `docs/design-bulk-import.md` · Plan: `docs/superpowers/plans/2026-07-23-bulk-import.md`
Multi-select images → one Draft post each with shared batch defaults; fully local (no AI/cloud).
- [x] `createDraftPostsBulk(items, shared)`: N single-image drafts in ONE transaction
      (wraps `createDraftPost`; a per-image caption becomes the post's single generic variant).
- [x] `POST /api/posts/bulk-import`: validates items (≤100, each asset exists) + shared defaults
      (kind/status/targets/tags/periods) FULLY before writing — any 400 creates zero rows.
- [x] `/import` page + `<BulkImport>`: multi-image upload (reuses `/api/assets/upload` dedup) →
      thumbnail grid with per-image captions → batch defaults panel → "Create N drafts" →
      Library. Sidebar "Import" + Library "Bulk import" links. Verified: create path made 2
      drafts (captions+tag+target) shown in Library; page/nav render; whole-branch review clean.
- Deferred (spec §7 — the seam for later): AI-assisted captions/tags (needs owner LLM opt-in),
  folder-path import, CSV manifest, carousel grouping.

---

## Content management — sub-project ④ Library overview  `[x] done`
Design: `docs/design-library-overview.md` · Plan: `docs/superpowers/plans/2026-07-23-library-overview.md`
Builds on the post-management screen. Adds to the Library (all client-side):
- [x] Summary stat strip (Ready/Draft/Retired/Evergreen/One-time/total).
- [x] Status filter (draft/ready/retired) + Kind filter (evergreen/one-time), AND-combined with the
      existing tag/platform chips.
- [x] Caption search; Sort (Newest / Recently posted / Least recently posted — never-posted last).
- [x] "showing N of M" count. Verified in-browser; bulk-schedule / re-target / edit links intact.
- Deferred: per-post performance rollup, saved views, pagination.

---

## Post-workflow batch (items 1–3, alongside ④)  `[x] done`
Three quality-of-life features shipped in one design→build batch (subagent-driven, whole-batch review):
- [x] **Compose → "From library"** — pick an existing post + channels + date/time to schedule it
      (per-channel tz), reusing `bulkCreatePublications`. New `POST /api/posts/[id]/schedule`,
      `<ComposeSwitcher>` toggle + `<ScheduleFromLibrary>` picker.
      Design: `docs/design-compose-from-library.md`.
- [x] **Manual metrics refresh** — migration `0004` adds `publications.metrics_refresh_requested_at`;
      the worker honors it as a one-shot override of BOTH the interval and age gates, then clears it;
      per-row "Refresh metrics" + Overview "Refresh all". Async-honest ("Queued — updates next worker run").
      Design: `docs/design-metrics-refresh.md`.
- [x] **Scheduled-view filters** — Overview Publications table extracted into `<PublicationQueue>` with
      account / platform / status filters + "showing N of M". Design: `docs/design-scheduled-view-filters.md`.
- [x] Owner action done: `0004` applied to the live DB.

---

## Theme system — 7 families × light/dark  `[x] done`
Design: `docs/design-themes.md` · Plan: `docs/superpowers/plans/2026-07-23-themes.md`
Switchable themes (SocialScheduler [default], Claude, APT, FYZICAL, Default, Solarized, Vela) each
with a light + dark variant. `<html data-theme data-mode>` + `[data-theme][data-mode]` CSS blocks;
Tailwind v4 auto-generates utilities from the `--color-*` vars. localStorage persistence + no-flash
head script; sidebar picker + sun/moon toggle. Added `on-brand`/`on-accent`/`-strong` foreground
tokens so all buttons/pills pass WCAG AA across all 14 palettes. Verified in-browser.

---

## Worker liveness + honest metrics refresh  `[x] done`
Migration `0005` adds `worker_heartbeat`; the worker stamps `last_seen_at` every poll (before the
kill-switch check — alive != publishing). The Overview shows a **Worker online/offline** pill
(`getWorkerStatus`, 120s window) and the Refresh buttons warn when the worker looks offline instead
of silently promising an update that won't come. Root-caused from "metrics stuck at 0": the worker
is a polling daemon and wasn't running, so the birth-snapshot (0/0 at publish instant) never
refreshed — the API had the real numbers the whole time. 80 worker tests; browser-verified both
states.

---

## Image conformance — make uploads publish-safe  `[x] done`
Design: `docs/design-image-conformance.md` · Plan: `docs/superpowers/plans/2026-07-23-image-conformance.md`
Closes the Phase 5.5 gap: every uploaded image is conformed to the IG feed-image spec **on upload**
so the worker always sends Meta a valid file, and the framing decision is made once and remembered
per-asset (so evergreen auto-fill reuses it).
- [x] Task 0 — verified the live IG spec (8MB / 4:5–1.91:1 / 320–1440px / sRGB) → `reference.md`.
- [x] Migration `0006`: `assets.publish_path` / `conform_mode` / `needs_review` (additive).
- [x] `dashboard/lib/conform.ts` — pure `sharp` engine: EXIF-rotate (materialized), sRGB, ≤1440,
      JPEG stepping to ≤8MB; out-of-range ratio → center-crop (default) or letterbox-pad, flagged.
- [x] Conform on upload: writes a `pub/<hash>.jpg` derivative + stores the framing decision;
      original preserved; conform failure is non-fatal (falls back to original).
- [x] Worker `_resolve_url` precedence: external `public_url` → `publish_path` → `storage_path`.
- [x] `POST /api/assets/[id]/conform` — switch crop⇄pad, re-derives from the original, persists.
- [x] Dashboard `<ConformControl>`: "Auto-cropped — review framing" badge + Crop⇄Pad toggle +
      conformed preview, in composer / import / post-editor.
- [x] Verified: 82 worker tests; dashboard `tsc` clean; each task TDD/smoke + reviewed; the whole
      flow browser-verified (upload out-of-range → badge → toggle Pad → re-derived 1440×754 @1.910,
      persisted; back-compat: legacy assets fall back to the original).
- Deferred (Phase 6 / follow-up): Reels/Stories/video conformance; Facebook Pages specs; carousel
  same-ratio harmonization; blurred-fill pad + manual crop framing; pad-width>1440 cap for extreme
  tall sources (benign — Meta auto-scales width).

---

## Queue control — manage sends before they post  `[x] done`
Design: `docs/design-queue-control.md` · Plan: `docs/superpowers/plans/2026-07-23-queue-control.md`
Between "scheduled" and "posted" the owner can now fully manage a send. Guiding safety rule:
**never destroy the record of anything already posted to Instagram** (deletes are local-only and
blocked on posted/publishing content). The worker fires sends at their time whenever it's running
(no Meta-side scheduling), so these controls act on the local queue it polls.
- [x] **Cancel** (shipped first, `dc5dd40`): two-click Cancel on scheduled/pending sends → the
      `canceled` status that was in the schema but unreachable; drops out of the worker's queue.
- [x] Migration `0007`: `publications.is_held` (additive). Worker `fetch_due_publications` gains
      `AND is_held = 0` — a held send is simply never picked up (like canceled). +worker test.
- [x] Query layer: `deletePublication` / `reschedulePublication` / `holdPublication` /
      `resumePublication` / `deletePost` (3-state, blocked on live) / `getPostPublications`; all
      guarded (`WHERE … AND status IN (…)`) so they're atomic vs the worker (409, never a race).
- [x] Publication routes: `hold` · `resume` · `reschedule` ({date,time} → the send's own channel
      tz → UTC via `intervalSlots`) · `DELETE` (delete send). Guarded post-delete route (404/409/200).
- [x] **Overview** per-send controls: Hold/Resume + Cancel inline, Reschedule + Delete under a
      "More" toggle, a **Held** chip. **Post editor** "Scheduled sends" panel: list + per-send
      reschedule/hold/remove + **Add a send** (retarget, reuses `POST /api/posts/[id]/schedule`) +
      guarded **Delete post**.
- [x] Verified: 83 worker tests; dashboard `tsc` clean; each task TDD/curl + reviewed; the whole
      flow browser-verified (hold→chip, reschedule DST-correct 10:30 EDT→14:30 UTC, delete-send,
      add-send, delete-post blocked-when-live vs succeeds+redirects; DB baseline + FK intact).
- Deferred: bulk queue ops; a "hold" is a modifier not a new status; Facebook (native scheduling)
  revisited in Phase 6.

---

## Friendly launcher + update (hand-off to a non-technical teammate)  `[x]`
Spec: `docs/superpowers/specs/2026-07-23-launcher-and-update-design.md`. Goal: someone who won't
touch a terminal can start everything with one double-click and update with one double-click,
without ever risking her `.env` (secrets) or `/data` (DB + assets) — both gitignored.
- [x] Replaced the two `Start-Dashboard-*` files with **one launcher per platform**
      (`Start-SocialScheduler-Mac.command` / `-Windows.bat`). Preflight (Node + Python 3, friendly
      guidance if missing) → idempotent setup every launch (create `.env`, always run `migrate.py`,
      install dashboard deps + create the worker `.venv`) → a 2-item menu.
- [x] **Compose only** (default): dashboard only, worker never runs → nothing can post.
      **Go live**: starts the worker in the background **and** the dashboard; on window close the
      worker is stopped cleanly (Mac `trap … EXIT INT TERM HUP` → SIGTERM; Windows titled worker
      window + `taskkill`).
- [x] **Real-post guard**: Go live reads `DRY_RUN` from `.env` live. `DRY_RUN=1` → worker runs in
      dry-run with a clear note. `DRY_RUN=0` → "type YES to post for REAL" or fall back to Compose
      only. Warns (non-fatal) if `cloudflared` is missing; notes `KILL_SWITCH=1` idles the worker.
- [x] **Update scripts** (`Update-Mac.command` / `-Windows.bat`): not-a-checkout / no-network /
      local tracked-code edits each stop with a plain message and change nothing; otherwise
      `git pull --ff-only` → `migrate.py` → refresh deps → success. Never stash/discard/force;
      untracked stray files are ignored (ff-only still refuses a real collision).
- [x] Verified on this Mac: Compose starts no worker; Go-live(dry-run) starts the worker + it
      writes a fresh heartbeat; SIGTERM → clean "Worker stopped."; trap leaves no orphan;
      DRY_RUN=0 Enter→fallback / YES→worker; missing-Node and missing-Python messages; Update
      not-a-checkout + dirty-tracked stops; ff-only fast-forwards when behind and **refuses when
      diverged**. README quick-start updated.
- [x] **In-dashboard "check for updates"** (read-only). `GET /api/update-check` does a read-only
      `git fetch` + `rev-list --count HEAD..@{u}` (5-min cache, `?force=1` bypass, platform-aware),
      never pulls. Sidebar footer `UpdateBanner`: silent muted "Check for updates"/"Up to date"
      when current/unknown; amber "Update available — you're N behind, close the app + double-click
      Update-Mac/Windows" when behind (dismissible). Applying stays in the Update script — a running
      server can't cleanly replace its own code + restart. Verified all 3 states end-to-end
      (current/behind via a throwaway local upstream, reverted), dismiss, no console errors, tsc clean.

---

## Phase 6 — Extend adapters  `[ ]`
Built only after 1–5 are solid. **Re-verify live Meta docs** for each before building.
Done one sub-project at a time (own spec → plan → build), not all at once.
- [~] **Facebook Pages publish + metrics adapter** — spec'd
      (`docs/superpowers/specs/2026-07-23-facebook-pages-adapter-design.md`). Single image +
      multi-photo; mirrors the IG lifecycle (queue controls work unchanged); per-platform Graph
      client (FB → graph.facebook.com); **fail-soft metrics** (stable reactions/comments/shares +
      best-effort reach/views, since Meta deprecated many post insights 2026-06-15). No schema
      change — schema/config/dashboard already FB-ready. Work is in 3 worker files + tests.
- [ ] Reels/video (async container, status polling, `video_url`).
- [ ] Stories.
- [ ] First-comment automation (post-publish comment endpoint).
- [ ] Approval-workflow UI (activates the `requires_approval` flag).

### Verification
- [ ] Each adapter dry-run first, then one real post to a test account, before automation.

## Phase 6+ backlog (owner-requested 2026-07-23, brainstorm each as its own sub-project)
- [ ] **BPP — Best-Performing-Post recycling.** Auto-prioritize re-posting top performers.
      Extends the existing metrics + autofill/evergreen ranking; depends on good metrics flowing
      (IG done; FB from the adapter above). Design after the FB adapter lands.
- [ ] **"Fire with the Mac off" scheduling — simple, free, self-serviceable.** For FB, Meta's
      native scheduling is essentially free (the deferred "Option B"). For IG there's no
      Meta-side scheduling → needs an always-on host; explore simple/free options (always-on
      Pi/old Mac, free-tier VM, scheduled cloud runner) and their trade-offs (image-delivery
      tunnel, secrets handling, kill switch). Its own brainstorm — must stay simple enough for a
      non-technical clone owner to set up.
