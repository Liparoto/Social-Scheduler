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
- [x] Channel timezone is **editable after creation** (was create-only): US shortlist
      dropdown + custom IANA entry, and changing it rebases every pending send so the wall
      clock is preserved. Invalid zone names are now rejected instead of crashing render.
      See `docs/superpowers/specs/2026-07-30-channel-timezone-editing-design.md`.

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

## Windowless Start/Stop launchers  `[x]`
Spec: `docs/design-launcher-windowless.md` · Plan:
`docs/superpowers/plans/2026-07-31-windowless-launchers.md`. Goal: the Terminal window was the
stop mechanism, so anything that closed it — including a Claude Code session ending — killed the
dashboard. Start now detaches and closes its own window; a paired Stop takes over the job.
- [x] **`Stop-SocialScheduler-Mac.command` / `-Windows.bat`** (new): kills the watchdog first (so a
      stale timer can't fire at a recycled PID), then the worker, then the dashboard. **Always**
      sweeps port 3939 rather than trusting the recorded PID — `npm run dev` spawns the Next.js
      server as a *child*, so `$!` records the npm wrapper and killing it alone can orphan the
      server. Safe to run twice; reports "Nothing was running."
- [x] **Start rewritten (section 8 only)**: `nohup … & disown` (Mac) / `run-hidden.vbs` (Windows),
      PIDs recorded under `data/run/`. Steps 1–7 — preflight, `migrate.py`, first-run installs, the
      Compose/Go-live menu, the `DRY_RUN=0` YES guard — are untouched.
- [x] **Removed the `trap cleanup EXIT INT TERM HUP`**: with a detached worker it would have killed
      it the instant the window self-closed, the exact opposite of the goal.
- [x] **Window self-close (Mac)**: background AppleScript matching the script's own `tty`, fired
      after the shell exits so Terminal closes cleanly instead of prompting. Can only ever close its
      own window. Failure is cosmetic — the window just stays, which is the old behavior.
- [x] **Already-running check**: reopens the browser instead of double-starting, so Start doubles as
      an "is it on?" check. No separate Status file to explain.
- [x] **Worker auto-stop**: `WORKER_AUTO_STOP_HOURS` (default 12, in `.env.example`) + a detached
      watchdog + `data/run/worker.deadline`. The worker publishes for real and now has no visible
      window; this is what stops a forgotten worker posting unattended. Applies in dry-run too. The
      dashboard gets no timer — it publishes nothing.
- [x] Verified on this Mac: detached dashboard reparents to `launchd` and still serves HTTP 200
      after its launching shell exits (the original bug); already-running path leaves exactly one
      listener; Go-live records worker+watchdog+deadline at +12h with `KILL_SWITCH active —
      publishing nothing` in the log; Stop clears `data/run/`, frees the port, kills both processes;
      Stop twice is a clean no-op; real Terminal window opened and closed itself (1→2→1 windows)
      without touching a pre-existing window. `.env` restored byte-identical after testing.
- ⚠️ **Windows scripts are UNVERIFIED** — no Windows machine in this setup and no reliable batch
      linter. Logic mirrors the verified Mac scripts. `run-hidden.vbs` takes a `.cmd` *file path*
      rather than a command line specifically to avoid `for /f` quoting against a repo path
      containing a space. First person to run it on Windows should expect to report bugs.

---

## Export & backup  `[x] done`
Read-only snapshot of an install's content, for anyone who wants a dated local/Drive backup
without touching the database directly.
- [x] `worker/export/` — read-only collect → write, `python -m worker.export`.
- [x] Five-tab `.xlsx` (Posts, Sends, Metrics, Assets, Channels) + `export.json`.
- [x] Originals and IG-conformed image copies, named `postID_caption_position`.
- [x] `Export-Mac.command` double-click launcher — mirrors Start/Update's voice, opens the
      finished folder in Finder, never touches the database.
- [x] `Export-Windows.bat` — same launcher for Windows clones (opens File Explorer). Added
      `tzdata` to `requirements.txt` so `zoneinfo` has a database on Windows, where the OS
      ships none — without it the local-time columns (and the worker's scheduling) fall back
      to UTC. Note: the `.bat` mirrors the verified Mac launcher but has not been run on an
      actual Windows machine.
- [x] Secrets excluded by allow-list (`CHANNEL_COLUMNS` in `worker/export/collect.py`); guarded
      by both a name-specific test and a structural test that rejects any future
      token/secret/password/key/credential-shaped column, plus a grep over a real export.
- [ ] Future: re-import from `export.json`; `--since` / `--channel` filters.

## Phase 6 — Extend adapters  `[ ]`
Built only after 1–5 are solid. **Re-verify live Meta docs** for each before building.
Done one sub-project at a time (own spec → plan → build), not all at once.
- [x] **Facebook Pages publish + metrics adapter** — spec
      `docs/superpowers/specs/2026-07-23-facebook-pages-adapter-design.md`, plan
      `docs/superpowers/plans/2026-07-23-facebook-pages-adapter.md`. Single image
      (`/{page}/photos`, one call, stores the feed `post_id`) + multi-photo (unpublished
      uploads → `attached_media` feed post). No schema change. New `worker/clients.py`
      picks the Graph host per platform (FB pinned to graph.facebook.com, IG keeps
      `META_GRAPH_BASE`) so one install can mix IG + FB. IG quota gate skipped for FB
      (Pages have no `content_publishing_limit`). Metrics: stable reactions/comments/shares
      + best-effort reach via `FB_POST_INSIGHT_METRICS` (null, never fatal, when Meta
      rejects the name — a batch was deprecated 2026-06-15). Queue controls, captions,
      fan-out and dry-run all work unchanged.
      **Known limitation:** autofill's "prefer top performers" ranking sums
      `reach + saves`, both of which Facebook rarely/never provides, so it scores every FB
      post as 0 and recycling falls back to age/staleness order for FB until the planned
      best-performing-post work (see Phase 6+ backlog below) revisits the ranking formula.
- [x] **Threads real-post verification — DONE 2026-07-25.** First real post published
      end-to-end: media id `17976347178119414`,
      https://www.threads.com/@liparoto/post/DbOMTJ1kULz (IMAGE, @liparoto). Read back from
      the live API to confirm, not just trusted from our own DB. Proved on first contact:
      correct host+version (`graph.threads.net/v1.0`), the cloudflared tunnel serving a local
      image to Meta and tearing itself down, container→publish polling `status`, the runtime
      250/24h quota gate, and same-cycle metrics (views/likes/replies/reposts = 0 on a
      seconds-old post; `reach`/`saves` correctly null). `DRY_RUN` was flipped to 0 for exactly
      one `--once` cycle and restored to 1 immediately.
      - Gotcha that cost real time, now documented in `docs/meta-setup.md`: **the Threads user
        id is NOT the Instagram user id** (here `2786950…` vs `1784140…`). Using the IG id
        fails with `THApiException` code 100 *"Object with ID … does not exist"*, which reads
        like a bad token but isn't. `preflight` caught it before any publish attempt.
- [x] **Threads adapter (publish + metrics)** — third platform, registered in every platform
      registry (`clients._BASE_URLS`/`PLATFORM_CAPS`, `publisher._PUBLISHERS`/`_QUOTA_GATED`/
      `_QUOTA_READERS`, `preflight._CHECKS`, `metrics._FETCHERS`), each guarded by an assert
      against `SUPPORTED_PLATFORMS` so a platform can't be added to one registry and
      forgotten in another. No migration needed — `migrations/0008_platform_foundation.sql`
      (an earlier sub-project) had already widened `channels.platform` and `posts.post_type`
      to allow `'threads'` and `'text'`.
      - **Publishing:** container → publish on `https://graph.threads.net`, same shape as
        Instagram's flow but polling the container's **`status`** field (not IG's
        `status_code`). Three post types: **TEXT** (max 500 chars, no media — the only
        text-only format among the three platforms), **IMAGE**, and **CAROUSEL** (2–20
        children; Instagram's own cap is 10, unrelated).
      - **Quota:** Threads *is* gated at runtime, unlike Facebook — `GET
        /{threads-user-id}/threads_publishing_limit` (250 published posts / rolling 24h),
        read live before every publish, same pattern as Instagram's
        `content_publishing_limit`.
      - **Metrics:** `/{media-id}/insights`, configurable via `THREADS_INSIGHT_METRICS`
        (default `views,likes,replies,reposts,quotes`), handling both Threads'
        `total_value.value` envelope and IG/FB's `values[0].value` shape. Maps
        `views→impressions`, `likes→likes`, `replies→comments`, `reposts→shares`;
        **`quotes` is deliberately left unmapped** (no column — folding it into `shares`
        would inflate that number) and lives only in `raw_json`. `reach`/`saves` stay null,
        same gap as Facebook.
      - **Composer:** a **"Text only"** toggle hides the image area, shows a live character
        counter against the strictest limit among selected channels, and disables *and
        deselects* channels that can't publish text (Instagram, Facebook). Text posts can be
        saved to the library as drafts.
      - **Worker independently enforces every rule** — a text post aimed at Instagram fails
        terminally with a clear error even if it somehow reaches the database, it never
        silently drops the text or guesses at an image.
      - Full suite green (232 passing, dry-run-verified end to end); dashboard `tsc` clean.
      Setup guide: `docs/meta-setup.md#adding-a-threads-account`. Verified facts:
      `reference.md`.
      **Known limitation:** same as Facebook — autofill's "prefer top performers" ranking
      sums `reach + saves`, and Threads never provides either, so it scores every Threads
      post as 0 and recycling falls back to age/staleness order until the BPP work (Phase 6+
      backlog) revisits the ranking formula.
      **Version mismatch resolved:** Threads now resolves its API version independently via
      `clients._API_VERSIONS` / `config.threads_api_version` (env override
      `THREADS_API_VERSION`, default `v1.0`), instead of sharing the install-wide
      `META_GRAPH_VERSION`. `ClientRegistry` caches on the resolved `(base_url, version)`
      pair so Instagram/Facebook keep hitting the install's configured `v25.0` while Threads
      correctly hits `v1.0`. See `reference.md` for details.
- [x] ~~Real-post verification (owner, Threads) — PARKED 2026-07-24~~ **UNBLOCKED and DONE
      2026-07-25** — see the Threads real-post item above. The Meta-side plumbing this item
      was waiting on (Threads product added to the Meta app, Threads Login OAuth, long-lived
      token + the *Threads* user id) was all completed, and the first real post published.
- [~] Real-post verification (owner, Facebook) — **PARKED 2026-07-24**, to resume alongside other
      platform connections. Code is done, reviewed, merged and dry-run verified; what remains is
      Meta-side account plumbing only. State when parked:
      - **Blocker:** the Meta app (`Liparoto Social Scheduler`) does not offer
        `pages_manage_posts`. It only has the Instagram use case, so its permission list has the
        two read-only Page perms (`pages_show_list`, `pages_read_engagement`) plus
        `business_management`. **Fix:** App Dashboard → Dashboard → add/customize the
        **"Manage everything on your Page"** use case → Add `pages_manage_posts`. No App Review
        needed for one's own Page with the app in Development mode + admin role.
      - **Page available:** "Lectin Free Kitchen", id `369360343622084`, tasks include
        `CREATE_CONTENT` + `MANAGE` (full admin) — technically ready once the perm exists.
      - `me/accounts` returned only that one Page of ~9; re-grant with all Pages selected, or the
        rest are Business-portfolio-owned (different endpoint).
      - **Settled:** the Graph API cannot publish to a personal profile (hard platform limit
        since 2018 — `publish_actions`). Instagram's "also share to Facebook" crossposting is a
        first-party Accounts Center feature and does NOT imply API access to a profile. A Page is
        the only route; a Page need not be a business (Digital Creator etc. is fine).
      - Undecided: which Page the first real post targets.
- [x] **Discord + Telegram adapters (publish only) — DONE 2026-07-25.** Fourth and fifth
      platforms, registered in every platform registry (`clients._BASE_URLS`/
      `_API_VERSIONS`/`PLATFORM_CAPS`/`_CLIENT_FACTORIES`, `publisher._PUBLISHERS`/
      `_QUOTA_GATED`, `preflight._CHECKS`, `metrics._FETCHERS`), each guarded by an
      assert against `SUPPORTED_PLATFORMS`. No new tables —
      `migrations/0009_discord_telegram.sql` only widened `channels.platform`'s check
      constraint.
      - **Discord:** publish is a single POST to the webhook URL. Text is `content`
        (≤2000 chars); images go multipart as `payload_json` + `files[0]`...`files[9]`
        (≤10 attachments). The webhook URL is both address and secret, so a Discord
        channel has **no account id** — the dashboard asks for exactly one field.
      - **Telegram:** `sendMessage` / `sendPhoto` / `sendMediaGroup` under
        `api.telegram.org/bot{token}/...`. Text ≤4096 chars, but only **1024** once a
        photo is attached; albums are 2–10 items. Needs the bot token plus the channel
        (`@name` or numeric chat id).
      - **Neither platform opens the cloudflared tunnel** — both upload file bytes
        directly in the request, unlike Meta which must fetch a public URL
        (`PLATFORM_CAPS.uploads_media_bytes = True` for both).
      - **Neither platform has metrics or a publish-quota endpoint.** Their
        `metrics._FETCHERS` entry is explicitly `None` (not merely absent), and
        `publisher._QUOTA_GATED` is `False` for both — posted rows show no metrics
        strip, and auto-fill's "prefer top performers" ranking scores every
        Discord/Telegram post as 0, same standing gap as Facebook/Threads, until the
        BPP work below revisits the ranking formula.
      - **Preflight:** Discord does a read-only `GET` on the webhook URL; Telegram does
        `getMe` then `getChat` — the second is what catches "the bot isn't a channel
        admin," the mistake people actually make.
      - **Credential redaction:** all four Meta/Discord/Telegram clients now redact
        credentials from error text before it can reach `publications.last_error` (and
        therefore the dashboard) — the bot token and webhook URL both live in the
        request URL, so an un-redacted network error would otherwise have leaked them.
      - Full suite green (304 passing); dashboard `tsc` clean. Dry-run verified
        end-to-end (text/image/album, both platforms) against a **copy** of the real
        database — confirmed each reports `dry_run` with the right platform and post
        type, and that no tunnel opens; the copy was deleted afterward and the real
        database's row counts + `PRAGMA foreign_key_check` were confirmed unchanged
        before and after. Setup guide: `docs/other-platforms-setup.md` (linked from
        `docs/meta-setup.md` and `readme.md`). Verified facts: `reference.md`.
      - **Owner-gated follow-up:** a real post to each still needs the owner to create
        a Discord webhook URL and promote a Telegram bot to admin on a real channel —
        not attempted here, same pattern as the Facebook/Threads real-post items above.
      - **Known gap #1 — no delete-channel UI.** Removing a channel currently requires
        raw SQL; there's no dashboard control for it yet (pre-existing gap, not
        Discord/Telegram-specific, but noticed while adding these two).
      - **Known gap #2 — image aspect ratio.** ✅ **CLOSED 2026-07-25** (`d42d8ef`).
        Discord and Telegram were receiving the Instagram-conformed derivative
        (cropped/padded to 4:5–1.91:1) even though neither platform constrains aspect
        ratio. Fixed with `PlatformCaps.needs_conformed_media` (default `True`): the two
        unconstrained platforms now get the **untouched original** (`storage_path`)
        instead of `publish_path`. The caps flag is threaded through `_resolve_local_path`
        so `_validate` and `_build_plan` always agree on which file is being sent.
        Instagram, Facebook and Threads are unchanged. No "platform-native derivative"
        concept was needed after all.
- [x] Reels/video (async container, status polling, `video_url`) — see "Video + cover
      frames on Instagram Reels" below.
- [x] Stories — **verified live 2026-08-04** (`media_product_type: STORY`, see reference.md).
      A Story is a per-target SURFACE, not a post_type: `post_targets.surface` /
      `publications.surface` (+ `asset_id` for the slide). A multi-slide post fans out to one
      Story per slide at scheduling time. Composer, library scheduler, post editor and its
      sends panel all pick Feed/Story per Instagram channel; the Library has a Story badge and
      a Destination filter. Deferred: auto-fill story recycling, Facebook Page Stories.
- [x] **9:16 story canvas + framing you can see and change** — verified live 2026-08-04
      (`media_product_type: STORY`, a 1080×1920 blurred fill from a 3:4 source; confirmed
      by eye on the phone). assets gained story_path/story_mode; a Framing dialog shows
      both surfaces at a size where the options actually differ, states each option's cost
      from the real dimensions, and never stops offering the controls. Deferred: manual
      crop framing (sharp's `attention` picks the region — whether that is good enough is
      only answerable from real use) and video story canvases (needs a transcode, not a
      composite). Four Stories from one carousel verified live the same day —
      in slide order, which is the `ORDER BY scheduled_at, id` tie-break proven.
- [x] **Story insights** — `REQUESTED_STORY_METRICS` + a 24h auto-refresh cutoff, verified
      against the live API on the first real Story (no 400, `views: 6` recorded). The
      supported names were established by probing, not guessing: `taps_forward`/`taps_back`/
      `exits` are REJECTED, `navigation` and `views` replace them. See reference.md.
- [x] **First-comment automation** — VERIFIED LIVE 2026-08-06 on post 91: Instagram
      comment `18112425109948908` on media `17890533954412393` (`comments_count: 1`
      confirms it), and Threads reply `18614912674002589` under thread
      `17995486442803965`. `instagram_business_manage_comments` is therefore confirmed
      present on the live token — the read-only probe was right.
      Two things learned only from the live run: (1) Threads ate the leading `#` as the
      post's `topic_tag` (see reference.md — platform behaviour, not our bug); (2) the IG
      comments EDGE reads empty for a fresh comment even though `comments_count` is 1, so
      verify a comment by count, not by listing the edge.
      See `docs/plan-first-comment.md`. Until now the field was collected by
      the composer, stored, carried into the publish plan, and then never read by anything:
      no comment was ever posted, on any platform. Now:
      Instagram posts to the media's comment edge; Threads posts a self-reply
      (`reply_to_id`) since it has no comment edge; Facebook is written but UNVERIFIED
      (no FB channel to test against). The attempt happens strictly AFTER the publication
      is marked `posted`, and a comment failure can never downgrade a live post — it lands
      on `first_comment_status`/`first_comment_error` (migration 0017) and nowhere else.
      No automatic retry (a blind retry risks a second comment on a live post): retrying is
      an explicit dashboard action that sets `first_comment_retry_requested`, swept by the
      worker, cleared whether it succeeds or fails. The field is also editable AFTER
      creation now — before, only the composer could set it, so bulk-imported and extracted
      posts could never have one at all.
      Facebook remains the one unverified adapter (no FB channel on this install).
- [ ] Approval-workflow UI (activates the `requires_approval` flag).

### Verification
- [ ] Each adapter dry-run first, then one real post to a test account, before automation.

---

## Channel accent colour + original media on unconstrained platforms  `[x] done`
Plan: `docs/superpowers/plans/2026-07-25-channel-colour-and-original-media.md`
Two small, unrelated improvements shipped together.
- [x] Migration `0010`: nullable `channels.color_hue` INTEGER (0–360, an HSL **hue**, not a hex
      value) so `channelColor()`/`channelHue()` in `dashboard/lib/format.ts` keep guaranteeing
      contrast and dark-mode behaviour. `NULL` = "derive from the channel id, as before", so no
      existing channel changed appearance. Plain `ALTER TABLE` — none of `0008`/`0009`'s rebuild
      or cascade-delete risk. Routes validate null-or-0–360 before it reaches the DB.
- [x] Shared, keyboard-navigable `<ColorSwatchPicker>` (10 evenly-spaced hues + an explicit
      "Automatic" that stores NULL), in both the channel create form and a new edit control.
      Selection is never colour-only — every swatch has an accessible label, the active one gets
      a ring **and** a check mark. The chosen hue is threaded through *every* surface that renders
      a channel chip (Overview queue rail + publications table, Compose, Library, post editor,
      sends panel), not just the easiest ones.
- [x] Worker: `PlatformCaps.needs_conformed_media` → Discord/Telegram publish the original image.
      (See Phase 6's Known gap #2 above — this is what closed it.)

---

## "Post now" — publish without picking a date  `[x] done`
Designs/plans: `docs/superpowers/plans/2026-07-25-post-now.md` and `-post-now-from-library.md`
One behaviour to learn, available from all three places that create sends. Semantics everywhere:
`scheduled_at` = the current instant, status forced straight to `scheduled` (**approval bypassed**
— whoever is composing-and-publishing right now *is* the approver), and `post_now` wins over any
supplied date/time. The scheduled path is byte-identical to before and still honours
`requires_approval`, pinned by regression cases in both smoke scripts.
- [x] Server: `post_now: true` on `POST /api/posts` (new post) and on
      `POST /api/posts/[id]/schedule` (existing post). Every existing validation still applies
      under `post_now` — unknown channel, no channels, platform/post-type compatibility, carousel
      size, caption limit. It is not a hole around the rules.
- [x] UI: a Schedule / Post now toggle in the composer, the From-library picker, and the post
      editor's Add-a-send. Off by default; hides the date/time inputs when on (restoring any typed
      value if toggled back off). Shared `<PostNowReadinessNotice>` so all three surfaces show the
      same warnings.
- [x] **Honesty over instant gratification.** The three things that silently prevent a real post
      are surfaced *before* the click: `DRY_RUN` on, kill switch on, worker offline — **all**
      applicable warnings render, not the first one. The happy path says "within about a minute",
      not "instantly", because the worker polls. Neither condition disables the button.
- [x] Fixed a real trap found in review: readiness was read once at module load with parsing that
      disagreed with `worker/config.py`, so the composer could say "nothing will actually post"
      while the worker was live. `config.ts` now re-reads `.env` live (2s memo) and mirrors
      `_as_bool`'s allow-list and `override=True` precedence exactly.
- [x] Fixed a second trap: Post now publishes what's **saved**, so an unsaved caption edit could
      be silently discarded and the old text posted for real. `PostEditor` now blocks the Post-now
      submit while dirty. Scheduled sends are unaffected.
- [x] Verified: 324 worker tests; dashboard `tsc` clean; two smoke scripts driving the real routes
      against a scratch DB copy; browser-verified on all three surfaces; the live DB left exactly
      as found with `PRAGMA foreign_key_check` empty.

---

## Video + cover frames on Instagram Reels  `[x] done`
Design: `docs/superpowers/specs/2026-07-28-video-reels-covers-design.md` · Plan:
`docs/superpowers/plans/2026-07-28-video-reels-covers.md`
The Phase 6 "Reels/video" line item, plus a cover-frame capability video needs and images
don't. Ten tasks, dependency-ordered; unlike the FB/Threads/Discord/Telegram adapters this
was not purely mechanical — there was no video ingest path anywhere in the app to build on.
- [x] Video as a first-class asset type: migration `0011` adds `assets.duration_ms` /
      `cover_frame_ms` / `has_audio`. Purely additive — `assets.media_kind` and
      `posts.post_type` already permitted `'video'`/`'reel'`, so unlike `0008`/`0009` no
      CHECK-constraint table rebuild was needed.
- [x] Container header parsing **without ffmpeg** (`dashboard/lib/video-meta.ts`): reads
      `mvhd`/`tkhd`/`hdlr` directly out of the MP4/MOV box structure (~60 lines, no new
      dependency) for duration, width/height (tkhd rotation-matrix aware, so a portrait
      iPhone clip isn't misreported as landscape), and whether an audio track exists. An
      unparseable file is refused outright rather than accepted with unknown properties.
- [x] Reels spec validator (`dashboard/lib/video-spec.ts`): 300 MB max, 3s–15min duration,
      1920px max width, 0.01:1–10:1 aspect — verified against live Meta docs, not the
      widely-repeated wrong "4 GB / 90 seconds" numbers. Off-vertical aspect and no-audio
      are **warnings**, never refusals, since Instagram accepts and letterboxes a
      landscape Reel rather than rejecting it.
- [x] Upload route accepts MP4/MOV, sets a real `media_kind` instead of the old
      hardcoded `"image"`, skips image conforming/thumbnailing for video; `media/[id]`'s
      MIME map gains `mp4`/`mov` (without it the browser downloads the file instead of
      playing it, which breaks the cover scrubber outright since it's a `<video>` element
      pointed at that route).
- [x] Worker: `create_video_container` (REELS container, `video_url`, optional
      `thumb_offset`); `'reel'` added to `SUPPORTED_POST_TYPES` with a shape rule (exactly
      one asset, and it must be `media_kind='video'`); a Reels-specific poll budget
      (`REELS_STATUS_POLL_INTERVAL=10` × `REELS_STATUS_POLL_MAX_TRIES=90`, a 15-minute
      ceiling vs. the image path's 5 minutes) since video transcoding is materially
      slower than an image container; budget exhaustion is retryable, never terminal.
- [x] Cover-frame picker: a scrubber over a `<video>` bounded by `duration_ms`, saving a
      **millisecond offset** to `assets.cover_frame_ms` — never a generated image, since
      `thumb_offset` is all the Graph API needs and Meta extracts the frame itself. Reused
      by the composer and post editor; the same "decide once, remember per asset" pattern
      `conform_mode`/`needs_review` established for image framing, so evergreen recycling
      reuses the chosen cover automatically.
- [x] Composer support: video upload, the cover picker, and channel gating so a Reel only
      offers Instagram channels (`dashboard/lib/platforms.ts`'s `supportsVideo`).
- [x] **Live verification:** a real Reel published to the owner's own Instagram — media id
      `17983260633046217`, `media_product_type: REELS` confirmed by reading the API back
      rather than trusting our own DB, 60 seconds end to end, `thumb_offset` sent from a
      chosen cover frame. Full detail (exact numbers, moov-atom before/after,
      poll-budget headroom) is in `reference.md`'s "Verified: first real Reel published"
      section — not repeated here.
- [x] **Task 10 (this task) — auto-fill queues Reels.** `worker/autofill.py`'s candidate
      query widened to include `post_type='reel'` (`select_candidates`, one line, plus a
      new `worker/tests/test_autofill.py::test_reels_are_eligible_for_autofill`). Called
      out explicitly in the design as Decision 7, not an afterthought: leaving it out
      means a Reel is publishable but never auto-queued — it just silently never appears,
      with no error anywhere. Recycling evergreen demo footage is a primary goal for this
      owner, so this was a real hole, not a nicety.

### Decision 1 reversed by the first real file
The spec's Decision 1 was "validate and explain, never transcode" — reasoned from an
assumption that the owner's footage was *"mostly fine, occasionally not."* The first real
file run through the finished pipeline, an unedited iPhone camera clip, disproved that
assumption on contact: iPhone shoots **4K (2160×3840) by default**, over Instagram's
1920px width cap, so the case Decision 1 planned to refuse turned out to be the *normal*
case, not the exception. A scheduler that refuses most of what the owner actually films
is an obstacle, not a tool. That reversal became its own sub-project — **"Automatic video
conversion on upload,"** immediately below, with its own design spec and plan — this
entry doesn't repeat that detail.

### Deferred / known gaps
- **Threads video is not implemented**, even though Threads' real API supports
  `media_type=VIDEO`. `dashboard/lib/platforms.ts` hardcodes `supportsVideo: false` for
  every platform except Instagram — a real, scoped gap, not a structural blocker.
- **A real custom cover image via `cover_url` is not implemented.** Every Reel publishes
  with `thumb_offset` only. Meta's documented precedence is `cover_url` wins over
  `thumb_offset` when both are sent (see `reference.md`) — nothing here conflicts with
  adding it later.
- **No video playback controls in the library.** Video assets render as a
  `<video preload="metadata">` element for a first-frame/cover preview only, not a
  played-back clip with scrubbing/controls outside the dedicated cover picker.
- Stories, Facebook video, and video in bulk import (`/import` stays images-only) are all
  out of scope, per the design spec.
- **`PlatformCaps.post_types` was never generalised** (Decision 6). Each `_publish_*`
  function still ends in its own `else: raise _NonRetryable`, which already gives a
  correct, terminal, clearly-worded refusal for every platform that can't take a Reel —
  fine for one video-capable platform, worth revisiting only if a second one ever lands.
- **No delete-asset API exists** — a real, standing gap (same one Export & backup's
  section flagged for images): a stray test video asset created during verification
  cannot be removed through the app.
- **An in-spec HEVC video that never needs conversion is untested end to end.** Everything
  verified live went through the conversion path, which relocates `moov` to the front as
  a side effect and re-encodes to H.264. A file that's already ≤1920px/≤300MB/3–15min
  skips conversion entirely: per the known gap noted in `2a356e4`, it would have no
  H.264 derivative and would still **preview blank in Chrome** (HEVC is undecodable
  there), and it would publish with whatever `moov` position the camera actually wrote —
  the design spec's "Known risk: the moov atom" is closed for the conversion path only,
  not universally.

### Verification (all passed)
- [x] `.venv/bin/python -m pytest worker/tests -q` — 337 passed (336 before Task 10's
      autofill test, +1 after).
- [x] `cd dashboard && npx tsc --noEmit` — clean.
- [x] Live: one real Reel published end to end, detailed in `reference.md`.

---

## Automatic video conversion on upload  `[x] done`
Design/plan: `docs/superpowers/specs/2026-07-28-video-conversion-design.md` and
`docs/superpowers/plans/2026-07-28-video-conversion.md`

**This reverses Decision 1 of the Reels spec** ("validate and explain, never transcode").
That decision assumed the owner's footage was "mostly fine, occasionally not" — and the
first real file uploaded through the finished Reels pipeline, `IMG_3707.MOV`, disproved
it: a straight iPhone camera original, no edits, is **2160×3840**, over Instagram's
1920px width cap. iPhone records 4K **by default**, so the case the old design refused is
not the rare one — it's the normal one. A scheduler that rejects most of what the owner
actually films is an obstacle, not a tool.

Four tasks:
- [x] **Task 1 — split validation into fatal vs convertible**
      (`dashboard/lib/video-spec.ts`, `classifyReelErrors`). Duration is **fatal, never
      convertible** — trimming is an editorial decision (which seconds to cut) and the app
      must not make content choices on the owner's behalf. Width/size/container failures
      are convertible: re-encoding genuinely fixes them.
- [x] **Task 2 — the converter module** (`dashboard/lib/video-convert.ts`). Probes
      `avconvert` (ships with every Mac) → `ffmpeg` (PATH) → refuses conversion (never
      silently skips it). `execFile` with an array of args (no shell), a timeout that
      kills and cleans up a partial output, and a generous `maxBuffer` so a chatty
      converter can't spuriously fail an otherwise-successful conversion.
- [x] **Task 3 — convert on upload** (the video branch of
      `dashboard/app/api/assets/upload/route.ts`). Ordering is the point: fatal is checked
      **before** convertible so a 16-minute 4K video is refused for length without wasting
      a conversion attempt on a file that's getting rejected regardless. The derivative is
      re-validated after conversion — a still-too-wide or still-too-large output is refused,
      never silently published. Original stays at `storage_path`, untouched; only the
      derivative at `publish_path` is ever handed to Meta. Review follow-up fixed
      `public_url` pointing at the unpublishable original for converted video, image-only
      `ConformControl` rendering (and 500ing) on a converted video asset, a converter-name
      typo silently falling open, and a 422 body that leaked temp paths/command lines.
- [x] **Task 4 — tell the owner, and verify end to end.** The composer now renders
      `converted: { from, to }` next to the existing Reels warnings, in the same
      `bg-accent-weak`/`text-accent-strong` pill language as `conform-control.tsx`'s
      "Auto-cropped — review framing" notice: *"Converted to 1080×1920 so Instagram will
      accept it. Your original is untouched."* Browser-verified against the real 4K
      fixture: accepted (not refused), notice appears, cover scrubber bounded at the
      converted 7.6s duration and seeks correctly, and both the composer preview and the
      Library list thumbnail render the actual video (not a broken image) — see
      `reference.md`'s "Video conversion on upload" section for the measured before/after
      numbers, including that conversion also moved the `moov` atom to the front of the
      file.

### Verification (all passed)
- [x] `npx tsc --noEmit` clean.
- [x] `dashboard/scripts/smoke-video-convert-upload.mjs` — 4 scenarios (default converter,
      `VIDEO_CONVERTER=off`, forced-converter-failure, bad-output), all passing against the
      real 4K fixture where present.
- [x] Full `smoke-*.mjs` sweep — all pass except `smoke-content-model.mjs`'s pre-existing,
      unrelated `channels.color_hue` failure (confirmed byte-for-byte identical to a
      pre-implementation baseline, both before and after this sub-project).
- [x] `.venv/bin/python -m pytest worker/tests -q` — 336 passed (no worker file touched;
      `_resolve_url` already preferred `publish_path`, confirmed by reading it directly).
- [x] Browser-verified the whole flow with the dev server already running on :3939 (worker
      confirmed stopped first, so nothing could actually publish): dropped the real 4K
      `~/Downloads/IMG_3707.MOV`, confirmed acceptance + notice + scrubber + video
      rendering, then cleaned up through the app's own `DELETE /api/posts/[id]` (no raw
      SQL) — posts 2→1, post_assets 2→1, publications unchanged at 3,
      `PRAGMA foreign_key_check` empty both before and after. The one converted video
      asset row (no delete API exists for assets) is left in place, orphaned but harmless,
      alongside the pre-existing test assets from earlier sub-projects.

**Deferred:** no worker change (the design's premise that `_resolve_url` already prefers
`publish_path` held — verified, not assumed). Facebook Pages/Stories video and an
asset-delete API remain out of scope, as before.

---

## Media page — browse + delete assets (2026-07-29) — COMPLETE

Closes the "no delete API exists for assets" gap noted directly above, which had blocked
cleanup twice. Spec: `docs/superpowers/specs/2026-07-29-media-page-design.md`.
Plan: `docs/superpowers/plans/2026-07-29-media-page.md`.

- [x] **Task 1 — read-only `/media` page.** `listAssetsWithUsage()` replaces the never-called
      `recentAssets()`; grid shows thumbnail, size, dimensions/duration, and which post uses
      each asset. Sidebar entry added. No schema change, no new dependency.
- [x] **Task 2 — `DELETE /api/assets/:id`.** Guard lives ON the `DELETE` statement so it can't
      race a compose; a caught `SQLITE_CONSTRAINT*` lets any FK veto, including the
      `assets.cover_asset_id` that exists on the `custom-cover-image` branch but not here.
      Row first, then files; every path verified to resolve inside the asset store before
      unlinking. 200 / 404 / 409.
- [x] **Task 3 — delete button + confirm dialog.** Used assets get no button at all (absent,
      not disabled). Confirm names the file and size and states that it's permanent.
- [x] Verified: 409 + rows intact for both in-use assets; real deletes remove row, original,
      and `pub/` derivative; the ENOENT branch exercised for real by an asset whose
      `thumbnail_path` pointed at a `thumbs/` directory that doesn't exist; Cancel leaves
      everything untouched; no orphaned files left in the store.
- [x] `pytest -q` — 290 passed, no worker file touched. **The other 49 tests cannot run:**
      `openpyxl` is missing from the venv AND undeclared in `worker/requirements.txt`, so
      `test_export_main.py` / `test_export_write.py` fail at collection. Pre-existing and
      unrelated to this work, but it means a fresh clone's export would crash — tracked
      separately.

**Note (2026-07-29) — cause uncertain:** during Task 3 verification, asset 2
(`20250827_1442_video.mp4`, 22.3 MB, unused) disappeared between two checks. It was slated
for deletion by the approved plan either way, so nothing was lost that wasn't going. The
owner says they deleted it themselves; an automated coordinate-click at roughly the same
moment is the other candidate and cannot be ruled out. **The record says "unknown" rather
than guessing** — the earlier version of this entry asserted the automation did it and that
the browser tool auto-accepted the `confirm()` dialog, neither of which was ever proven.

The practice that came out of it stands on its own merits: **verify destructive controls
with Playwright and explicit `browser_handle_dialog`, not coordinate clicks.** Playwright
pauses on the dialog and reports its text, so the wording gets verified too, and clicks
target CSS selectors rather than coordinates that a media-heavy grid invalidates on reflow.

**Deliberately out of scope:** bulk/multi-select delete, a trash/undo flow, force-deleting a
used asset, thumbnail backfill for assets that have none. Two unused personal files
(`IMG_3707_1080.mov`, the Malaya photo) were kept at the owner's direction.

- [ ] **Follow-up:** when migration `0016_cover_asset.sql` (the `custom-cover-image` branch;
      renumbered from `0012` once main shipped its own 0012–0015)
      merges to main, `listAssetsWithUsage()` must learn about `assets.cover_asset_id`. Until
      it does, a Reels cover image has no `post_assets` row, so `/media` will show it as
      "Unused" with a Delete button and count its bytes in the reclaim total. The delete
      itself is safe — the foreign key rejects it — but the page's "unused" figure would
      overstate.

---

## Merge posts into a carousel (2026-07-30)

**Design:** `docs/design-merge-into-carousel.md` · **Plan:** `docs/plan-merge-into-carousel.md`

Select 2+ draft posts in the Library, review the slide order, and merge them into one carousel
draft. Motivated by the bulk import creating one draft per photo: 135 of 147 drafts were single
images, many of them really slides of the same carousel.

- [x] **Task 1 — test harness.** The dashboard had NO tests (the worker has 34 pytest files).
      Added one with **zero new dependencies**: Node 23 runs TypeScript natively and ships
      `node --test`. Needs three things — `--conditions=react-server` (because `lib/db.ts`
      imports `server-only`, which throws in plain Node), a 12-line `node:module` resolver hook
      (Node's ESM resolver won't resolve the extensionless `./db` that Next's bundler does), and
      `DATABASE_PATH` pointed at a temp DB built by `migrate.py`. Run it: `cd dashboard && npm test`.
- [x] **Task 2 — `lib/merge-plan.ts`.** Pure guards + slide ordering, imports nothing but
      `./platforms`, so every rejection path is testable without SQLite.
- [x] **Task 3 — `mergePostsIntoCarousel`.** One `.immediate()` transaction. Rebuilds the
      `post_assets` rows on the survivor *before* deleting the emptied posts, and sets
      `post_type` to match the resulting slide count (`carousel` for 2+, `single` for exactly 1).
- [x] **Task 4 — `POST /api/posts/merge`.** Thin passthrough; all guards live below it.
- [x] **Task 5 — extracted `components/slide-reorder.tsx`** from the composer so the merge modal
      reuses the one drag/keyboard reorder implementation instead of copying it.
- [x] **Task 6 — merge modal + Library bulk action**, including the two owner decisions below.
- [x] **Task 7 — end-to-end verified** through the real UI with Playwright.

**Two traps this feature exists around, both worth remembering:**
1. **`posts.post_type` is frozen at write time** and only re-validated by the Python worker at
   publish. A merge that moved assets but forgot `post_type` would look perfectly correct in the
   dashboard and then fail at send with `carousel needs 2-10 assets, has 1`. This is why the
   transaction sets it, and why there is a dedicated test.
2. **`UNIQUE (post_id, sort_order)` is checked per-row and immediately.** Renumbering in place
   collides with itself. The transaction deletes the involved join rows and rebuilds them — a
   join row carries nothing worth preserving.

**Owner decisions (2026-07-30):**
- **Scheduled sends are warned about, not silently destroyed.** Merging deletes non-survivor
  drafts, which cascade-deletes their `scheduled`/`pending_approval` publications. The modal
  says "N of these has a scheduled send that will be canceled" — and correctly stays silent when
  the only queued post is the *survivor*, whose sends are untouched.
- **"No caption" genuinely clears.** `caption: null` and `""` behave identically and wipe both
  `posts.caption` and all `caption_variants`. There is no "leave it alone" value.

**Verification note:** the end-to-end run used throwaway drafts created for the purpose, then
deleted — the owner's real content was never merged. Database confirmed byte-identical to the
pre-work backup afterward (149 posts / 166 assets / 4 publications / 166 post_assets). Per the
Media-page incident above, all destructive UI was driven with Playwright, never the in-app browser.

**Deliberately out of scope:** splitting a carousel back into singles, reordering an existing
carousel outside a merge, merging from the Media page.

- [ ] **Follow-up (pre-existing, unrelated to merge):** `createDraftPost` derives `post_type`
      from asset count alone and ignores `media_kind`, so a single *video* saved as a draft
      becomes `single` rather than `reel` — which the worker then refuses to publish. Confirmed
      live 2026-07-30.
- [x] **FIXED 2026-08-05 — publish-in-flight race: merge could cascade-delete a publication the worker was actively sending.** The worker fetches `status='scheduled'` publications, loads the post and assets into Python memory, does an HTTP quota check, and only *then* writes `'publishing'` to the database. During that window the row still reads `scheduled`, so the merge's guard (which blocks `posted`/`publishing`) lets it through. The merge deletes the post, CASCADE removes the publication, and the worker's later status writes silently update 0 rows. Outcome: a real Instagram post exists with no database record, and the same photo sits in the merged carousel ready to post a second time. Pre-existing — `deletePost` has the identical guard — but merging widens the exposure because the merge modal explicitly invites merging posts that have queued sends. **Fix is worker-side:** claim the publication row conditionally before loading it — `UPDATE publications SET status='publishing' WHERE id=? AND status='scheduled'` — and abort if it updates 0 rows. The dashboard's `.immediate()` transaction cannot help because the worker is not writing during the window; it is holding state in memory.
      **Resolution:** `db.claim_publication()` does exactly that conditional UPDATE, and `publish_one` now calls it as step 0, before loading anything. A dry run deliberately does not claim. Pinned by `worker/tests/test_publish_claim.py`, including a test that asserts the row already reads `publishing` *during* the quota check — the RED run of that test showed `scheduled`, which is the race itself. The same claim closes the two-daemon double-publish hole, since only one caller can win the row.
- [ ] **Follow-up created by that fix — a crash between the claim and the publish strands the row at `publishing`.** `fetch_due_publications` only selects `scheduled`, so a stranded row is never retried. This was already possible (the old code also wrote `publishing` before publishing) but claiming earlier widens the window by the load + validate + quota-check duration, and the auto-stop watchdog kills the worker on a timer. A reaper that resets stale `publishing` rows is the obvious fix but is **not safe to write naively**: a Reel legitimately sits in `publishing` for up to 15 minutes while Meta transcodes, so a too-eager reset would double-publish the very thing this claim prevents. Needs a heartbeat or an explicit claim timestamp, not just `updated_at` age.
- [ ] **Follow-up — spec gap: caption-length guard never implemented.** The design doc's §5 lists a `captionLimitError` guard (reusing the per-post-type limit from `lib/caption-limits.ts`) that was never implemented — `planMerge` never receives the caption at all, so the check cannot run. Only reachable if someone merges posts with a caption that exceeds the `carousel` limit (where `single` captions were within bounds). The worker re-validates at publish and fails visibly at send rather than silently, so it surfaces eventually; low priority but the design doc currently overstates what ships.

---

## Phase 7 — Channel groups (coordinated auto-fill)  `[x] done — LIVE since 2026-07-31`

Spec: `docs/superpowers/specs/2026-07-30-channel-groups-design.md`.
Plan: `docs/superpowers/plans/2026-07-30-channel-groups.md`.

**The problem:** auto-fill ran per channel in isolation, so an Instagram channel and a Threads
channel representing the same account picked different content on different days. There was no
way to say "these two are one voice."

**The rule the design hinges on.** A post is group-eligible when at least one member is capable
AND allowed, and every member that is *capable* is also *allowed*:
- A **capability** miss (Threads cannot take video; Threads caps captions at 500 chars) makes
  only that member sit the slot out. Without this carve-out, grouping would have silently ended
  evergreen Reel recycling — see `PLATFORM_CAPS` in `worker/clients.py`.
- A **rule** miss (targeting, cooldown, one-time, blackout period, already queued) blocks the
  whole group, so members never drift apart on content they could both have taken.

### Implementation
- [x] `migrations/0013_channel_groups.sql`: `channel_groups` table + nullable `channels.group_id`
      with `ON DELETE SET NULL` (deleting a group returns members to solo, never cascades into
      publications). Purely additive — every existing channel defaults to ungrouped.
- [x] `worker/autofill.py`: capability split out from rules (`capable_post_ids`), group selection
      (`group_eligible_candidates`, `group_rank`), and `run_autofill` restructured to iterate
      **units** — a group with its active members, or a single ungrouped channel. Solo channels
      take the unchanged code path. Group ranking uses the **max** performance across members,
      never the sum (Threads reports no reach/saves, so summing would scramble IG's ordering).
      Group queue depth counts distinct slots; solo keeps counting rows.
- [x] Group fill is atomic: the insert loop rolls back and re-raises, so a mid-group failure can
      never persist a half-queued group. This was a review finding, reproduced empirically —
      `run.py` reuses the connection after catching, and the next cycle's heartbeat commit would
      otherwise have swept up the partial work.
- [x] Dashboard: `ChannelGroup` type + queries, `/api/channel-groups` CRUD + timezone route,
      Groups section on the Channels page, group membership picker per channel.
- [x] A grouped channel's own timezone picker is hidden and its channel-level timezone route
      returns 400 — changing one member's zone would desync the pair.

### Verification (all passed)
- [x] 405 worker tests, 63 dashboard tests, `npx tsc --noEmit` clean.
- [x] Two review findings were **vacuous tests** — they passed whether or not the code was right
      (MAX-vs-SUM ranking, and the guard against double-filling a grouped channel). Both were
      rewritten to discriminate and re-verified by mutation. Worth remembering as a review habit.
- [x] **Live-data run against a byte-exact copy of the real DB** (2026-07-30), real channels and
      real content, live install never touched: post 67 queued to Instagram **and** Threads at an
      identical `scheduled_at`; the Reel (post 2) queued to **Instagram alone** while Threads sat
      the slot out; post 1, targeted at Instagram only, was skipped entirely rather than posted to
      one member; a second run added nothing. Slot resolved to 18:00 America/Los_Angeles.

### Live configuration (as of 2026-07-31)
Group **"Liparoto Meta"** — Instagram + Threads (both `Liparoto`), `America/Los_Angeles`,
auto-fill on, every day at 18:00, refill below 2, fill to 7, reuse after 90 days.
First real mirrored slot: 2026-07-31 18:00 PDT. 14 publications across 7 slots, every slot
carrying both members at an identical `scheduled_at`. `KILL_SWITCH=1` is the stop.

**Gotcha that cost an hour:** enabling the group changed nothing at first. The worker daemon
had been running since before this code existed, and Python holds the modules it loaded at
startup — so it was polling happily against the OLD per-channel autofill, which finds nothing
because a grouped channel's own `autofill_enabled` is 0. **Restart the worker after any change
to worker code.** A live heartbeat proves the daemon is alive, not that it is running current code.

- [ ] **Before first real use:** only 3 of 139 posts are `content_status='ready'`, and posts 1 and
      2 target Instagram only. Since targeting is a *rule*, any post not targeted at **every**
      member is invisible to the group. Retarget before expecting a full queue — and note
      `POST /api/posts/targets/bulk` returns 400 on the first over-caption-limit post and abandons
      the whole batch, so a mixed set cannot be bulk-retargeted in one go.
- [ ] **Follow-up — grouped channels keep their own `channels.timezone`,** which the *manual*
      scheduling paths still read. A channel card can therefore truthfully show a zone different
      from the group's auto-fill zone. Not a defect; a decision left open.
- [ ] **Follow-up — `worker/export/collect.py` was not extended:** `channel_groups` is not
      collected and `group_id` is not in the channel allow-list, so a portable backup silently
      loses all group configuration. The allow-list exists to keep credentials out, so omitting it
      is defensible — but nobody decided it.

---

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
### Library workflow (owner-requested 2026-08-02) — each specced separately
Four independent sub-projects, each with its own design + plan. Related but separately
shippable; suggested order is the order listed. Only #2 carries a blocking decision.
| # | Sub-project | Design | Plan |
|---|---|---|---|
| 1 | Bulk edit | `specs/2026-08-02-library-bulk-edit-design.md` | `plans/2026-08-02-library-bulk-edit.md` |
| 2 | Period visibility | `specs/2026-08-02-library-period-visibility-design.md` | `plans/2026-08-02-library-period-visibility.md` |
| 3 | Quick edit | `specs/2026-08-02-library-quick-edit-design.md` | `plans/2026-08-02-library-quick-edit.md` |
| 4 | Media → post links | `specs/2026-08-02-media-post-links-design.md` | `plans/2026-08-02-media-post-links.md` |

✅ **#2 timezone decision (owner-approved 2026-08-03):** the Library badge uses
`DEFAULT_TIMEZONE`, names the evaluation date and timezone in its advisory tooltip, and explains
that the worker remains authoritative in each target channel's timezone.

- [x] **Bulk edit in the Library — tags, periods, status, kind** (owner-requested 2026-08-02).
      The Library already has everything needed structurally: an **ordered multi-select**
      (`selected` in `dashboard/components/library-view.tsx`) and a bulk action bar. What's
      missing is that only *three* bulk actions were ever wired to it — bulk-schedule
      (`/api/posts/bulk`), bulk re-target (`/api/posts/targets/bulk`), and merge-into-carousel.
      Everything else is still one post at a time through `/library/[id]`.
      **Wanted, at minimum:** bulk add/remove **topic tags**, bulk attach/detach **periods**
      (green *and* blackout), bulk **content_status** (draft→ready is the big one), bulk
      **content_kind**, and bulk **cooldown_days**.
      **Why it's real, not a nicety:** this backlog already carries the evidence.
      (a) The "before first real use" note above says *only 3 of 139 posts are
      `content_status='ready'`* — promoting the rest is a 136-click job today.
      (b) Marking the 36 football posts to Football Season on 2026-08-02 had to be done in raw
      SQL against the live DB, because the UI offers no way to do it. That's the owner reaching
      past the app to get routine work done, which is the signal the feature is missing.
      **Design notes for whoever picks this up:**
      - Follow `/api/posts/targets/bulk`'s **add/remove verb** shape, not a set/replace shape.
        Replace semantics on a multi-select would silently wipe tags the other selected posts
        had — destructive and invisible. Add/remove is idempotent and safe to re-run.
      - **Validate the whole batch before writing any of it**, the way `/api/posts/bulk-import`
        does (it validates ≤100 items fully, so any 400 creates zero rows). Note the existing
        counter-example flagged above: `POST /api/posts/targets/bulk` *"returns 400 on the first
        over-caption-limit post and abandons the whole batch"* — a partially-applied bulk edit.
        Don't copy that; wrap the writes in one transaction.
      - Tags/periods/status are pure local metadata — **no publishing risk, no Meta call, no
        worker interaction**. That makes this a genuinely low-risk feature and a good candidate
        to ship before the two heavier items above it.
      - Consider the same bar on the `/import` page's batch-defaults panel, which already proves
        the interaction pattern for applying shared metadata to many posts at once.
      - Worth a confirm step showing "apply X to N posts" — at 36+ posts a misclick is expensive
        to undo by hand.
- [x] **Period visibility in the Library — names, a filter, and an in-season indicator**
      (owner-requested 2026-08-02). Three related asks; periods are currently near-invisible
      outside the single-post editor. Natural companion to the bulk-edit item above — do the
      filter first and bulk-editing a season becomes "filter to it, select all, apply."
      - **(a) Show *which* periods, not how many.** `listPosts` in `dashboard/lib/queries.ts`
        only computes `green_period_count` / `blackout_period_count` via a `COUNT(...)`
        subquery, so `library-view.tsx` can only render `green ×2` — the **names never leave
        the database**. A post says it has two green periods and gives the owner no way to
        learn what they are without opening it. `getPostPeriods` already returns the real rows
        per post; the library list query needs the equivalent (a `GROUP_CONCAT` or a second
        batched query keyed by post id — avoid N+1 across 139 posts).
      - **(b) Multi-select period filter.** Same AND-combined pattern as the existing
        tag/platform/status/kind chips in the Library. Should cover green *and* blackout
        (filtering to "what's blacked out during X" is as useful as the inverse).
      - **(c) In-season / green-lit indicator.** The owner's example: a `ready` post attached
        to Football Season should read as **dormant** in August and **live** once the season
        opens — right now `ready` looks identical either way, which is misleading, since
        `content_status='ready'` and *actually eligible today* are orthogonal.
      **⚠️ The hard part is (c), and it is not a UI task.** The season math exists **only in
      Python** — `worker/periods.py`'s `period_contains` + `in_season`. There is no TypeScript
      equivalent anywhere in `dashboard/lib/`. So this needs a port, and a wrong port produces
      the worst possible outcome: **the dashboard says "green lit" while the worker skips the
      post**, or vice versa. Four rules that must survive the port —
      - **Wrap-around years.** Football Season is Aug 25 → Feb 15, i.e. `start > end`. The
        Python uses a `month*100+day` key and flips to `cur >= start or cur <= end` when the
        window crosses New Year. Naive date comparison silently breaks every winter season.
      - **Blackout beats green**, always — it is checked first and short-circuits.
      - **No green periods means always in season.** The rule is *"if green periods exist, one
        must contain today"* — so an unattached post is eligible, not ineligible. Easy to
        invert by accident, and it would mislabel most of the library.
      - **One-off periods** use `start_date`/`end_date` ISO strings, not month/day.
      **Open design question — which timezone does the badge use?** `in_season` is evaluated
      against a **local date in the channel's timezone**, and a post can target several
      channels in different zones (this install genuinely mixes `America/Los_Angeles` and
      `America/New_York`), so a post can be in-season for one target and not another on the
      boundary day. A single library badge cannot be per-channel. Decide deliberately: install
      default timezone, or a per-target breakdown on the post editor and a
      "somewhere/everywhere" summary on the card. Don't let this get picked by accident.
      **Recommended:** rather than reimplement, consider having the *worker* be the only place
      this math lives and expose the verdict — but note it currently has no API surface (the DB
      is the contract, by design), so a TS port is the likely answer. If ported, port the
      Python unit tests alongside it so the two implementations are pinned to the same cases.
- [x] **Quick-edit modal in the Library** (owner-requested 2026-08-02, shipped 2026-08-03).
      `quick-edit-modal.tsx` + an Edit button on each card; saves through the existing
      `PATCH /api/posts/[id]/content`, no new endpoint and no migration. Editing one field
      used to mean a full navigation to `/library/[id]` and back, which is why routine
      cleanup felt heavy; the dialog now covers the common fields without leaving the page.
      Scope shipped: `content_status`, `content_kind`, `cooldown_days`, tags, periods —
      captions, images, targets and sends stayed out, as planned below.
      - **No new API needed.** `PATCH /api/posts/[id]/content` already accepts exactly this
        set, and `<PostEditor>` already composes `<TagEditor>` / `<PeriodAttach>` /
        `<CaptionVariantsEditor>`. This is a repackaging job, not new plumbing.
      - **Suggested scope:** `content_status`, `content_kind`, `cooldown_days`, tags, periods.
        These are safe scalars with no publishing side effects.
      - **Leave out** images, scheduled sends, and targets — those have real consequences and
        already have considered UI in the full editor. A modal is the wrong place for them.
      - **Captions are the judgement call.** They're `1..N` variants (generic + per-platform),
        so "edit the caption" is ambiguous when several exist. Either show the generic variant
        only and defer the rest to the full editor, or leave captions out of v1.
      - **⚠️ Dirty-state trap, already paid for once.** The Post-now work records that a post
        publishes what is **saved**, so an unsaved edit can be silently discarded and stale
        text posted for real — `PostEditor` had to block Post-now while dirty. A modal makes
        this *easier* to hit (click-outside, Esc, card scroll all dismiss). Decide the
        behaviour explicitly: confirm-on-dismiss, or save-then-close. Never silently drop.
      - **DECIDED 2026-08-03 — confirm-on-dismiss.** Cancel, the ✕, Esc and click-outside all
        ask *"Discard changes?"* while the dialog differs from what it opened with; a clean
        dismissal closes silently, so there's no friction when nothing is at stake. Esc while
        that prompt is up means *keep editing* — Esc never destroys. Save-then-close was
        rejected: a stray Esc would write to the DB with no way to back out, and a save that
        fails once the dialog is gone has nowhere to report itself. The reasoning is repeated
        in `quick-edit-modal.tsx`'s header so it doesn't have to be re-derived.
      - After saving, refresh the card in place — a modal that forces a full reload defeats the
        point. Pairs naturally with the bulk-edit item: same fields, one post vs. many.
- [ ] **Media page → the post, properly** (owner-requested 2026-08-02). A link *does* already
      exist (`media-manager.tsx` renders "In post #N" → `/library/[id]`), so the gap is that
      it's too weak to be useful, not that it's absent:
      - **Reused media dead-ends.** `listAssetsWithUsage` returns `MIN(pa.post_id)` as
        `first_post_id` — the **lowest-numbered** post, chosen arbitrarily, not the most
        relevant. Every other post is collapsed into the plain text `+N more`, which is **not
        a link and not reachable**. For an asset reused across posts — the normal case for
        evergreen recycling — most of its posts simply cannot be navigated to.
      - **"post #47" carries no information.** A bare id gives nothing to recognise the post
        by. Show the caption's first line and/or a thumbnail so it's identifiable at a glance.
      - **Fix shape:** return the full set of `(post_id, caption, status)` per asset rather
        than one `MIN()` id, and render each as a link (a small popover if the list is long).
        Watch for N+1 across the whole asset store — batch it, the way the period-names query
        above will need to.

---

## Carousel reorder + lightbox swipe (2026-08-03)  `[x] done`

**Design:** `docs/design-carousel-reorder-and-swipe.md` · **Plan:**
`docs/superpowers/plans/2026-08-03-carousel-reorder-and-swipe.md`

The merge-into-carousel item above explicitly left "reordering an existing carousel outside a
merge" out of scope. This closes that gap and adds a matching read side: an owner can now
**reorder an existing carousel's slides** from the post detail page *and* from the Library
quick-edit dialog, and the Library shows carousels as a **stack with a count chip** instead of
just the cover image. A new **lightbox** browses every slide of a post — arrows, on-screen
prev/next buttons, touch/trackpad swipe, and a `N / total` counter — from both the post detail
page and the Library.

**No schema migration and no worker change.** `post_assets.sort_order` already existed and
`worker/db.py::get_ordered_assets` already reads it at publish time — this branch is dashboard-only.

**One write path.** `GET` / `PATCH /api/posts/[id]/assets`. The `PATCH` accepts **only a
permutation** of the post's current slide ids — it can reorder, never add, remove, or swap in a
different asset. That constraint is what keeps the frozen `posts.post_type` invariant (see the
merge-feature traps above) correct *by construction*: since the slide count can't change, the
post type the write path was frozen at can't go stale.

**Guard:** a `PATCH` is refused with `409` only while a target's publication is actually
`publishing` — queued (`scheduled`/`pending_approval`) and already-`posted` sends are allowed,
with the UI warning the owner about queued ones before they save.

- [x] Post detail page: all slides shown (removed the old `slice(0, 4)` truncation that hid
      carousels past 4 images), drag/keyboard reorder, Save/Reset disabled until dirty, Reset
      reverts and re-disables.
- [x] Library quick-edit dialog: same reorder UI, resynced after its async asset fetch so it
      doesn't render a stale slide order (the `useAssetOrder` fix).
- [x] Library card: carousels render as a stack (layered thumbnails) with a count chip; adds
      **zero** extra image requests — the stack layers reuse the cover image.
- [x] Lightbox: opens on the full-size image (not the thumbnail variant), arrows/buttons/swipe
      move between slides, clamps at both ends (does not wrap), Escape closes and restores body
      scroll and focus, single-image posts get a bare Close button with no counter or arrows.

**Verification.** `npm test` (26 test-ui + 197 lib/test), `tsc --noEmit`, and `npm run build`
all green; `npm run lint` sits at the same 15 pre-existing problems the branch started with
(12 errors, 3 warnings), none added. Full interaction path re-verified live against the :3939
dev server with Playwright: lightbox counter and clamping, focus return, single-image posts,
detail-page truncation fix, a save-then-hard-reload-then-restore round trip that left the
owner's real data exactly as it started, and an exact count of 36 stack chips for 36 carousels
with 110 `<img>` tags across 109 cards (confirming the stack adds no image requests). A
stack-sizing bug (layers stretching to full card height) was caught in this pass and fixed in
commit `a927704`; re-measured afterward at exactly 64×64 with the layers offset +6/+6 and +2/+2.

**Two verification gaps, left open deliberately:**
- **The worker's `DRY_RUN` publish-order check was not run live.** The owner's install publishes
  for real (`DRY_RUN=0`) and is asleep; flipping `DRY_RUN` in the live `.env` and restoring it
  unattended risks leaving the install silently stuck in dry-run. Publish-order-after-reorder is
  instead covered by `lib/queries.reorder.test.ts` ("getPostAssets reads back in the new order")
  and by the fact that `worker/db.py::get_ordered_assets` — unmodified by this branch — already
  sorts by `sort_order` at publish time.
- **The dashboard's rendering of a live `409` was not exercised in the browser.**
  `test/assets-order-route.test.ts` proves the guard itself against a real migrated SQLite
  database (a `publishing` publication → `409`, order left untouched), but nobody watched the
  Save button actually surface the "being published right now" message on screen.

**Deferred (spec §9), not lost:**
- [ ] **Adding or removing slides on an existing post.** This branch only reorders a fixed set
      of slides — it deliberately never changes which assets belong to the post. Add/remove
      moves `posts.post_type`, has to re-run platform compatibility, and needs the conform
      pipeline for any newly uploaded asset. Merge-into-carousel covers the "assemble a carousel
      from scratch" case today; there is still no way to add one more photo to an existing
      carousel or drop one slide from it without rebuilding the post.
- [ ] **Reordering from inside the lightbox.** Considered and rejected during design: the
      lightbox is a read-only viewer shared by three screens, and giving it a save state would
      turn it into a write surface with its own dirty/discard handling duplicated across all
      three. Recorded here so it isn't re-proposed without re-litigating that trade-off.

**Also noted during review, not fixed here:**
- `npm run lint` carries 15 pre-existing problems (mostly `react-hooks/set-state-in-effect`)
  that predate this branch — worth a dedicated cleanup pass sometime.
- The dashboard's UI test suite renders with `renderToStaticMarkup`, which strips event handlers
  and can't measure layout. Both the stack-sizing bug and the entire lightbox interaction path
  were only catchable in a real browser because of this. If this area of the UI keeps growing, a
  jsdom-based suite would start paying for itself.

---

## Custom Reels cover image (2026-07-29, rebased and finished 2026-08-04)  `[x] done — not yet merged to main`

**Design:** `docs/superpowers/specs/2026-07-29-custom-cover-image-design.md` · **Plan:**
`docs/superpowers/plans/2026-07-29-custom-cover-image.md`

The cover-frame picker could only choose a moment that already existed in the footage. This
adds the other half the owner asked for: **upload a real image as a Reel's cover** — a title
card, a branded frame, a better photo. Instagram supports it natively via `cover_url`, so this
is plumbing rather than invention.

**The trap the whole design exists to avoid.** 9:16 is 0.5625, and the existing image pipeline
conforms uploads to the *feed* range of 0.8–1.91. A cover pushed through the normal upload path
would be cropped to 0.8, mangling exactly the framing the owner chose, silently.
`dashboard/lib/conform-cover.ts` is therefore a **separate** conform: sRGB JPEG stepped under
8 MB, aspect ratio **never touched**, warning instead when the ratio isn't near 9:16. Meta
center-crops a non-9:16 cover itself, and it is better to let the platform do that visibly than
to crop locally and pretend the result was chosen.

**One choice, not two fighting controls.** Meta's precedence is fixed — `cover_url` wins and
`thumb_offset` is ignored — so the picker shows a single Frame/Image toggle, and
`_build_plan` resolves it to exactly one field in the plan rather than sending both and leaning
on Meta's behaviour. Setting an image leaves `cover_frame_ms` untouched and marks the scrubber
as overridden rather than hiding it, so removing the image restores the previously chosen frame.

- [x] `migrations/0016_cover_asset.sql` — `assets.cover_asset_id`, nullable, additive.
- [x] `dashboard/lib/conform-cover.ts` + `setAssetCoverImage()` + `Asset.cover_asset_id`.
- [x] `POST`/`DELETE /api/assets/[id]/cover-image` — conform, content-hash dedup, link/unlink.
      `DELETE` unlinks only; it never deletes the asset row, since dedup means another post may
      reference the same bytes.
- [x] Worker: `create_video_container` gains `cover_url`; `_build_plan` carries `cover_url` **or**
      `cover_frame_ms`, never both; a dangling `cover_asset_id` falls back rather than raising.
- [x] `_resolve_rel` gains a **`cover` surface** resolving to `storage_path`, never `publish_path`
      — see traps below.
- [x] Frame-or-Image toggle in `cover-frame-picker.tsx`, with preview, Remove, and the ratio
      warning surfaced.

**Traps this exposed.**

1. **Migration renumbering breaks installs that already applied it.** Authored as `0012` while
   main was at `0011`; main then shipped its own 0012–0015. `schema_migrations` is keyed by
   **filename**, so renaming to `0016` made it look pending again and fail with `duplicate
   column name`. Fresh clones are unaffected; the owner's install needed a one-time
   `UPDATE schema_migrations SET version=...`. Documented in the migration header.
2. **A surface-aware `_resolve_rel` silently broke the cover.** The Stories work made
   `_resolve_rel` prefer `publish_path` for the `feed` surface. The cover resolution was still
   taking that default, so a cover row that *had* a `publish_path` would have published the
   **feed-cropped** derivative — the exact mangling this feature exists to prevent. Cover rows
   normally have `publish_path` NULL, but content-hash dedup can return a row that was also
   uploaded as a feed image, so correctness must not depend on that.
3. **`DRY_RUN=1` on the command line does nothing.** `worker/run.py` calls
   `load_env(override=True)` every loop so `.env` can be toggled live — which means `.env`'s
   `DRY_RUN=0` **overwrites** the environment variable you passed. An attempted dry run made
   real Graph API calls and created a live container; nothing published only because the
   container errored first. `DATABASE_PATH=<scratch>` protects the data, **not** the network.
   Exercise publish behaviour via `_build_plan` directly or the test suite instead.

**Verification.** `pytest worker/tests` 464 passed; `npm test` 52 + 258 = 310 passed;
`tsc --noEmit` clean; `npm run lint` **0 errors** (13 pre-existing warnings, none in this
branch's files); `test-conform-cover.mjs` 6/6 (dimensions unchanged, sRGB, ≤8 MB);
`smoke-cover-image.mjs` all 8 scenarios. Migration tested both ways against a `sqlite3 .backup`
copy — fresh DB 0001→0016 clean, and the already-applied case reproduced and fixed.

Browser-verified against the real Reel (`/library/2`, asset 8) on the :3939 dev server with
Playwright: a 9:16 cover uploads with **no** warning and preserved 1080×1920 dimensions; a 1:1
cover produces exactly one warning naming the middle-9:16 crop and is left uncropped at
1200×1200; the scrubber stays visible at `opacity 0.6` with an "Overridden by the uploaded
image" badge and is **not** disabled; Remove restores it to full opacity with `cover_frame_ms`
still 3900; re-uploading identical bytes deduped to the existing asset row rather than creating
a new one; the lightbox `overlay` slot still renders. Console clean (0 errors, 0 warnings). All
five theme tokens the picker uses resolve in **all 14 palettes** (7 families × light/dark);
light-mode contrast 6.33:1 (warning) and 6.02:1 (badge). Test covers were removed through the
app's own delete API, leaving the live DB at exactly its starting counts — 167 assets, 110
posts, 25 publications — asset 8 back to `cover_frame_ms=3900` / `cover_asset_id` NULL, no
files left in `data/assets/cover/`, `foreign_key_check` and `integrity_check` clean.

**Deliberately out of scope:** changing the cover of an **already-published** Reel (Meta does
not document whether it is possible); generating a cover (title cards, text overlay); covers
for Threads or TikTok (no equivalent — TikTok has a timestamp, like `thumb_offset`); cropping
the cover locally to 9:16.

- [ ] **Follow-up:** `listAssetsWithUsage()` still doesn't know about `assets.cover_asset_id`,
      so a linked cover shows on `/media` as "Unused" with a Delete button and counts toward the
      reclaim total. The delete itself is safe — the foreign key rejects it — but the figure
      overstates. (Same item noted under the `/media` work above.)

---

## Unmerge: split a carousel back into separate posts  `[x] done`

Splitting a carousel back into singles was **explicitly out of scope** of the merge feature
(2026-07-30). This is the return trip: take one carousel post and break it into one post per
slide. The narrower case of pulling selected slides out and leaving the rest shipped
separately on 2026-08-05 — see `docs/design-extract-slides.md`.

Merge is the model to follow — same guard/transaction/modal shape — but unmerge is **not**
symmetrical, and the asymmetries below are where the work actually is.

### Settle these before writing code

Each changes the implementation, and none is ours to guess. Brainstorm first, per the usual
order of operations, then write `docs/design-unmerge-carousel.md`.

- [x] **What happens to the caption?** A carousel has one `posts.caption` plus any
      `caption_variants` rows. Split into 5 posts, does each get a copy, only the first, or
      none? Copying means editing one later silently diverges from the others; dropping loses
      work the owner typed. Merge's precedent is that captions are handled explicitly rather
      than defaulted.
- [x] **What happens to tags, periods, channel targets, and `content_status`?** A carousel
      carries topic tags, time-of-day, in-season windows, `post_targets`, and cooldown
      overrides. Copy all to every child, or produce bare drafts the owner re-tags? Copying is
      probably right, but it is a decision, not an obvious default.
- [x] **What happens to scheduled sends?** Merge *warns* that non-survivor sends get canceled.
      Unmerge is worse: one carousel with a queued send becomes N posts, and it is genuinely
      unclear whether that send should follow the first slide, be canceled, or block the split
      outright. **Recommend blocking the split while any send is `scheduled`** — the owner can
      cancel it themselves via existing queue control — because silently retargeting a real
      send is the kind of surprise this project avoids.
- [x] **Is the original carousel post kept or consumed?** Merge designates a *survivor*.
      Unmerge could keep the carousel as post 1 and spawn N-1 siblings, or delete it and create
      N fresh posts. Keeping it preserves its id, metrics history, and any `posted` publications
      — **strongly prefer keeping it**, since deleting a post with `posted` publications would
      destroy real published records.
- [x] **Does an already-`posted` carousel get to be split at all?** It has real Instagram media
      attached. Recommend refusing: the published carousel is a historical record.

### Phase 1 — pure planning layer

- [x] `dashboard/lib/unmerge-plan.ts`, mirroring `lib/merge-plan.ts`: import nothing but
      `./platforms` so every rejection path is testable without SQLite.
- [x] Guards: post exists; `post_type` is `carousel`; 2+ slides; no `posted`/`publishing`
      publication; the scheduled-send rule chosen above.
- [x] Derive each child's `post_type` **from its own asset's `media_kind`** — a video slide
      must become `reel`, not `single`. ⚠ See the known `createDraftPost` bug below: the
      existing derivation ignores `media_kind` and would silently produce an unpublishable post.
- [x] Tests in `dashboard/test/` — every guard, plus the video-slide case.
- [x] **Verify:** `cd dashboard && npm test`, `npx tsc --noEmit`, `npm run lint` at **0 errors**.

### Phase 2 — the transaction

- [x] `unmergeCarousel(postId)` in `lib/queries.ts`, one `.immediate()` transaction, modelled on
      `mergePostsIntoCarousel`.
- [x] **Trap — `post_type` is frozen at write time** and only re-validated by the Python worker
      at publish. A child left as `carousel` with one asset looks fine in the dashboard and then
      fails at send with `carousel needs 2-10 assets, has 1`. Set it explicitly; add a test.
- [x] **Trap — `UNIQUE (post_id, sort_order)` is checked per-row and immediately.** Renumbering
      in place collides with itself. Delete the involved `post_assets` rows and rebuild them; a
      join row carries nothing worth preserving.
- [x] Assets are **shared, never copied** — content-hash dedup means the children reference the
      same `assets` rows. Nothing is written to `/data`, and no asset may be deleted here.
- [x] **Verify:** `PRAGMA foreign_key_check` clean on a scratch copy made with `sqlite3 .backup`
      (never `cp` — the DB is WAL). Report row counts before/after.

### Phase 3 — API and UI

- [x] `POST /api/posts/[id]/unmerge` — thin passthrough, all guards below it, matching
      `POST /api/posts/merge`.
- [x] Post-detail action + confirm modal that states plainly what will happen: how many posts
      result, what each inherits, and what is canceled. Reuse `components/slide-reorder.tsx` if
      the owner should pick the resulting order.
- [x] Theme tokens must already exist in `app/globals.css` — 7 families × light/dark = **14
      palettes**, and an invented class renders invisible in some of them.
- [x] **Verify in a real browser, with Playwright, not the in-app browser** — `renderToStaticMarkup`
      strips event handlers and cannot measure layout, and destructive flows need
      `browser_handle_dialog`. Use throwaway drafts, never the owner's real content, and confirm
      the DB is byte-identical afterward.

### Known landmines already documented elsewhere in this file

- [ ] **`createDraftPost` derives `post_type` from asset count alone and ignores `media_kind`**
      (follow-up under the merge section, confirmed live 2026-07-30). **Still open — unmerge
      sidesteps it rather than fixing it:** `unmergeCarousel` writes its own `INSERT` with an
      explicit `post_type`, so it never reaches this derivation.
- [x] **Publish-in-flight race — FIXED 2026-08-05.** The worker now claims a publication
      conditionally before loading anything, so a row being sent reads `publishing` from the
      first moment and the dashboard's existing guards see it. Unmerge inherits that protection
      for free; it still needs its own decision about what to do with a merely *queued* send.
- [x] **`listAssetsWithUsage()` and `/media`** count usage via `post_assets`. Unmerge changes
      which posts reference an asset without changing the asset — confirm the "unused" figure
      and reclaim total stay correct.

**Shipped 2026-08-05.** Design: `docs/design-unmerge-carousel.md`. Plan:
`docs/plan-unmerge-carousel.md`. Full split only; pulling selected slides out shipped
separately the same day — see the Extract slides section below.

Two decisions landed differently than the notes above guessed, both settled with the owner:

- The **caption is copied to every resulting post** (plus its `caption_variants` rows), as an
  independent copy — editing one later does not change the others. Tags, periods, channel
  targets (with `surface`), `content_kind`, `content_status`, `cooldown_days` and `created_by`
  copy the same way.
- A carousel with a **queued** send is **refused**, not silently retargeted — the owner cancels
  or holds it in queue control first. Published carousels are refused outright.

Verified in a real browser against a `sqlite3 .backup` copy of the live DB, never the live DB
itself: the happy path (6-slide carousel → 6 posts, `assets` and `post_assets` row counts
unchanged), both 409 guards, dark and light themes, and — because Task 4 extracted the shared
modal focus trap — the merge modal and the lightbox's arrow-key and `video[controls]` handling.

---

## Extract slides: pull selected photos out of a carousel  `[x] done`

**Shipped 2026-08-05.** Design: `docs/design-extract-slides.md`. Plan:
`docs/plan-extract-slides.md`. The narrower half of unmerge, deferred when the full split
shipped earlier the same day.

Pick one or more slides on the post screen and pull them out; each becomes its own post and
the original keeps the rest. Both actions now live in one **"Break this up"** card.

What it does:

- Each selected slide becomes its own post, typed from its own `media_kind` (a video slide
  becomes a Reel), carrying an independent **copy** of the caption, caption variants, channel
  targets with `surface`, tags, seasons, `content_kind`, `content_status`, `cooldown_days`.
- The original keeps every unselected slide, **renumbered contiguously from 0**, and is
  retyped: 2+ left stays `carousel`, exactly 1 left becomes `single` or `reel`.
- Assets stay shared. `assets` and `post_assets` row counts are unchanged, so `/media` usage
  and reclaim figures are unaffected.

Decisions settled with the owner during brainstorming:

- Selecting several slides produces **one post each**, not one new carousel together.
- Extracted posts **inherit** the content model rather than coming out bare.

Three guards of its own on top of the five shared with the full split: nothing selected, a
slide that is not in this post (a stale picker), and selecting *every* slide — which would
leave the original with zero photos, so it names the full split instead of silently
redirecting a differently-labelled button.

**The trap this feature exists to survive:** the original now keeps *several* slides and they
must come out contiguous. `UNIQUE (post_id, sort_order)` is checked per-row and immediately,
so renumbering in place collides the moment a survivor moves onto a number a later survivor
still holds. The full split sidestepped this by rebuilding a single row at 0; extraction
cannot, so it deletes every join row and rebuilds the keepers.

Two refactors landed first, each with the existing tests unedited and green as proof they were
inert: guards 1-5 moved into a shared `checkRestructurable` prelude, and the
post-creation-with-content-model block became `spawnPostsFromSlides`, so the two operations
cannot drift on what they copy.

Verified in a real browser against a `sqlite3 .backup` copy of the live DB, never the live DB:
pulling slides 2 and 4 out of a 4-slide carousel left `0→19, 1→21` (gap closed), produced two
`single` drafts in carousel order, and left `assets`/`post_assets` at 167/167 with
`foreign_key_check` clean. Guard 8 blocks client-side too. Dark mode measured, not eyeballed:
the dialog's background matches the page's exactly.

Still open: reordering while extracting (reorder is already its own control), and extracting
several slides into one new carousel together.

---

## Worker autostart (2026-08-05)  `[x] done — LIVE`

The worker had to be started by hand through `Start-SocialScheduler-Mac.command`, which
gates live mode behind a typed `YES`, and it then stopped itself after 12 hours. The owner's
actual intent is simpler: **the worker should be running whenever the Mac is.**

**One script, and no menu at all.** This went through two wrong shapes first: a separate
`Enable-Worker-Autostart` script (two double-clicks for one intention), then a three-option
menu inside Start. Both were over-thought. The owner's question settled it — *"someone
starts it when they go live, and stops it when they stop the scheduler, so really just a
single option is needed, right?"* — and they were right:

- **Compose-vs-live was a distinction without a difference.** An idle worker does nothing
  until a send is actually due, and whether anything can post for real is decided by
  `DRY_RUN` in `.env`, which a fresh clone ships as `1`. The menu was protecting against
  almost nothing that `DRY_RUN` did not already cover.
- **The `Type YES` gate was pure friction** once the worker was autostarted: it fired on
  every launch to re-confirm a decision already recorded, for a worker Start was not even
  starting. Setting `DRY_RUN=0` in `.env` is itself the deliberate act.

So Start now just says what is happening and does it. The one thing autostart genuinely
buys — and the reason it is not simply "Start runs the worker" — is surviving a **reboot**:
after a restart nobody is there to double-click anything. `Disable-Worker-Autostart-*` is
the rarely-used undo.

macOS uses a per-user LaunchAgent (`~/Library/LaunchAgents/com.socialscheduler.worker.plist`);
Windows uses an at-logon Scheduled Task (`SocialSchedulerWorker`).

- [x] `RunAtLoad` starts the worker at login; `KeepAlive: {SuccessfulExit: false}` restarts
      it **only** on a non-zero exit. The worker exits 0 on SIGTERM, so `Stop-...command`
      still genuinely stops it instead of fighting launchd, and it returns at the next login.
- [x] `Stop-...command` learned to stop the agent (`launchctl kill TERM`, not `bootout`, so
      autostart survives). Without this, Stop would report success while launchd's worker
      kept publishing — it has no `worker.pid` for Stop to find.
- [x] `Start-...command` refuses to start a second worker while the agent owns one, and
      kickstarts a stopped agent instead.
- [x] The 12-hour auto-stop watchdog is retired when autostart is enabled — a deadline
      contradicts "always running". `KILL_SWITCH=1` in `.env` remains the emergency stop and
      still takes effect within one poll, without uninstalling anything.

**Three traps, all of which cost real debugging time:**

1. **launchd's `PATH` does not include `/usr/local/bin`.** The worker shells out to
   `cloudflared` by bare name for the publish tunnel, so without an explicit
   `EnvironmentVariables` `PATH` a REAL publish fails with `'cloudflared' not found` — and
   only at send time. The plist sets PATH explicitly.
2. **`com.apple.provenance` makes a log file unusable as `StandardOutPath`.** macOS stamps
   files created by a Terminal-launched process with that xattr, it **cannot be removed**
   (`xattr -d` silently no-ops), and launchd refuses to open such a file for a job. The job
   then dies with **exit 78 `EX_CONFIG` before the worker ever starts**, with nothing in any
   log. Reusing the launcher's `worker-daemon.out` triggered exactly this. launchd now writes
   to its own `worker-launchd.out`, which the enable script deletes first to guarantee a
   fresh inode. Nothing is lost: the real rotating log is `data/logs/worker.log`.
3. **A registered launchd job is not a running one.** The first version of the enable script
   checked `launchctl print` succeeded and cheerfully reported success while the job failed
   to spawn on a loop — leaving *no worker running at all*. It now polls for a real pid and
   prints the exit code on failure.

**Verified:** crash-restart (SIGKILL → respawned in 5s), clean stop (`launchctl kill TERM` →
exit 0, no respawn, still registered), exactly one worker process throughout, heartbeat
advancing on the 30s poll.

- [ ] **Not done — this is login-scoped, not boot-scoped.** A LaunchAgent runs when the owner
      logs in. If the Mac reboots and sits at the login window, the worker does not run. A
      true boot-scoped daemon needs a `LaunchDaemon` in `/Library/LaunchDaemons` and `sudo`.
- [x] **Windows parity — same three-option menu**, backed by `schtasks /SC ONLOGON` instead
      of launchd, with `Stop-...bat` ending the running task and
      `Disable-Worker-Autostart-Windows.bat` removing it. **Every Windows script in this
      repo remains UNTESTED** — written on macOS, no Windows machine available. One real
      capability gap, not hidden in the code: launchd can also *restart* a crashed worker
      (`KeepAlive`); `schtasks` has no equivalent flag, so Windows gets start-at-logon only
      and a crashed worker stays down until the next logon.

---

## Phase: cloudflared installs itself (2026-08-05) — SHIPPED

Reported from Windows: a fresh install never sets up cloudflared, so the person has to
figure it out themselves. It applied to macOS too, and was worse than it looked — the
launchers only warned when `DRY_RUN=0`, and a fresh clone ships `DRY_RUN=1`, so a new
install got **no warning at all** and only found out when its first REAL publish failed.

Design: `docs/superpowers/specs/2026-08-05-cloudflared-autoinstall-design.md`

- [x] `worker/cloudflared_setup.py` — detects OS/arch, reads Cloudflare's latest GitHub
      release, downloads to a temp file, extracts (`.tgz` on macOS, bare `.exe` on
      Windows), `chmod +x`, proves it runs with `--version`, and only THEN moves it into
      `data/bin/`. Idempotent: a working binary short-circuits before any network call.
- [x] A present-but-broken binary counts as missing, so a truncated download self-heals.
- [x] An existing system install (e.g. `brew install cloudflared`) is used as-is —
      nothing is downloaded and nobody's setup gets overridden.
- [x] `worker/tunnel.py` — `resolve_binary()`: PATH → literal path → `data/bin` copy.
      Returns an **absolute** path, which also kills the launchd landmine recorded
      earlier in this file: launchd's minimal PATH excludes Homebrew, so a bare
      `cloudflared` never resolved for the autostarted worker.
- [x] Both launchers run it in the first-run block, **unconditionally** — the `DRY_RUN=0`
      gate is precisely what failed. Non-fatal: composing and dry runs need no tunnel.
- [x] `.env.example` / `readme.md` — `CLOUDFLARED_PATH` is now optional and commented out;
      the "one-time setup: brew install cloudflared" instruction is gone.

**The certificate trap (cost a full debugging cycle, worth recording):** the first real
download died with `CERTIFICATE_VERIFY_FAILED`. python.org's macOS Python ships **no CA
store** — it depends on a separate "Install Certificates.command" almost nobody runs — so
stdlib `urllib` cannot verify github.com. The rest of the worker never hit this because
`requests` bundles `certifi`. Fixed by using certifi's bundle when importable and running
the module with the **venv** Python, not the system one. Verification is never disabled:
this downloads an executable that then gets run.

**Verified:** 28 new tests, full suite 508 passed. Real download on macOS/arm64 (41.2 MB,
`cloudflared version 2026.7.3`, second run downloads nothing). Real tunnel opened with the
vendored binary and **nothing on PATH**, bytes fetched back through the public
`trycloudflare.com` URL, clean teardown. **Windows remains untested** — no Windows machine
available, same caveat as every other Windows script here.

---

## Phase — Insights hub (account-wide metrics)  ·  2026-08-05

Design: `docs/design-insights-hub.md`. Instagram and Threads shipped; Facebook Pages
deferred to its own phase.

### Schema — `0018_insights_hub.sql`
- [x] `remote_media` — every post ON the account, ours or not, with a nullable
      `publication_id` linking back when it happens to be one we sent.
- [x] `media_metrics`, `account_metrics` (one row per channel per UTC day, upserted),
      `audience_demographics` (long/narrow, so a new platform bucket needs no migration).
- [x] `channels` gains sync bookkeeping + an `insights_refresh_requested` handshake.
- [x] `post_metrics` deliberately untouched — autofill depends on it.

### Worker
- [x] `worker/insights_probe.py` — asks the LIVE account which metric names work, one per
      request. Read-only, manual, prints the `.env` lines to copy.
- [x] `worker/media_sync.py` — mirrors the account's media list. Bounded by age/count,
      re-walks a refresh window so edits and deletions are seen, flags removed posts
      rather than deleting them.
- [x] `worker/account_metrics.py` — daily series + demographics, chunked backfill.
- [x] `worker/media_metrics.py` — per-post insights, reusing a fresh `post_metrics`
      snapshot instead of paying Meta twice for the same reading.
- [x] All three are read-only, run under `DRY_RUN`, obey the kill switch, and share a
      per-cycle call budget that also watches Meta's `X-Business-Use-Case-Usage` header.

### Dashboard
- [x] `/insights` — one card per account. No cross-account totals: reach cannot be summed
      without double-counting people who follow both.
- [x] `/insights/[id]` — KPI row, 365-day reach ribbon, trend chart, content leaderboard,
      audience, best-time grid. Every control is a URL param, so the whole page stays a
      server component with no client bundle.
- [x] Charts hand-rolled in SVG (`components/charts.tsx`), themed entirely through CSS
      custom properties, tooltips via native `<title>`.

### What live probing changed (docs were wrong; see reference.md)
- [x] **`impressions` is dead on Instagram** — 400 in both envelopes. `views` replaces it.
- [x] **A single day is `[D, D+1)`** — `since=D&until=D` returns `{}` silently.
- [x] **`end_time` marks the START of the local day**, so a bucket is labelled by
      `end_time + 12h` (robust for any UTC offset, unlike taking the date directly).
- [x] **Threads `shares` returns HTTP 500**, `clicks` is always null — neither is real.

### Bugs caught before shipping
- [x] Incremental sync stopped at the newest known post, so no existing post was ever
      re-examined — caption edits and deletions would never have been seen.
- [x] Deletion flagging used "oldest post found" as its search floor, which moves UP past
      a deleted post. The floor now derives from why the walk stopped.
- [x] The backfill "has history?" check ran AFTER the job's own first insert, collapsing a
      365-day backfill to 30 days.
- [x] UTC vs account-local day: at 01:00 UTC the follower snapshot landed on tomorrow's
      row. The account's local day is now read from Meta's own newest bucket.
- [x] Per-post `LIMIT` was derived from the API call budget, silently capping the
      copy-across path that exists to conserve it.
- [x] KPI row showed a 2-day sum under a "30 days" heading beside a true 30-day figure.
      Coverage is now stated, and deltas withheld unless both windows are complete.

**Verified against the live account:** 146 Instagram posts + 8 Threads posts synced, 365
days of account history, 154/154 posts with metrics (17 reused, 0 API calls wasted), 16
demographic breakdowns. Suites: **651 worker + 394 dashboard**, 0 lint errors.

### Not done
- [ ] **Facebook Pages** — every adapter registers `facebook: None`. Needs its own probe
      first; Meta retired a batch of Page metrics on 2026-06-15.
- [ ] **Reels `video_views`** is never requested — the shared post-metric list omits it,
      and Instagram 400s the whole call if one name is invalid, so adding it needs a probe.
- [ ] Meta's CDN thumbnail URLs expire; there is no local proxy for posts we did not publish.
