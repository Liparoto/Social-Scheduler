# Manual Metrics Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner request an on-demand metrics fetch — per posted publication and "all posted" — via a flag the worker honors on its next poll.

**Architecture:** A nullable `publications.metrics_refresh_requested_at` column is the DB contract. The dashboard sets it (routes + query helpers + Overview buttons); the worker's metrics job treats it as an override of the 6h interval gate and clears it after one attempt.

**Tech Stack:** Python 3.11 stdlib worker (+pytest); Next.js 16 App Router + TypeScript + better-sqlite3; plain-SQL migrations.

## Global Constraints

- **Schema lives in `/migrations/*.sql`, additive only.** New file: `migrations/0004_metrics_refresh.sql`. Never edit an applied migration.
- **All Next.js route handlers: `export const runtime = "nodejs"`.**
- **Worker ↔ dashboard communicate only through the shared DB** (WAL, FK ON). No new dependency (Python stdlib only; no new JS deps).
- **The flag overrides only the *timing* gate.** The base eligibility filters (status `posted`, `is_dry_run=0`, `remote_post_id` present & not `'DRYRUN'`, published within `max_age_days`) still stand — a flag on an ineligible row is ignored.
- **One-shot:** the worker clears the flag after exactly one attempt (success, no-token, or failure) via `try/finally`, so a queued refresh never loops.
- **Honest async UX:** buttons confirm the refresh is **queued**, not done ("updates after the next worker run"). No fake instant numbers. Never log/return tokens or PII.
- Spec: `docs/design-metrics-refresh.md`.

### Reused interfaces (verified)
- `worker/metrics.py`: `publications_needing_metrics(conn, now, max_age_days, min_interval_hours)` and `run_metrics(conn, config, client, now, logger=None) -> int`.
- Metrics test helpers in `worker/tests/test_metrics.py`: `_channel(conn, token="tok")`, `_posted_pub(conn, channel_id, *, published_at, remote_id="media-1", dry_run=0) -> (post_id, pub_id)`, `_snapshots(conn, pub_id)`, `NOW`. `FakeGraphClient(fail_on=[...])` from `worker/tests/conftest.py` (raises on `get_media_insights` when `"insights"` in `fail_on`). The `config` fixture leaves `metrics_max_age_days=30`, `metrics_min_interval_hours=6` (defaults).
- `dashboard/lib/queries.ts`: `getDb()`, `nowIso()` already imported. Overview passes `<PublicationActions id={p.id} status={p.status} />` (page.tsx:180); the row `p` has `is_dry_run`.

---

### Task 1: Migration `0004` — the flag column

**Files:**
- Create: `migrations/0004_metrics_refresh.sql`
- Test: `worker/tests/test_migration_0004.py`

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_migration_0004.py`:

```python
"""0004 adds the metrics-refresh flag column additively."""
from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


def _apply(conn, name):
    conn.executescript((MIG / name).read_text())
    conn.commit()


def test_0004_adds_flag_column(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "m.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for name in ("0001_init.sql", "0002_content_model.sql",
                 "0003_tag_taxonomy.sql", "0004_metrics_refresh.sql"):
        _apply(conn, name)

    cols = [r["name"] for r in conn.execute("PRAGMA table_info(publications)").fetchall()]
    assert "metrics_refresh_requested_at" in cols

    # New publications default the flag to NULL.
    conn.execute("INSERT INTO channels (platform, account_name) VALUES ('instagram','C')")
    conn.execute("INSERT INTO posts (post_type) VALUES ('single')")
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at) "
                 "VALUES (1, 1, '2026-01-01T00:00:00+00:00')")
    conn.commit()
    row = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id=1"
    ).fetchone()
    assert row["metrics_refresh_requested_at"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && .venv/bin/python -m pytest worker/tests/test_migration_0004.py -v`
Expected: FAIL — migration file not found / column missing.

- [ ] **Step 3: Write the migration**

Create `migrations/0004_metrics_refresh.sql`:

```sql
-- 0004_metrics_refresh.sql
-- On-demand metrics refresh: the dashboard sets this timestamp to REQUEST a metrics
-- fetch for a posted publication; the worker honors it (bypassing the once-per-interval
-- gate) on its next poll, then clears it. NULL = no pending request. Additive.
ALTER TABLE publications ADD COLUMN metrics_refresh_requested_at TEXT;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest worker/tests/test_migration_0004.py -v`
Expected: PASS.

- [ ] **Step 5: Full worker suite (schema build sanity)**

Run: `.venv/bin/python -m pytest worker/tests/ -q`
Expected: all pass (conftest globs all migrations).

- [ ] **Step 6: Commit**

```bash
git add migrations/0004_metrics_refresh.sql worker/tests/test_migration_0004.py
git commit -m "feat(schema): 0004 metrics_refresh_requested_at flag on publications"
```

---

### Task 2: Worker honors + clears the flag

**Files:**
- Modify: `worker/metrics.py` (`publications_needing_metrics` query + `run_metrics` flag-clear)
- Test: `worker/tests/test_metrics.py` (append cases)

**Interfaces:**
- Behavior: a flagged posted pub is returned by `publications_needing_metrics` even within the interval; `run_metrics` clears the flag after one attempt on every path.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_metrics.py`:

```python
def test_manual_flag_overrides_interval_and_is_cleared(conn, config, fake_client):
    ch = _channel(conn)
    _, pub = _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat())
    # A fresh snapshot at NOW → within the 6h interval, so normally skipped.
    conn.execute(
        "INSERT INTO post_metrics (publication_id, fetched_at, reach) VALUES (?,?,10)",
        (pub, NOW.isoformat()),
    )
    conn.commit()
    assert run_metrics(conn, config, fake_client, NOW) == 0  # gated by interval

    conn.execute(
        "UPDATE publications SET metrics_refresh_requested_at=? WHERE id=?",
        (NOW.isoformat(), pub),
    )
    conn.commit()
    assert run_metrics(conn, config, fake_client, NOW) == 1  # flag overrides the gate
    flag = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id=?", (pub,)
    ).fetchone()[0]
    assert flag is None  # cleared after the fetch


def test_manual_flag_cleared_even_on_fetch_failure(conn, config):
    from worker.tests.conftest import FakeGraphClient
    ch = _channel(conn)
    _, pub = _posted_pub(conn, ch, published_at=(NOW - timedelta(days=1)).isoformat())
    conn.execute(
        "UPDATE publications SET metrics_refresh_requested_at=? WHERE id=?",
        (NOW.isoformat(), pub),
    )
    conn.commit()
    client = FakeGraphClient(fail_on=["insights"])
    assert run_metrics(conn, config, client, NOW) == 0  # fetch failed, nothing recorded
    flag = conn.execute(
        "SELECT metrics_refresh_requested_at FROM publications WHERE id=?", (pub,)
    ).fetchone()[0]
    assert flag is None  # cleared even though the fetch failed
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest worker/tests/test_metrics.py -k manual_flag -v`
Expected: FAIL — flagged pub not returned (override missing) / flag not cleared.

- [ ] **Step 3: Update `publications_needing_metrics`**

In `worker/metrics.py`, replace the `NOT EXISTS (...)` gate with the flag-aware version. The query becomes:

```python
    return conn.execute(
        """
        SELECT pub.* FROM publications pub
        WHERE pub.status = 'posted'
          AND pub.is_dry_run = 0
          AND pub.remote_post_id IS NOT NULL
          AND pub.remote_post_id != 'DRYRUN'
          AND pub.published_at IS NOT NULL
          AND pub.published_at >= ?
          AND (
            NOT EXISTS (
              SELECT 1 FROM post_metrics pm
              WHERE pm.publication_id = pub.id AND pm.fetched_at > ?
            )
            OR pub.metrics_refresh_requested_at IS NOT NULL
          )
        """,
        (max_age_cutoff, interval_cutoff),
    ).fetchall()
```

(Bind order is unchanged: `max_age_cutoff` then `interval_cutoff`.)

- [ ] **Step 4: Clear the flag in `run_metrics`**

Wrap the per-pub body in `try/finally` so the flag is cleared on every path. Replace the loop body:

```python
    for pub in due:
        was_flagged = pub["metrics_refresh_requested_at"] is not None
        try:
            channel = conn.execute(
                "SELECT access_token FROM channels WHERE id = ?", (pub["channel_id"],)
            ).fetchone()
            token = channel["access_token"] if channel else None
            if not token:
                continue
            try:
                insights = client.get_media_insights(
                    pub["remote_post_id"], token, REQUESTED_METRICS
                )
            except Exception as exc:  # noqa: BLE001 — a metrics fetch failure is non-fatal
                if logger:
                    logger.info("[metrics pub %s] fetch failed: %s", pub["id"], exc)
                continue
            _record(conn, pub["id"], now_iso, insights)
            fetched += 1
        finally:
            if was_flagged:
                conn.execute(
                    "UPDATE publications SET metrics_refresh_requested_at = NULL WHERE id = ?",
                    (pub["id"],),
                )
                conn.commit()
```

- [ ] **Step 5: Run the metrics tests + full suite**

Run: `.venv/bin/python -m pytest worker/tests/test_metrics.py -v && .venv/bin/python -m pytest worker/tests/ -q`
Expected: all pass (existing metrics tests unaffected — an unflagged pub with no recent snapshot still fetches; the interval gate still applies when no flag is set).

- [ ] **Step 6: Commit**

```bash
git add worker/metrics.py worker/tests/test_metrics.py
git commit -m "feat(worker): honor + clear metrics_refresh_requested_at (manual refresh)"
```

---

### Task 3: Query helpers + API routes

**Files:**
- Modify: `dashboard/lib/queries.ts` (add two functions)
- Create: `dashboard/app/api/publications/[id]/refresh-metrics/route.ts`
- Create: `dashboard/app/api/metrics/refresh-all/route.ts`

**Interfaces:**
- `requestMetricsRefresh(publicationId: number): "ok" | "not_found" | "not_posted"`
- `requestMetricsRefreshAll(): number` (rows flagged)
- `POST /api/publications/[id]/refresh-metrics` → `{ ok: true }` | 404 | 400
- `POST /api/metrics/refresh-all` → `{ requested: number }`

- [ ] **Step 1: Add the query helpers**

In `dashboard/lib/queries.ts`, near the other publication helpers (after `approvePublication`, ~line 500), add:

```typescript
/** Flag a posted, non-dry-run publication for an on-demand metrics fetch. */
export function requestMetricsRefresh(
  publicationId: number
): "ok" | "not_found" | "not_posted" {
  const db = getDb();
  const pub = db
    .prepare("SELECT status, is_dry_run FROM publications WHERE id = ?")
    .get(publicationId) as { status: string; is_dry_run: number } | undefined;
  if (!pub) return "not_found";
  if (pub.status !== "posted" || pub.is_dry_run === 1) return "not_posted";
  db.prepare(
    "UPDATE publications SET metrics_refresh_requested_at = ? WHERE id = ?"
  ).run(nowIso(), publicationId);
  return "ok";
}

/** Flag ALL eligible posted publications for a metrics fetch. Returns the count flagged. */
export function requestMetricsRefreshAll(): number {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE publications SET metrics_refresh_requested_at = ?
        WHERE status = 'posted' AND is_dry_run = 0
          AND remote_post_id IS NOT NULL AND remote_post_id != 'DRYRUN'`
    )
    .run(nowIso());
  return info.changes;
}
```

- [ ] **Step 2: Create `dashboard/app/api/publications/[id]/refresh-metrics/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { requestMetricsRefresh } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = requestMetricsRefresh(Number(id));
  if (result === "not_found") {
    return NextResponse.json({ error: "Publication not found." }, { status: 404 });
  }
  if (result === "not_posted") {
    return NextResponse.json(
      { error: "Only posted (non-dry-run) publications can refresh metrics." },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create `dashboard/app/api/metrics/refresh-all/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { requestMetricsRefreshAll } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST() {
  const requested = requestMetricsRefreshAll();
  return NextResponse.json({ requested });
}
```

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/queries.ts "dashboard/app/api/publications/[id]/refresh-metrics/route.ts" dashboard/app/api/metrics/refresh-all/route.ts
git commit -m "feat(dashboard): metrics-refresh query helpers + API routes"
```

---

### Task 4: UI — per-row + Overview "Refresh all"

**Files:**
- Modify: `dashboard/components/publication-actions.tsx` (posted branch)
- Create: `dashboard/components/refresh-all-metrics.tsx` (client)
- Modify: `dashboard/app/page.tsx` (pass `isDryRun`; add the Refresh-all button)

- [ ] **Step 1: Add a posted branch to `publication-actions.tsx`**

Add an `isDryRun` prop and a "Refresh metrics" action. Extend the component:

```tsx
export function PublicationActions({
  id,
  status,
  isDryRun = false,
}: {
  id: number;
  status: PublicationStatus;
  isDryRun?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
```

Keep the existing `act(...)` (retry/approve) and its `failed`/`pending_approval` branches unchanged. Add a refresh handler and a posted branch:

```tsx
  async function refreshMetrics() {
    setError(null);
    const res = await fetch(`/api/publications/${id}/refresh-metrics`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    setQueued(true);
    startTransition(() => router.refresh());
  }
```

And before the final `return null;`, add:

```tsx
  if (status === "posted" && !isDryRun) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={refreshMetrics}
          disabled={pending || queued}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
          title="Queue a metrics fetch on the next worker run"
        >
          {queued ? "Queued ✓" : "Refresh metrics"}
        </button>
        {error ? <span className="text-[10px] text-status-failed">{error}</span> : null}
      </div>
    );
  }
```

- [ ] **Step 2: Pass `isDryRun` from the Overview**

In `dashboard/app/page.tsx` line ~180, change:

```tsx
<PublicationActions id={p.id} status={p.status} isDryRun={p.is_dry_run === 1} />
```

- [ ] **Step 3: Create `dashboard/components/refresh-all-metrics.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RefreshAllMetrics() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setMsg(null);
    const res = await fetch("/api/metrics/refresh-all", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(body.error ?? "Something went wrong.");
      return;
    }
    setMsg(`Queued ${body.requested} — updates after the next worker run.`);
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2">
      {msg ? <span className="data text-[11px] text-muted">{msg}</span> : null}
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
      >
        {pending ? "Queuing…" : "Refresh all metrics"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Add the Refresh-all button to the Overview queue header**

In `dashboard/app/page.tsx`, import `RefreshAllMetrics` and render it in the queue section's header (near the "The queue itself" section heading — around line 89-96, the `<h2>`/description block). Place `<RefreshAllMetrics />` beside that heading (e.g. a flex row with the heading on the left and the button on the right). Do not change the queue table itself.

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Browser verification (controller runs this; list it)**

Note for the controller: on the Overview, posted (non-dry-run) rows show a "Refresh metrics" button that, when clicked, shows "Queued ✓" and (DB) sets `metrics_refresh_requested_at`; a "Refresh all metrics" button in the queue header shows "Queued N …". Dry-run posted rows do NOT show the per-row button. (Fetching real numbers needs the worker running + live tokens — out of scope for this UI check.)

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/publication-actions.tsx dashboard/components/refresh-all-metrics.tsx dashboard/app/page.tsx
git commit -m "feat(dashboard): metrics-refresh UI — per-row + Overview refresh-all"
```

---

## Self-Review

**Spec coverage** (spec `docs/design-metrics-refresh.md`):
- §2 flag column + worker override + clear-on-all-paths → Tasks 1, 2. ✅
- §3 routes + query helpers + UI (per-row + refresh-all) → Tasks 3, 4. ✅
- §4 honest-async copy, one-shot clear, dry-run/unposted safety → Task 2 (finally-clear), Task 3 (route rejects non-posted; refresh-all excludes dry-run), Task 4 (queued copy; hidden on dry-run). ✅
- §5 verification (migration test, worker tests success+failure, tsc, browser) → each task's steps. ✅

**Placeholder scan:** No TBD/TODO. Full code in every code step; the two page edits are described against concrete existing line anchors (line 180; the queue section heading ~line 89-96).

**Type consistency:** `metrics_refresh_requested_at` column (Task 1) read by the worker (Task 2) and written by the query helpers (Task 3). `requestMetricsRefresh`/`requestMetricsRefreshAll` (Task 3) consumed by the routes (Task 3). `PublicationActions` gains `isDryRun?: boolean` (Task 4) supplied by the Overview (Task 4). Route response `{ok}` / `{requested}` matches the UI's reads.

---

## Out of scope (deferred, per spec §6)
- Metrics history/charts; scheduled refreshes; per-metric selection.
