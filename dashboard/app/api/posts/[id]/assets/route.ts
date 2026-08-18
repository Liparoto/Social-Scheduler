import { NextRequest, NextResponse } from "next/server";
import {
  addPostAssets,
  getAsset,
  getPost,
  getPostAssets,
  getPostCompatChannels,
  getPostSlides,
  postHasLiveSend,
  postHasPublishingPublication,
  reorderPostAssets,
} from "@/lib/queries";
import { checkAssetOrder } from "@/lib/asset-order";
import { checkAddAssets } from "@/lib/post-media-edit";

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

/**
 * Add slides to a post. Body: { asset_ids: [12, 9] } — appended after what it already has.
 *
 * The counterpart to PATCH above, and separate from it for the reason PATCH's own comment
 * gives: a reorder cannot change the slide count, which is what lets it stay this simple.
 * Adding can, so post_type is re-derived and channel compatibility re-checked here.
 *
 * The assets themselves must already exist — uploading is POST /api/assets/upload, which
 * owns content-hash dedup, image conforming, and video validation/conversion. This route
 * deliberately knows none of that; it only links ids that are already in the library.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId) || !getPost(postId)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const raw = (body as { asset_ids?: unknown } | null)?.asset_ids;
  if (!Array.isArray(raw) || !raw.every((v) => Number.isInteger(v))) {
    return NextResponse.json(
      { error: "Expected a JSON body with asset_ids as whole numbers.", code: "bad_body" },
      { status: 400 }
    );
  }

  // Resolve every id to a real asset BEFORE any rule runs, so "asset 999 doesn't exist"
  // is reported as itself rather than as a confusing type or compatibility error.
  const incoming = [];
  for (const assetId of raw as number[]) {
    const asset = getAsset(assetId);
    if (!asset) {
      return NextResponse.json(
        { error: `There's no file with id ${assetId} in the library.`, code: "bad_body" },
        { status: 400 }
      );
    }
    incoming.push({ asset_id: asset.id, media_kind: asset.media_kind });
  }

  const checked = checkAddAssets(
    {
      slides: getPostSlides(postId),
      hasLiveSend: postHasLiveSend(postId),
      channels: getPostCompatChannels(postId),
    },
    incoming
  );
  if (!checked.ok) {
    return NextResponse.json(
      { error: checked.error, code: checked.code },
      { status: checked.status }
    );
  }

  // The same live-send rule again, this time inside the write, where it cannot be raced.
  const result = addPostAssets(
    postId,
    incoming.map((s) => s.asset_id),
    checked.post_type
  );
  if (result === "has_live") {
    return NextResponse.json(
      {
        error: "This post went live while you were editing it, so nothing was changed.",
        code: "live_send",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    post_type: checked.post_type,
    asset_ids: checked.slides.map((s) => s.asset_id),
  });
}
