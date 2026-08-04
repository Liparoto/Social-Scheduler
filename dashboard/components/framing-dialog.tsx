"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cropLossFraction, needsStoryCanvas } from "@/lib/story-geometry";
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
*/

/** Big enough to actually judge. The old control was 40x40. */
const FEED_PREVIEW = "h-[200px] w-[200px]";
const STORY_PREVIEW = "h-[284px] w-[160px]";

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
  onClose,
}: {
  asset: Asset;
  /** Scheduled-but-unsent publications this asset's framing governs — a real consequence
   *  of changing it, so it is stated rather than discovered. */
  scheduledSendCount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [feedMode, setFeedMode] = useState(asset.conform_mode);
  const [storyMode, setStoryMode] = useState(asset.story_mode);
  const [bust, setBust] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const w = asset.width ?? 0;
  const h = asset.height ?? 0;
  // sharp cannot reframe video, so neither surface offers anything for one.
  const isImage = asset.media_kind === "image";
  const storyNeedsCanvas = isImage && needsStoryCanvas(w, h);
  const cropLoss = Math.round(cropLossFraction(w, h) * 100);

  async function choose(url: string, body: object, apply: () => void) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? "Could not update framing.");
        return;
      }
      apply();
      setBust((b) => b + 1); // cache-bust the previews so the new render is fetched
      router.refresh();
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
        if (e.target === e.currentTarget) onClose();
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
          <button onClick={onClose} className="text-sm text-muted hover:text-ink">
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
              <div className={FEED_PREVIEW}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${asset.id}?variant=publish&v=${bust}`}
                  alt="Feed framing preview"
                  className={PREVIEW_IMG}
                />
              </div>
              <div className="mt-2 flex gap-1">
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={feedMode === "crop"}
                  className={optionBtn(feedMode === "crop")}
                  onClick={() =>
                    choose(`/api/assets/${asset.id}/conform`, { mode: "crop" }, () =>
                      setFeedMode("crop"),
                    )
                  }
                >
                  Crop
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={feedMode === "pad"}
                  className={optionBtn(feedMode === "pad")}
                  onClick={() =>
                    choose(`/api/assets/${asset.id}/conform`, { mode: "pad" }, () =>
                      setFeedMode("pad"),
                    )
                  }
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
                  <div className={STORY_PREVIEW}>
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
                      onClick={() =>
                        choose(
                          `/api/assets/${asset.id}/story-framing`,
                          { mode: "blurred" },
                          () => setStoryMode("blurred"),
                        )
                      }
                    >
                      Blurred fill
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={storyMode === "crop"}
                      className={optionBtn(storyMode === "crop")}
                      onClick={() =>
                        choose(
                          `/api/assets/${asset.id}/story-framing`,
                          { mode: "crop" },
                          () => setStoryMode("crop"),
                        )
                      }
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
          <p className="mt-4 text-[11px] text-muted">
            {scheduledSendCount} scheduled send{scheduledSendCount === 1 ? "" : "s"} will use
            the new framing. Already-posted sends are unaffected — what is on Instagram
            can&apos;t be changed from here.
          </p>
        ) : null}
        {error ? <p className="mt-2 text-[11px] text-status-failed">{error}</p> : null}
      </div>
    </div>
  );
}
