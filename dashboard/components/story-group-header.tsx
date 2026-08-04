"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The heading above the slides of one Story.
 *
 * A 4-slide Story is 4 independent publications — that independence is deliberate (each
 * retries and fails on its own), but without a heading it reads as four unrelated sends,
 * and cancelling it means four separate two-click confirms.
 *
 * This row is presentation plus one bulk action. It deliberately does NOT own the slides'
 * state: each still shows its own status and actions, because a Story where slide 3 failed
 * and 1, 2 and 4 posted is a real outcome the queue has to be able to express.
 */
export function StoryGroupHeader({
  slideCount,
  caption,
  channelName,
  cancelableIds,
  workerOnline,
}: {
  slideCount: number;
  caption: string | null;
  channelName: string;
  /** Publications still cancelable — empty once they've all posted or failed. */
  cancelableIds: number[];
  workerOnline: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function cancelAll() {
    setError(null);
    setBusy(true);
    // Reuses the per-publication endpoint rather than adding a bulk one: the individual
    // sends stay authoritative, so cancelling the group IS cancelling each of them.
    const results = await Promise.all(
      cancelableIds.map((id) =>
        fetch(`/api/publications/${id}/cancel`, { method: "POST" }).then((r) => r.ok)
      )
    );
    setBusy(false);
    setConfirming(false);
    const failed = results.filter((ok) => !ok).length;
    // Partial failure is reported, never swallowed — the same rule the publish path follows.
    if (failed > 0) {
      setError(`${failed} of ${results.length} could not be canceled.`);
    }
    startTransition(() => router.refresh());
  }

  return (
    <tr className="border-b border-border bg-surface-sunken/70">
      <td colSpan={4} className="px-4 py-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border-strong px-1.5 py-px text-[10px] font-medium text-ink-soft">
            Story
          </span>
          <span className="text-xs font-medium text-ink">
            {slideCount} slides, back to back
          </span>
          <span className="data text-[11px] text-faint">
            → {channelName}
            {caption ? ` · ${caption.slice(0, 40)}${caption.length > 40 ? "…" : ""}` : ""}
          </span>
          {error ? (
            <span className="text-[11px] text-status-failed">{error}</span>
          ) : null}
        </span>
      </td>
      <td className="px-4 py-2 text-right">
        {cancelableIds.length === 0 ? null : confirming ? (
          <span className="flex items-center justify-end gap-1">
            <button
              onClick={cancelAll}
              disabled={busy}
              className="rounded-md bg-status-failed px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Canceling…" : `Cancel all ${cancelableIds.length}`}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            // Two-click confirm, matching PublicationActions — a queued send is never
            // canceled on a stray click, and this one cancels several at once.
            title={
              workerOnline
                ? `Cancel all ${cancelableIds.length} slides of this Story`
                : "Worker is offline — these are queued, not sending"
            }
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted hover:text-ink"
          >
            Cancel all
          </button>
        )}
      </td>
    </tr>
  );
}
