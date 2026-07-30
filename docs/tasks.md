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
- [ ] Stories.
- [ ] First-comment automation (post-publish comment endpoint).
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

- [ ] **Follow-up:** when migration `0012_cover_asset.sql` (the `custom-cover-image` branch)
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
- [ ] **Follow-up — publish-in-flight race: merge can cascade-delete a publication the worker is actively sending.** The worker fetches `status='scheduled'` publications, loads the post and assets into Python memory, does an HTTP quota check, and only *then* writes `'publishing'` to the database. During that window the row still reads `scheduled`, so the merge's guard (which blocks `posted`/`publishing`) lets it through. The merge deletes the post, CASCADE removes the publication, and the worker's later status writes silently update 0 rows. Outcome: a real Instagram post exists with no database record, and the same photo sits in the merged carousel ready to post a second time. Pre-existing — `deletePost` has the identical guard — but merging widens the exposure because the merge modal explicitly invites merging posts that have queued sends. **Fix is worker-side:** claim the publication row conditionally before loading it — `UPDATE publications SET status='publishing' WHERE id=? AND status='scheduled'` — and abort if it updates 0 rows. The dashboard's `.immediate()` transaction cannot help because the worker is not writing during the window; it is holding state in memory.
- [ ] **Follow-up — spec gap: caption-length guard never implemented.** The design doc's §5 lists a `captionLimitError` guard (reusing the per-post-type limit from `lib/caption-limits.ts`) that was never implemented — `planMerge` never receives the caption at all, so the check cannot run. Only reachable if someone merges posts with a caption that exceeds the `carousel` limit (where `single` captions were within bounds). The worker re-validates at publish and fails visibly at send rather than silently, so it surfaces eventually; low priority but the design doc currently overstates what ships.

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
