"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QuickEditModal, type QuickEditPost } from "@/components/quick-edit-modal";
import { captionsToDrafts } from "@/lib/quick-edit-captions";
import type { CaptionVariantDraft } from "@/components/caption-variants-editor";
import type { Period, Tag } from "@/lib/types";

/**
 * One line saying what this edit actually reaches.
 *
 * `queued` deliberately excludes the failed send you may have opened this from, so that
 * case is spelled out separately rather than being silently reported as "nothing".
 */
function noteFor(queued: number, isFailedSend: boolean): string {
  if (isFailedSend) {
    if (queued === 0) {
      return "Edits the post itself — including this failed send, when you retry it.";
    }
    return `Edits the post itself — this failed send when you retry it, and the ${queued} other send${
      queued === 1 ? "" : "s"
    } queued from it.`;
  }
  if (queued > 1) {
    return `Edits the post itself — all ${queued} queued sends of it, not just this row.`;
  }
  if (queued === 1) return "Edits the post itself. One send is queued from it.";
  return "Edits the post itself. Nothing is queued from it right now.";
}

/**
 * Open the Library's quick-edit dialog from a queue row.
 *
 * The Library hands that dialog a row it already has. The Overview can't: a queue row is
 * a SEND — it carries a post_id and nothing about the post's content model — so this
 * fetches the post first and mounts the dialog only once there is something real to seed
 * it with. One request, for the post you actually clicked, on a route that already
 * existed to serve this dialog's captions.
 *
 * Mounting late (rather than opening an empty dialog that fills in) is deliberate:
 * QuickEditModal reads `post` in useState initialisers and compares against it to decide
 * whether it is dirty. A dialog whose opening values arrived after mount would compare
 * edits against placeholders, and confirm-on-dismiss — the thing standing between a
 * stray Esc and a lost edit — would be judging against the wrong baseline.
 */
export function QueueQuickEdit({
  postId,
  isFailedSend = false,
  periods,
  timeOfDayTags,
  topicTags,
  onClose,
  onSaved,
}: {
  postId: number;
  /**
   * Was this opened from a FAILED row? It changes what the note can honestly claim.
   *
   * `queued_publication_count` counts only 'scheduled' and 'pending_approval', so a failed
   * send isn't in it — and a post whose only send failed reports zero. Saying "nothing is
   * queued from it" there is actively wrong: Retry is right next to the button you just
   * pressed, and it publishes the caption you're editing now.
   */
  isFailedSend?: boolean;
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [post, setPost] = useState<QuickEditPost | null>(null);
  const [captions, setCaptions] = useState<CaptionVariantDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/posts/${postId}/content`, {
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not load this post.");
        if (!body.quick_edit || !Array.isArray(body.caption_variants)) {
          // Half a post is worse than none: seeding the dialog from a partial response
          // and saving it would write those gaps back over real values.
          throw new Error("The response for this post was incomplete.");
        }
        setCaptions(captionsToDrafts(body.caption_variants));
        setPost(body.quick_edit as QuickEditPost);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error ? loadError.message : "Could not load this post."
        );
      }
    })();
    return () => controller.abort();
  }, [postId]);

  // Re-read the post after its media changed. The Library hands QuickEditModal a row from
  // a server-rendered list, so router.refresh() is enough there; here `post` is local state
  // from the one-shot fetch above and nothing refreshes it — leaving post_type (which picks
  // the caption limits) and asset_count on their opening values after a slide is added.
  //
  // Captions are deliberately NOT touched: they were handed to the dialog as its opening
  // baseline and may have been edited since, so overwriting them with the server's copy
  // would silently throw that edit away.
  const refreshSeq = useRef(0);
  const refreshPost = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const res = await fetch(`/api/posts/${postId}/content`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.quick_edit) return;
      if (seq !== refreshSeq.current) return;
      setPost(body.quick_edit as QuickEditPost);
    } catch {
      // The dialog keeps working off what it already has. A stale caption limit is a worse
      // reason to interrupt an edit in progress than it is a problem.
    }
  }, [postId]);

  // Only while this shell is on screen. Once the dialog mounts it owns Esc — and it must,
  // because by then there can be unsaved edits and Esc has to ask before discarding them.
  const settled = post !== null;
  useEffect(() => {
    if (settled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [settled, onClose]);

  if (post && captions) {
    const queued = post.queued_publication_count;
    return (
      <QuickEditModal
        post={post}
        periods={periods}
        timeOfDayTags={timeOfDayTags}
        topicTags={topicTags}
        // Already in hand from the fetch above — see the prop's own warning about why
        // this must never be passed speculatively.
        initialCaptions={captions}
        // A queue row is one send, but a caption belongs to the post. Editing the row
        // headed to Instagram also rewrites what goes to Facebook, and that is not
        // guessable from the row you clicked.
        note={noteFor(queued, isFailedSend)}
        onMediaChanged={refreshPost}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Loading post"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-6 shadow-xl">
        {error ? (
          <div role="alert">
            <h2 className="font-display text-base font-semibold text-ink">
              Couldn&rsquo;t open this post
            </h2>
            <p className="mt-2 text-sm text-status-failed">{error}</p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-surface-sunken"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">Loading post…</p>
        )}
      </div>
    </div>
  );
}
