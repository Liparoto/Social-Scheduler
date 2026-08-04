"use client";

import { useState } from "react";
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

  const field =
    "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";

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
            onClick={onClose}
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

        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-[11px] text-faint">
            Captions, images, targets and sends stay in the full editor.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
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
