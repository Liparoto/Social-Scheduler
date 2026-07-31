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

## Get the code
Open **Terminal** (macOS) or **Git Bash** (Windows), go to where you keep projects, and run:

```
git clone https://github.com/Liparoto/Social-Scheduler.git
```

That makes a `Social-Scheduler` folder — your own private install. Open it and follow the
quick start below.

> **Don't use GitHub's "Download ZIP".** A ZIP isn't a git checkout, so `Update-Mac.command` /
> `Update-Windows.bat` can't pull new versions and will stop with an error. Clone it.

Nothing personal is in this repo — no credentials, no database, no images. Your `.env` and your
`/data` folder are created on *your* machine and are never uploaded.

## Quick start — start & update by double-click

**Start it:**
- **macOS:** double-click **`Start-SocialScheduler-Mac.command`**. (First time, if macOS blocks
  it: right-click → Open.)
- **Windows:** double-click **`Start-SocialScheduler-Windows.bat`**.

On first run it creates your `.env` from the template, prepares the database, and installs
everything (dashboard deps **and** the worker's Python environment). Every run it re-checks the
database so new updates apply automatically. Then it asks what you want to do:

- **1) Compose only** — opens the dashboard at `http://localhost:3939`; the worker never runs, so
  **nothing can post**. This is the default and is always safe.
- **2) Go live** — opens the dashboard **and** starts the worker that publishes due posts. While
  `DRY_RUN=1` (the shipped default) the worker only *logs* what it would post. If you've set
  `DRY_RUN=0`, it asks you to type **YES** first — otherwise it quietly stays in Compose only.

Once it's running, the launcher **closes its own window** — the dashboard and worker keep
running in the background, so nothing is left cluttering your screen and nothing dies if you
close a window by accident.

**Stop it:**
- **macOS:** double-click **`Stop-SocialScheduler-Mac.command`**
- **Windows:** double-click **`Stop-SocialScheduler-Windows.bat`**

Double-clicking Start again while it's already running just reopens the browser tab — it won't
start a second copy, so it doubles as an "is it on?" check.

If you chose **Go live**, the worker also **stops itself after 12 hours** so it can't keep
publishing unattended if you forget about it. Change that with `WORKER_AUTO_STOP_HOURS` in your
`.env`. The dashboard has no timer — it publishes nothing, so it runs until you stop it.

Logs are in `data/logs/` — `dashboard.log` and `worker-daemon.out`. Requires **Node.js**
(nodejs.org) and **Python 3** (python.org); the launcher tells you if either is missing.

**Update to the latest code (keeps all your data):**
- **macOS:** double-click **`Update-Mac.command`** · **Windows:** **`Update-Windows.bat`**.

It pulls the newest code (fast-forward only), applies any new database changes, and refreshes
dependencies. Your `.env` and `/data` are never touched. If you have local code edits, no network,
or it isn't a git checkout, it stops with a plain explanation and changes nothing.

**Back up your content:**
- **macOS:** double-click **`Export-Mac.command`** — saves every post, image, and stat into a
  dated folder in `~/Documents/SocialScheduler Exports/`, ready to drag into Google Drive.
  Read-only: it never changes or posts anything.
- **Windows:** double-click **`Export-Windows.bat`** — same export, into
  `%USERPROFILE%\Documents\SocialScheduler Exports\`, opened in File Explorer when done.

**Manual (for developers):**
1. Copy `.env.example` → `.env` and fill in your own Meta app + per-channel credentials.
2. `python3 migrate.py` to build/update the local database.
3. `cd dashboard && npm install && npm run dev` for the dashboard.
4. For publishing, run the worker: `python3 -m worker.run` (see below).

## Going live (first real post)
Do a **dry-run** first (`DRY_RUN=1` in `.env`), then follow **`docs/meta-setup.md`** to connect
a real Instagram account and publish. Verify credentials anytime with
`python3 -m worker.preflight` (reads your quota, posts nothing).

> Requires an Instagram **professional** (Business/Creator) account. For your own accounts,
> Meta **Standard Access + Development mode** is sufficient — no App Review needed.

Discord and Telegram channels don't need any of the Meta setup above — see
**`docs/other-platforms-setup.md`** instead. Setup is shorter for both: no public URL or
tunnel is needed, since the worker uploads the image bytes directly.
