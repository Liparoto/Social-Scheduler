import { NextRequest, NextResponse } from "next/server";
import { createPostWithPublications, getChannel, getPeriod } from "@/lib/queries";
import { zonedTimeToUtc } from "@/lib/time";
import type { ContentKind, PostType } from "@/lib/types";
import { parseCaptionVariants, parsePeriodLinks } from "@/lib/content-model-validation";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const assetIds: number[] = Array.isArray(body.asset_ids) ? body.asset_ids : [];
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const localTime: string = body.scheduled_local; // "YYYY-MM-DDTHH:mm"
  const timeZone: string = body.timezone || "UTC";

  if (assetIds.length === 0) {
    return NextResponse.json({ error: "Add at least one image." }, { status: 400 });
  }
  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (!localTime) {
    return NextResponse.json({ error: "Pick a date and time." }, { status: 400 });
  }
  for (const cid of channelIds) {
    if (!getChannel(cid)) {
      return NextResponse.json({ error: `Unknown channel ${cid}.` }, { status: 400 });
    }
  }

  const postType: PostType = assetIds.length > 1 ? "carousel" : "single";
  if (postType === "carousel" && assetIds.length > 10) {
    return NextResponse.json(
      { error: "A carousel can hold at most 10 images." },
      { status: 400 }
    );
  }

  let scheduledUtc: string;
  try {
    scheduledUtc = zonedTimeToUtc(localTime, timeZone);
  } catch {
    return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
  }

  let contentKind: ContentKind | undefined;
  if (body.content_kind !== undefined) {
    if (body.content_kind !== "evergreen" && body.content_kind !== "one_time") {
      return NextResponse.json({ error: "Invalid content_kind." }, { status: 400 });
    }
    contentKind = body.content_kind;
  }

  const captionVariants = parseCaptionVariants(body.caption_variants);
  if (captionVariants === "invalid") {
    return NextResponse.json({ error: "Invalid caption_variants." }, { status: 400 });
  }

  const periodLinks = parsePeriodLinks(body.period_links, getPeriod);
  if (periodLinks === "invalid") {
    return NextResponse.json({ error: "Invalid period_links." }, { status: 400 });
  }

  const { postId, publicationIds } = createPostWithPublications({
    caption: (body.caption || "").trim(),
    first_comment: (body.first_comment || "").trim(),
    post_type: postType,
    asset_ids: assetIds,
    channel_ids: channelIds,
    scheduled_at: scheduledUtc,
    created_by: body.created_by,
    content_kind: contentKind,
    content_status: "ready",
    target_channel_ids: channelIds,
    caption_variants: captionVariants ?? undefined,
    period_links: periodLinks ?? undefined,
  });

  return NextResponse.json({ postId, publicationIds, scheduledUtc }, { status: 201 });
}
