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

## Phase 3 — Dashboard composer + overview  `[ ]`
Make the process legible; compose → schedule → watch it publish.

### Implementation
- [ ] Next.js app reading/writing SQLite via `better-sqlite3` (WAL).
- [ ] Asset upload → content-hash dedup → local store + `public_url` + thumbnail.
- [ ] Composer: caption, `first_comment`, drag-to-order carousel, **per-channel checkboxes that
      make the target account(s) obvious**, schedule picker (interpreted in channel timezone),
      tags.
- [ ] Overview table: status (draft/scheduled/posted/failed) + performance once live; manual
      retry on failed publications.
- [ ] Channel config: credentials, timezone, cadence, `requires_approval` toggle, kill switch.

### Verification
- [ ] Compose a post targeting two channels → two `publications` created with correct
      per-channel scheduled times.
- [ ] Upload the same file twice → deduped to one asset.
- [ ] A scheduled post composed in the dashboard is picked up and published by the Phase 2
      worker (end-to-end).
- [ ] Failed publication shows as failed and can be retried from the table.

---

## Phase 4 — Scheduling + auto-fill  `[ ]`

### Implementation
- [ ] Bulk schedule: N posts at a fixed cadence from the next open slot.
- [ ] Per-channel cadence config + min-queue-depth target.
- [ ] Auto-fill top-up honoring the selection order: never-posted → not-posted-in-180d
      (configurable) → per-channel top performers not reused in 180d.

### Verification
- [ ] Bulk-schedule 5 posts every 2 days @ 6pm → correct times in channel TZ.
- [ ] Drain a queue below the threshold → auto-fill tops it to target using the right
      selection order (verify each tier with crafted data).

---

## Phase 5 — Metrics fetch job  `[ ]`

### Implementation
- [ ] Per-`publication` metrics fetch (reach/saves/etc.) → time-series `post_metrics` rows.
- [ ] Feed per-channel performance ranking used by auto-fill tier 3.

### Verification
- [ ] Fetch metrics for a real published post → snapshot row written.
- [ ] Ranking query returns per-channel top performers correctly on seeded data.

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
