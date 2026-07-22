# SocialScheduler — Plan

This is the drafted-from-the-start plan. It records the shape of the system and the intended
build sequence. Detailed, checkable phase steps live in `docs/tasks.md`; verified API facts in
`reference.md`; rules and conventions in `CLAUDE.md`; scope in `context.md`.

## Goal
A local, self-hosted tool to compose, schedule, auto-fill, and publish Instagram + Facebook
Page content, with systematic content recycling, that anyone can clone and run independently
with their own credentials.

## Architecture
- **Dashboard** (Next.js/TypeScript) and **Worker** (Python) **share one SQLite file (WAL
  mode)** and never call each other. The DB is the contract.
- **Schema** lives in `/migrations` as plain `.sql`, applied by a language-agnostic migrate
  script. Each clone migrates its own DB.
- **`/data`** holds the DB + local asset store, gitignored, per-install.

## Data model (target)
`assets` · `posts` · `post_assets` · `channels` · `publications` · `post_metrics` · `tags` +
`post_tags` · `publish_limits`. The `publications` table (post → channel → time, independent
status) is what enables both recycling and independent partial-failure handling. Metrics hang
off `publications`, so per-channel performance ranking falls out naturally.

## Key behaviors
- **Scheduling:** manual, bulk (N posts at fixed cadence from next open slot), auto-fill
  (per-channel cadence + min-queue-depth top-up).
- **Auto-fill selection order:** never-posted → not-posted-in-180d (configurable) → per-channel
  top performers not reused in 180d.
- **Publishing:** container → status-poll → publish; rate-limit checked at runtime via
  `content_publishing_limit`; dry-run supported; failures visible + auto-retry with backoff;
  first comment auto-posted after publish.
- **Timezones:** per-channel IANA; store UTC, display in channel zone.
- **Safety:** kill switch halts the worker; no secrets in code; no silent failures.

## Build sequence (see tasks.md for the checkable breakdown)
1. **Foundation & schema** — repo scaffold, `.env.example`, migrations for all tables, migrate
   script, seed/inspect helpers.
2. **IG publish worker (image + carousel)** — Graph API client, container→status→publish,
   rate-limit gate, dry-run, retry/backoff, kill switch, against a test account.
3. **Dashboard composer + overview** — upload/dedup assets, compose (caption + first_comment +
   ordered carousel), per-channel targeting made obvious, schedule picker, status/overview
   table.
4. **Scheduling + auto-fill** — cadence config, queue-depth top-up, selection rules.
5. **Metrics fetch job** — per-publication snapshots; feed per-channel performance ranking.
6. **Extend adapters** — Facebook Pages → Reels/video → Stories → first-comment automation →
   approval-workflow UI.

## Explicitly deferred (schema-ready, built later)
Facebook/video/Stories adapters, first-comment automation, approval workflow UI, metrics
rollup/pruning. The schema accommodates them from Phase 1; the code arrives in Phase 6.

## Verification discipline
Every phase in `tasks.md` ends with a verification step that must pass before the next phase
starts. Publishing phases verify with a **test account in dry-run first**, then a single real
post, before any automation runs against real data.
