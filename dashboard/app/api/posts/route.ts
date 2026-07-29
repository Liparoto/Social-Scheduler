import { NextRequest, NextResponse } from "next/server";
import { createPostWithPublications, getAsset, getChannel, getPeriod, listTags } from "@/lib/queries";
import { zonedTimeToUtc } from "@/lib/time";
import type { ContentKind, PostType } from "@/lib/types";
import { parseCaptionVariants, parsePeriodLinks, parseTagIds } from "@/lib/content-model-validation";
import { incompatiblePostError } from "@/lib/platforms";
import { captionLimitError } from "@/lib/caption-limits";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const assetIds: number[] = Array.isArray(body.asset_ids) ? body.asset_ids : [];
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const localTime: string = body.scheduled_local; // "YYYY-MM-DDTHH:mm"
  const timeZone: string = body.timezone || "UTC";
  const isText: boolean = body.post_type === "text";
  const caption: string = (body.caption || "").trim();
  // "Post now": publish on the worker's next poll instead of a chosen date/time.
  // Wins over any scheduled_local also present in the body — see below.
  const postNow: boolean = body.post_now === true;

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
  if (!postNow && !localTime) {
    return NextResponse.json({ error: "Pick a date and time." }, { status: 400 });
  }
  const channels = channelIds.map((cid) => getChannel(cid));
  const unknownIdx = channels.findIndex((c) => !c);
  if (unknownIdx !== -1) {
    return NextResponse.json({ error: `Unknown channel ${channelIds[unknownIdx]}.` }, { status: 400 });
  }
  const targetChannels = channels.map((c) => c!);

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

  // A single VIDEO asset is a reel, not a "single". Everything else is unchanged.
  const isReel =
    !isText && chosenAssets.length === 1 && chosenAssets[0].media_kind === "video";
  const postType: PostType = isText
    ? "text"
    : isReel
      ? "reel"
      : assetIds.length > 1
        ? "carousel"
        : "single";

  // The strictest selected channel is the one that matters — the worker still enforces
  // each channel's own limit independently per publication, but accepting a count that's
  // guaranteed to fail on ANY selected channel just defers a certain failure.
  const compatError = incompatiblePostError(postType, assetIds.length, targetChannels);
  if (compatError) {
    return NextResponse.json({ error: compatError }, { status: 400 });
  }

  // post_now wins over any scheduled_local also present in the body: the current
  // instant is used as-is, with no timezone conversion needed (there's no wall-clock
  // entry to convert — "now" means now, in UTC, on this machine).
  let scheduledUtc: string;
  if (postNow) {
    scheduledUtc = new Date().toISOString();
  } else {
    try {
      scheduledUtc = zonedTimeToUtc(localTime, timeZone);
    } catch {
      return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
    }
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

  // Same check content/route.ts's PATCH does before saving — a caption that's fine to
  // *look* at in the composer but too long for a targeted platform must not be allowed
  // to schedule, or it just fails terminally at publish instead.
  const captionError = captionLimitError(targetChannels, captionVariants ?? [], caption, postType);
  if (captionError) {
    return NextResponse.json({ error: captionError }, { status: 400 });
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
    skip_approval: postNow,
    caption_variants: captionVariants ?? undefined,
    period_links: periodLinks ?? undefined,
    tag_ids: tagIds ?? undefined,
  });

  return NextResponse.json({ postId, publicationIds, scheduledUtc }, { status: 201 });
}
