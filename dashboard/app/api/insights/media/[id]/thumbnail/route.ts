import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { resolveInsideStore } from "@/lib/asset-files";
import { avatarContentType } from "@/lib/avatar-files";

export const runtime = "nodejs";

/**
 * Serve the cached thumbnail for one synced post.
 *
 * Directly mirrors app/api/channels/[id]/avatar/route.ts, and for the same reason: the
 * platform's own thumbnail URLs are short-lived signed CDN links, so hotlinking them
 * produces a table of broken images a few weeks later. The worker keeps a copy
 * (worker/thumbnails.py) and this serves it from our disk.
 *
 * A missing file is a 404, not an error. The worker may not have reached this post yet,
 * and for a post whose CDN link expired before we did there will never be one — both are
 * normal states the UI renders as a plain tinted square.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const mediaId = Number(id);
  if (!Number.isInteger(mediaId)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const row = getDb()
    .prepare("SELECT thumbnail_path FROM remote_media WHERE id = ?")
    .get(mediaId) as { thumbnail_path: string | null } | undefined;

  if (!row?.thumbnail_path) {
    return NextResponse.json({ error: "No thumbnail." }, { status: 404 });
  }

  // Guards against a stored path escaping the asset store via traversal — the value
  // comes from our own worker, but a serving route should not depend on that.
  const abs = resolveInsideStore(config.assetStorageDir, row.thumbnail_path);
  if (!abs) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(abs);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": avatarContentType(row.thumbnail_path),
        // A given post's thumbnail never changes, so this can cache hard. Private
        // because the dashboard is not public and these are the owner's own media.
        "Cache-Control": "private, max-age=86400",
        "Content-Length": String(buf.length),
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing on disk." }, { status: 404 });
  }
}
