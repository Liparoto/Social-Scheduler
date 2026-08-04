"use client";

import { useEffect, useState } from "react";
import { PeriodAttach } from "@/components/period-attach";
import { TagEditor } from "@/components/tag-editor";
import type { ContentKind, ContentStatus, Period, PeriodMode, Tag } from "@/lib/types";

/**
 * Edit one post's common metadata without leaving the Library — status, kind, cooldown,
 * tags and period links. Saves through the SAME `PATCH /api/posts/[id]/content` the full
 * editor at `/library/[id]` uses, so there is only ever one write path and one set of
 * validators to keep correct.
 *
 * Deliberately NOT here: captions (a post has 1..N variants, so "edit the caption" is
 * ambiguous in a small dialog), images, scheduled sends and targets. Those have real
 * consequences and already have considered UI in the full editor. Fields this dialog
 * doesn't send are left untouched by the route.
 *
 * Every value it opens with is passed in from the Library list — no fetch on open, because
 * the list query already carries all of it.
 *
 * DIRTY-STATE BEHAVIOUR: **confirm-on-dismiss** (decided 2026-08-03, recorded in
 * docs/tasks.md). Every dismissal path — Cancel, the ✕, Esc and click-outside — asks
 * "Discard changes?" while anything differs from what the dialog opened with. Dismissing
 * with no changes closes silently, so there is no friction when nothing is at stake.
 *
 * Why it matters: this project has already been bitten once by an unsaved edit looking
 * saved (Post-now published the stale saved caption, so PostEditor now blocks the submit
 * while dirty). A modal makes that easier to hit, not harder — Esc and a stray click both
 * dismiss it. Save-then-close was rejected: an accidental Esc would write to the DB with
 * no way to back out, and a save that fails after the dialog is gone has nowhere to report
 * itself. An edit is never silently dropped and never silently committed.
 */

export interface QuickEditPost {
  id: number;
  caption: string | null;
  content_status: ContentStatus;
  content_kind: ContentKind;
  cooldown_days: number | null;
  tag_ids: number[];
  /** Same collapse the full editor does: one mode per period. */
  periods: { id: number; mode: PeriodMode }[];
}

export function QuickEditModal({
  post,
  periods,
  timeOfDayTags,
  topicTags,
  onClose,
  onSaved,
}: {
  post: QuickEditPost;
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<ContentStatus>(post.content_status);
  const [kind, setKind] = useState<ContentKind>(post.content_kind);
  const [cooldown, setCooldown] = useState(
    post.cooldown_days === null ? "" : String(post.cooldown_days)
  );
  const [tagIds, setTagIds] = useState<number[]>(post.tag_ids);
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>(() =>
    Object.fromEntries(post.periods.map((p) => [p.id, p.mode]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const field =
    "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";

  // Compared against the values this dialog opened with, field by field, so re-picking a
  // tag you just removed reads as clean rather than as a change. Ids are sorted because
  // TagEditor appends in click order; periods are keyed by id for the same reason.
  const sortedIds = (ids: number[]) => JSON.stringify([...ids].sort((a, b) => a - b));
  const normalizedPeriods = (entries: [number, PeriodMode][]) =>
    JSON.stringify([...entries].sort((a, b) => a[0] - b[0]));
  const cooldownValue = cooldown.trim() === "" ? null : Number(cooldown);
  const isDirty =
    status !== post.content_status ||
    kind !== post.content_kind ||
    cooldownValue !== post.cooldown_days ||
    sortedIds(tagIds) !== sortedIds(post.tag_ids) ||
    normalizedPeriods(
      Object.entries(periodModes).map(([pid, mode]) => [Number(pid), mode])
    ) !== normalizedPeriods(post.periods.map((p) => [p.id, p.mode]));

  /** The single funnel every dismissal path goes through. Nothing calls onClose directly. */
  function requestClose() {
    if (saving) return;
    if (isDirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      // Esc never destroys: while the discard prompt is up it backs out of the prompt
      // (= keep editing) rather than confirming the discard it just asked about.
      if (confirmingDiscard) {
        setConfirmingDiscard(false);
        return;
      }
      requestClose();
    }
    // Capture phase so this runs before anything else listening for Esc on the page.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // No dependency array on purpose: the handler closes over isDirty, which changes with
    // every keystroke. A stale closure here would be exactly the silent-discard bug.
  });

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${post.id}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content_status: status,
          content_kind: kind,
          cooldown_days: cooldown.trim() === "" ? null : Number(cooldown),
          tag_ids: tagIds,
          period_links: Object.entries(periodModes).map(([pid, mode]) => ({
            periodId: Number(pid),
            mode,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Stay open with the user's input intact — a rejected save must never look like
        // a successful one, and retyping the edit to retry it is pure friction.
        setError(body.error ?? "Could not save these changes.");
        return;
      }
      onSaved();
    } catch {
      setError("Could not confirm whether the save completed. Reopen this post to check.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-edit-title"
      // mousedown, not click: a text selection that starts inside the panel and ends on
      // the backdrop would otherwise read as a click-outside and try to dismiss the
      // dialog mid-edit. currentTarget check keeps it to the backdrop itself.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="quick-edit-title" className="font-display text-xl font-semibold text-ink">
              Quick edit
            </h2>
            <p className="mt-1 line-clamp-1 text-sm text-muted">
              {post.caption || <span className="italic text-faint">No caption</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-sunken hover:text-ink"
            aria-label="Close quick edit"
          >
            ✕
          </button>
        </div>

        <section className="mt-5 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-ink-soft">
            <span className="mb-1 block">Status</span>
            <select
              className={`${field} w-full`}
              value={status}
              onChange={(e) => setStatus(e.target.value as ContentStatus)}
            >
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="retired">Retired</option>
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            <span className="mb-1 block">Kind</span>
            <select
              className={`${field} w-full`}
              value={kind}
              onChange={(e) => setKind(e.target.value as ContentKind)}
            >
              <option value="evergreen">Evergreen</option>
              <option value="one_time">One-time</option>
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            <span className="mb-1 block">Cooldown days</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder="Channel default"
              className={`${field} w-full`}
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
            />
          </label>
        </section>
        <p className="mt-1.5 text-[11px] text-faint">
          Leave cooldown blank to use the channel default.
        </p>

        <section className="mt-5 border-t border-border pt-5">
          <TagEditor
            timeOfDayTags={timeOfDayTags}
            topicTags={topicTags}
            value={tagIds}
            onChange={setTagIds}
          />
        </section>

        <section className="mt-5 border-t border-border pt-5">
          <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />
        </section>

        {error ? (
          <p className="mt-4 text-sm text-status-failed" role="alert">
            {error}
          </p>
        ) : null}

        {confirmingDiscard ? (
          <div
            className="mt-4 rounded-lg border border-status-failed/40 bg-status-failed/5 p-4"
            role="alertdialog"
            aria-labelledby="quick-edit-discard-title"
          >
            <p id="quick-edit-discard-title" className="text-sm font-semibold text-ink">
              Discard changes?
            </p>
            <p className="mt-1 text-xs text-muted">
              Your edits to this post have not been saved yet.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDiscard(false)}
                autoFocus
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-sunken"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-status-failed/50 px-3 py-1.5 text-sm font-medium text-status-failed hover:bg-status-failed/10"
              >
                Discard
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-[11px] text-faint">
            Captions, images, targets and sends stay in the full editor.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={requestClose}
              disabled={saving}
              className="rounded-lg border border-border px-4 py-2 text-sm text-ink hover:bg-surface-sunken disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
