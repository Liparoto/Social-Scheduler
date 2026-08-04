/**
 * Is a proposed slide order a valid reordering of the slides a post actually has?
 *
 * This is the check that keeps posts.post_type honest. post_type is computed once at
 * creation and then frozen, and worker/publisher.py::_validate re-derives the expectation
 * at publish time — a 'carousel' that lost a slide here would look completely correct in
 * the dashboard and then fail at send time with "carousel needs 2-10 assets, has 1".
 * Refusing anything that isn't a permutation makes the asset count invariant, which makes
 * post_type correct by construction rather than by remembering to update it.
 */
export type AssetOrderCheck =
  | { ok: true; asset_ids: number[] }
  | {
      ok: false;
      code: "not_an_array" | "empty" | "not_integers" | "not_a_permutation";
      error: string;
    };

export function checkAssetOrder(current: number[], proposed: unknown): AssetOrderCheck {
  if (!Array.isArray(proposed)) {
    return { ok: false, code: "not_an_array", error: "asset_ids must be an array." };
  }
  if (proposed.length === 0) {
    return { ok: false, code: "empty", error: "asset_ids must not be empty." };
  }
  if (!proposed.every((value) => Number.isInteger(value))) {
    return { ok: false, code: "not_integers", error: "asset_ids must be whole numbers." };
  }

  const next = proposed as number[];
  const proposedSet = new Set(next);
  const isPermutation =
    next.length === current.length &&
    // Catches duplicates: a repeated id collapses in the Set, so the sizes diverge even
    // though the lengths matched.
    proposedSet.size === next.length &&
    current.every((id) => proposedSet.has(id));

  if (!isPermutation) {
    return {
      ok: false,
      code: "not_a_permutation",
      error:
        "asset_ids must list exactly this post's slides, each one once. This endpoint " +
        "reorders slides; it cannot add or remove them.",
    };
  }

  return { ok: true, asset_ids: next };
}
