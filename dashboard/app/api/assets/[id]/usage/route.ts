import { NextRequest, NextResponse } from "next/server";
import { countOtherAssetReferences, countOtherPostsUsingAsset } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * Everything that could stop `DELETE /api/posts/[id]/assets/[assetId]?mode=everywhere` from
 * actually deleting the file — what the media editor's confirm dialog reads to decide
 * whether "Delete the file entirely" is even worth offering.
 *
 * Three independent counts, not one: `other_post_count` (post_assets on another post) is
 * what the confirm dialog originally checked, but Phase 1's review found two more things
 * that block the same delete —`publications.asset_id` (a Story send naming this slide, in
 * ANY status, ON DELETE RESTRICT) and `assets.cover_asset_id` (this image is a Reel's cover
 * frame). Both come from countOtherAssetReferences() in lib/queries.ts. Checking only
 * other_post_count would offer a button the server then refuses.
 *
 * Advisory only, same as before: DELETE re-checks all of this itself inside its own
 * transaction, so a stale answer here can hide the button but can never destroy a file
 * something still points at.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const assetId = Number(id);
  const postId = Number(req.nextUrl.searchParams.get("post_id"));
  if (!Number.isInteger(assetId) || !Number.isInteger(postId)) {
    return NextResponse.json({ error: "Bad ids." }, { status: 400 });
  }
  const otherRefs = countOtherAssetReferences(assetId);
  return NextResponse.json({
    other_post_count: countOtherPostsUsingAsset(postId, assetId),
    other_send_count: otherRefs.sends,
    other_cover_count: otherRefs.covers,
  });
}
