"use client";

import { useState } from "react";
import { FramingDialog } from "@/components/framing-dialog";
import { feedRatio, feedShapesDisagree } from "@/lib/feed-geometry";
import { needsStoryCanvas, STORY_RATIO } from "@/lib/story-geometry";
import { videoPreviewSrc } from "@/lib/format";
import { stepIndex } from "@/lib/lightbox-nav";
import type { Asset } from "@/lib/types";

/*
  "How this posts" — the same post shown at BOTH surfaces' real shapes, side by side.

  This replaces the composer's old preview card, which was the reason "what will this
  actually look like" was unanswerable. That card rendered a fixed `aspect-square` box with
  `object-cover`, sourced from `/api/media/{id}` with NO variant param — i.e. the untouched
  ORIGINAL, square-cropped by CSS. Instagram publishes neither of those things: the feed
  gets the conformed derivative (4:5-1.91:1) and a Story gets the 9:16 canvas. A preview
  that shows a third shape nobody will ever see is worse than no preview, because it is
  believed.

  Three rules this component exists to keep:

    * every image is fetched through the SAME variant the worker publishes
      (`?variant=publish` for feed, `?variant=story` for a Story), never the original;
    * frames are the real aspect ratio, and images inside them are object-CONTAIN. The
      40x40 object-cover control in the old conform-control is the documented case of a
      preview that could not distinguish the very options it existed to compare;
    * one slide index drives BOTH panels, so you are always comparing the same photo in
      two shapes rather than two photos.
*/

/*
  The two panels are sized in FRACTIONS, not pixels, and their frames get their height from
  CSS `aspect-ratio` rather than a computed number. This is load-bearing, not stylistic: the
  composer renders this in a 360px sticky column while the post page gives it 768px. Fixed
  260+180 widths wrapped in the composer, stacking the panels vertically — which destroys
  the one thing the component is for, comparing two shapes side by side, in the exact place
  the owner is still choosing photos. Fractions hold the comparison at any width.

  Capped so the panels don't sprawl on the wide post page.
*/
const PANELS = "grid grid-cols-[1.55fr_1fr] gap-4 max-w-[520px]";

const FRAME =
  "overflow-hidden rounded-lg border border-border bg-surface-sunken";
/** object-CONTAIN, always. See the header comment. */
const FRAME_MEDIA = "h-full w-full object-contain";

const arrowBtn =
  "rounded-md border border-border px-2 py-1 text-xs text-ink transition-colors hover:bg-surface-sunken disabled:opacity-30";

export function PostPreview({
  assets,
  caption,
  firstComment,
  scheduledSendCounts = {},
  textOnly = false,
}: {
  /** In publish order — the caller owns ordering, this only renders it. */
  assets: Asset[];
  caption: string;
  firstComment?: string;
  /** Scheduled-but-unsent publications per asset, passed straight to the framing dialog
   *  so changing framing from here states its blast radius the same way it does anywhere
   *  else. Defaults to none, which is correct for a post that has never been scheduled. */
  scheduledSendCounts?: Record<number, number>;
  textOnly?: boolean;
}) {
  const [index, setIndex] = useState(0);
  // assetId -> the ratio of the derivative the browser actually received. Ground truth,
  // and it cannot drift from conform.ts the way a second copy of the maths could. The
  // predicted ratio below only sizes the frame until this arrives.
  const [measured, setMeasured] = useState<Record<number, number>>({});
  const [framing, setFraming] = useState<Asset | null>(null);

  // A slide can disappear under us (removed in the composer while the preview is open).
  const safeIndex = Math.min(index, Math.max(0, assets.length - 1));
  const asset = assets[safeIndex];

  const captionBlock = (
    <div className="p-3">
      <p className="whitespace-pre-wrap text-sm text-ink">
        {caption || <span className="text-faint">Your caption…</span>}
      </p>
      {firstComment ? (
        <p className="mt-2 border-t border-border pt-2 text-xs text-muted">
          <span className="text-faint">First comment: </span>
          {firstComment}
        </p>
      ) : null}
    </div>
  );

  if (textOnly || !asset) {
    return (
      <div className="rounded-card border border-border bg-surface p-4">
        <div className="mb-3">
          <PreviewHeading />
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-3 py-2">
            <span className="data text-xs font-medium uppercase tracking-wide text-muted">
              {textOnly ? "Text post" : "No media yet"}
            </span>
          </div>
          {captionBlock}
        </div>
        {!textOnly ? (
          <p className="mt-2 text-center text-[11px] text-faint">
            Add an image to see how it is framed for the feed and for a Story.
          </p>
        ) : null}
      </div>
    );
  }

  const isImage = asset.media_kind === "image";
  const isCarousel = assets.length > 1;

  // Predicted from the source dimensions; replaced by the real measurement on load. Falls
  // back to square only when the dimensions were never recorded AND nothing has loaded.
  const ratio = measured[asset.id] ?? feedRatio(asset.width, asset.height) ?? 1;

  // Each asset conforms independently, so a carousel can end up mixed-shape.
  const mixedShapes = feedShapesDisagree(
    assets.map((a) => (a.media_kind === "image" ? measured[a.id] ?? feedRatio(a.width, a.height) : null)),
  );

  const storyIsNative = isImage && !needsStoryCanvas(asset.width ?? 0, asset.height ?? 0);

  function recordRatio(id: number, w: number, h: number) {
    if (!w || !h) return;
    const real = w / h;
    setMeasured((prev) => (prev[id] === real ? prev : { ...prev, [id]: real }));
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <PreviewHeading />
        {isImage ? (
          // The slide it acts on is the one on screen; the nav row below already names
          // that, so the label does not repeat it and stay narrow enough for the
          // composer's 360px column.
          <button
            type="button"
            onClick={() => setFraming(asset)}
            className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-ink transition-colors hover:bg-surface-sunken"
          >
            Fix framing
          </button>
        ) : null}
      </div>

      {isCarousel ? (
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            className={arrowBtn}
            disabled={safeIndex === 0}
            aria-label="Previous slide"
            onClick={() => setIndex(stepIndex(safeIndex, -1, assets.length))}
          >
            ←
          </button>
          <span className="data text-[11px] text-muted">
            Slide {safeIndex + 1} of {assets.length}
          </span>
          <button
            type="button"
            className={arrowBtn}
            disabled={safeIndex === assets.length - 1}
            aria-label="Next slide"
            onClick={() => setIndex(stepIndex(safeIndex, 1, assets.length))}
          >
            →
          </button>
        </div>
      ) : null}

      <div className={PANELS}>
        {/* ---- Feed ---------------------------------------------------------------- */}
        <section>
          <SurfaceLabel name="Feed" detail={`${ratio.toFixed(2)}:1`} />
          <div className={FRAME} style={{ aspectRatio: ratio }}>
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/${asset.id}?variant=publish`}
                alt={`Slide ${safeIndex + 1} as it will appear in the feed`}
                className={FRAME_MEDIA}
                onLoad={(e) =>
                  recordRatio(asset.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
                }
              />
            ) : (
              // videoPreviewSrc's #t= fragment forces Safari to paint a frame on load
              // (Chrome does it for free), and uses the owner's chosen cover frame so this
              // agrees with the cover picker instead of showing frame 0.
              <video
                src={videoPreviewSrc(asset.id, asset.cover_frame_ms)}
                className={FRAME_MEDIA}
                muted
                playsInline
                controls
                onLoadedMetadata={(e) =>
                  recordRatio(asset.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)
                }
              />
            )}
          </div>
          <div className="mt-2 overflow-hidden rounded-lg border border-border">
            {captionBlock}
          </div>
        </section>

        {/* ---- Story --------------------------------------------------------------- */}
        <section>
          <SurfaceLabel name="Story" detail="9:16" />
          <div className={FRAME} style={{ aspectRatio: STORY_RATIO }}>
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/media/${asset.id}?variant=story&mode=${asset.story_mode}`}
                alt={`Slide ${safeIndex + 1} as it will appear as a Story`}
                className={FRAME_MEDIA}
              />
            ) : (
              <video
                src={videoPreviewSrc(asset.id, asset.cover_frame_ms)}
                className={FRAME_MEDIA}
                muted
                playsInline
              />
            )}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            {!isImage ? (
              // sharp cannot reframe video, and the story-framing endpoint refuses it, so
              // there is no 9:16 canvas to show. Say so rather than imply this frame is
              // what Instagram will produce.
              <>Video goes to a Story as-is — Instagram applies its own fit.</>
            ) : storyIsNative ? (
              <>Already 9:16 — published untouched.</>
            ) : asset.story_mode === "blurred" ? (
              <>Blurred fill — the whole photo, over a blurred copy of itself.</>
            ) : (
              <>Crop to fill — trimmed to 9:16.</>
            )}
          </p>
          {isCarousel ? (
            <p className="mt-1 text-[11px] text-faint">
              A carousel sent to Stories goes out as {assets.length} separate Stories, one
              per slide.
            </p>
          ) : null}
        </section>
      </div>

      {mixedShapes ? (
        // Deliberately does NOT predict what Instagram does with a mixed-shape carousel:
        // that is not verified anywhere in reference.md, and this project does not
        // publish remembered numbers as fact. The actionable part is the mismatch itself.
        <p className="mt-3 rounded-lg bg-accent-weak px-3 py-2 text-[11px] text-accent-strong">
          These slides are not all the same shape. Each photo is framed on its own, so a
          carousel can end up mixed — set them to matching framing if you want them uniform.
        </p>
      ) : null}

      {framing ? (
        <FramingDialog
          asset={framing}
          scheduledSendCount={scheduledSendCounts[framing.id] ?? 0}
          onClose={() => setFraming(null)}
        />
      ) : null}
    </div>
  );
}

function PreviewHeading() {
  return (
    <h3 className="font-display text-xs font-semibold uppercase tracking-wide text-muted">
      How this posts
    </h3>
  );
}

function SurfaceLabel({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-1.5">
      <span className="text-xs font-medium text-ink">{name}</span>
      <span className="data text-[11px] text-faint">{detail}</span>
    </div>
  );
}
