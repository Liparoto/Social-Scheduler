import { NextRequest, NextResponse } from "next/server";
import { assetFilePaths, unlinkInsideStore } from "@/lib/asset-files";
import {
  countOtherAssetReferences,
  countOtherPostsUsingAsset,
  countQueuedDirectSendsForSlide,
  getAsset,
  getPost,
  getPostCompatChannels,
  getPostSlides,
  postHasLiveSend,
  removePostAsset,
} from "@/lib/queries";
import { checkRemoveAsset } from "@/lib/post-media-edit";

export const runtime = "nodejs";

/**
 * Take one slide off a post — and, optionally, delete the file itself.
 *
 * `?mode=post` (the default) unlinks the slide and leaves the file in the library, where
 * /media will show it as unused. `?mode=everywhere` also deletes the asset row and its
 * files from disk, permanently.
 *
 * ONE endpoint rather than the UI chaining an unlink and DELETE /api/assets/[id]: that
 * sequence refuses a shared asset only AFTER the slide is already gone, leaving a
 * half-done edit exactly when the user asked for the safer outcome. Here nothing is
 * written until everything has been checked.
 *
 * Anything unrecognised in `mode` falls back to the non-destructive one on purpose. A
 * typo'd query string must never be the thing that deletes a file.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id, assetId: rawAssetId } = await params;
  const postId = Number(id);
  const assetId = Number(rawAssetId);
  const post = Number.isInteger(postId) ? getPost(postId) : undefined;
  if (!post) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  if (!Number.isInteger(assetId)) {
    return NextResponse.json({ error: "That file isn't on this post." }, { status: 404 });
  }

  const mode = req.nextUrl.searchParams.get("mode") === "everywhere" ? "everywhere" : "post";

  // Read the paths BEFORE the row can disappear — after the DELETE there is nothing left
  // to read them from. Same reason DELETE /api/assets/[id] reads them up front.
  const asset = getAsset(assetId);

  const checked = checkRemoveAsset(
    {
      slides: getPostSlides(postId),
      postType: post.post_type,
      hasLiveSend: postHasLiveSend(postId),
      channels: getPostCompatChannels(postId),
    },
    assetId,
    mode,
    countOtherPostsUsingAsset(postId, assetId),
    // A scheduled Story send pinned to THIS slide (publications.asset_id = assetId) would
    // otherwise survive unlinking and still try to publish a slide the post no longer has —
    // in either mode, not only "everywhere". checkRemoveAsset refuses rather than
    // auto-canceling the send: see its own comment for why.
    countQueuedDirectSendsForSlide(postId, assetId),
    // Everything else that points at this asset row, so `mode=everywhere` refuses up front
    // and honestly. Without this the foreign keys on publications.asset_id and
    // assets.cover_asset_id only surfaced as a constraint error mid-transaction, which the
    // route then described as a race that had not happened.
    countOtherAssetReferences(assetId)
  );
  if (!checked.ok) {
    return NextResponse.json(
      { error: checked.error, code: checked.code },
      { status: checked.status }
    );
  }

  const result = removePostAsset(postId, assetId, checked.post_type, mode === "everywhere");
  if (result === "has_live") {
    return NextResponse.json(
      {
        error: "This post went live while you were editing it, so nothing was changed.",
        code: "live_send",
      },
      { status: 409 }
    );
  }
  if (result === "still_used") {
    return NextResponse.json(
      {
        error:
          "Another post picked this file up while you were editing, so it wasn't deleted. " +
          "Nothing was changed.",
        code: "shared_asset",
      },
      { status: 409 }
    );
  }
  if (result === "referenced_asset") {
    // Not a race — a foreign key. checkRemoveAsset's countOtherAssetReferences() check is
    // meant to catch this first, so reaching here means a reference appeared in the gap.
    // Either way `mode=post` would have gone through, so say so rather than leaving the
    // owner with a refusal and no next step.
    return NextResponse.json(
      {
        error:
          "Something still references this file, so it wasn't deleted and nothing was " +
          "changed. Removing it from just this post would work.",
        code: "referenced_asset",
      },
      { status: 409 }
    );
  }
  if (result === "not_found") {
    // checkRemoveAsset already rejects an absent slide with "not_on_post" before we ever
    // get here, using the slides it read moments ago — so this only fires if the slide was
    // removed out from under us in the gap between that read and this write (another
    // request, or the worker). Same voice as that check's message, since to the user it is
    // the same fact: the file isn't on this post (any more).
    return NextResponse.json({ error: "That file isn't on this post." }, { status: 404 });
  }

  // Rows are gone — now the files, and only now. A failed row delete must never leave
  // files deleted, but a failed file delete only leaves harmless bytes behind.
  // assetFilePaths() owns the list of what an asset writes to disk; spelling it out here
  // instead is how the story canvas came to be missed when it was added.
  let leftover: string[] = [];
  if (mode === "everywhere" && asset) {
    leftover = (await Promise.all(assetFilePaths(asset).map(unlinkInsideStore))).filter(
      (p): p is string => p !== null
    );
    if (leftover.length > 0) {
      console.warn(`Asset ${assetId} row deleted, but these files remain: ${leftover.join(", ")}`);
    }
  }

  return NextResponse.json({
    post_type: checked.post_type,
    asset_ids: checked.slides.map((s) => s.asset_id),
    deleted_asset: mode === "everywhere",
    leftover,
  });
}
