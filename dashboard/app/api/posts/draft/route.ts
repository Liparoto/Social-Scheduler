import { NextRequest, NextResponse } from "next/server";
import { createDraftPost, getChannel, getPeriod } from "@/lib/queries";
import type { ContentKind, ContentStatus } from "@/lib/types";
import { parseCaptionVariants, parsePeriodLinks } from "@/lib/content-model-validation";

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

  const captionVariants = parseCaptionVariants(body.caption_variants);
  if (captionVariants === "invalid") {
    return NextResponse.json({ error: "Invalid caption_variants." }, { status: 400 });
  }

  const periodLinks = parsePeriodLinks(body.period_links, getPeriod);
  if (periodLinks === "invalid") {
    return NextResponse.json({ error: "Invalid period_links." }, { status: 400 });
  }

  const postId = createDraftPost({
    caption: (body.caption || "").trim(),
    first_comment: (body.first_comment || "").trim(),
    asset_ids: assetIds,
    created_by: body.created_by,
    content_kind: contentKind,
    content_status: contentStatus,
    target_channel_ids: targetChannelIds,
    caption_variants: captionVariants ?? undefined,
    period_links: periodLinks ?? undefined,
  });
  return NextResponse.json({ postId }, { status: 201 });
}
