"use client";

import { useState, type ReactNode } from "react";
import { SlideReorder, type Slide } from "@/components/slide-reorder";

/** The least a slide needs to be reordered and drawn. Matches what GET /assets returns. */
export interface OrderableAsset {
  id: number;
  media_kind: "image" | "video";
}

/**
 * Slide-order state and the one PATCH that saves it.
 *
 * Lives in a hook rather than inside <CarouselReorder> because the two screens that can
 * reorder disagree about when saving happens: the post detail page has its own Save
 * button, while the quick-edit dialog saves everything through a single Save and would
 * quietly lose work if a control inside it saved on its own schedule. The hook is what
 * keeps the write itself singular; the button belongs to whoever is hosting it.
 */
export function useAssetOrder(postId: number, assets: OrderableAsset[]) {
  const savedOrder = assets.map((a) => a.id);
  // useState's initializer only runs on mount, but the quick-edit dialog mounts before its
  // assets fetch lands — `assets` starts as [] and becomes the real list a tick later. An
  // effect could re-seed `order` then, but that's a render-then-immediately-re-render for
  // something derivable during render itself, which is exactly what React's "adjusting
  // state during render" pattern exists for: compare against a key that changes identity
  // whenever the saved order does (the fetch landing, or a parent refresh after save) and
  // reset synchronously, in the same render, with no extra pass and no effect.
  const savedKey = savedOrder.join(",");
  const [syncedKey, setSyncedKey] = useState(savedKey);
  const [order, setOrder] = useState<number[]>(savedOrder);
  if (syncedKey !== savedKey) {
    setSyncedKey(savedKey);
    setOrder(savedOrder);
  }
  const [error, setError] = useState<string | null>(null);

  // String compare rather than element-wise: order is a small array of numbers, and this
  // reads as "is it the same list in the same sequence", which is exactly the question.
  const isDirty = order.join(",") !== savedOrder.join(",");

  /** Resolves true when the order is saved — or when there was nothing to save. */
  async function save(): Promise<boolean> {
    if (!isDirty) return true;
    setError(null);
    try {
      const res = await fetch(`/api/posts/${postId}/assets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_ids: order }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Could not save the slide order.");
        return false;
      }
      return true;
    } catch {
      setError("Could not confirm whether the slide order saved. Reload the page to check.");
      return false;
    }
  }

  return {
    order,
    setOrder,
    isDirty,
    reset: () => {
      setOrder(savedOrder);
      setError(null);
    },
    save,
    error,
  };
}

/**
 * The reorder grid for a carousel that already exists, plus the one thing the user needs
 * told before they save it. Controlled — it holds no state of its own, so the host can
 * decide when the order is written (see useAssetOrder above).
 */
export function CarouselReorder({
  assets,
  order,
  onOrderChange,
  queuedSendCount,
  renderExtra,
}: {
  assets: OrderableAsset[];
  order: number[];
  onOrderChange: (next: number[]) => void;
  queuedSendCount: number;
  // Mirrors SlideReorder's own renderExtra, keyed by asset id rather than by Slide so
  // callers don't need to know this component's internal Slide shape. OrderableAsset
  // deliberately doesn't carry conform fields (see above) — a caller with the full
  // Asset[] server-side (the post detail page, for ConformControl) supplies this;
  // quick edit, whose assets come from GET /api/posts/[id]/assets, simply doesn't.
  renderExtra?: (assetId: number, index: number) => ReactNode;
}) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  // An id in `order` that no longer exists on the post is dropped rather than rendered as
  // a broken thumbnail. It shouldn't happen — the PATCH refuses non-permutations — but a
  // stale prop mid-refresh must not take the page down.
  const slides: Slide[] = order
    .filter((id) => byId.has(id))
    .map((id, index) => ({ assetId: id, label: `Slide ${index + 1}` }));

  return (
    <div className="space-y-2">
      <SlideReorder
        slides={slides}
        onReorder={(next) => onOrderChange(next.map((s) => s.assetId))}
        renderExtra={renderExtra ? (slide, index) => renderExtra(slide.assetId, index) : undefined}
      />
      {queuedSendCount > 0 ? (
        <p className="data text-[11px] text-muted">
          {queuedSendCount} queued send{queuedSendCount === 1 ? "" : "s"} will go out in this order.
        </p>
      ) : null}
    </div>
  );
}
