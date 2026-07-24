import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getAsset, updateAssetConform } from "@/lib/queries";
import { conformImage, type ConformMode } from "@/lib/conform";

export const runtime = "nodejs";

const VALID_MODES = new Set<ConformMode>(["crop", "pad"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const body = await req.json().catch(() => null);
  const mode = body?.mode;
  if (typeof mode !== "string" || !VALID_MODES.has(mode as ConformMode)) {
    return NextResponse.json(
      { error: "mode must be 'crop' or 'pad'." },
      { status: 400 }
    );
  }

  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }

  const originalAbs = path.join(config.assetStorageDir, asset.storage_path);
  const original = await fs.readFile(originalAbs);
  const conformed = await conformImage(original, mode as ConformMode);

  const publishRel = `pub/${asset.content_hash}.jpg`;
  const publishAbs = path.join(config.assetStorageDir, publishRel);
  await fs.mkdir(path.dirname(publishAbs), { recursive: true });
  await fs.writeFile(publishAbs, conformed.buffer);

  updateAssetConform(asset.id, {
    publish_path: publishRel,
    conform_mode: conformed.mode,
    needs_review: 0,
  });

  return NextResponse.json({ asset: getAsset(asset.id) });
}
