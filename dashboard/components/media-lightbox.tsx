"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { videoPreviewSrc } from "@/lib/format";

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
      className="absolute bottom-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-ink/70 text-white transition-colors hover:bg-ink/85"
    >
      {mediaKind === "video" ? <PlayGlyph /> : <ExpandGlyph />}
    </button>
  );
}

/** Full-size, in-place view of one asset — a Reel with controls and sound, or a photo at
 *  full size. Rendered through a portal so it escapes the Library card's overflow-hidden
 *  and stacking context (Decision 2 / 5). Read-only: no API, schema, or worker change. */
export function MediaLightbox({
  asset,
  label,
  onClose,
}: {
  asset: LightboxAsset;
  label: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [mediaError, setMediaError] = useState(false);

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
        onClose();
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
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
      onClick={onClose}
    >
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

        {mediaError ? (
          <p className="max-w-sm rounded-card border border-border bg-surface px-6 py-8 text-sm text-status-failed">
            Couldn&apos;t load this file — it may be missing, or (for a video saved before
            automatic conversion existed) in a format this browser can&apos;t play.
          </p>
        ) : asset.media_kind === "video" ? (
          <video
            src={videoPreviewSrc(asset.id, asset.cover_frame_ms)}
            controls
            playsInline
            autoPlay={false}
            onError={() => setMediaError(true)}
            className="max-h-[85vh] max-w-[90vw] rounded-card bg-ink-soft"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/media/${asset.id}`}
            alt={label}
            onError={() => setMediaError(true)}
            className="max-h-[85vh] max-w-[90vw] rounded-card object-contain"
          />
        )}
      </div>
    </div>,
    document.body
  );
}
