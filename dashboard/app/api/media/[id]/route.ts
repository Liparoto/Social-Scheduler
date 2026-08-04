import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getAsset } from "@/lib/queries";
import { needsStoryCanvas, renderStoryCanvas, type StoryMode } from "@/lib/story-canvas";

export const runtime = "nodejs";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/**
 * Serve one stored file, with Range support.
 *
 * EVERY variant goes through here rather than each branch doing its own read: Range
 * handling (206) is what makes a <video> seekable at all, and duplicating it per variant is
 * how one branch quietly loses it. See the Range comment below for what breaks without it.
 */
async function serveFile(rel: string, req: NextRequest): Promise<NextResponse> {
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
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    // Only a single-range header with at least one of start/end present is handled
    // here (per RFC 7233 §2.1/§3.1). An unparseable header (e.g. "bytes=abc") or a
    // multi-range header (e.g. "bytes=0-9,20-29") doesn't match this regex at all —
    // match stays null and we deliberately ignore the header, falling through to the
    // existing full-file 200 below, rather than rejecting with 416.
    if (match && (match[1] || match[2])) {
      const total = buf.length;
      // Suffix form ("bytes=-500" — last N bytes, RFC 7233 §2.1): match[1] is empty,
      // so `start` must count back from the end, not default to 0. Safari/QuickTime
      // use this form to fetch a trailing moov atom in .mov files.
      const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
      const end = match[1]
        ? match[2]
          ? Math.min(Number(match[2]), total - 1)
          : total - 1
        : total - 1;
      if (start >= total || start > end) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${total}` },
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

  // A story canvas may not exist on disk yet. The framing dialog has to show BOTH options
  // before either is chosen, and generating a canvas for every upload would burn CPU and
  // disk on the many images that are never storied — so render on demand, then cache.
  if (variant === "story" && asset.media_kind === "image") {
    const requested = req.nextUrl.searchParams.get("mode");
    const mode: StoryMode =
      requested === "crop" || requested === "blurred" ? requested : asset.story_mode;

    // Already story-shaped: there is no canvas and the original IS the right answer —
    // the same rule the publish path applies (docs/design-story-canvas-and-framing.md §2).
    if (!needsStoryCanvas(asset.width ?? 0, asset.height ?? 0)) {
      return serveFile(asset.storage_path, req);
    }

    // Same naming as the story-framing route, so a preview and a committed choice share
    // one cached render rather than each keeping their own.
    const rel = `story/${asset.content_hash}-${mode}.jpg`;
    const abs = path.join(config.assetStorageDir, rel);
    try {
      await fs.access(abs);
    } catch {
      try {
        const original = await fs.readFile(
          path.join(config.assetStorageDir, asset.storage_path)
        );
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, await renderStoryCanvas(original, mode));
      } catch {
        return NextResponse.json(
          { error: "Could not render a story canvas for this image." },
          { status: 404 }
        );
      }
    }
    return serveFile(rel, req);
  }

  // Video defaults to the DERIVATIVE, not the original. An iPhone original is routinely
  // HEVC, which Chrome cannot decode (canPlayType('video/mp4; codecs="hvc1"') === "") —
  // the <video> element loads metadata, sizes itself correctly, and then paints nothing.
  // That silently broke every preview AND the cover-frame scrubber, so a cover could only
  // be chosen blind. The derivative is H.264 by construction (see lib/video-convert.ts),
  // and is also the smaller file. Falls back to the original when no derivative exists.
  const rel =
    asset.media_kind === "video"
      ? (asset.publish_path ?? asset.storage_path)
      : variant === "thumb" && asset.thumbnail_path
        ? asset.thumbnail_path
        : variant === "publish"
          ? (asset.publish_path ?? asset.storage_path)
          : asset.storage_path;

  return serveFile(rel, req);
}
