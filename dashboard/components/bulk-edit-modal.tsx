"use client";

import { useState } from "react";
import { PeriodAttach } from "@/components/period-attach";
import { TagEditor } from "@/components/tag-editor";
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

export function BulkEditModal({
  postIds,
  periods,
  timeOfDayTags,
  topicTags,
  onClose,
  onSaved,
}: BulkEditModalProps) {
  const [tagAction, setTagAction] = useState<"add" | "remove">("add");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [periodAction, setPeriodAction] = useState<"add" | "remove">("add");
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>({});
  const [contentStatus, setContentStatus] = useState<ContentStatus | "unchanged">("unchanged");
  const [contentKind, setContentKind] = useState<ContentKind | "unchanged">("unchanged");
  const [cooldownMode, setCooldownMode] = useState<"unchanged" | "default" | "custom">(
    "unchanged"
  );
  const [cooldownDays, setCooldownDays] = useState(30);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft: BulkEditDraft = {
    tagAction,
    tagIds,
    periodAction,
    periodModes,
    contentStatus,
    contentKind,
    cooldownMode,
    cooldownDays,
  };
  const allTags = [...timeOfDayTags, ...topicTags];
  const labels = bulkEditChangeLabels(draft, allTags, periods);
  const cooldownInvalid =
    cooldownMode === "custom" && (!Number.isInteger(cooldownDays) || cooldownDays < 0);
  const field =
    "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";
  const actionButton = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${
      active
        ? "border-brand bg-brand-weak text-brand-strong"
        : "border-border bg-surface text-muted hover:bg-surface-sunken"
    }`;

  async function apply() {
    if (labels.length === 0 || cooldownInvalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/posts/bulk-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBulkEditPayload(postIds, draft)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Could not apply the bulk edit.");
        return;
      }
      onSaved(labels);
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
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-xl">
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
            {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
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

            <section className="mt-6 border-t border-border pt-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Tags</h3>
                  <p className="text-xs text-muted">Choose tags, then say explicitly whether to add or remove them.</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={actionButton(tagAction === "add")} onClick={() => setTagAction("add")}>Add these tags</button>
                  <button type="button" className={actionButton(tagAction === "remove")} onClick={() => setTagAction("remove")}>Remove these tags</button>
                </div>
              </div>
              <TagEditor
                timeOfDayTags={timeOfDayTags}
                topicTags={topicTags}
                value={tagIds}
                onChange={setTagIds}
                allowCreateTopic={false}
              />
            </section>

            <section className="mt-6 border-t border-border pt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Periods</h3>
                  <p className="text-xs text-muted">Choose the exact green or blackout link to attach or detach.</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={actionButton(periodAction === "add")} onClick={() => setPeriodAction("add")}>Attach these periods</button>
                  <button type="button" className={actionButton(periodAction === "remove")} onClick={() => setPeriodAction("remove")}>Detach these periods</button>
                </div>
              </div>
              <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />
            </section>

            <section className="mt-6 border-t border-border pt-5">
              <h3 className="text-sm font-semibold text-ink">Set shared values</h3>
              <p className="mb-3 text-xs text-muted">Leave a field unchanged to preserve each post&apos;s current value.</p>
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

            {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
            <div className="mt-6 flex items-center justify-between gap-4">
              <p className="text-xs text-muted">
                {labels.length === 0 ? "Choose at least one change." : `${labels.length} change${labels.length === 1 ? "" : "s"} ready to review.`}
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm text-ink hover:bg-surface-sunken">Cancel</button>
                <button
                  type="button"
                  onClick={() => setReviewing(true)}
                  disabled={labels.length === 0 || cooldownInvalid}
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
