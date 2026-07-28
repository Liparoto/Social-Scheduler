import { NextRequest, NextResponse } from "next/server";
import { getAsset, updateAssetCoverFrame } from "@/lib/queries";

export const runtime = "nodejs";

/** Choose which frame of a video is its cover. Stored as a millisecond offset and sent
 *  to Instagram as thumb_offset — no cover image is generated. */
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
      { error: "Only a video has a cover frame." },
      { status: 409 }
    );
  }

  const body = await req.json().catch(() => null);
  const ms = body?.cover_frame_ms;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0) {
    return NextResponse.json(
      { error: "cover_frame_ms must be a non-negative integer (milliseconds)." },
      { status: 400 }
    );
  }
  // Bound against the asset's own duration. Instagram silently falls back to frame 0 for
  // an out-of-range offset, so an unchecked value would look saved but do nothing.
  if (asset.duration_ms !== null && ms > asset.duration_ms) {
    return NextResponse.json(
      {
        error: `That frame is past the end of the video (${(asset.duration_ms / 1000).toFixed(1)}s).`,
      },
      { status: 400 }
    );
  }

  updateAssetCoverFrame(asset.id, ms);
  return NextResponse.json({ asset: getAsset(asset.id) });
}
