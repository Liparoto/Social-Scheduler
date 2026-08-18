"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { videoPreviewSrc } from "@/lib/format";
import { AssetPickerModal } from "@/components/asset-picker-modal";
import { deleteBlockState, type UsageCounts } from "@/lib/media-delete-confirm";
import { LIVE_SEND_MESSAGE } from "@/lib/post-media-edit";
import { useModalFocusTrap } from "./use-modal-focus-trap";

export interface EditorSlide {
  id: number;
  media_kind: string;
  cover_frame_ms: number | null;
}

/** Reorder wiring, supplied by whoever owns the order state (see useAssetOrder). */
export interface SlideReorderControl {
  /** Asset ids in display order. */
  order: number[];
  onOrderChange: (next: number[]) => void;
  /** True while the order differs from what's saved — the strip warns before losing it. */
  isDirty: boolean;
}

/**
 * The two-option delete confirm for one slide: unlink it from just this post, or delete the
 * asset row and its files everywhere.
 *
 * Its own component, mounted only while a slide is being confirmed — same idiom as
 * AssetPickerModal and UnmergeModal. useModalFocusTrap's focus/Escape/Tab/scroll-lock setup
 * runs once on mount; if this dialog's JSX just lived inline in PostMediaEditor, that mount
 * would happen when the whole editor strip mounts, not when the dialog opens, and the trap
 * would never activate.
 *
 * Fetches its own usage counts on mount, the same way AssetPickerModal fetches its own
 * library list — advisory only. DELETE /api/posts/[id]/assets/[assetId] re-checks
 * everything inside its own transaction, so a stale or failed usage lookup here can hide
 * the "delete entirely" button but can never destroy a file something still references.
 */
function DeleteConfirmDialog({
  postId,
  slide,
  onClose,
  onRemoved,
}: {
  postId: number;
  slide: EditorSlide;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageCounts | null>(null);
  const [usageError, setUsageError] = useState(false);

  useModalFocusTrap({ panelRef, onClose: () => !busy && onClose() });

  useEffect(() => {
    let live = true;
    fetch(`/api/assets/${slide.id}/usage?post_id=${postId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((body: { other_post_count?: number; other_send_count?: number; other_cover_count?: number }) => {
        if (!live) return;
        setUsage({
          otherPosts: body.other_post_count ?? 0,
          sends: body.other_send_count ?? 0,
          covers: body.other_cover_count ?? 0,
        });
      })
      .catch(() => live && setUsageError(true));
    return () => {
      live = false;
    };
    // Mount-only: slide/postId are the identity of which dialog this is and don't change
    // while it's open (a new slide means a new DeleteConfirmDialog instance, keyed below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(mode: "post" | "everywhere") {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/posts/${postId}/assets/${slide.id}?mode=${mode}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't remove that.");
        return;
      }
      onRemoved();
    } catch {
      setError("Couldn't reach the server. Is the dashboard still running?");
    } finally {
      setBusy(false);
    }
  }

  const { blocked, message: blockedMessage } = deleteBlockState(usage, usageError);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Remove this photo?"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-card border border-border bg-surface p-5"
      >
        <h2 className="text-base font-medium text-ink">Remove this photo?</h2>
        <p className="mt-2 text-sm text-muted">
          You can take it off this post and keep it in your library, or delete the file from
          your computer for good.
        </p>
        {blockedMessage ? <p className="mt-2 text-sm text-faint">{blockedMessage}</p> : null}
        {error ? <p className="mt-2 text-sm text-status-failed">{error}</p> : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => remove("post")}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink"
          >
            Remove from this post
          </button>
          <button
            type="button"
            disabled={busy || blocked}
            title={blockedMessage ?? undefined}
            onClick={() => remove("everywhere")}
            className="rounded-lg bg-status-failed px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Delete the file entirely
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * THE strip for a post's slides — every edit surface mounts this one component, and every
 * slide appears on the page exactly once inside it.
 *
 * It used to only add and remove, sitting next to a second, separate reorder grid that drew
 * the same images all over again. Two grids of the same six photos side by side is not two
 * features, it is one confusing feature, so reordering moved in here (2026-08-18) and
 * <CarouselReorder> went away. Add, remove, reorder and whatever the host hangs off each
 * slide (the framing button, the lightbox badge) now all live on one tile.
 *
 * CHANGES APPLY IMMEDIATELY, not behind a Save button. QuickEditModal is confirm-on-dismiss
 * and compares every field against what it opened with; staging media inside that model
 * would mean tracking pending deletes and orphaning already-uploaded files whenever someone
 * hit Cancel. Slide REORDER is the exception and stays the host's business — it has its own
 * Save on the post page and rides the dialog's Save in quick edit — which is why `reorder`
 * is passed in rather than owned here.
 */
export function PostMediaEditor({
  postId,
  slides,
  onChanged,
  hasLiveSend = false,
  reorder,
  renderTile,
  renderExtra,
}: {
  postId: number;
  /** Every slide on the post. Drawn in `reorder.order` when reordering is on. */
  slides: EditorSlide[];
  onChanged: () => void;
  /**
   * Has any publication of this post reached the platform — 'posted' or 'publishing'?
   *
   * When true, EVERY media control is disabled and the strip says why. The server already
   * refuses these edits with `live_send`, so nothing was ever destroyed — but the delete
   * confirm's own usage lookup happily reported "nothing else references this file" for a
   * published FEED carousel (a feed publication has `asset_id IS NULL`, so it isn't one of
   * the references it counts), which meant a red "Delete the file entirely" button was
   * being OFFERED on a post that is already on Instagram. Never offer an action that
   * cannot succeed, least of all the irreversible one.
   *
   * Defaults to false so a host that genuinely cannot have a live send (a fresh compose)
   * needs no ceremony; every host that edits an EXISTING post passes it.
   */
  hasLiveSend?: boolean;
  /**
   * Omit when there is nothing to reorder (a single image, a Reel), or when the host
   * doesn't offer reordering. Numbering and the ← → arrows appear only when this is
   * supplied AND there are 2+ slides.
   */
  reorder?: SlideReorderControl;
  /**
   * Draw the thumbnail yourself. The post page uses it for a single image or Reel, where
   * the tile is a cover-frame picker or carries a lightbox badge. Return null to fall back
   * to the default thumbnail. The ✕, the numbering and the arrows are added around it
   * either way.
   */
  renderTile?: (slide: EditorSlide, index: number) => ReactNode;
  /** Extra UI under each slide — the post page's per-image FramingButton. */
  renderExtra?: (slide: EditorSlide, index: number) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState<EditorSlide | null>(null);
  // A media change that is waiting on the "you'll lose your unsaved order" answer. Held as
  // a thunk so the confirm can run the exact action that was interrupted — see guarded().
  const [pendingChange, setPendingChange] = useState<(() => void) | null>(null);
  const dragIndex = useRef<number | null>(null);

  // Display order. An id in `order` that the post no longer has is dropped rather than
  // drawn as a broken thumbnail, and a slide that isn't in `order` yet — which is exactly
  // what a just-added one looks like for the tick between the POST landing and the order
  // state re-syncing — is appended rather than silently hidden.
  const ordered = (() => {
    if (!reorder) return slides;
    const byId = new Map(slides.map((s) => [s.id, s]));
    const known = reorder.order.filter((id) => byId.has(id));
    const knownSet = new Set(known);
    return [
      ...known.map((id) => byId.get(id)!),
      ...slides.filter((s) => !knownSet.has(s.id)),
    ];
  })();
  const canReorder = reorder !== undefined && ordered.length > 1;

  function move(from: number, to: number) {
    if (!reorder || to < 0 || to >= ordered.length) return;
    const next = ordered.map((s) => s.id);
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorder.onOrderChange(next);
  }

  /**
   * Adding or removing a slide re-reads the post's slides, which re-seeds the reorder
   * baseline — so a drag the user hasn't saved yet is about to vanish. Ask first. We
   * deliberately do NOT save their order for them: they never asked for that write, and it
   * can 409 while the post is publishing.
   */
  function guarded(run: () => void) {
    if (reorder?.isDirty) {
      setPendingChange(() => run);
      return;
    }
    run();
  }

  async function attach(assetIds: number[]) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/posts/${postId}/assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ asset_ids: assetIds }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't add that to the post.");
        return;
      }
      onChanged();
    } catch {
      setError("Couldn't reach the server. Is the dashboard still running?");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ask whether this post can take a new slide at all, BEFORE uploading anything.
   *
   * /api/assets/upload writes the original, a conformed derivative and a thumbnail into
   * /data and only then returns an id — so without this, every attempt on a post that is
   * live, Story-queued or text-only left another orphaned copy in the library before
   * attach() got to report the refusal. Returns the server's own sentence to show, or null
   * when adding is allowed.
   *
   * Fail-OPEN on a network error, deliberately: this is an optimisation, not the guard.
   * POST /api/posts/[id]/assets re-checks every one of these rules and is the thing that
   * actually refuses. Blocking the upload because a pre-flight couldn't be reached would
   * turn a tidiness measure into a way to lose a working feature.
   */
  async function preflightAdd(): Promise<string | null> {
    try {
      const res = await fetch(`/api/posts/${postId}/assets/can-add`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) return body.error ?? "Couldn't add anything to this post.";
      return body.ok === false ? (body.error ?? "Couldn't add anything to this post.") : null;
    } catch {
      return null;
    }
  }

  async function onFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    const blocked = await preflightAdd();
    if (blocked !== null) {
      setError(blocked);
      setBusy(false);
      return;
    }
    const uploaded: number[] = [];
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          asset?: { id: number };
        };
        if (!res.ok || !body.asset) {
          setError(body.error ?? `Couldn't upload ${file.name}.`);
          break;
        }
        uploaded.push(body.asset.id);
      }
    } catch {
      setError("Couldn't reach the server. Is the dashboard still running?");
    } finally {
      setBusy(false);
    }
    // Attach whatever DID upload, even if a later file failed — the successful uploads
    // are already in the library, and silently stranding them there is worse than
    // attaching them and showing the error about the one that failed.
    if (uploaded.length > 0) await attach(uploaded);
  }

  return (
    <div>
      <ul className="flex flex-wrap gap-3">
        {ordered.map((s, i) => (
          <li
            key={s.id}
            draggable={canReorder}
            onDragStart={canReorder ? () => (dragIndex.current = i) : undefined}
            onDragOver={canReorder ? (e) => e.preventDefault() : undefined}
            onDrop={
              canReorder
                ? () => {
                    if (dragIndex.current !== null) move(dragIndex.current, i);
                    dragIndex.current = null;
                  }
                : undefined
            }
          >
            <div className="relative">
              {renderTile?.(s, i) ?? (
                <div
                  className={`h-24 w-24 overflow-hidden rounded-lg border border-border bg-surface-sunken${
                    canReorder ? " cursor-grab active:cursor-grabbing" : ""
                  }`}
                >
                  {s.media_kind === "video" ? (
                    <video
                      src={videoPreviewSrc(s.id, s.cover_frame_ms)}
                      preload="metadata"
                      muted
                      playsInline
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/media/${s.id}?variant=thumb`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
              )}
              {canReorder ? (
                <span className="data absolute left-1 top-1 z-10 rounded bg-ink/75 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  {i + 1}
                </span>
              ) : null}
              <button
                type="button"
                disabled={busy || hasLiveSend || ordered.length === 1}
                onClick={() => guarded(() => setConfirming(s))}
                title={
                  hasLiveSend
                    ? LIVE_SEND_MESSAGE
                    : ordered.length === 1
                      ? "A post needs at least one photo"
                      : "Remove this from the post"
                }
                aria-label={`Remove slide ${s.id}`}
                className="absolute right-1 top-1 z-10 rounded-full bg-black/60 px-1.5 text-xs text-white disabled:opacity-40"
              >
                ✕
              </button>
            </div>
            {renderExtra?.(s, i)}
            {canReorder ? (
              <div className="mt-1 flex justify-center gap-1">
                <button
                  type="button"
                  onClick={() => move(i, i - 1)}
                  disabled={i === 0}
                  className="rounded px-1 text-xs text-muted hover:text-ink disabled:opacity-30"
                  aria-label="Move left"
                >
                  ←
                </button>
                <button
                  type="button"
                  onClick={() => move(i, i + 1)}
                  disabled={i === ordered.length - 1}
                  className="rounded px-1 text-xs text-muted hover:text-ink disabled:opacity-30"
                  aria-label="Move right"
                >
                  →
                </button>
              </div>
            ) : null}
          </li>
        ))}

        {/* Kept on screen when the post is live, disabled and titled, rather than removed:
            an absent control reads as "adding isn't a thing here", which isn't the reason.
            Same call the sole slide's ✕ makes. */}
        <li
          className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-faint"
          title={hasLiveSend ? LIVE_SEND_MESSAGE : undefined}
        >
          <label
            className={
              hasLiveSend
                ? "text-faint"
                : "cursor-pointer text-ink-soft hover:underline"
            }
          >
            {busy ? "Working…" : "Upload"}
            {/* Accept both the MIME types and the extensions: a Windows machine with
                nothing registered for .webp sends an empty type. See lib/upload-mime.ts. */}
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.mp4,.mov"
              className="hidden"
              disabled={busy || hasLiveSend}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length > 0) guarded(() => onFiles(files));
              }}
            />
          </label>
          <button
            type="button"
            disabled={busy || hasLiveSend}
            onClick={() => guarded(() => setPicking(true))}
            className="text-ink-soft hover:underline disabled:text-faint disabled:no-underline"
          >
            Library
          </button>
        </li>
      </ul>

      {/* Said out loud, not just as a title attribute: a disabled control with no visible
          reason is the thing this whole gate exists to avoid. */}
      {hasLiveSend ? <p className="mt-2 text-xs text-muted">{LIVE_SEND_MESSAGE}</p> : null}

      {error ? <p className="mt-2 text-sm text-status-failed">{error}</p> : null}

      {pendingChange ? (
        <div
          className="mt-2 rounded-lg border border-status-failed/40 bg-status-failed/5 p-3"
          role="alertdialog"
          aria-labelledby="post-media-order-warning"
        >
          <p id="post-media-order-warning" className="text-sm font-semibold text-ink">
            Your unsaved slide order will be lost
          </p>
          <p className="mt-1 text-xs text-muted">
            Adding or removing a slide reloads this post&rsquo;s slides, which throws away the
            order you dragged but haven&rsquo;t saved. Cancel and save the order first, or
            continue and set it again afterwards.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setPendingChange(null)}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-sunken"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const run = pendingChange;
                setPendingChange(null);
                run();
              }}
              className="rounded-lg border border-status-failed/50 px-3 py-1.5 text-sm font-medium text-status-failed hover:bg-status-failed/10"
            >
              Discard order and continue
            </button>
          </div>
        </div>
      ) : null}

      {picking ? (
        <AssetPickerModal
          excludeIds={slides.map((s) => s.id)}
          onClose={() => setPicking(false)}
          onPick={(ids) => {
            setPicking(false);
            attach(ids);
          }}
        />
      ) : null}

      {confirming ? (
        <DeleteConfirmDialog
          key={confirming.id}
          postId={postId}
          slide={confirming}
          onClose={() => setConfirming(null)}
          onRemoved={() => {
            setConfirming(null);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
