"use client";

import { useState } from "react";

/** The least a slide needs to be reordered and drawn. Matches what GET /assets returns. */
export interface OrderableAsset {
  id: number;
  media_kind: "image" | "video";
}

/**
 * Slide-order state and the one PATCH that saves it.
 *
 * Lives in a hook rather than inside the strip that draws the slides (<PostMediaEditor>)
 * because the two screens that can reorder disagree about when saving happens: the post
 * detail page has its own Save button, while the quick-edit dialog saves everything through
 * a single Save and would quietly lose work if a control inside it saved on its own
 * schedule. The hook is what keeps the write itself singular; the button belongs to whoever
 * is hosting it.
 *
 * The grid that used to live alongside this hook is gone (2026-08-18) — it drew a second
 * copy of every slide next to <PostMediaEditor>'s, so the reorder affordances moved into
 * that one strip instead. `isDirty` is now also what warns before an add or a remove
 * discards an order in progress.
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
