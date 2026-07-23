# Design — Manual metrics refresh

**Status:** approved 2026-07-23, ready for implementation planning
**Part of:** the "post workflow" batch (item 2 of 4).

---

## 1. Purpose

The worker already auto-fetches post metrics (reach/saves/likes…) on an interval, and the
Overview displays them. But there's no way to say "update this posted item's metrics **now**" —
you wait for the worker's next scheduled refresh (gated to once per `metrics_min_interval_hours`,
default 6h). This adds an on-demand refresh: per posted publication, plus a "refresh all posted".

Because the dashboard and worker communicate **only through the shared DB** (no direct API), the
refresh is a **request**, not an instant fetch: the UI sets a flag, the worker honors it on its
next poll (~30s) and clears it. The UI is honest about this ("queued — updates after the next
worker run").

---

## 2. Mechanism — a flag column (the DB contract)

Add a nullable column `publications.metrics_refresh_requested_at TEXT` (migration `0004`).

- **UI → sets the flag** to now.
- **Worker → honors it as an override of the interval gate**, then **clears it** after one attempt.

`metrics.publications_needing_metrics` keeps all its base filters (status `posted`, non-dry-run,
`remote_post_id` present, published within `max_age_days`) but replaces the interval-only gate
with:

```sql
AND (
  NOT EXISTS (SELECT 1 FROM post_metrics pm
              WHERE pm.publication_id = pub.id AND pm.fetched_at > :interval_cutoff)
  OR pub.metrics_refresh_requested_at IS NOT NULL   -- manual override
)
```

`run_metrics` clears the flag for any flagged publication it processes — **on every path**
(success, no-token skip, or fetch failure) via a `try/finally` — so one click forces exactly one
fetch attempt and never loops. Clearing is `UPDATE publications SET metrics_refresh_requested_at =
NULL WHERE id = ?`.

This override only bypasses the *timing* gate; a dry-run or unpublished row still can't be
fetched (the base filters stand), and a flag on such a row is simply ignored by the query.

---

## 3. Components

### New
1. **Migration** `migrations/0004_metrics_refresh.sql`:
   `ALTER TABLE publications ADD COLUMN metrics_refresh_requested_at TEXT;` (additive).

2. **Worker** (`worker/metrics.py`): the query override (§2) + flag-clearing in `run_metrics`
   (`try/finally`). Tests cover: a recently-fetched pub is skipped normally but returned when
   flagged; the flag is cleared after `run_metrics` (success and failure paths).

3. **Routes** (`export const runtime = "nodejs"`):
   - `POST /api/publications/[id]/refresh-metrics` — the publication must exist (404) and be
     `posted` + non-dry-run (400 otherwise); set `metrics_refresh_requested_at = now`. `{ ok: true }`.
   - `POST /api/metrics/refresh-all` — set the flag on **all** eligible posted, non-dry-run
     publications (a single `UPDATE ... WHERE status='posted' AND is_dry_run=0 AND remote_post_id
     IS NOT NULL AND remote_post_id != 'DRYRUN'`); return `{ requested: <rowcount> }`.
   - Query helpers in `dashboard/lib/queries.ts`: `requestMetricsRefresh(publicationId): "ok" |
     "not_found" | "not_posted"` and `requestMetricsRefreshAll(): number`.

4. **UI**:
   - `dashboard/components/publication-actions.tsx` — add a **posted** branch (non-dry-run) with a
     "Refresh metrics" button → POST the per-publication route → shows "Queued" (transient), then
     `router.refresh()`. (Pass `isDryRun` from the Overview so dry-run rows don't show it.)
   - `dashboard/app/page.tsx` — a "Refresh all metrics" button in the Overview header/queue
     section → POST `/api/metrics/refresh-all` → shows "Queued N" → `router.refresh()`. (A small
     client component, since the page is otherwise server-rendered.)

### Reused
- The metrics display already on the Overview (reach/saves/likes) — unchanged; it just shows
  fresher numbers after the worker runs.

---

## 4. UX / correctness

- **Honest async:** buttons confirm the refresh is **queued**, not done. Copy: "Refresh queued —
  metrics update after the next worker run." No fake instant numbers.
- **One-shot:** the worker clears the flag after one attempt, so a queued refresh doesn't loop
  even if the fetch fails (failure is logged, non-fatal — matches existing behavior).
- **Dry-run/unposted safety:** the per-publication route rejects non-posted/dry-run rows; the
  refresh-all `UPDATE` excludes them; the worker query ignores a flag on an ineligible row.
- **No secrets exposed:** the flag is a timestamp; tokens/PII are never logged or returned
  (unchanged from existing metrics handling).

---

## 5. Verification

- `migrations`: 0004 applies additively (column present, default null) — migration test.
- `worker`: `pytest` — flagged pub returned despite recent fetch; flag cleared after `run_metrics`
  (fake client, success + failure).
- `dashboard`: `npx tsc --noEmit` clean. Curl `POST /api/publications/<id>/refresh-metrics` on a
  posted pub → `{ok:true}` and DB shows the flag set; on a non-posted pub → 400. Curl
  `/api/metrics/refresh-all` → `{requested:n}`. Browser: a "Refresh metrics" button shows on
  posted rows and confirms "Queued"; "Refresh all metrics" in the header confirms "Queued N".
- Owner note: seeing updated numbers requires the worker running (and live Meta tokens) — the
  refresh sets the request; the fetch happens on the worker's next poll.

---

## 6. Out of scope (deferred)
- A metrics history/chart view; scheduling of refreshes; per-metric selection. This is just an
  on-demand "fetch now" request over the existing metrics pipeline.
