"use client";

import { useEffect, useState } from "react";
import { PeriodAttach } from "@/components/period-attach";
import { TagEditor } from "@/components/tag-editor";
import {
  coverageLabel,
  coverageState,
  type BulkEditContext,
  type CoverageState,
} from "@/lib/bulk-edit-context";
import {
  buildBulkEditPayload,
  bulkEditChangeLabels,
  type BulkEditDraft,
} from "@/lib/bulk-edit-form";
import type { ContentKind, ContentStatus, Period, PeriodMode, Tag } from "@/lib/types";

interface BulkEditModalProps {
  postIds: number[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  onClose: () => void;
  onSaved: (labels: string[]) => void;
}

const coverageBadgeClass: Record<CoverageState, string> = {
  all: "border border-status-posted/30 bg-status-posted/15 text-status-posted",
  some: "border border-amber-300 bg-amber-100 text-amber-800",
  none: "border border-border bg-surface-sunken text-faint",
};

function CoverageBadge({ count, total }: { count: number; total: number }) {
  const state = coverageState(count, total);
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${coverageBadgeClass[state]}`}>
      {coverageLabel(count, total)}
    </span>
  );
}

function CurrentValueRow({
  label,
  values,
  total,
}: {
  label: string;
  values: { label: string; count: number }[];
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-20 shrink-0 font-medium text-ink-soft">{label}</span>
      {values.map((value) => (
        <span key={value.label} className="inline-flex items-center gap-1.5 text-ink">
          {value.label}
          <CoverageBadge count={value.count} total={total} />
        </span>
      ))}
    </div>
  );
}

function withoutMatchingPeriodLinks(
  current: Record<number, PeriodMode>,
  next: Record<number, PeriodMode>
): Record<number, PeriodMode> {
  const result = { ...current };
  for (const [periodId, mode] of Object.entries(next)) {
    if (result[Number(periodId)] === mode) delete result[Number(periodId)];
  }
  return result;
}

export function BulkEditModal({
  postIds,
  periods,
  timeOfDayTags,
  topicTags,
  onClose,
  onSaved,
}: BulkEditModalProps) {
  const [tagAdds, setTagAdds] = useState<number[]>([]);
  const [tagRemoves, setTagRemoves] = useState<number[]>([]);
  const [periodAdds, setPeriodAdds] = useState<Record<number, PeriodMode>>({});
  const [periodRemoves, setPeriodRemoves] = useState<Record<number, PeriodMode>>({});
  const [contentStatus, setContentStatus] = useState<ContentStatus | "unchanged">("unchanged");
  const [contentKind, setContentKind] = useState<ContentKind | "unchanged">("unchanged");
  const [cooldownMode, setCooldownMode] = useState<"unchanged" | "default" | "custom">(
    "unchanged"
  );
  const [cooldownDays, setCooldownDays] = useState(30);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [context, setContext] = useState<BulkEditContext | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const contextRequestBody = JSON.stringify({ post_ids: postIds });

  useEffect(() => {
    const controller = new AbortController();

    async function loadContext() {
      try {
        const response = await fetch("/api/posts/bulk-edit/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: contextRequestBody,
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error ?? "Could not load existing metadata.");
        }
        if (
          typeof body.post_count !== "number" ||
          !Array.isArray(body.tags) ||
          !Array.isArray(body.periods) ||
          !Array.isArray(body.content_statuses) ||
          !Array.isArray(body.content_kinds) ||
          !Array.isArray(body.cooldowns)
        ) {
          throw new Error("The existing metadata response was incomplete.");
        }
        setContext(body as BulkEditContext);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setContextError(
          loadError instanceof Error ? loadError.message : "Could not load existing metadata.",
        );
      } finally {
        if (!controller.signal.aborted) setContextLoading(false);
      }
    }

    loadContext();
    return () => controller.abort();
  }, [contextRequestBody, retryAttempt]);

  const draft: BulkEditDraft = {
    tagAdds,
    tagRemoves,
    periodAdds,
    periodRemoves,
    contentStatus,
    contentKind,
    cooldownMode,
    cooldownDays,
  };
  const allTags = [...timeOfDayTags, ...topicTags];
  const labels = bulkEditChangeLabels(draft, allTags, periods);
  const tagCoverage = Object.fromEntries(
    (context?.tags ?? []).map((row) => [row.tag_id, row.count]),
  ) as Record<number, number>;
  const periodCoverage = Object.fromEntries(
    (context?.periods ?? []).map((row) => [`${row.period_id}:${row.mode}`, row.count]),
  );
  const selectedPostCount = context?.post_count ?? 0;
  const cooldownInvalid =
    cooldownMode === "custom" && (!Number.isInteger(cooldownDays) || cooldownDays < 0);
  const field =
    "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";

  function chooseTagAdds(ids: number[]) {
    setTagAdds(ids);
    setTagRemoves((current) => current.filter((id) => !ids.includes(id)));
  }

  function chooseTagRemoves(ids: number[]) {
    setTagRemoves(ids);
    setTagAdds((current) => current.filter((id) => !ids.includes(id)));
  }

  function choosePeriodAdds(next: Record<number, PeriodMode>) {
    setPeriodAdds(next);
    setPeriodRemoves((current) => withoutMatchingPeriodLinks(current, next));
  }

  function choosePeriodRemoves(next: Record<number, PeriodMode>) {
    setPeriodRemoves(next);
    setPeriodAdds((current) => withoutMatchingPeriodLinks(current, next));
  }

  function retryContext() {
    setContext(null);
    setContextLoading(true);
    setContextError(null);
    setRetryAttempt((attempt) => attempt + 1);
  }

  async function apply() {
    if (labels.length === 0 || cooldownInvalid || busy) return;
    setBusy(true);
    setApplyError(null);
    try {
      const response = await fetch("/api/posts/bulk-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBulkEditPayload(postIds, draft)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setApplyError(body.error ?? "Could not apply the bulk edit.");
        return;
      }
      onSaved(labels);
    } catch {
      setApplyError("Could not confirm whether the edit completed. Refresh the Library before retrying.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-edit-title"
    >
      <div className="max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-xl">
        {reviewing ? (
          <>
            <h2 id="bulk-edit-title" className="font-display text-xl font-semibold text-ink">
              Apply {labels.length === 1 ? labels[0] : `${labels.length} changes`} to {postIds.length}{" "}
              post{postIds.length === 1 ? "" : "s"}?
            </h2>
            <p className="mt-2 text-sm text-muted">
              This updates every selected post in one atomic operation.
            </p>
            <ul className="mt-4 space-y-2 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-ink">
              {labels.map((label) => (
                <li key={label}>• {label}</li>
              ))}
            </ul>
            {applyError ? <p className="mt-3 text-sm text-status-failed">{applyError}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReviewing(false)}
                disabled={busy}
                className="rounded-lg border border-border px-4 py-2 text-sm text-ink hover:bg-surface-sunken disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={busy}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
              >
                {busy ? "Applying…" : "Confirm bulk edit"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="bulk-edit-title" className="font-display text-xl font-semibold text-ink">
                  Bulk edit {postIds.length} post{postIds.length === 1 ? "" : "s"}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Only fields you choose below will change. Existing unrelated tags and periods stay attached.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-sunken hover:text-ink"
                aria-label="Close bulk edit"
              >
                ✕
              </button>
            </div>

            {contextLoading ? (
              <div className="mt-6 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-muted" role="status">
                Loading existing metadata…
              </div>
            ) : null}
            {contextError ? (
              <div className="mt-6 rounded-lg border border-status-failed/40 p-4" role="alert">
                <p className="text-sm text-status-failed">{contextError}</p>
                <p className="mt-1 text-xs text-muted">
                  This read-only check did not change any posts.
                </p>
                <button
                  type="button"
                  onClick={retryContext}
                  className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm text-ink hover:bg-surface-sunken"
                >
                  Retry
                </button>
              </div>
            ) : null}

            {context ? (
              <>
                <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-xs text-muted">
                  <span className="font-medium text-ink-soft">Coverage</span>
                  <span className="inline-flex items-center gap-1.5">
                    <CoverageBadge count={selectedPostCount} total={selectedPostCount} />
                    on every selected post
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${coverageBadgeClass.some}`}>
                      Some
                    </span>
                    X of {selectedPostCount} means only that many selected posts
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <CoverageBadge count={0} total={selectedPostCount} />
                    on no selected posts
                  </span>
                </div>

            <section className="mt-6 border-t border-border pt-5">
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-ink">Tags</h3>
                <p className="text-xs text-muted">
                  Add and remove lists are separate. Choosing a tag in one list removes the same tag from the other.
                </p>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-card border border-status-posted/40 p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-status-posted">Add tags</p>
                  <TagEditor
                    timeOfDayTags={timeOfDayTags}
                    topicTags={topicTags}
                    value={tagAdds}
                    onChange={chooseTagAdds}
                    allowCreateTopic={false}
                    coverage={tagCoverage}
                    selectedPostCount={selectedPostCount}
                    disableFullCoverage
                  />
                </div>
                <div className="rounded-card border border-border p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-soft">Remove tags</p>
                  <TagEditor
                    timeOfDayTags={timeOfDayTags}
                    topicTags={topicTags}
                    value={tagRemoves}
                    onChange={chooseTagRemoves}
                    allowCreateTopic={false}
                    coverage={tagCoverage}
                    selectedPostCount={selectedPostCount}
                    hideZeroCoverage
                    emptyCoverageMessage="None of the selected posts have removable tags."
                  />
                </div>
              </div>
            </section>

            <section className="mt-6 border-t border-border pt-5">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-ink">Periods</h3>
                <p className="text-xs text-muted">Choose exact green or blackout links independently for attach and detach.</p>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-status-posted">Attach periods</p>
                  <PeriodAttach
                    periods={periods}
                    value={periodAdds}
                    onChange={choosePeriodAdds}
                    coverage={periodCoverage}
                    selectedPostCount={selectedPostCount}
                    disableFullCoverage
                  />
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Detach periods</p>
                  <PeriodAttach
                    periods={periods}
                    value={periodRemoves}
                    onChange={choosePeriodRemoves}
                    coverage={periodCoverage}
                    selectedPostCount={selectedPostCount}
                    hideZeroCoverage
                  />
                </div>
              </div>
            </section>

            <section className="mt-6 border-t border-border pt-5">
              <h3 className="text-sm font-semibold text-ink">Set shared values</h3>
              <p className="mb-3 text-xs text-muted">Leave a field unchanged to preserve each post&apos;s current value.</p>
              <div className="mb-4 space-y-2 rounded-lg border border-border bg-surface-sunken p-4" aria-label="Current values on selected posts">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Current selection</p>
                <CurrentValueRow
                  label="Status"
                  total={selectedPostCount}
                  values={context.content_statuses.map((row) => ({
                    label: { ready: "Ready", draft: "Draft", retired: "Retired" }[row.value],
                    count: row.count,
                  }))}
                />
                <CurrentValueRow
                  label="Kind"
                  total={selectedPostCount}
                  values={context.content_kinds.map((row) => ({
                    label: row.value === "one_time" ? "One-time" : "Evergreen",
                    count: row.count,
                  }))}
                />
                <CurrentValueRow
                  label="Cooldown"
                  total={selectedPostCount}
                  values={context.cooldowns.map((row) => ({
                    label: row.value === null ? "Channel default" : `${row.value} day${row.value === 1 ? "" : "s"}`,
                    count: row.count,
                  }))}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs text-ink-soft">
                  <span className="mb-1 block">Status</span>
                  <select className={`${field} w-full`} value={contentStatus} onChange={(e) => setContentStatus(e.target.value as ContentStatus | "unchanged")}>
                    <option value="unchanged">Leave unchanged</option>
                    <option value="draft">Draft</option>
                    <option value="ready">Ready</option>
                    <option value="retired">Retired</option>
                  </select>
                </label>
                <label className="text-xs text-ink-soft">
                  <span className="mb-1 block">Kind</span>
                  <select className={`${field} w-full`} value={contentKind} onChange={(e) => setContentKind(e.target.value as ContentKind | "unchanged")}>
                    <option value="unchanged">Leave unchanged</option>
                    <option value="evergreen">Evergreen</option>
                    <option value="one_time">One-time</option>
                  </select>
                </label>
                <label className="text-xs text-ink-soft">
                  <span className="mb-1 block">Cooldown</span>
                  <select className={`${field} w-full`} value={cooldownMode} onChange={(e) => setCooldownMode(e.target.value as typeof cooldownMode)}>
                    <option value="unchanged">Leave unchanged</option>
                    <option value="default">Use channel default</option>
                    <option value="custom">Set custom days</option>
                  </select>
                </label>
              </div>
              {cooldownMode === "custom" ? (
                <label className="mt-3 block max-w-48 text-xs text-ink-soft">
                  <span className="mb-1 block">Cooldown days</span>
                  <input type="number" min={0} step={1} className={`${field} w-full`} value={cooldownDays} onChange={(e) => setCooldownDays(Number(e.target.value))} />
                </label>
              ) : null}
              {cooldownInvalid ? <p className="mt-2 text-xs text-status-failed">Cooldown must be zero or a positive whole number.</p> : null}
            </section>

              </>
            ) : null}

            {applyError ? <p className="mt-3 text-sm text-status-failed">{applyError}</p> : null}
            <div className="mt-6 flex items-center justify-between gap-4">
              <p className="text-xs text-muted">
                {labels.length === 0 ? "Choose at least one change." : `${labels.length} change${labels.length === 1 ? "" : "s"} ready to review.`}
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm text-ink hover:bg-surface-sunken">Cancel</button>
                <button
                  type="button"
                  onClick={() => setReviewing(true)}
                  disabled={labels.length === 0 || cooldownInvalid || contextLoading || Boolean(contextError) || !context}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
                >
                  Review changes
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
