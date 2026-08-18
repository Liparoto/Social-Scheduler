"use client";

import { useRef, useState } from "react";
import type { Asset } from "@/lib/types";
import { videoPreviewSrc } from "@/lib/format";

/** Two-option segmented toggle, same idiom as the crop/pad control in conform-control.tsx —
 *  one pattern to learn for "pick one of two mutually exclusive things." */
const segBtn = (active: boolean) =>
  `rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
    active ? "bg-brand-weak text-brand-strong" : "text-muted hover:text-ink"
  }`;

/** Pick a Reel's cover: a frame from the video, or an uploaded image.
 *
 *  Instagram's precedence is fixed — cover_url (the uploaded image) wins and
 *  thumb_offset (the frame) is ignored entirely if both are set. So this shows ONE
 *  visible choice rather than two controls that could silently fight.
 *
 *  What is stored for the frame is a single millisecond offset — Instagram extracts
 *  the frame itself via thumb_offset, so nothing is uploaded for that choice. The
 *  <video> here is preview only.
 *
 *  Setting an image does NOT clear cover_frame_ms, and removing the image does not
 *  restore it from anywhere — it was never touched. The scrubber below stays visible
 *  (just visibly marked as overridden) so that value isn't lost, and the owner can
 *  come back to it by removing the image. */
/** `overlay` is rendered over the video itself (not over the scrubber below it), so a
 *  caller can place a control such as the lightbox badge without knowing this layout. */
export function CoverFramePicker({
  asset,
  overlay,
}: {
  asset: Asset;
  overlay?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ms, setMs] = useState(asset.cover_frame_ms ?? 0);
  const [saved, setSaved] = useState(asset.cover_frame_ms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [coverAssetId, setCoverAssetId] = useState<number | null>(asset.cover_asset_id);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const duration = asset.duration_ms ?? 0;
  const dirty = saved !== ms;
  const overridden = coverAssetId !== null;

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

  async function uploadCover(file: File) {
    setCoverBusy(true);
    setCoverError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/assets/${asset.id}/cover-image`, {
      method: "POST",
      body: form,
    });
    setCoverBusy(false);
    if (!res.ok) {
      setCoverError(
        (await res.json().catch(() => ({})))?.error ?? "Could not upload the cover image."
      );
      return;
    }
    const body = await res.json();
    setCoverAssetId(body.cover.id);
    setWarnings(body.warnings ?? []);
  }

  async function removeCover() {
    setCoverBusy(true);
    setCoverError(null);
    const res = await fetch(`/api/assets/${asset.id}/cover-image`, { method: "DELETE" });
    setCoverBusy(false);
    if (!res.ok) {
      setCoverError(
        (await res.json().catch(() => ({})))?.error ?? "Could not remove the cover image."
      );
      return;
    }
    setCoverAssetId(null);
    setWarnings([]);
  }

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border border-border p-0.5">
        <button
          type="button"
          disabled={coverBusy}
          aria-pressed={!overridden}
          className={segBtn(!overridden)}
          onClick={() => overridden && removeCover()}
        >
          Frame from the video
        </button>
        <button
          type="button"
          disabled={coverBusy}
          aria-pressed={overridden}
          className={segBtn(overridden)}
          onClick={() => fileInputRef.current?.click()}
        >
          Uploaded image
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow choosing the same file again later
          if (file) uploadCover(file);
        }}
      />

      {overridden ? (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media/${coverAssetId}`}
            alt="Uploaded cover"
            className="h-16 w-9 rounded border border-border object-cover"
          />
          <button
            type="button"
            onClick={removeCover}
            disabled={coverBusy}
            className="rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50"
          >
            {coverBusy ? "Removing…" : "Remove"}
          </button>
        </div>
      ) : null}
      {warnings.map((w, i) => (
        <p key={i} className="text-xs font-medium text-accent-strong">
          {w}
        </p>
      ))}
      {coverError && <p className="text-xs text-status-failed">{coverError}</p>}

      <div className={overridden ? "space-y-2 opacity-60" : "space-y-2"}>
        {overridden ? (
          <span className="inline-block rounded bg-accent-weak px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
            Overridden by the uploaded image
          </span>
        ) : null}
        <div className="relative w-full max-w-xs">
          {overlay}
          <video
            ref={videoRef}
            src={videoPreviewSrc(asset.id, asset.cover_frame_ms)}
            preload="metadata"
            muted
            playsInline
            className="w-full rounded-md border border-border"
            onLoadedMetadata={(e) => {
              // Same value the URL's #t= fragment already seeked to, so this doesn't fight
              // it — it's the fallback for browsers that ignore media fragments, and the
              // mechanism the scrubber itself uses for every seek after this first one.
              e.currentTarget.currentTime = (ms > 0 ? ms : 100) / 1000;
            }}
          />
        </div>
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
    </div>
  );
}
