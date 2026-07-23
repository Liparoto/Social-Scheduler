import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "@/lib/config";
import { getAssetByHash, upsertAssetByHash } from "@/lib/queries";

export const runtime = "nodejs";

const THUMB_MAX = 480;
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  const mime = file.type;
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, or WebP images are supported (video arrives in a later phase)." },
      { status: 415 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // Dedup by CONTENT HASH (not filename) — check before writing anything to disk.
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const existing = getAssetByHash(hash);
  if (existing) {
    return NextResponse.json({ asset: existing, deduped: true });
  }

  const storageRel = `${hash}.${ext}`;
  const thumbRel = `thumbs/${hash}.jpg`;
  const storageAbs = path.join(config.assetStorageDir, storageRel);
  const thumbAbs = path.join(config.assetStorageDir, thumbRel);

  await fs.mkdir(path.dirname(thumbAbs), { recursive: true });
  await fs.writeFile(storageAbs, buf);

  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(buf).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    await sharp(buf)
      .resize(THUMB_MAX, THUMB_MAX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toFile(thumbAbs);
  } catch {
    // Thumbnail is a nicety — if sharp chokes, keep the original and move on.
  }

  const publicUrl = config.publicAssetBaseUrl
    ? `${config.publicAssetBaseUrl.replace(/\/$/, "")}/${storageRel}`
    : null;

  const { asset, deduped } = upsertAssetByHash({
    content_hash: hash,
    media_kind: "image",
    original_filename: file.name || null,
    storage_path: storageRel,
    public_url: publicUrl,
    thumbnail_path: thumbRel,
    mime_type: mime,
    width,
    height,
    byte_size: buf.length,
  });

  return NextResponse.json({ asset, deduped });
}
