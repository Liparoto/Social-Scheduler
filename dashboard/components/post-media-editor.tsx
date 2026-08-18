"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { videoPreviewSrc } from "@/lib/format";
import { AssetPickerModal } from "@/components/asset-picker-modal";
import { deleteBlockState, type UsageCounts } from "@/lib/media-delete-confirm";
import { useModalFocusTrap } from "./use-modal-focus-trap";

export interface EditorSlide {
  id: number;
  media_kind: string;
  cover_frame_ms: number | null;
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
 * Add and remove a post's slides, in one component both edit surfaces mount.
 *
 * CHANGES APPLY IMMEDIATELY, not behind a Save button. QuickEditModal is confirm-on-dismiss
 * and compares every field against what it opened with; staging media inside that model
 * would mean tracking pending deletes and orphaning already-uploaded files whenever someone
 * hit Cancel. Slide REORDER in the same dialog already works this way — its own Save,
 * separate from the text fields — so this follows an existing precedent rather than
 * inventing a second one.
 *
 * Reordering is deliberately not here: <CarouselReorder> already owns it, through its own
 * endpoint, and the two are mounted side by side.
 */
export function PostMediaEditor({
  postId,
  slides,
  onChanged,
}: {
  postId: number;
  slides: EditorSlide[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState<EditorSlide | null>(null);

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

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    const uploaded: number[] = [];
    try {
      for (const file of Array.from(files)) {
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
      <div className="flex flex-wrap gap-3">
        {slides.map((s) => (
          <div
            key={s.id}
            className="relative h-24 w-24 overflow-hidden rounded-lg border border-border bg-surface-sunken"
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
            <button
              type="button"
              disabled={busy || slides.length === 1}
              onClick={() => setConfirming(s)}
              title={
                slides.length === 1
                  ? "A post needs at least one photo"
                  : "Remove this from the post"
              }
              aria-label={`Remove slide ${s.id}`}
              className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 text-xs text-white disabled:opacity-40"
            >
              ✕
            </button>
          </div>
        ))}

        <div className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-faint">
          <label className="cursor-pointer text-ink-soft hover:underline">
            {busy ? "Working…" : "Upload"}
            {/* Accept both the MIME types and the extensions: a Windows machine with
                nothing registered for .webp sends an empty type. See lib/upload-mime.ts. */}
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.mp4,.mov"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                onFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => setPicking(true)}
            className="text-ink-soft hover:underline"
          >
            Library
          </button>
        </div>
      </div>

      {error ? <p className="mt-2 text-sm text-status-failed">{error}</p> : null}

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
