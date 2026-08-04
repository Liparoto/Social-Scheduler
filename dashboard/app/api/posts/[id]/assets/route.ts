import { NextRequest, NextResponse } from "next/server";
import {
  getPost,
  getPostAssets,
  postHasPublishingPublication,
  reorderPostAssets,
} from "@/lib/queries";
import { checkAssetOrder } from "@/lib/asset-order";

export const runtime = "nodejs";

/**
 * A post's slides, in order.
 *
 * Two consumers, both of which need one post's slides and neither of which can get them
 * from the Library list query: the quick-edit dialog (which already lazy-loads its
 * captions from /content the same way) and the Library card's lightbox. listPosts()
 * already carries asset_ids_csv, but not each slide's media_kind/width/height — adding
 * those as four more GROUP_CONCAT subqueries would ship every slide's metadata for every
 * card on every Library load to serve a dialog that opens one post at a time.
 *
 * The field list is deliberately exactly LightboxAsset plus nothing: no storage_path, no
 * public_url, no content_hash. This is a browser-facing read.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId) || !getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  return NextResponse.json({
    assets: getPostAssets(postId).map((a) => ({
      id: a.id,
      media_kind: a.media_kind,
      cover_frame_ms: a.cover_frame_ms,
      width: a.width,
      height: a.height,
    })),
  });
}

/**
 * Reorder a post's slides. Body: { asset_ids: [12, 9, 30] } — the complete new order.
 *
 * The single write path for slide order, shared by the post detail page and the Library's
 * quick-edit dialog. It reorders and does nothing else: `asset_ids` must be a permutation
 * of what the post already has, so the slide count cannot change, so posts.post_type
 * cannot go stale. Adding or removing slides is a bigger operation (it moves post_type and
 * re-runs platform compatibility) and is deliberately not this endpoint.
 *
 * Everything is checked before anything is written.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId) || !getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return NextResponse.json(
      { error: "Expected a JSON body with asset_ids.", code: "bad_body" },
      { status: 400 }
    );
  }

  const current = getPostAssets(postId).map((a) => a.id);
  const checked = checkAssetOrder(current, (body as { asset_ids?: unknown }).asset_ids);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error, code: checked.code }, { status: 400 });
  }

  // Last, because it is the only check that can go stale between here and the write — and
  // the one that matters: the worker is reading post_assets for this post right now to
  // build a container. Rewriting the rows underneath it is the single way a reorder can
  // produce a genuinely wrong published carousel.
  if (postHasPublishingPublication(postId)) {
    return NextResponse.json(
      {
        error: "This post is being published right now. Try again once that send finishes.",
        code: "publishing",
      },
      { status: 409 }
    );
  }

  reorderPostAssets(postId, checked.asset_ids);
  return NextResponse.json({ asset_ids: checked.asset_ids });
}
