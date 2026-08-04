"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { videoPreviewSrc } from "@/lib/format";
import { stepIndex } from "@/lib/lightbox-nav";

/** The minimum an asset needs to be shown full-size — see media-lightbox-design.md. */
export interface LightboxAsset {
  id: number;
  media_kind: "image" | "video";
  cover_frame_ms: number | null;
  width: number | null;
  height: number | null;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/** Minimum horizontal drag, in px, before a touch swipe counts as a slide change. */
const SWIPE_PX = 50;

function PlayGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function ExpandGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function ChevronGlyph({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={direction === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

/** Overlay button on a thumbnail that opens the lightbox. A real, keyboard-reachable
 *  <button>, not a click handler bolted onto the tile — see Decision 1 / 5 in the design
 *  doc. `stopPropagation` is load-bearing: this sits on a card whose own onClick toggles
 *  bulk-selection, and the nested title/thumbnail <Link> already relies on the same
 *  pattern to reach the editor without also selecting the card. */
export function MediaBadge({
  mediaKind,
  onOpen,
  label,
}: {
  mediaKind: "image" | "video";
  onOpen: () => void;
  label?: string;
}) {
  const verb = mediaKind === "video" ? "Play video" : "View image";
  const accessibleName = label ? `${verb} — ${label}` : verb;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      aria-label={accessibleName}
      title={accessibleName}
      className="absolute bottom-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white transition-colors hover:bg-black/85"
    >
      {mediaKind === "video" ? <PlayGlyph /> : <ExpandGlyph />}
    </button>
  );
}

/** The panel itself: media, close, and — for a carousel — the slide navigation.
 *  Stateless and portal-free so it can be rendered in a test; MediaLightbox below owns
 *  the portal, the focus trap, the key handling, and which slide is showing. */
export function LightboxPanel({
  assets,
  index,
  label,
  mediaError,
  onClose,
  onStep,
  onMediaError,
  panelRef,
  onVideoPlay,
}: {
  assets: LightboxAsset[];
  index: number;
  label: string;
  mediaError: boolean;
  onClose: () => void;
  onStep: (delta: number) => void;
  onMediaError: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  onVideoPlay?: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
}) {
  const asset = assets[index];
  if (!asset) return null;
  const many = assets.length > 1;
  const navButton =
    "absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-ink shadow-lg transition-opacity hover:bg-surface-sunken disabled:opacity-30";

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      className="relative max-h-full max-w-full"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-ink shadow-lg hover:bg-surface-sunken"
      >
        <CloseGlyph />
      </button>

      {many ? (
        <>
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={index === 0}
            aria-label="Previous slide"
            title="Previous slide"
            className={`${navButton} -left-4`}
          >
            <ChevronGlyph direction="left" />
          </button>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={index === assets.length - 1}
            aria-label="Next slide"
            title="Next slide"
            className={`${navButton} -right-4`}
          >
            <ChevronGlyph direction="right" />
          </button>
          <span className="data absolute -bottom-7 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-2.5 py-0.5 text-xs text-white">
            {index + 1} / {assets.length}
          </span>
        </>
      ) : null}

      {mediaError ? (
        <p className="max-w-sm rounded-card border border-border bg-surface px-6 py-8 text-sm text-status-failed">
          Couldn&apos;t load this file — it may be missing, or (for a video saved before
          automatic conversion existed) in a format this browser can&apos;t play.
        </p>
      ) : asset.media_kind === "video" ? (
        <video
          key={asset.id}
          src={videoPreviewSrc(asset.id, asset.cover_frame_ms)}
          controls
          playsInline
          autoPlay={false}
          onError={onMediaError}
          onPlay={onVideoPlay}
          className="max-h-[85vh] max-w-[90vw] rounded-card bg-black"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={asset.id}
          src={`/api/media/${asset.id}`}
          alt={label}
          onError={onMediaError}
          className="max-h-[85vh] max-w-[90vw] rounded-card object-contain"
        />
      )}
    </div>
  );
}

/** Full-size, in-place view of a post's assets — a Reel with controls and sound, a photo
 *  at full size, or (for a carousel) any slide in the set, browsable with arrow keys, the
 *  on-screen chevrons, or a swipe. Rendered through a portal so it escapes the Library
 *  card's overflow-hidden and stacking context (Decision 2 / 5). Read-only: no API,
 *  schema, or worker change. */
export function MediaLightbox({
  assets,
  initialIndex = 0,
  label,
  onClose,
}: {
  assets: LightboxAsset[];
  initialIndex?: number;
  label: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // The setup effect below must run ONCE per open, not on every parent re-render.
  // Callers pass onClose as an inline arrow, so its identity changes on each render of
  // the parent; depending on it directly tore the effect down and rebuilt it, which
  // reset focus to the close button and discarded wherever the user had tabbed to.
  // Reading it through a ref keeps the handler current with an empty dependency array.
  // Whether the viewer has pressed play yet, so the rewind-to-start below happens once.
  const hasPlayed = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [index, setIndex] = useState(() => stepIndex(initialIndex, 0, assets.length));
  const [mediaError, setMediaError] = useState(false);

  // The list can grow under us: the Library card opens on slide 1 with the one asset it
  // already had, then extends to the full carousel when its fetch lands. Reading through
  // stepIndex keeps the index in range through that, and through a post losing a slide.
  const safeIndex = stepIndex(index, 0, assets.length);
  const asset = assets[safeIndex];

  // Kept in a ref so the key handler (installed once, below) always steps from the
  // current slide rather than from whichever one it closed over on mount.
  const stateRef = useRef({ index: safeIndex, length: assets.length });

  const step = useCallback((delta: number) => {
    const { index: from, length } = stateRef.current;
    const next = stepIndex(from, delta, length);
    if (next === from) return;
    // A new slide is a new file: whatever failed to load on the last one says nothing
    // about this one, and a video's "have we played yet" bookkeeping starts over.
    setMediaError(false);
    hasPlayed.current = false;
    setIndex(next);
  }, []);
  // Exists so the key handler below can call the current `step` without adding it to
  // that effect's dependency array, which the "install once" contract forbids touching.
  // `step` happens to be referentially stable today (useCallback with no deps), but this
  // ref is resynced on every render regardless — if `step` ever grows a dependency and
  // stops being stable, stepRef stays correct instead of freezing a stale mount-time
  // closure that exhaustive-deps has no way to flag (refs are exempt from that check).
  const stepRef = useRef(step);

  // Both refs above are read from a DOM event handler (installed once, empty deps, below)
  // and from touch/wheel handlers that close over render-time values — assigning them
  // inline during render is a lint error (react-hooks/refs), so they're synced here
  // instead. useLayoutEffect (not useEffect) guarantees both are current before the
  // browser paints or the user can press a key, swipe, or scroll.
  useLayoutEffect(() => {
    stateRef.current = { index: safeIndex, length: assets.length };
    stepRef.current = step;
  });

  // Focus in on open, trap Tab while open, restore focus + body scroll on close/unmount.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
    (focusables()[0] ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Arrow keys already mean "seek" inside a video player, and the player's own
        // controls must keep working — only steal them when focus is elsewhere.
        const target = e.target as HTMLElement | null;
        if (target?.closest("video")) return;
        if (stateRef.current.length < 2) return;
        e.preventDefault();
        stepRef.current(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, []);

  // Depending on `assets` itself would re-run this on every parent render: every caller
  // passes a fresh array literal, carousel or not, so the effect would fire a new
  // window.Image() per keystroke once a caller (Task 9) passes a real multi-slide array.
  // Depending on the neighbour ids instead — plain numbers/null — only re-runs when the
  // actual neighbouring slide changes.
  const prevNeighbour = assets[safeIndex - 1];
  const nextNeighbour = assets[safeIndex + 1];
  const prevNeighbourId = prevNeighbour?.media_kind === "image" ? prevNeighbour.id : null;
  const nextNeighbourId = nextNeighbour?.media_kind === "image" ? nextNeighbour.id : null;

  useEffect(() => {
    for (const id of [prevNeighbourId, nextNeighbourId]) {
      if (id != null) {
        // Warming the browser cache only — the element is deliberately never mounted.
        const preload = new window.Image();
        preload.src = `/api/media/${id}`;
      }
    }
  }, [prevNeighbourId, nextNeighbourId]);

  const touchStartX = useRef<number | null>(null);
  const lastWheelStep = useRef(0);

  function onTouchStart(e: React.TouchEvent) {
    // A touch on a video's own (shadow-DOM) scrub bar is `composed`, so it retargets to
    // the <video> host and bubbles up to this backdrop handler same as any other touch.
    // Without this guard, dragging the seek bar more than SWIPE_PX horizontally both
    // seeks the video AND steps the carousel mid-scrub — the same "controls must keep
    // working" problem the arrow-key handler guards against, just for touch instead.
    if ((e.target as HTMLElement | null)?.closest("video")) {
      touchStartX.current = null;
      return;
    }
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    const from = touchStartX.current;
    touchStartX.current = null;
    if (from === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? from) - from;
    if (Math.abs(dx) < SWIPE_PX) return;
    step(dx < 0 ? 1 : -1);
  }
  // No video-target guard here, unlike touch and arrow keys: no major browser binds a
  // horizontal wheel gesture to video seeking, so there is no native control to fight
  // over. A vertical wheel over the volume slider is already excluded by the directional
  // check below (deltaX must dominate deltaY), which is the only wheel interaction any
  // browser's native video controls actually bind.
  function onWheel(e: React.WheelEvent) {
    // A Mac trackpad's two-finger horizontal swipe arrives as a stream of wheel events,
    // so without the cooldown one flick would run through the whole carousel. Vertical
    // scroll is ignored outright: the page behind is already locked.
    if (Math.abs(e.deltaX) < 30 || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const now = Date.now();
    if (now - lastWheelStep.current < 350) return;
    lastWheelStep.current = now;
    step(e.deltaX > 0 ? 1 : -1);
  }

  if (!asset) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onWheel={onWheel}
    >
      <LightboxPanel
        assets={assets}
        index={safeIndex}
        label={label}
        mediaError={mediaError}
        onClose={onClose}
        onStep={step}
        onMediaError={() => setMediaError(true)}
        panelRef={panelRef}
        onVideoPlay={(e) => {
          // Unchanged behaviour, moved: the #t= fragment seeks to the cover frame so the
          // video OPENS there (and so Safari paints anything at all), but that is a poster
          // position, not a playback position. Rewind on first play only, and only if the
          // playhead is still where the fragment put it — if the viewer scrubbed somewhere
          // themselves and then pressed play, that is where they meant to start.
          if (hasPlayed.current) return;
          hasPlayed.current = true;
          const video = e.currentTarget;
          const coverSeconds = (asset.cover_frame_ms ?? 0) / 1000;
          if (coverSeconds > 0 && Math.abs(video.currentTime - coverSeconds) < 0.5) {
            video.currentTime = 0;
          }
        }}
      />
    </div>,
    document.body
  );
}
