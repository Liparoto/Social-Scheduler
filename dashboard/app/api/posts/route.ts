import { NextRequest, NextResponse } from "next/server";
import { createPostWithPublications, getChannel, getPeriod, listTags } from "@/lib/queries";
import { zonedTimeToUtc } from "@/lib/time";
import type { ContentKind, PostType } from "@/lib/types";
import { parseCaptionVariants, parsePeriodLinks, parseTagIds } from "@/lib/content-model-validation";
import { describeChannel, incompatibleChannelsForPostType, maxCarousel } from "@/lib/platforms";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const assetIds: number[] = Array.isArray(body.asset_ids) ? body.asset_ids : [];
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const localTime: string = body.scheduled_local; // "YYYY-MM-DDTHH:mm"
  const timeZone: string = body.timezone || "UTC";
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
  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (!localTime) {
    return NextResponse.json({ error: "Pick a date and time." }, { status: 400 });
  }
  const channels = channelIds.map((cid) => getChannel(cid));
  const unknownIdx = channels.findIndex((c) => !c);
  if (unknownIdx !== -1) {
    return NextResponse.json({ error: `Unknown channel ${channelIds[unknownIdx]}.` }, { status: 400 });
  }
  const targetChannels = channels.map((c) => c!);

  const postType: PostType = isText ? "text" : assetIds.length > 1 ? "carousel" : "single";

  const incompatible = incompatibleChannelsForPostType(postType, targetChannels);
  if (incompatible.length > 0) {
    return NextResponse.json(
      { error: `${incompatible.map(describeChannel).join(", ")} can't publish a ${postType} post.` },
      { status: 400 }
    );
  }

  if (postType === "carousel") {
    // The most permissive selected channel sets the ceiling here — the worker still
    // enforces each channel's own limit independently per publication, so a Threads-only
    // carousel shouldn't be capped at Instagram/Facebook's stricter number.
    const limit = Math.max(...targetChannels.map((c) => maxCarousel(c.platform)));
    if (assetIds.length > limit) {
      return NextResponse.json(
        { error: `A carousel can hold at most ${limit} images for the selected channels.` },
        { status: 400 }
      );
    }
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

  const validTagIds = new Set(listTags().map((t) => t.id));
  const tagIds = parseTagIds(body.tag_ids, (id) => validTagIds.has(id));
  if (tagIds === "invalid") {
    return NextResponse.json({ error: "Invalid tag_ids." }, { status: 400 });
  }

  const { postId, publicationIds } = createPostWithPublications({
    caption,
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
    tag_ids: tagIds ?? undefined,
  });

  return NextResponse.json({ postId, publicationIds, scheduledUtc }, { status: 201 });
}
