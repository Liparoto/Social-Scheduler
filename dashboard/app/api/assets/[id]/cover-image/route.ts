import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getAsset, getAssetByHash, upsertAssetByHash, setAssetCoverImage } from "@/lib/queries";
import { conformCover, COVER_MAX_BYTES } from "@/lib/conform-cover";

export const runtime = "nodejs";

/** Upload (or replace) a Reel's custom cover image, and remove it.
 *
 *  A cover image OVERRIDES the cover frame at publish time (Instagram's cover_url wins
 *  over thumb_offset — see docs/superpowers/specs/2026-07-29-custom-cover-image-design.md),
 *  but cover_frame_ms itself is never touched here in either direction: POST never writes
 *  it, and DELETE never restores it from anywhere — it was never cleared, so unlinking the
 *  image just uncovers the frame value that was there all along.
 *
 *  The cover is an ordinary `assets` row (media_kind='image'), so it gets content-hash
 *  dedup for free. DELETE only unlinks cover_asset_id; it never deletes the cover asset
 *  row or its file — another post may reference the same bytes, and this project has no
 *  asset-delete path precisely because deletion isn't safe to do casually. */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  if (asset.media_kind !== "video") {
    return NextResponse.json(
      { error: "Only a video has a Reels cover." },
      { status: 409 }
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // conformCover(buf) is the whole "is this an image" check — deliberately no separate
  // MIME allow-list. sharp throws on unreadable/non-image bytes regardless of what the
  // browser claimed the file's type was, and that throw is refused with 422 BEFORE
  // anything is hashed or written. Never resizes/crops (see conform-cover.ts) — only
  // color space + JPEG quality stepping.
  let conformed;
  try {
    conformed = await conformCover(buf);
  } catch {
    return NextResponse.json(
      { error: "That file isn't a readable image (JPEG, PNG, or WebP)." },
      { status: 422 }
    );
  }

  if (conformed.buffer.length > COVER_MAX_BYTES) {
    return NextResponse.json(
      {
        error:
          `This cover is ${(conformed.buffer.length / (1024 * 1024)).toFixed(1)} MB even ` +
          `after compression — Instagram's Reels cover limit is 8 MB. Try a smaller or ` +
          "simpler image.",
      },
      { status: 422 }
    );
  }

  // Hash the CONFORMED bytes, not the original upload — dedup must reflect what is
  // actually stored and would actually be sent to Meta as cover_url.
  const hash = crypto.createHash("sha256").update(conformed.buffer).digest("hex");
  const existing = getAssetByHash(hash);

  let coverAsset;
  if (existing) {
    coverAsset = existing;
  } else {
    const storageRel = `cover/${hash}.jpg`;
    const storageAbs = path.join(config.assetStorageDir, storageRel);
    await fs.mkdir(path.dirname(storageAbs), { recursive: true });
    await fs.writeFile(storageAbs, conformed.buffer);

    const { asset: created } = upsertAssetByHash({
      content_hash: hash,
      media_kind: "image",
      original_filename: file.name || null,
      storage_path: storageRel,
      public_url: config.publicAssetBaseUrl
        ? `${config.publicAssetBaseUrl.replace(/\/$/, "")}/${storageRel}`
        : null,
      thumbnail_path: null,
      mime_type: "image/jpeg",
      width: conformed.width,
      height: conformed.height,
      byte_size: conformed.buffer.length,
      publish_path: null,
    });
    coverAsset = created;
  }

  // cover_frame_ms is untouched — only cover_asset_id changes.
  setAssetCoverImage(asset.id, coverAsset.id);

  return NextResponse.json({
    asset: getAsset(asset.id),
    cover: coverAsset,
    warnings: conformed.warnings,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  if (asset.media_kind !== "video") {
    return NextResponse.json(
      { error: "Only a video has a Reels cover." },
      { status: 409 }
    );
  }

  // Unlink only. cover_frame_ms was never touched by POST, so it's still exactly what
  // it was before the image was set — nothing to restore, nothing lost. The cover
  // asset row and its file on disk are left alone; see the file-level comment above.
  setAssetCoverImage(asset.id, null);

  return NextResponse.json({ asset: getAsset(asset.id) });
}
