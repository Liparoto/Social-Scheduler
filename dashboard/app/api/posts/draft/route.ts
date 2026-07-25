import { NextRequest, NextResponse } from "next/server";
import { createDraftPost, getChannel, getPeriod, listTags } from "@/lib/queries";
import type { ContentKind, ContentStatus } from "@/lib/types";
import { parseCaptionVariants, parsePeriodLinks, parseTagIds } from "@/lib/content-model-validation";
import { PLATFORMS, incompatiblePostError } from "@/lib/platforms";
import { captionLimitError } from "@/lib/caption-limits";

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

  let targetChannelIds: number[] | undefined;
  if (body.target_channel_ids !== undefined) {
    if (!Array.isArray(body.target_channel_ids)) {
      return NextResponse.json({ error: "Invalid target_channel_ids." }, { status: 400 });
    }
    for (const cid of body.target_channel_ids) {
      if (typeof cid !== "number" || !getChannel(cid)) {
        return NextResponse.json({ error: `Unknown channel ${cid}.` }, { status: 400 });
      }
    }
    targetChannelIds = body.target_channel_ids;
  }

  const postType = isText ? "text" : assetIds.length > 1 ? "carousel" : "single";
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
    const captionError = captionLimitError(targetChannels, captionVariants ?? [], caption);
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
    post_type: isText ? "text" : undefined,
    asset_ids: assetIds,
    created_by: body.created_by,
    content_kind: contentKind,
    content_status: contentStatus,
    target_channel_ids: targetChannelIds,
    caption_variants: captionVariants ?? undefined,
    period_links: periodLinks ?? undefined,
    tag_ids: tagIds ?? undefined,
  });
  return NextResponse.json({ postId }, { status: 201 });
}
