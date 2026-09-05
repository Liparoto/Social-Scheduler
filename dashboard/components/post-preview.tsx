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

  Rules this component exists to keep:

    * every image is fetched through the SAME variant the worker publishes
      (`?variant=publish` for feed, `?variant=story` for a Story), never the original;
    * frames are the real aspect ratio, and images inside them are object-CONTAIN. The
      40x40 object-cover control in the old conform-control is the documented case of a
      preview that could not distinguish the very options it existed to compare;
    * one slide index drives BOTH panels, so you are always comparing the same photo in
      two shapes rather than two photos;
    * anything it STATES is measured, not predicted. See MEASURING below.
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

const FRAME = "overflow-hidden rounded-lg border border-border bg-surface-sunken";
/** object-CONTAIN, always. See the header comment. */
const FRAME_MEDIA = "h-full w-full object-contain";

const arrowBtn =
  "rounded-md border border-border px-2 py-1 text-xs text-ink transition-colors hover:bg-surface-sunken disabled:opacity-30";

/** What the frame falls back to before anything has loaded and nothing can be predicted. */
const UNKNOWN_RATIO = 1;

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
  /*
    MEASURING. assetId -> the ratio of the derivative the browser actually received.

    Predicting a shape from `assets.width/height` is not good enough to make a CLAIM from,
    because those columns hold the source's PRE-EXIF-rotation dimensions: the upload route
    reads `sharp(buf).metadata()` without `.rotate()`, which for EXIF orientation 5-8 (a
    routine vertical phone photo) reports width and height the wrong way round — the exact
    trap conform.ts:41-49 documents at length. A prediction is therefore fine for sizing a
    frame that is about to be corrected, and NOT fine for deciding whether two slides
    disagree. Everything this component asserts is measured; predictions only avoid a
    layout jump on the way there.
  */
  const [measured, setMeasured] = useState<Record<number, number>>({});
  const [framing, setFraming] = useState<Asset | null>(null);
  /*
    Framing is editable from inside this component, and the media route serves derivatives
    with `Cache-Control: private, max-age=3600`. Without a cache-buster the panels keep
    showing the OLD derivative at a byte-identical URL immediately after the owner changes
    it — i.e. the preview goes stale exactly when it is being used to fix something, which
    is the one moment it must not. FramingDialog busts its own previews for this reason;
    this is the same fix for the panels that host it.
  */
  const [bust, setBust] = useState(0);
  /*
    ...and the mode itself has to be tracked locally, because a server refresh cannot reach
    it. FramingDialog ends with router.refresh(), which re-renders server components — but
    the COMPOSER holds its assets in client state (useState<UploadedAsset[]>), so its Asset
    rows never change and `asset.story_mode` stays at the old value forever. That would
    request the wrong canvas AND print a label that names the wrong choice, which is worse
    than a stale image: it is a false statement.
  */
  const [storyOverride, setStoryOverride] = useState<Record<number, Asset["story_mode"]>>({});

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
  const storyMode = storyOverride[asset.id] ?? asset.story_mode;

  const ratio = measured[asset.id] ?? predictRatio(asset) ?? UNKNOWN_RATIO;

  // Every image slide, measured. mixedShapes may ONLY be computed from these: mixing one
  // measured value with N predicted ones is how a carousel of identical phone portraits
  // ends up accused of being mixed (see MEASURING above).
  const imageSlides = assets.filter((a) => a.media_kind === "image");
  const measuredSlides = imageSlides.map((a) => measured[a.id]);
  const allMeasured = imageSlides.length > 0 && measuredSlides.every((r) => r !== undefined);
  const mixedShapes = allMeasured && feedShapesDisagree(measuredSlides);
  const distinctShapes = allMeasured
    ? [...new Set(measuredSlides.map((r) => (r as number).toFixed(2)))]
    : [];

  // Only claimed when the dimensions are actually known: needsStoryCanvas() returns false
  // for 0x0, so asserting on it would print "Already 9:16" for an asset whose dimensions
  // were never recorded (the upload route swallows a sharp failure).
  const storyDimsKnown = Boolean(asset.width && asset.height);
  const storyIsNative =
    isImage && storyDimsKnown && !needsStoryCanvas(asset.width!, asset.height!);

  function recordRatio(id: number, w: number, h: number) {
    if (!w || !h) return;
    const real = w / h;
    setMeasured((prev) => (prev[id] === real ? prev : { ...prev, [id]: real }));
  }

  /*
    A ref callback is required ALONGSIDE onLoad, not instead of it.

    The media route serves derivatives with max-age=3600, so on any revisit the image is
    already in the browser cache and finishes loading BEFORE React attaches its onLoad
    handler — the handler then never fires. Measuring only in onLoad therefore worked on a
    cold cache and silently stopped working on every subsequent visit, which is the worst
    possible failure for a component whose contract is "what it states is measured": it
    would quietly fall back to the unreliable stored dimensions with nothing to show for it.
    The ref runs at commit and reads a complete image immediately; onLoad covers the
    still-downloading case. recordRatio() bails when the value is unchanged, so the ref
    re-running on later renders cannot loop.
  */
  const measureImage = (id: number) => (el: HTMLImageElement | null) => {
    if (el?.complete) recordRatio(id, el.naturalWidth, el.naturalHeight);
  };
  const measureVideo = (id: number) => (el: HTMLVideoElement | null) => {
    // readyState >= HAVE_METADATA means videoWidth/videoHeight are populated.
    if (el && el.readyState >= 1) recordRatio(id, el.videoWidth, el.videoHeight);
  };

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <PreviewHeading />
        {isImage ? (
          // The slide it acts on is the one on screen; the nav row below already names
          // that, so the label does not repeat it and stays narrow enough for the
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
                src={`/api/media/${asset.id}?variant=publish&v=${bust}`}
                alt={`Slide ${safeIndex + 1} as it will appear in the feed`}
                className={FRAME_MEDIA}
                ref={measureImage(asset.id)}
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
                ref={measureVideo(asset.id)}
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
                src={`/api/media/${asset.id}?variant=story&mode=${storyMode}&v=${bust}`}
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
            ) : !storyDimsKnown ? (
              <>Framing shown as rendered — this image&apos;s dimensions were not recorded.</>
            ) : storyIsNative ? (
              <>Already 9:16 — published untouched.</>
            ) : storyMode === "blurred" ? (
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
        /*
          States the mismatch and stops. It deliberately does NOT predict what Instagram
          does with a mixed-shape carousel (not verified in reference.md), and it no longer
          suggests "set them to matching framing" — that advice was unachievable. Conform
          only reshapes a source OUTSIDE 4:5-1.91:1, so for two in-range slides the Crop and
          Pad buttons are no-ops and no control in this app can make them match. Naming the
          shapes is the part the owner can actually act on, by choosing different photos.
        */
        <p className="mt-3 rounded-lg bg-accent-weak px-3 py-2 text-[11px] text-accent-strong">
          These slides are not all the same shape ({distinctShapes.join(":1, ")}:1). Each
          photo is framed on its own, so a carousel can end up mixed.
        </p>
      ) : null}

      {/*
        Measures every OTHER image slide, so mixedShapes above can be computed from real
        derivatives rather than from the unreliable stored dimensions. 1px and behind the
        card rather than `display:none`, so there is no dependence on how a browser treats
        fetches for undisplayed images. Same URLs as the panels, so the visible slide costs
        no extra request.
      */}
      <div aria-hidden className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0">
        {imageSlides
          .filter((a) => measured[a.id] === undefined)
          .map((a) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`measure-${a.id}-${bust}`}
              src={`/api/media/${a.id}?variant=publish&v=${bust}`}
              alt=""
              ref={measureImage(a.id)}
              onLoad={(e) =>
                recordRatio(a.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
              }
            />
          ))}
      </div>

      {framing ? (
        <FramingDialog
          asset={framing}
          scheduledSendCount={scheduledSendCounts[framing.id] ?? 0}
          onChanged={(next) => {
            // Track the story mode locally (a server refresh cannot reach the composer's
            // client-held assets) and bust the URLs so the new derivative is fetched.
            setStoryOverride((prev) => ({ ...prev, [framing.id]: next.storyMode }));
            setMeasured((prev) => {
              if (prev[framing.id] === undefined) return prev;
              const next = { ...prev };
              delete next[framing.id];
              return next;
            });
            setBust((b) => b + 1);
          }}
          onClose={() => setFraming(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The shape the feed frame will be, before anything has loaded. Sizing only — never a claim.
 *
 * Images are clamped into the feed's range because conformImage() clamps them. Video is NOT:
 * the upload path only downscales it (conform_mode "downscale"), which preserves the ratio,
 * so applying the image bounds would render a 9:16 Reel at 0.80 until its metadata lands.
 */
function predictRatio(asset: Asset): number | null {
  if (asset.media_kind === "image") return feedRatio(asset.width, asset.height);
  if (!asset.width || !asset.height) return null;
  return asset.width / asset.height;
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
