# Current Project

## What we are building
**SocialScheduler** — a self-hosted tool for composing, scheduling, auto-filling, and
publishing social media posts (Instagram + Facebook Pages) from a local Mac, with a Next.js
dashboard for people and a Python worker for the automation, sharing one SQLite database. It
exists to remove the manual bottleneck of posting/scheduling by hand and to enable **content
recycling** — the same asset can be published many times over its life, and the system knows
what to re-post when.

## Who it's for
- The owner, managing multiple of their **own** accounts (personal IG + a business IG,
  "Advantage Physical Therapy") as first-class, independently-configured channels.
- Later, anyone who clones the repo for their **own** accounts (first: the owner's wife's
  event-planning business). Every clone is a fully independent install — its own `.env`, DB,
  and Meta credentials. No shared backend, no accounts system.

## Scope decided for v1
- **Platforms:** Instagram Business/Creator **and Facebook Pages**. Schema/adapters generic
  enough to add more later.
- **Media types:** image, carousel (max 10 via API), Reels/video, and Stories. (Built in that
  order of priority — see build order.)
- **Multi-account:** first-class from day one. The dashboard must make it **obvious which
  account a post is headed to before it's scheduled**. Credentials are stored **per-channel**,
  not globally.
- **Approval step:** a `requires_approval` field exists per channel, **defaulting to off** so
  the owner's own use stays frictionless; a full review workflow can be turned on later for
  multi-user installs.
- **Timezones:** **per-channel** IANA timezone. All times stored UTC, displayed/interpreted in
  the channel's zone.
- **Hashtags / first comment:** a separate `first_comment` field, **auto-posted as the first
  comment after publish** (keeps the caption clean).
- **Tagging:** simple **free-form tags** on posts/assets, filterable in the dashboard.
- **Partial failure:** each channel target is an **independent publication with its own
  status**; failures **auto-retry with exponential backoff**, then rest in a **visible
  `failed`** state with a manual retry.
- **Performance ranking (for auto-fill):** **per-channel** — a post's performance is judged on
  the specific channel's audience.
- **Dry-run mode, rate-limit self-pacing, and a kill switch** are all in v1.
- **Metrics retention:** keep every snapshot in v1; add rollup/pruning later.

## Core data model (see design spec + migrations for detail)
`assets` (content-hash dedup, public URL, thumbnail) · `posts` (caption, first_comment,
status, post_type, created_by) · `post_assets` (ordered join — carousel order) · `channels`
(platform + account + business label + timezone + credentials + cadence + approval flag) ·
`publications` (one row per post→channel→time; independent status; the thing that makes
recycling possible) · `post_metrics` (time-series per publication) · `tags` + `post_tags` ·
`publish_limits` (cached content_publishing_limit per channel).

## Scheduling
- **Manual** (a post, a time, channel(s)).
- **Bulk** (N posts at a fixed cadence from the next open slot).
- **Auto-fill** (per-channel cadence + min-queue-depth top-up to a target depth).
- **Auto-fill selection order:** (1) never-posted → (2) not posted in 180+ days *(configurable)*
  → (3) per-channel top performers (reach/saves) not reused in 180+ days.

## Build order
1. DB schema + migrations (all tables).
2. Python publish worker → **Instagram, image + carousel only**, against a test account
   (container → status → publish, rate-limit check, dry-run).
3. Dashboard composer + overview (compose → schedule → watch it publish).
4. Scheduling + auto-fill logic.
5. Metrics fetch job (feeds per-channel performance ranking).
6. Extend adapters: Facebook Pages → Reels/video → Stories → first-comment automation →
   approval workflow UI.

## What good looks like
- A fresh clone can be configured with its own `.env` + Meta app, run migrations, connect a
  channel, and **do a dry-run publish** that shows exactly what *would* post — before anything
  goes live.
- Composing a post makes it **unmistakable which account(s) it targets** and in what carousel
  order, before scheduling.
- The worker **paces itself against Meta's real quota** and **never silently swallows a
  failure** — a failed publish is visibly failed and retryable.
- The same asset can be **scheduled and re-published over time** (recycling), and the system
  can auto-refill a thin queue using the selection rules.
- The whole thing runs locally with **no paid service** and can be **stopped instantly**.

## What to avoid
- Any shared backend, hosted service, login/accounts system, or cross-install coupling.
- Any paid tool or cloud dependency sneaking into the stack.
- Hardcoding the rate limit, or publishing without checking the account's real quota.
- Dedup by filename (must be content hash).
- Silent failures, or all-or-nothing publishing across channels.
- Skipping the container `status_code` check before publishing video/carousel.
- Storing image assets behind Drive/Dropbox share links (Meta can't fetch them).
- Over-polishing the UI at the expense of transparency; this is an internal tool.
- Building the full approval workflow, video, Stories, or Facebook adapters before the IG
  image/carousel pipeline works end-to-end.
