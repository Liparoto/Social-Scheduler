"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cropLossFraction, needsStoryCanvas, STORY_RATIO } from "@/lib/story-geometry";
import { feedRatio, needsFeedConform } from "@/lib/feed-geometry";
import type { Asset } from "@/lib/types";

/*
  Choose how one image is framed, for BOTH surfaces, with previews big enough to judge.

  This replaces an inline control that failed in two specific ways, and the fixes are
  load-bearing rather than cosmetic:

    * its preview was 40x40 with object-cover. object-cover CROPS — so Crop and Pad rendered
      identically, in the one control meant to tell them apart.
    * it replaced its buttons with static text after the first click, so a choice could
      never be revisited.

  Hence: large previews, object-contain, and no branch anywhere below that hides the
  controls once a choice exists.

  NOTHING IS WRITTEN UNTIL SAVE. Every button used to POST the moment it was clicked, so
  looking at the options changed the data — the owner reframed three assets simply by
  exploring what the buttons did, and had no way to back out. Clicking now only changes a
  local selection; Save persists whichever surfaces actually changed, and Cancel discards.
  Both previews render the UNCOMMITTED mode through the media route's `mode=` parameters,
  which render on demand without touching the asset row.
*/

/** Incremented per dialog mount; see `bust` below. */
let dialogOpenCount = 0;

/*
  Big enough to actually judge (the old control was 40x40), and CAPPED AGAINST THE VIEWPORT
  so it stays that way on a short window.

  The fixed 200px/284px heights made the panel ~496px tall regardless of the room available.
  On a laptop window shorter than that the panel scrolled — but the whole panel is one
  scroll container, so scrolling down to reach "Blurred fill" / "Crop to fill" carried the
  preview those buttons control off the top of the screen. A framing picker where you cannot
  see the photo and the button at the same time cannot do its job; at 420px tall the story
  buttons were off-screen outright. min() lets the previews shrink instead of pushing the
  controls out of reach, and aspect-ratio keeps each frame honest while it shrinks.
*/
const FEED_PREVIEW_HEIGHT = "min(200px, 26vh)";
const STORY_PREVIEW_BOX = { height: "min(284px, 34vh)", aspectRatio: STORY_RATIO };

/** object-CONTAIN, never object-cover: padding and bars must be visible AS padding and
 *  bars. The sunken backdrop makes letterboxing legible against the page. */
const PREVIEW_IMG =
  "h-full w-full rounded border border-border bg-surface-sunken object-contain";

const optionBtn = (active: boolean) =>
  `rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
    active
      ? "border-transparent bg-brand-weak text-brand-strong"
      : "border-border text-muted hover:text-ink"
  }`;

export function FramingDialog({
  asset,
  scheduledSendCount,
  onChanged,
  onClose,
}: {
  asset: Asset;
  /** Scheduled-but-unsent publications this asset's framing governs — a real consequence
   *  of changing it, so it is stated rather than discovered. */
  scheduledSendCount: number;
  /** Fired after a save is persisted, with BOTH modes as they now stand.
   *
   *  router.refresh() below is not enough on its own for every host. It re-renders server
   *  components, but the composer keeps its assets in client state (useState<UploadedAsset[]>),
   *  so its Asset rows — and therefore story_mode — never change. A host that renders from
   *  its own copy needs to be told. */
  onChanged?: (next: {
    feedMode: Asset["conform_mode"];
    storyMode: Asset["story_mode"];
  }) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const savedFeedMode = asset.conform_mode;
  const savedStoryMode = asset.story_mode;
  const [feedMode, setFeedMode] = useState(savedFeedMode);
  const [storyMode, setStoryMode] = useState(savedStoryMode);
  // Seeded per mount rather than at 0: the media route serves derivatives with
  // max-age=3600, so a dialog reopened after a change would otherwise re-request the
  // byte-identical `v=0` URL and show the framing the owner already replaced.
  const [bust] = useState(() => ++dialogOpenCount);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const w = asset.width ?? 0;
  const h = asset.height ?? 0;
  // sharp cannot reframe video, so neither surface offers anything for one.
  const isImage = asset.media_kind === "image";
  const storyNeedsCanvas = isImage && needsStoryCanvas(w, h);
  const feedNeedsConform = isImage && needsFeedConform(w, h);
  const cropLoss = Math.round(cropLossFraction(w, h) * 100);

  // The shape the conformed derivative will actually be. The frame used to be a fixed
  // SQUARE, which letterboxed every non-square image behind pale bands — so an in-range
  // landscape photo, which is published untouched, looked like it was about to be padded.
  const feedShape = feedRatio(asset.width, asset.height) ?? 1;

  const feedDirty = feedMode !== savedFeedMode;
  const storyDirty = storyMode !== savedStoryMode;
  const dirty = feedDirty || storyDirty;

  // Escape closes, as every other dialog in this app does (asset-picker-modal,
  // emoji-picker, checkbox-filter-dropdown). Its absence here meant a dialog that covers
  // the page could only be dismissed by finding the Close button.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      attemptClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function attemptClose() {
    // A discarded choice is cheap to redo; a silently discarded one is confusing. Only
    // asks when there is genuinely something to lose.
    if (dirty && !window.confirm("Discard the framing changes you haven't saved?")) return;
    onClose();
  }

  async function post(url: string, mode: string): Promise<boolean> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (res.ok) return true;
    setError((await res.json().catch(() => ({}))).error ?? "Could not update framing.");
    return false;
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      // Only the surfaces that actually changed are written. Saving both every time would
      // regenerate a derivative the owner never touched and reset its needs_review flag.
      if (feedDirty && !(await post(`/api/assets/${asset.id}/conform`, feedMode))) return;
      if (storyDirty && !(await post(`/api/assets/${asset.id}/story-framing`, storyMode)))
        return;
      onChanged?.({ feedMode, storyMode });
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Framing"
      onClick={(e) => {
        if (e.target === e.currentTarget) attemptClose();
      }}
    >
      <div className="max-h-full w-full max-w-3xl overflow-auto rounded-card border border-border bg-surface p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-ink">Framing</h2>
            <p className="data text-[11px] text-faint">
              Source {w} × {h}
            </p>
          </div>
          <button onClick={attemptClose} className="text-sm text-muted hover:text-ink">
            Close
          </button>
        </div>

        {!isImage ? (
          <p className="rounded-lg border border-dashed border-border-strong px-3 py-6 text-center text-xs text-muted">
            Video isn&apos;t reframed here — a video needs a transcode, not a crop.
          </p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {/* ---- Feed ---------------------------------------------------------- */}
            <section>
              <h3 className="mb-0.5 text-xs font-medium text-ink">Feed</h3>
              <p className="mb-2 text-[11px] text-muted">4:5 to 1.91:1</p>
              <div style={{ height: FEED_PREVIEW_HEIGHT, aspectRatio: feedShape }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${asset.id}?variant=publish&mode=${
                    feedMode === "pad" ? "pad" : "crop"
                  }&v=${bust}`}
                  alt="Feed framing preview"
                  className={PREVIEW_IMG}
                />
              </div>
              {!feedNeedsConform ? (
                // Crop and Pad are genuinely no-ops here — conformImage() resolves "none"
                // for an in-range source and leaves the shape alone. Offering two buttons
                // that cannot differ is the same lie the 40x40 object-cover preview told.
                <p className="mt-2 text-[11px] text-muted">
                  Already within 4:5 – 1.91:1 — published with this shape untouched, so
                  there is nothing to crop or pad.
                </p>
              ) : (
                <>
                  <div className="mt-2 flex gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={feedMode === "crop"}
                      className={optionBtn(feedMode === "crop")}
                      onClick={() => setFeedMode("crop")}
                    >
                      Crop
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={feedMode === "pad"}
                      className={optionBtn(feedMode === "pad")}
                      onClick={() => setFeedMode("pad")}
                    >
                      Pad
                    </button>
                  </div>
                  <dl className="mt-1.5 space-y-0.5 text-[11px] text-muted">
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 font-medium">Crop</dt>
                      <dd>fills the frame — trims to fit the feed&apos;s range.</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 font-medium">Pad</dt>
                      <dd>keeps the whole photo, on white bars.</dd>
                    </div>
                  </dl>
                </>
              )}
            </section>

            {/* ---- Story --------------------------------------------------------- */}
            <section>
              <h3 className="mb-0.5 text-xs font-medium text-ink">Story</h3>
              <p className="mb-2 text-[11px] text-muted">9:16</p>
              {!storyNeedsCanvas ? (
                <p className="rounded-lg border border-dashed border-border-strong px-3 py-6 text-center text-xs text-muted">
                  Already 9:16 — the original is published untouched, with nothing to choose.
                </p>
              ) : (
                <>
                  <div style={STORY_PREVIEW_BOX}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/media/${asset.id}?variant=story&mode=${storyMode}&v=${bust}`}
                      alt="Story framing preview"
                      className={PREVIEW_IMG}
                    />
                  </div>
                  <div className="mt-2 flex gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={storyMode === "blurred"}
                      className={optionBtn(storyMode === "blurred")}
                      onClick={() => setStoryMode("blurred")}
                    >
                      Blurred fill
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={storyMode === "crop"}
                      className={optionBtn(storyMode === "crop")}
                      onClick={() => setStoryMode("crop")}
                    >
                      Crop to fill
                    </button>
                  </div>
                  {/* BOTH costs are always shown, not just the selected one. Revealing
                      "loses 58%" only after you pick crop tells you too late — the point
                      is to compare before committing. */}
                  <dl className="mt-1.5 space-y-0.5 text-[11px] text-muted">
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 font-medium">Blurred fill</dt>
                      <dd>keeps the whole photo, over a blurred copy of itself.</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 font-medium">Crop to fill</dt>
                      <dd>fills the frame — loses {cropLoss}% of the width.</dd>
                    </div>
                  </dl>
                </>
              )}
            </section>
          </div>
        )}

        {scheduledSendCount > 0 ? (
          // Shown up front, not only once something is dirty: the point is to know what is
          // at stake BEFORE fiddling, which is the whole reason this warning exists.
          <p className="mt-4 text-[11px] text-muted">
            {scheduledSendCount} scheduled send{scheduledSendCount === 1 ? "" : "s"} will use
            the new framing. Already-posted sends are unaffected — what is on Instagram
            can&apos;t be changed from here.
          </p>
        ) : null}
        {error ? <p className="mt-2 text-[11px] text-status-failed">{error}</p> : null}

        {isImage ? (
          <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="rounded-md border border-transparent bg-brand-weak px-3 py-1.5 text-xs font-medium text-brand-strong transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save framing"}
            </button>
            <button
              type="button"
              onClick={attemptClose}
              disabled={busy}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              Cancel
            </button>
            <span className="data ml-auto text-[11px] text-faint">
              {dirty ? "Unsaved changes" : "Nothing to save"}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
