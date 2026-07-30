"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlideReorder, type Slide } from "@/components/slide-reorder";

// Everything the modal needs about a selected post — a subset of library-view's PostLite,
// kept narrow so this file doesn't have to import (and stay in sync with) the whole thing.
export interface MergeCandidatePost {
  id: number;
  caption: string | null;
  asset_ids: number[]; // in this post's current slide order
  has_queued_publication: boolean; // scheduled/pending_approval — see lib/queries.ts
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Review-and-confirm dialog for folding several selected Library posts into one carousel.
 * Pure client state until Confirm — nothing is written until POST /api/posts/merge succeeds.
 *
 * `posts` must be in SELECTION order (library-view's `selected` array mapped to post data):
 * the first entry is the post that survives, exactly matching what /api/posts/merge expects
 * for `post_ids`. Reordering slides only ever changes `asset_order`, never which post
 * survives or which posts get deleted.
 */
export function MergeModal({
  posts,
  onClose,
  onMerged,
}: {
  posts: MergeCandidatePost[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Kept current via an effect (not a render-time assignment) so the mount effect below can
  // read the latest onClose through .current without listing it as a dependency — writing a
  // ref during render itself is flagged by the React Compiler's refs rule.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const survivor = posts[0];
  const others = posts.slice(1);
  // How many of the posts that are about to be DELETED have a send still waiting to go out.
  // The survivor's own row (and its publications) is untouched by the merge, so it's
  // deliberately excluded from this count — warning about it would be both wrong and
  // alarming for no reason.
  const queuedOthersCount = others.filter((p) => p.has_queued_publication).length;

  // Seeded once, in selection order, from the props passed in when the modal opened — a
  // carousel expands to all of its slides, in order, so the first selected post's images
  // come first. Lazy initializer: this must only run on mount, not on every re-render.
  const [slides, setSlides] = useState<Slide[]>(() =>
    posts.flatMap((p) =>
      p.asset_ids.map((assetId): Slide => ({
        assetId,
        label: p.caption ?? `Post ${p.id}`,
      }))
    )
  );

  // Distinct non-empty captions across the selection, in first-seen (= selection) order.
  // Computed once on mount for the same reason as `slides` above — `posts` is a snapshot of
  // what was selected when the modal opened.
  const [distinctCaptions] = useState<string[]>(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const p of posts) {
      if (p.caption && !seen.has(p.caption)) {
        seen.add(p.caption);
        list.push(p.caption);
      }
    }
    return list;
  });
  // Render the picker only when at least one selected post actually has a caption — the
  // common case (115 of 135 drafts) has none, and the picker would just be dead space.
  // `null` stands for "No caption", which is a real clear, not "leave it alone" — see the
  // caption contract in lib/queries.ts's mergePostsIntoCarousel doc comment.
  const showCaptionPicker = distinctCaptions.length > 0;
  const [selectedCaption, setSelectedCaption] = useState<string | null>(
    distinctCaptions[0] ?? null
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus in on open, trap Tab while open, restore focus + body scroll on close/unmount —
  // mirrors media-lightbox.tsx exactly (see that file's comment for why onClose is read
  // through a ref rather than closed over directly).
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
    (focusables()[0] ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, []);

  async function confirm() {
    setError(null);
    setSubmitting(true);
    const res = await fetch("/api/posts/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        post_ids: posts.map((p) => p.id),
        asset_order: slides.map((s) => s.assetId),
        // Not rendering the picker means no selected post had a caption to begin with, so
        // there is nothing to keep — send null, same as picking "No caption" explicitly.
        caption: showCaptionPicker ? selectedCaption : null,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSubmitting(false);
      setError(body.error ?? "Could not merge those posts.");
      return;
    }
    onMerged();
  }

  const otherCount = others.length;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Merge into carousel"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card border border-border-strong bg-surface p-5 shadow-lg"
      >
        <h2 className="font-display text-base font-semibold text-ink">Merge into carousel</h2>
        <p className="mt-1 text-sm text-muted">
          Keeps post #{survivor.id} and deletes the other {otherCount} emptied draft
          {otherCount === 1 ? "" : "s"}. No photos are deleted.
        </p>
        {queuedOthersCount > 0 ? (
          <p className="mt-2 text-sm font-medium text-accent-strong">
            {queuedOthersCount} of these {queuedOthersCount === 1 ? "has a" : "have"} scheduled
            send{queuedOthersCount === 1 ? "" : "s"} that will be canceled.
          </p>
        ) : null}

        <div className="mt-4">
          <p className="mb-2 text-xs text-muted">Drag to reorder — this is the carousel order.</p>
          <SlideReorder slides={slides} onReorder={setSlides} />
        </div>

        {showCaptionPicker ? (
          <fieldset className="mt-4">
            <legend className="mb-2 text-xs text-muted">Caption for the merged post:</legend>
            <ul className="space-y-1.5">
              {distinctCaptions.map((c) => (
                <li key={c}>
                  <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="merge-caption"
                      className="mt-0.5"
                      checked={selectedCaption === c}
                      onChange={() => setSelectedCaption(c)}
                    />
                    <span className="line-clamp-2">{c}</span>
                  </label>
                </li>
              ))}
              <li>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="radio"
                    name="merge-caption"
                    checked={selectedCaption === null}
                    onChange={() => setSelectedCaption(null)}
                  />
                  <span>
                    No caption{" "}
                    <span className="text-xs text-faint">— clears the caption entirely</span>
                  </span>
                </label>
              </li>
            </ul>
          </fieldset>
        ) : null}

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
            {submitting ? "Merging…" : "Merge into carousel"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
