# Friendly Launcher + Update Experience — Design

**Date:** 2026-07-23
**Goal:** Let a non-technical teammate run her *own* clone of SocialScheduler and keep it
updated, without ever touching a terminal, and without any risk to her secrets or data.

## Who this is for

The owner's wife (event-planning business) will clone this repo, add her own Meta
credentials, and run it locally. She will not use `git`, `npm`, or a shell directly. She
needs exactly two actions:

1. **Start everything** with one double-click.
2. **Update to the latest code** with one double-click, without losing her data.

## Context verified against the repo

- Every clone is an independent, LOCAL-ONLY install. `.env` (Meta secrets) and `/data`
  (SQLite DB + assets) are **gitignored and per-install** — so `git` operations never see
  or touch them.
- The **worker** runs as `python3 -m worker.run` from the repo root, using the root `.venv`
  and `requirements.txt` (only dep: `requests`). It reads `DRY_RUN` and `KILL_SWITCH`
  **live** from `.env` every cycle, and shuts down cleanly on SIGINT/SIGTERM (finishes the
  current publish, then exits).
- The **dashboard** runs `npm run dev` in `/dashboard` on port **3939**.
- `migrate.py` is **stdlib-only and idempotent** — safe to run every launch; applies any
  new additive migrations after an update and preserves existing data.
- **cloudflared** is only needed for *real* publishing (DRY_RUN=0). Dry-run and
  compose-only need nothing extra.
- Existing tooling: `Start-Dashboard-Mac.command` / `Start-Dashboard-Windows.bat` start the
  **dashboard only** and have **no update path**. These are replaced.

## The three UX decisions (settled)

1. **One launcher file per platform, with a small menu.** `Start-SocialScheduler-Mac.command`
   and `Start-SocialScheduler-Windows.bat` replace the two `Start-Dashboard-*` files. On
   open, a two-item menu makes the posting-vs-not choice explicit *every* launch:
   - `1) Compose only` — dashboard only; the worker never runs, so nothing can post. (default)
   - `2) Go live` — dashboard **and** the worker that publishes due posts.
   Rationale: two "start" files confuse a non-technical person; a silent always-both default
   hides whether posting is active. A menu keeps the mode legible (a core project guardrail).

2. **Real-post guard.** In *Go live*, the launcher reads `DRY_RUN` from `.env`:
   - `DRY_RUN=1` (the shipped default) → start the worker and print a clear "DRY-RUN:
     nothing will actually post" note.
   - `DRY_RUN=0` → show `⚠️ This will post to Instagram/Facebook for REAL. Type YES to
     continue.` If she does not type `YES`, **fall back to Compose only** so she is never
     stuck and never posts by accident. Also warn (non-fatal) if `cloudflared` is missing,
     noting dry-run works without it.
   - If `KILL_SWITCH=1`, still start the worker (it is designed to idle safely) but note it
     will publish nothing until the switch is cleared.

3. **Update safety.** `Update-Mac.command` / `Update-Windows.bat` do a **fast-forward-only**
   pull and never rewrite her work:
   - Not a git checkout (no `.git`) → explain (likely a ZIP download) and stop.
   - Can't reach the network (`git fetch` fails) → explain and stop.
   - Local edits to tracked files (`git status --porcelain` non-empty) → explain and stop;
     never stash, discard, or force. (`.env` and `/data` are gitignored, so they never
     appear here and are never at risk.)
   - Otherwise `git pull --ff-only` → `python3 migrate.py` → refresh deps (`npm install`,
     `.venv` pip install) → success message.

## What each script does

### `Start-SocialScheduler-Mac.command` / `-Windows.bat`

1. **Preflight (friendly):** Node.js present? Python 3 present? If either is missing, print
   where to get it (nodejs.org LTS / python.org), keep the window open, and stop.
2. **Idempotent setup (every launch):**
   - Create `.env` from `.env.example` if missing.
   - Always run `migrate.py` (applies new schema after an update, preserves data).
   - Ensure dashboard deps: `npm install` in `/dashboard` if `node_modules` is missing.
   - Ensure the worker's Python env: create `.venv` if missing, then
     `pip install -r requirements.txt` into it.
3. **Menu:** Compose only (default) vs Go live.
4. **Compose only:** open `http://localhost:3939`, run `npm run dev` in the foreground.
   Closing the window stops the dashboard.
5. **Go live:** run the real-post guard, then start the worker in the **background**, start
   the dashboard in the foreground, and **clean up the worker when the window closes**
   (Mac: `trap ... EXIT INT TERM HUP` → `kill` the worker PID; Windows: worker runs in its
   own titled window, `taskkill` when the dashboard stops).

### `Update-Mac.command` / `-Windows.bat`

Runs the update-safety flow above, with plain success/failure messages, window kept open on
any error.

## Safety properties (non-negotiable)

- **Never touches `.env` or `/data`** — no script reads secrets, and git never sees them.
- **Respects `DRY_RUN` / `KILL_SWITCH`** — read live from `.env`, never overridden.
- **Real posting always requires an explicit `YES`** when `DRY_RUN=0`.
- **Clean shutdown** of both processes — the worker gets a normal signal and exits
  gracefully (it never leaves a half-finished publish).
- **No new dependencies, no cloud, no network calls** beyond `git` (Update only) and what
  the app already does.

## Cross-platform parity notes

- Mac uses `bash` with a `trap` for clean worker shutdown; Windows batch can't trap the
  window's X button, so the worker runs in its own clearly-titled window and is killed via
  `taskkill` when the dashboard stops. This is the closest faithful parity batch allows and
  is documented in the README.
- Both match the existing files' plain, numbered, friendly-comment style.

## Out of scope

- No installer/packaging (.app, .exe), no auto-update-on-launch, no service/daemon
  registration. Double-click launch + double-click update only.

## Testing (on this machine)

- Clean start (Compose only and Go live).
- Worker actually starts and writes its heartbeat; graceful shutdown of both.
- An update run (ff-only success; dirty-tree stop; not-a-checkout stop; no-network stop).
- Missing-Node and missing-Python error paths (simulated via PATH).
