"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { videoPreviewSrc } from "@/lib/format";
import { useModalFocusTrap } from "./use-modal-focus-trap";

interface PickableAsset {
  id: number;
  media_kind: string;
  original_filename: string | null;
  cover_frame_ms: number | null;
}

/**
 * Pick files already in the library to add to a post.
 *
 * Uploading the same file again would resolve to the same asset anyway — /api/assets/upload
 * dedups by content hash — so this exists to save hunting for the original on disk, not to
 * avoid a duplicate.
 *
 * Closes unconditionally on Escape or click-outside: unlike merge/unmerge, this dialog holds
 * only an in-progress selection, not unsaved edits, so dismissing it loses nothing worth
 * guarding.
 *
 * Focus, Escape, Tab cycling and body-scroll locking all come from useModalFocusTrap, the
 * same hook merge-modal.tsx and unmerge-modal.tsx use.
 */
export function AssetPickerModal({
  excludeIds,
  onPick,
  onClose,
}: {
  excludeIds: number[];
  onPick: (ids: number[]) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [assets, setAssets] = useState<PickableAsset[] | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useModalFocusTrap({ panelRef, onClose });

  useEffect(() => {
    let live = true;
    fetch(`/api/assets?exclude=${excludeIds.join(",")}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((body: { assets: PickableAsset[] }) => live && setAssets(body.assets))
      .catch(() => live && setError("Couldn't load the library."));
    return () => {
      live = false;
    };
  }, [excludeIds]);

  function toggle(id: number) {
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose from the library"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-card border border-border bg-surface p-5"
      >
        <h2 className="text-base font-medium text-ink">Choose from the library</h2>
        <p className="mt-1 text-sm text-faint">
          Files already on this post aren&rsquo;t shown.
        </p>

        {error ? <p className="mt-4 text-sm text-status-failed">{error}</p> : null}

        <div className="mt-4 grid flex-1 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
          {assets === null && !error ? (
            <p className="col-span-full text-sm text-faint">Loading…</p>
          ) : null}
          {assets?.length === 0 ? (
            <p className="col-span-full text-sm text-faint">
              Nothing else in the library yet.
            </p>
          ) : null}
          {assets?.map((a) => {
            const on = chosen.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => toggle(a.id)}
                aria-pressed={on}
                title={a.original_filename ?? `Asset ${a.id}`}
                className={`relative aspect-square overflow-hidden rounded-lg border-2 bg-surface-sunken ${
                  on ? "border-accent" : "border-transparent"
                }`}
              >
                {a.media_kind === "video" ? (
                  // No thumbnail file exists for video (no ffmpeg dependency by design) —
                  // render the real file with preload="metadata" so the browser decodes
                  // just one frame. The #t= fragment in videoPreviewSrc forces Safari to
                  // actually paint that frame instead of a blank tile.
                  <video
                    src={videoPreviewSrc(a.id, a.cover_frame_ms)}
                    preload="metadata"
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${a.id}?variant=thumb`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                {on ? (
                  <span className="absolute right-1 top-1 rounded-full bg-accent px-2 py-0.5 text-xs text-on-accent">
                    {chosen.indexOf(a.id) + 1}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={() => onPick(chosen)}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-50"
          >
            Add {chosen.length || ""}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
