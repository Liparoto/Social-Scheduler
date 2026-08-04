"use client";

import { useRef, type ReactNode } from "react";

// Minimal shape a carousel slide needs to be reordered: which asset it points at,
// plus an optional label for the thumbnail's alt text. Deliberately doesn't carry
// anything asset-specific (media_kind, conform state, etc.) — this component is
// shared by the composer (images only, for now) and the merge-into-carousel modal,
// and neither owner should have to satisfy the other's fields just to reorder.
export interface Slide {
  assetId: number;
  label?: string;
}

export function SlideReorder({
  slides,
  onReorder,
  onRemove,
  renderExtra,
}: {
  slides: Slide[];
  onReorder: (next: Slide[]) => void;
  onRemove?: (assetId: number) => void;
  // Callers (the composer, for its per-image FramingButton) can hang extra UI off
  // each slide without this component needing to know what that UI is or import
  // anything video/conform-specific — keeps this reusable for the merge modal,
  // which only ever deals in already-conformed images.
  renderExtra?: (slide: Slide, index: number) => ReactNode;
}) {
  // HTML5 drag-and-drop hands you dragstart/dragover/drop events but no notion of
  // "which index started this drag" — we track the source index in a ref rather
  // than state because dragover fires continuously while hovering, and re-rendering
  // the whole list on every one of those events would be wasteful.
  const dragIndex = useRef<number | null>(null);

  function move(from: number, to: number) {
    if (to < 0 || to >= slides.length) return;
    const next = [...slides];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onReorder(next);
  }

  return (
    <ul className="flex flex-wrap gap-3">
      {slides.map((slide, i) => (
        <li
          key={slide.assetId}
          draggable
          onDragStart={() => (dragIndex.current = i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragIndex.current !== null) move(dragIndex.current, i);
            dragIndex.current = null;
          }}
          className="group relative"
        >
          <span className="data absolute left-1 top-1 z-10 rounded bg-ink/75 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {i + 1}
          </span>
          {onRemove ? (
            <button
              onClick={() => onRemove(slide.assetId)}
              className="absolute right-1 top-1 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-ink/75 text-xs text-white group-hover:flex"
              aria-label="Remove image"
            >
              ×
            </button>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media/${slide.assetId}?variant=thumb`}
            alt={slide.label ?? "image"}
            className="h-24 w-24 cursor-grab rounded-lg border border-border object-cover active:cursor-grabbing"
          />
          {renderExtra ? renderExtra(slide, i) : null}
          <div className="mt-1 flex justify-center gap-1">
            <button
              onClick={() => move(i, i - 1)}
              disabled={i === 0}
              className="rounded px-1 text-xs text-muted hover:text-ink disabled:opacity-30"
              aria-label="Move left"
            >
              ←
            </button>
            <button
              onClick={() => move(i, i + 1)}
              disabled={i === slides.length - 1}
              className="rounded px-1 text-xs text-muted hover:text-ink disabled:opacity-30"
              aria-label="Move right"
            >
              →
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
