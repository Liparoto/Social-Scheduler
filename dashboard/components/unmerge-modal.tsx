"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocusTrap } from "./use-modal-focus-trap";

/**
 * The modal's one piece of computed copy, pulled out so it can be tested without a DOM —
 * createPortal needs a real document, so the component itself can't go through
 * renderToStaticMarkup. Kept deliberately blunt: this is a bulk change to the library, and
 * the count is the number the owner needs to see before confirming.
 */
export function splitSummary(slideCount: number): string {
  return (
    `This carousel will become ${slideCount} separate posts, one per photo. ` +
    `This post keeps the first photo along with its history. No photos are deleted.`
  );
}

/**
 * Confirm dialog for splitting one carousel back into separate posts. Nothing is written
 * until POST /api/posts/[id]/unmerge succeeds — this holds no draft state of its own, because
 * there is nothing to choose: the split is total and the existing slide order is kept.
 *
 * Focus, Escape, Tab cycling and body-scroll locking all come from useModalFocusTrap, the
 * same hook merge-modal.tsx and media-lightbox.tsx use. No extra keys here — a confirm
 * dialog has nothing to navigate.
 */
export function UnmergeModal({
  postId,
  slideCount,
  onClose,
  onUnmerged,
}: {
  postId: number;
  slideCount: number;
  onClose: () => void;
  onUnmerged: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useModalFocusTrap({ panelRef, onClose });

  async function confirm() {
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/posts/${postId}/unmerge`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSubmitting(false);
      // The server's message is the specific one (already published / send queued), so it is
      // shown verbatim rather than replaced with a generic failure.
      setError(body.error ?? "Could not split this carousel.");
      return;
    }
    onUnmerged();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Split into separate posts"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card border border-border-strong bg-surface p-5 shadow-lg"
      >
        <h2 className="font-display text-base font-semibold text-ink">
          Split into separate posts
        </h2>
        <p className="mt-1 text-sm text-muted">{splitSummary(slideCount)}</p>
        <p className="mt-2 text-sm text-muted">
          Each new post keeps this one&rsquo;s caption, channels, tags and seasons — as its own
          copy, so editing one later won&rsquo;t change the others.
        </p>

        {error ? <p className="mt-4 text-sm text-status-failed">{error}</p> : null}

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={submitting}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
          >
            {submitting ? "Splitting…" : "Split into separate posts"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
