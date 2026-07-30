import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { config } from "@/lib/config";
import { getChannel } from "@/lib/queries";
import { resolveInsideStore } from "@/lib/asset-files";
import { avatarContentType } from "@/lib/avatar-files";

export const runtime = "nodejs";

/**
 * Serve a channel's cached profile photo for in-dashboard display only.
 *
 * Mirrors app/api/media/[id]/route.ts, minus the range support — an avatar is never
 * seeked. The photo is served from OUR disk rather than hotlinked from the platform
 * because the platform URLs are short-lived signed CDN links (see migration 0012).
 *
 * A missing file is a 404, not an error: the worker may not have fetched this channel
 * yet, and the UI's fallback is a normal state rather than a failure.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = getChannel(Number(id));
  if (!channel?.avatar_path) {
    return NextResponse.json({ error: "No avatar." }, { status: 404 });
  }

  const abs = resolveInsideStore(config.assetStorageDir, channel.avatar_path);
  if (!abs) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(abs);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": avatarContentType(channel.avatar_path),
        "Cache-Control": "private, max-age=3600",
        "Content-Length": String(buf.length),
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing on disk." }, { status: 404 });
  }
}
