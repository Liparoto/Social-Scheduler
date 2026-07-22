# Identity

You are helping build **SocialScheduler** — a self-hosted, single-install social media
posting and scheduling automation tool. It is an **internal tool, not a product**: it runs
entirely on a local Mac, uses no paid SaaS, and depends on nothing cloud-hosted unless the
owner explicitly asks for it later. The only external dependency is Meta's own developer
platform (the Instagram/Facebook Graph API).

The person you are working for is a **solo developer, still building familiarity with these
stacks** — explain the "why," keep it plain, and favor one clear recommendation over a menu
of options. See the global `~/.claude` / top-level `CLAUDE.md` for their working style
(teaching mode, verification, security standards). This file does not repeat those; it adds
the project-specific rules below.

Who uses it:
- **Primarily the owner**, managing several of their *own* accounts (e.g. a personal
  Instagram account and a separate business account, "Advantage Physical Therapy").
- **Eventually anyone who clones the repo** for their *own* accounts — starting with the
  owner's wife, for her event-planning business. Each clone is a fully independent install.

## Rules

### Multi-tenancy is structural, not a feature
Every clone of this repo is a **completely independent install**. There is **no shared
backend, no hosted service, and no user-accounts/auth system.** Concretely:
- Each install has its **own `.env`**, its **own SQLite database file**, and its **own Meta
  app credentials + per-channel tokens**.
- Never introduce a central server, a shared database, a login system, or anything that
  assumes multiple installs talk to each other. They must not.
- `created_by` on a post is a **free-text label** for shared-install clarity, never an
  identity/permission system.
- Anything written to `/data` (the DB, the local asset store) is **per-install and
  gitignored**. Only code and docs are committed.

### Tech stack (fixed unless the owner changes it)
- **Dashboard:** Next.js (App Router), TypeScript, running locally. Internal only — no public
  hosting assumed.
- **Worker/automation:** Python, in a **virtual environment (`venv`)** — never the system
  Python. Update `requirements.txt` after adding packages.
- **Storage:** **SQLite**, one file per install, in **WAL mode**.
- **Everything runs locally on macOS.** No paid tools or services anywhere in the stack. If a
  task seems to need a cloud service, stop and flag it — do not add one silently.

### How the Next.js app and the Python worker communicate
**They share one SQLite file. There is no API between them.** The database is the contract.
- The **Next.js dashboard** reads/writes SQLite directly from server-side route handlers
  (via `better-sqlite3`). All interactive work — compose, order carousels, pick channels,
  schedule — is DB writes.
- The **Python worker** is a standalone long-running daemon that **polls** the DB for due
  work (publish, fetch metrics, run auto-fill), calls the Graph API, and writes results back.
- **They never call each other directly.** WAL mode gives concurrent readers + one writer,
  which is enough for a single install.
- **Why not a local HTTP API between them?** It would add a second server, a port, request
  auth, and error plumbing to solve a coordination problem the shared DB already solves.
  Rejected for simplicity.

### Schema ownership
The schema lives in **`/migrations` as plain `.sql` files** and is the single source of truth.
Neither language "owns" it. A tiny language-agnostic migrate script applies pending
migrations. Every clone runs migrations against **its own** DB on setup. Do not define schema
inline in TypeScript or Python — write a migration.

### Folder structure
```
/dashboard      Next.js app (composer, calendar/queue, overview, channel config)
/worker         Python worker (publisher, metrics, autofill, scheduler, kill switch)
/migrations     *.sql schema migrations — SOURCE OF TRUTH for the schema
/data           SQLite DB + local asset store — gitignored, per-install
/docs           plan.md, tasks.md, design specs
CLAUDE.md  context.md  reference.md  readme.md  .env.example
```

### Publishing correctness (see reference.md for the verified specifics)
- Instagram publishing is a **two-step container → publish** flow, and for
  video/Reels/carousel you **must poll container `status_code` until `FINISHED`** before
  publishing. Never skip the status check.
- Images must be reachable at a **genuinely public URL that returns raw image bytes** — Meta
  cURLs it server-side. Google Drive / Dropbox *share* links do **not** work.
- **Never hardcode the publishing rate limit.** Read `content_publishing_limit` at runtime
  and gate on the account's actual quota. Meta's own docs disagree on the number.
- **Dedup assets by content hash, never by filename.**
- **Failed publishes must be visibly failed, never silent.** Each channel target is an
  independent `publication` with its own status; a failure on one must not roll back or block
  the others.

### Guardrails (this is an internal tool — act like it)
- Favor **simplicity and transparency over polish or scale.** The dashboard's job is to make
  the process *legible* (how a post is assembled + where it's headed), not to look like a SaaS.
- Every automation must have a **kill switch** that halts the worker immediately.
- Support a **dry-run mode** so a fresh clone can be sanity-checked before it ever posts for
  real.
- **Never hardcode secrets.** Tokens and app credentials come from `.env` / per-channel config
  only. Never log tokens, full API responses containing PII, or credentials.
- Build the **schema and abstractions to accommodate all of v1's scope** (Instagram +
  Facebook Pages; image, carousel, Reels/video, Stories; approval step), but **implement in
  the agreed build order** — a working IG image/carousel pipeline first, then layer the rest.
