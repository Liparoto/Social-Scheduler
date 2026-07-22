# SocialScheduler

A **self-hosted, local-only** tool to compose, schedule, auto-fill, and publish social media
posts to **Instagram** and **Facebook Pages** — built to remove the manual posting bottleneck
and to make **content recycling** (re-publishing good content over time) systematic.

It is an **internal tool, not a product**. No paid SaaS, nothing cloud-hosted, no accounts
system. The only external dependency is Meta's own developer platform.

## Independent installs (multi-tenant by cloning)
Every clone of this repo is a **completely separate install** — its own `.env`, its own SQLite
database, and its own Meta app credentials + per-channel tokens. There is no shared backend and
no coupling between installs. Clone it, configure your own credentials, run your own instance.

## Architecture (short version)
- **`/dashboard`** — Next.js (App Router, TypeScript) internal dashboard: compose posts, order
  carousels, pick target channels, schedule, and watch status + performance.
- **`/worker`** — Python daemon: polls the database for due work, publishes via the Meta Graph
  API, fetches metrics, runs auto-fill, and paces itself against Meta's rate limit.
- **`/migrations`** — plain `.sql` schema migrations; the single source of truth for the schema.
- **`/data`** — the SQLite database (WAL mode) + local asset store. Per-install, gitignored.

The dashboard and worker **share the one SQLite file** and never call each other — the database
is the contract.

## Scope (v1)
Instagram + Facebook Pages · image, carousel, Reels/video, Stories · multi-account first-class ·
per-channel timezones · manual / bulk / auto-fill scheduling · per-channel performance ranking ·
free-form tags · separate auto-posted first comment · content-hash dedup · dry-run mode ·
kill switch · visible (never silent) publish failures.

## Status
Early build. See `docs/plan.md` for the plan and `docs/tasks.md` for phased progress.
`CLAUDE.md`, `context.md`, and `reference.md` are the source-of-truth context docs.

## Setup (will expand as the build lands)
1. Copy `.env.example` → `.env` and fill in your own Meta app + per-channel credentials.
2. Run the migrations against a fresh `/data` database.
3. Start the dashboard (`/dashboard`) and the worker (`/worker`).
4. Do a **dry-run** publish to verify everything before going live.

> Requires an Instagram **professional** (Business/Creator) account. For your own accounts,
> Meta **Standard Access + Development mode** is sufficient — no App Review needed.
