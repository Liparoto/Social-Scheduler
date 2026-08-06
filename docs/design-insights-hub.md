# Design — Insights Hub

Account-wide and per-post metrics for every connected profile, in one dashboard section.

Status: Instagram and Threads shipped 2026-08-05. Facebook Pages deferred — see
`docs/tasks.md` for the verified results and the open items.

---

## Why this needs new tables

`post_metrics` is keyed to `publication_id`. It can only ever describe posts **this tool
published** — which is exactly what `autofill` needs for performance ranking, and exactly
what an analytics hub cannot be limited to. A post made from the phone is invisible to it.

So the hub gets a second anchor: the account's real media list, as Meta sees it.

```
remote_media                       -- every post on the account, synced from the API
   publication_id  (nullable)      -- set only when this post is one we sent
```

The hub reads `remote_media` and never has to care which is which. A `publication_id`
badge in the UI is presentation, not structure.

**`post_metrics` is deliberately left alone.** It works, it is tested, and `autofill`
depends on it. Rewriting it to serve a second consumer would put a working publish-side
feature at risk for no gain.

## Tables

| Table | Grain | Purpose |
|---|---|---|
| `remote_media` | one row per post on the account | The account's media list: remote id, type, permalink, caption, thumbnail, published_at, nullable `publication_id` |
| `media_metrics` | one row per post per fetch | Per-post insights over time. Same column set as `post_metrics` plus `raw_json` |
| `account_metrics` | **one row per channel per UTC day** | Account-level daily snapshot: followers, reach, views, profile views, engaged accounts |
| `audience_demographics` | one row per channel/day/breakdown/dimension | `(age, "25-34", 412)`, `(country, "US", 1830)`, for followers / reached / engaged |

**Day-grain on `account_metrics` is the load-bearing choice.** Re-running the job upserts
today's row instead of appending, so charts are `SELECT ... ORDER BY day` with no dedup
logic anywhere, and a crashed or double-run job cannot corrupt a series.

Columns for the common metrics, `raw_json` for the rest — the same pattern `post_metrics`
already uses. That is what lets a Meta rename degrade to a null column instead of a crash.

## Worker jobs

Three new jobs, all **read-only**, all obeying the kill switch.

**`media_sync`** — pages `/{account}/media` (100/page). First run backfills up to
`MEDIA_SYNC_MAX_AGE_DAYS` (default 730) or `MEDIA_SYNC_MAX_POSTS` (default 2000),
whichever comes first. Afterwards it is incremental: it stops once it reaches posts it
already has.

**`account_metrics`** — daily account snapshot plus insights, upserted per UTC day.
Backfills whatever historical window the API allows on first run.

**`audience_sync`** — demographics, once per day. They barely move and cost an extra call
per breakdown, so they do not belong on the 6-hour cycle.

Being read-only, all three **run even when `DRY_RUN=1`**. A fresh clone gets a populated
Insights hub before it ever posts for real, which is the best possible dry-run check.

**No duplicate API calls.** When a `remote_media` row is one we published and
`post_metrics` already holds a fresh snapshot, the job copies those values across rather
than paying for the same insight twice.

**Rate limiting** is the real risk here — a full backfill on a large account is a lot of
calls. Per-cycle call cap, exponential backoff on 429, and read Meta's
`X-Business-Use-Case-Usage` header where it is returned rather than guessing a number.
Same rule as publishing: never hardcode a limit Meta will disagree with.

## Dashboard

New nav item **Insights**, between Overview and Channels.

`/insights` — one card per connected account: avatar, followers with 30-day delta, reach,
engagement rate, sparkline. Plus last-synced time and worker status, because metrics
reading zero is far more often a stopped daemon than a real zero.

`/insights/[channel]` —

- **Header** — account, followers + change, range picker (7 / 30 / 90 / all)
- **KPI row** — reach, views, profile views, accounts engaged, interactions, follower
  growth, each with period-over-period change
- **Trends** — line chart, toggleable metric, follower growth overlaid
- **Content leaderboard** — every post, sortable by any metric, filterable by type, with
  a badge on the ones we scheduled
- **Audience** — age, gender, top countries, top cities
- **Best time to post** — engagement by day-of-week x hour, computed from this account's
  own posts. More useful than Meta's version because it reflects actual results.

**Charts are hand-rolled inline SVG**, roughly 200 lines for sparkline / line / bar /
donut. A charting library does not clear this project's "no dependencies without clear
value" bar for four simple shapes, and would fight the existing theme-token system.

**Every card states what its platform cannot report.** A blank Facebook reach number must
read as "Meta retired this metric", never as "the app is broken".

## Known risks

**Metric names are volatile.** Meta retired a large batch on 2026-06-15. Account-insight
names therefore come from config (the pattern `fb_post_insight_metrics` already
establishes), and a probe script tests each name against the live account and reports what
works *before* the UI is wired to anything. No account metric name is hardcoded.

**Instagram host.** IG media reads may require `graph.instagram.com` rather than
`graph.facebook.com`, depending on whether the install uses the Instagram-Login or
Facebook-Login path. `clients.py` already resolves this per platform; media sync must go
through that resolver rather than assuming a host.

## Platform coverage

| Platform | Account metrics | Post metrics | Demographics |
|---|---|---|---|
| Instagram | Yes — richest set | Yes | Yes (needs 100+ followers) |
| Threads | Yes | Yes (no reach/saves) | Yes |
| Facebook Pages | Partial — names volatile | Partial | Partial |
| Discord / Telegram | None — no insights endpoint exists | None | None |

## Build order

| Phase | Scope |
|---|---|
| 1 | Migration + `media_sync` + live probe script |
| 2 | Instagram account metrics + audience sync |
| 3 | Insights hub UI — cards, per-account page, charts |
| 4 | Threads adapter |
| 5 | Facebook Pages adapter |
