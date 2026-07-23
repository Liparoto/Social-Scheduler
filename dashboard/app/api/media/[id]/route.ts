import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getAsset } from "@/lib/queries";

export const runtime = "nodejs";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Serve a stored asset (or its thumbnail) for in-dashboard preview only. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const wantThumb = req.nextUrl.searchParams.get("variant") === "thumb";
  const rel = wantThumb && asset.thumbnail_path ? asset.thumbnail_path : asset.storage_path;

  const base = path.resolve(config.assetStorageDir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(abs);
    const ext = path.extname(abs).slice(1).toLowerCase();
    return new NextResponse(buf, {
      headers: {
        "Content-Type": MIME_BY_EXT[ext] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing on disk." }, { status: 404 });
  }
}
