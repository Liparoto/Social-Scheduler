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
  mp4: "video/mp4",
  mov: "video/quicktime",
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
  const variant = req.nextUrl.searchParams.get("variant");
  const rel =
    variant === "thumb" && asset.thumbnail_path
      ? asset.thumbnail_path
      : variant === "publish"
        ? (asset.publish_path ?? asset.storage_path)
        : asset.storage_path;

  const base = path.resolve(config.assetStorageDir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(abs);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";

    // Range support (206 Partial Content) — required for <video> seeking to work at
    // all. Without Accept-Ranges + a real 206 response, Chromium reports the whole
    // media element as unseekable (seekable() stays [0,0] forever, even once the file
    // is fully buffered) rather than just seeking within what's downloaded so far.
    // Images never needed this (never seeked), but the cover-frame scrubber's whole
    // point is scrubbing a <video>, so this was a silent blocker for that feature
    // specifically. Harmless to apply to every variant, image or video.
    const range = req.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const total = buf.length;
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : total - 1;
      if (!match || start > end || end >= total || start < 0) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }
      return new NextResponse(buf.subarray(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=3600",
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }

    return new NextResponse(buf, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
        "Accept-Ranges": "bytes",
        "Content-Length": String(buf.length),
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing on disk." }, { status: 404 });
  }
}
