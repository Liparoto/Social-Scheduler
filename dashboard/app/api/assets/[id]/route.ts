import { NextResponse } from "next/server";
import { unlinkInsideStore } from "@/lib/asset-files";
import { deleteAsset, getAsset } from "@/lib/queries";

export const runtime = "nodejs";

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
          "Something still references this file, so it can't be deleted. If it's attached to a post, remove it from the post first.",
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
