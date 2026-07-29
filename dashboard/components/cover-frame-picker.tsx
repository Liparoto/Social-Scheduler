"use client";

import { useRef, useState } from "react";
import type { Asset } from "@/lib/types";
import { videoPreviewSrc } from "@/lib/format";

/** Pick which frame of a video becomes its cover.
 *
 *  What is stored is a single millisecond offset — Instagram extracts the frame itself
 *  via thumb_offset, so nothing is uploaded. The <video> here is preview only.
 *  Because the choice lives on the asset, a recycled evergreen video reuses it. */
export function CoverFramePicker({ asset }: { asset: Asset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ms, setMs] = useState(asset.cover_frame_ms ?? 0);
  const [saved, setSaved] = useState(asset.cover_frame_ms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = asset.duration_ms ?? 0;
  const dirty = saved !== ms;

  function scrub(next: number) {
    setMs(next);
    if (videoRef.current) videoRef.current.currentTime = next / 1000;
  }

  // Mirrors videoPreviewSrc's fallback: seeking to exactly 0 doesn't reliably force
  // Safari to paint a frame, so the very first seek (on load, before the owner has
  // touched the scrubber) nudges off zero. Any real scrub value (including one the
  // owner deliberately drags back to 0 afterward) is honored as-is — only the initial,
  // never-touched "0" is suspect.

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/assets/${asset.id}/cover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cover_frame_ms: ms }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({})))?.error ?? "Could not save the cover frame.");
      return;
    }
    setSaved(ms);
  }

  return (
    <div className="space-y-2">
      <video
        ref={videoRef}
        src={videoPreviewSrc(asset.id, asset.cover_frame_ms)}
        preload="metadata"
        muted
        playsInline
        className="w-full max-w-xs rounded-md border border-border"
        onLoadedMetadata={(e) => {
          // Same value the URL's #t= fragment already seeked to, so this doesn't fight
          // it — it's the fallback for browsers that ignore media fragments, and the
          // mechanism the scrubber itself uses for every seek after this first one.
          e.currentTarget.currentTime = (ms > 0 ? ms : 100) / 1000;
        }}
      />
      <label className="block text-sm font-medium">
        Cover frame
        <input
          type="range"
          min={0}
          max={duration}
          step={100}
          value={ms}
          onChange={(e) => scrub(Number(e.target.value))}
          className="mt-1 w-full max-w-xs"
          aria-label="Cover frame position in the video"
        />
      </label>
      <p className="text-xs text-muted">
        {(ms / 1000).toFixed(1)}s of {(duration / 1000).toFixed(1)}s
        {saved === null && " — not chosen yet, Instagram would use the first frame"}
      </p>
      {error && <p className="text-xs text-status-failed">{error}</p>}
      <button
        type="button"
        onClick={save}
        disabled={busy || !dirty}
        className="rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50"
      >
        {busy ? "Saving…" : dirty ? "Save cover frame" : "Saved"}
      </button>
    </div>
  );
}
