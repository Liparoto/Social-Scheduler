import { NextRequest, NextResponse } from "next/server";
import { createDraftPost } from "@/lib/queries";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const assetIds: number[] = Array.isArray(body.asset_ids) ? body.asset_ids : [];
  if (assetIds.length === 0) {
    return NextResponse.json({ error: "Add at least one image." }, { status: 400 });
  }
  if (assetIds.length > 10) {
    return NextResponse.json({ error: "A carousel can hold at most 10 images." }, { status: 400 });
  }
  const postId = createDraftPost({
    caption: (body.caption || "").trim(),
    first_comment: (body.first_comment || "").trim(),
    asset_ids: assetIds,
    created_by: body.created_by,
  });
  return NextResponse.json({ postId }, { status: 201 });
}
