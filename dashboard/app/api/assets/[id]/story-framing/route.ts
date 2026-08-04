import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getAsset, updateAssetStoryFraming } from "@/lib/queries";
import { needsStoryCanvas, renderStoryCanvas, type StoryMode } from "@/lib/story-canvas";

export const runtime = "nodejs";

// The story surface has its own two treatments. 'pad' is a FEED mode and is deliberately
// absent: white bars are a reasonable feed look and a mistake on a full-bleed Story.
const VALID_MODES = new Set<StoryMode>(["blurred", "crop"]);

/**
 * Choose how this image is framed for an Instagram Story, and render it.
 *
 * Always re-runnable. Framing is never one-way — the whole point of this route existing
 * separately from the old inline control is that the choice can be revisited.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const body = await req.json().catch(() => null);
  const mode = body?.mode;
  // Reject rather than default: a guessed framing is how a Story ends up looking like an
  // accident, and the owner never finds out which choice they got.
  if (typeof mode !== "string" || !VALID_MODES.has(mode as StoryMode)) {
    return NextResponse.json(
      { error: "mode must be 'blurred' or 'crop'." },
      { status: 400 }
    );
  }

  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  // sharp cannot decode video. Mirrors the same guard in /api/assets/[id]/conform — the
  // route must not depend on every caller gating this correctly.
  if (asset.media_kind === "video") {
    return NextResponse.json(
      { error: "Only an image can be given a story canvas." },
      { status: 409 }
    );
  }

  // An already-9:16 source needs no canvas: NULL story_path means "publish the untouched
  // original", which is what the story publish path already does correctly. The mode is
  // still recorded, so the choice survives if the asset is ever replaced by a differently
  // shaped one.
  if (!needsStoryCanvas(asset.width ?? 0, asset.height ?? 0)) {
    updateAssetStoryFraming(asset.id, { story_path: null, story_mode: mode as StoryMode });
    return NextResponse.json({ asset: getAsset(asset.id), canvas: false });
  }

  const original = await fs.readFile(path.join(config.assetStorageDir, asset.storage_path));
  const canvas = await renderStoryCanvas(original, mode as StoryMode);

  // The mode is in the filename so switching back and forth reuses an existing render
  // instead of re-encoding — which is what makes "change your mind" cheap enough to be
  // true in practice rather than merely permitted.
  const rel = `story/${asset.content_hash}-${mode}.jpg`;
  const abs = path.join(config.assetStorageDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, canvas);

  updateAssetStoryFraming(asset.id, { story_path: rel, story_mode: mode as StoryMode });
  return NextResponse.json({ asset: getAsset(asset.id), canvas: true });
}
