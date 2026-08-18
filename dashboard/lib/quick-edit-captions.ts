import { captionLimit, platformLabel } from "./platforms";

/**
 * Caption logic for the Library's quick-edit dialog.
 *
 * Three separate concerns, all pure so they can be tested without a DB or a browser:
 * what counts as a caption change, what limit a generic caption is actually held to, and
 * what `posts.caption` should become when variants are written.
 */

export interface CaptionDraft {
  /** "" means the generic ("Any") variant — matches <CaptionVariantsEditor>. */
  platform: string;
  body: string;
}

export interface SavedCaptionVariant {
  platform: string | null;
  body: string;
  sort_order: number;
}

/** Blank rows are scaffolding, not content — the editor always leaves one behind. */
export function usableCaptions(drafts: CaptionDraft[]): CaptionDraft[] {
  return drafts.filter((draft) => draft.body.trim() !== "");
}

/** The payload shape `PATCH /api/posts/[id]/content` expects. */
export function captionVariantsToSave(drafts: CaptionDraft[]): SavedCaptionVariant[] {
  return usableCaptions(drafts).map((draft, index) => ({
    platform: draft.platform || null,
    body: draft.body.trim(),
    sort_order: index,
  }));
}

/**
 * Stable key for the dirty check. Order matters — the worker rotates through a platform's
 * variants in sort order, so moving a row is a real change — but trailing whitespace and
 * blank rows are not.
 */
export function captionsKey(drafts: CaptionDraft[]): string {
  return JSON.stringify(
    usableCaptions(drafts).map((draft) => [draft.platform || null, draft.body.trim()])
  );
}

/** Turn saved rows back into editor drafts, keeping one empty row for an uncaptioned post. */
export function captionsToDrafts(variants: SavedCaptionVariant[]): CaptionDraft[] {
  if (variants.length === 0) return [{ platform: "", body: "" }];
  return variants.map((variant) => ({
    platform: variant.platform ?? "",
    body: variant.body,
  }));
}

export interface GenericCaptionLimit {
  limit: number;
  /** The platforms that limit is the strictest of, for the counter's label. */
  platforms: string[];
  label: string;
}

/**
 * The limit a GENERIC caption is really held to.
 *
 * <CaptionVariantsEditor> shows no counter for an "Any" row because captionLimit("") is
 * null — but that row is exactly what publishes for every post that has no per-platform
 * variant, so it has a limit in practice: the strictest of the platforms that would fall
 * back to it.
 *
 * Two exclusions matter. A targeted platform that already has its own variant in the
 * current draft never falls back to the generic one (see captionsForPlatform), so it does
 * not constrain it. And a platform with no known limit is skipped rather than counted as
 * zero. If nothing is left — no targets, or none with a limit — there is no counter, which
 * is the same state the editor shows today.
 */
export function genericCaptionLimit(
  targetPlatforms: string[],
  drafts: CaptionDraft[],
  postType: string
): GenericCaptionLimit | null {
  const coveredBySpecific = new Set(
    usableCaptions(drafts)
      .map((draft) => draft.platform)
      .filter((platform) => platform !== "")
  );
  const relevant = [...new Set(targetPlatforms)]
    .filter((platform) => platform !== "" && !coveredBySpecific.has(platform))
    .map((platform) => ({ platform, limit: captionLimit(platform, postType) }))
    .filter((entry): entry is { platform: string; limit: number } => entry.limit !== null);
  if (relevant.length === 0) return null;

  const limit = Math.min(...relevant.map((entry) => entry.limit));
  const platforms = relevant
    .filter((entry) => entry.limit === limit)
    .map((entry) => entry.platform);
  return { limit, platforms, label: platforms.map(platformLabel).join(", ") };
}

/** A generic row over the limit its targets actually impose. */
export function overLimitGenericCaptions(
  targetPlatforms: string[],
  drafts: CaptionDraft[],
  postType: string
): { length: number; limit: number; label: string }[] {
  const resolved = genericCaptionLimit(targetPlatforms, drafts, postType);
  if (!resolved) return [];
  return usableCaptions(drafts)
    .filter((draft) => draft.platform === "" && draft.body.trim().length > resolved.limit)
    .map((draft) => ({
      length: draft.body.trim().length,
      limit: resolved.limit,
      label: resolved.label,
    }));
}

/**
 * What `posts.caption` becomes when these variants are saved.
 *
 * `posts.caption` is what the Library card renders, what the caption search filters on,
 * and what captionsForPlatform() falls back to. setCaptionVariants() never wrote it, which
 * is why the two have already drifted apart on real posts.
 *
 * `undefined` means "leave it alone" — the only case where that is right is a post whose
 * variants are all platform-specific, because there the column is still the live fallback
 * for any targeted platform without a variant of its own. Overwriting it there would
 * change what publishes to a platform the user never touched.
 */
export function syncedPostCaption(variants: SavedCaptionVariant[]): string | null | undefined {
  if (variants.length === 0) return null;
  const generic = variants.find((variant) => variant.platform === null);
  if (!generic) return undefined;
  return generic.body;
}

/**
 * What an editor should OPEN with for a post — saved variants, or `posts.caption`.
 *
 * `caption` and `caption_variants` are independent fields on the create/update API, so a
 * post can legitimately have a caption and no variant rows at all (anything posted to
 * `/api/posts/draft` with just a `caption` lands exactly there). Reading only the variants
 * then showed an EMPTY caption box for a post that visibly has a caption everywhere else —
 * and because a save replaces variants wholesale, saving from that dialog sent `[]`, which
 * `syncedPostCaption()` turns into a NULL `posts.caption`. Editing a tag was enough to
 * destroy the caption of a post nobody meant to touch.
 *
 * The worker already resolves the same ambiguity in `_select_caption()` by falling back to
 * `posts.caption`, so this makes the editor show what would actually publish. Saving then
 * writes that text into `caption_variants` and the two representations converge instead of
 * drifting further apart.
 *
 * Saved variants always win, INCLUDING platform-specific-only ones: there, `posts.caption`
 * is still the live fallback for any targeted platform without a variant of its own, and
 * synthesising a generic row would promote that fallback into a real variant and change
 * what publishes. See `syncedPostCaption()`, which declines to touch the column for that
 * same reason.
 */
export function editorCaptionVariants(
  variants: SavedCaptionVariant[],
  postCaption: string | null
): SavedCaptionVariant[] {
  if (variants.length > 0) return variants;
  if (!postCaption || postCaption.trim() === "") return [];
  return [{ platform: null, body: postCaption, sort_order: 0 }];
}
