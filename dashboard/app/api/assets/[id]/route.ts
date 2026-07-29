import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { deleteAsset, getAsset } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * Unlink a stored file, but only if it really resolves inside the asset store — these
 * paths come out of the database, and a path that escapes the store must never be
 * deleted. Same containment check as api/media/[id]/route.ts:46.
 * Returns the path if it could NOT be removed, so the caller can report leftovers.
 */
async function unlinkInsideStore(rel: string | null): Promise<string | null> {
  if (!rel) return null;
  const base = path.resolve(config.assetStorageDir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) return rel;
  try {
    await fs.unlink(abs);
    return null;
  } catch (err) {
    // Already gone is success — the row is what the UI reads.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return rel;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Read the paths BEFORE the row disappears — after the DELETE there is nothing to
  // read them from.
  const asset = getAsset(Number(id));
  if (!asset) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }

  const result = deleteAsset(Number(id));
  if (result === "not_found") {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  if (result === "in_use") {
    return NextResponse.json(
      {
        error:
          "This file is attached to a post, so it can't be deleted. Remove it from the post first.",
      },
      { status: 409 }
    );
  }

  // Row is gone — now the files. Order matters: a failed row delete must never leave
  // files deleted, but a failed file delete only leaves harmless bytes behind.
  const leftover = (
    await Promise.all([
      unlinkInsideStore(asset.storage_path),
      unlinkInsideStore(asset.publish_path),
      unlinkInsideStore(asset.thumbnail_path),
    ])
  ).filter((p): p is string => p !== null);

  if (leftover.length > 0) {
    console.warn(`Asset ${id} row deleted, but these files remain: ${leftover.join(", ")}`);
  }
  return NextResponse.json({ ok: true, leftover });
}
