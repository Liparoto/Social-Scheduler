import { NextRequest, NextResponse } from "next/server";
import { createDraftPost, getAsset, getChannel, getPeriod, listTags } from "@/lib/queries";
import type { ContentKind, ContentStatus } from "@/lib/types";
import { parseCaptionVariants, parsePeriodLinks, parseTagIds } from "@/lib/content-model-validation";
import { PLATFORMS, incompatiblePostError } from "@/lib/platforms";
import { captionLimitError } from "@/lib/caption-limits";
import { parseTargets } from "@/lib/story-fanout";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const assetIds: number[] = Array.isArray(body.asset_ids) ? body.asset_ids : [];
  const isText: boolean = body.post_type === "text";
  const caption: string = (body.caption || "").trim();

  if (isText) {
    if (assetIds.length > 0) {
      return NextResponse.json(
        { error: "A text-only post can't have images." },
        { status: 400 }
      );
    }
    if (!caption) {
      return NextResponse.json({ error: "Write a caption for the text post." }, { status: 400 });
    }
  } else if (assetIds.length === 0) {
    return NextResponse.json({ error: "Add at least one image." }, { status: 400 });
  }

  let contentKind: ContentKind | undefined;
  if (body.content_kind !== undefined) {
    if (body.content_kind !== "evergreen" && body.content_kind !== "one_time") {
      return NextResponse.json({ error: "Invalid content_kind." }, { status: 400 });
    }
    contentKind = body.content_kind;
  }

  let contentStatus: ContentStatus | undefined;
  if (body.content_status !== undefined) {
    if (body.content_status !== "draft" && body.content_status !== "ready") {
      return NextResponse.json({ error: "Invalid content_status." }, { status: 400 });
    }
    contentStatus = body.content_status;
  }

  // The composer sends `targets` (channel + surface); older callers send
  // target_channel_ids, which can only have meant feed targets.
  const parsedTargets = parseTargets(body.targets, body.target_channel_ids);
  if (parsedTargets === "invalid") {
    return NextResponse.json({ error: "Invalid targets." }, { status: 400 });
  }
  let targetChannelIds: number[] | undefined;
  if (body.targets !== undefined || body.target_channel_ids !== undefined) {
    // Deduped: one Instagram account picked for both Feed and Story is still one channel
    // to validate and to describe.
    targetChannelIds = [...new Set(parsedTargets.map((t) => t.channel_id))];
    for (const cid of targetChannelIds) {
      if (!getChannel(cid)) {
        return NextResponse.json({ error: `Unknown channel ${cid}.` }, { status: 400 });
      }
    }
  }

  // Load the assets so post_type can reflect what they ACTUALLY are, not just how many
  // there are. Mirrors the channel lookup directly above.
  const postAssets = assetIds.map((aid) => getAsset(aid));
  const unknownAssetIdx = postAssets.findIndex((a) => !a);
  if (unknownAssetIdx !== -1) {
    return NextResponse.json(
      { error: `Unknown asset ${assetIds[unknownAssetIdx]}.` },
      { status: 400 }
    );
  }
  const chosenAssets = postAssets.map((a) => a!);

  // No platform publishes a carousel containing video. Caught here so it fails at
  // compose time with a clear reason, rather than terminally in the worker later.
  if (!isText && chosenAssets.length > 1 && chosenAssets.some((a) => a.media_kind === "video")) {
    return NextResponse.json(
      { error: "A carousel can only contain images. Post a video as its own Reel." },
      { status: 400 }
    );
  }

  // A single VIDEO asset is post_type "video", not a "single". Everything else is unchanged.
  const isVideo =
    !isText && chosenAssets.length === 1 && chosenAssets[0].media_kind === "video";
  const postType = isText
    ? "text"
    : isVideo
      ? "video"
      : assetIds.length > 1
        ? "carousel"
        : "single";
  const targetChannels = (targetChannelIds ?? []).map((cid) => getChannel(cid)!);

  if (targetChannels.length > 0) {
    // A draft with known targets is checked exactly like a live post — the strictest
    // targeted channel wins, never the most permissive.
    const compatError = incompatiblePostError(postType, assetIds.length, targetChannels);
    if (compatError) {
      return NextResponse.json({ error: compatError }, { status: 400 });
    }
  } else if (postType === "carousel") {
    // Untargeted: cap against the strictest cap among all known platforms — the worker
    // still enforces each channel's own limit independently once it's actually targeted,
    // but a draft shouldn't be savable at a size that's already guaranteed to fail
    // everywhere.
    const limit = Math.min(...PLATFORMS.map((p) => p.maxCarousel));
    if (assetIds.length > limit) {
      return NextResponse.json(
        { error: `A carousel can hold at most ${limit} images for the selected targets.` },
        { status: 400 }
      );
    }
  }

  const captionVariants = parseCaptionVariants(body.caption_variants);
  if (captionVariants === "invalid") {
    return NextResponse.json({ error: "Invalid caption_variants." }, { status: 400 });
  }

  if (targetChannels.length > 0) {
    const captionError = captionLimitError(targetChannels, captionVariants ?? [], caption, postType);
    if (captionError) {
      return NextResponse.json({ error: captionError }, { status: 400 });
    }
  }

  const periodLinks = parsePeriodLinks(body.period_links, getPeriod);
  if (periodLinks === "invalid") {
    return NextResponse.json({ error: "Invalid period_links." }, { status: 400 });
  }

  const validTagIds = new Set(listTags().map((t) => t.id));
  const tagIds = parseTagIds(body.tag_ids, (id) => validTagIds.has(id));
  if (tagIds === "invalid") {
    return NextResponse.json({ error: "Invalid tag_ids." }, { status: 400 });
  }

  const postId = createDraftPost({
    caption,
    first_comment: (body.first_comment || "").trim(),
    // undefined (not "carousel"/"single") falls through to createDraftPost's own
    // asset-count derivation — but that derivation doesn't know about video, so a video
    // post must be passed explicitly or it would be saved as "single" edit-time.
    post_type: isText ? "text" : isVideo ? "video" : undefined,
    asset_ids: assetIds,
    created_by: body.created_by,
    content_kind: contentKind,
    content_status: contentStatus,
    targets: targetChannelIds ? parsedTargets : undefined,
    caption_variants: captionVariants ?? undefined,
    period_links: periodLinks ?? undefined,
    tag_ids: tagIds ?? undefined,
  });
  return NextResponse.json({ postId }, { status: 201 });
}
