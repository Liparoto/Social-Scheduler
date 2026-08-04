import { NextRequest, NextResponse } from "next/server";
import {
  bulkCreatePublications,
  getCaptionVariants,
  getChannel,
  getPost,
  getPostAssets,
  IncompatiblePostTargetError,
  type BulkEntry,
} from "@/lib/queries";
import { intervalSlots } from "@/lib/scheduling";
import { incompatiblePostError } from "@/lib/platforms";
import { captionLimitError } from "@/lib/caption-limits";
import { parseTargets } from "@/lib/story-fanout";

export const runtime = "nodejs";

/** Schedule ONE existing post to one or more channels at a date/time (per-channel tz). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const postId = Number(id);
  const post = getPost(postId);
  if (!post) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  // The library scheduler sends `targets` (channel + surface); older callers send
  // channel_ids, which can only have meant feed targets.
  const parsedTargets = parseTargets(body.targets, body.channel_ids);
  if (parsedTargets === "invalid") {
    return NextResponse.json({ error: "Invalid targets." }, { status: 400 });
  }
  // Compatibility and caption checks are per ACCOUNT, so dedupe.
  const channelIds: number[] = [...new Set(parsedTargets.map((t) => t.channel_id))];
  const date: string = body.date || "";
  const time: string = body.time || "";
  // "Post now": publish on the worker's next poll instead of a chosen date/time.
  // Wins over any date/time also present in the body — see below.
  const postNow: boolean = body.post_now === true;

  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (!postNow) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Pick a date." }, { status: 400 });
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return NextResponse.json({ error: "Enter a time as HH:MM." }, { status: 400 });
    }
  }

  const channels = channelIds.map((cid) => getChannel(cid));
  const unknownIdx = channels.findIndex((c) => !c);
  if (unknownIdx !== -1) {
    return NextResponse.json({ error: `Unknown channel ${channelIds[unknownIdx]}.` }, { status: 400 });
  }
  const targetChannels = channels.map((c) => c!);

  // This route used to check text-compatibility only — a carousel's size against each
  // target's maxCarousel was never checked at all, so an oversized carousel could be
  // scheduled here and fail terminally at publish.
  const assetCount = getPostAssets(postId).length;
  const compatError = incompatiblePostError(post.post_type, assetCount, targetChannels);
  if (compatError) {
    return NextResponse.json({ error: compatError }, { status: 400 });
  }

  // Same check content/route.ts's PATCH and the create routes already do — a caption
  // that fits every channel this post is CURRENTLY targeted at can still be too long
  // for a channel being added here (e.g. retargeting an evergreen IG post to Telegram).
  // Skipping this check is exactly how a post ends up scheduled and then failing
  // terminally, forever, on every autofill re-selection.
  const variants = getCaptionVariants(postId).map((v) => ({ platform: v.platform, body: v.body }));
  const captionError = captionLimitError(targetChannels, variants, post.caption, post.post_type);
  if (captionError) {
    return NextResponse.json({ error: captionError }, { status: 400 });
  }

  // post_now wins over any date/time also present in the body: the current instant is
  // used as-is, with no timezone conversion needed (there's no wall-clock entry to
  // convert — "now" means now, in UTC, on this machine) — same as app/api/posts/route.ts.
  const nowIso = new Date().toISOString();

  const entries: BulkEntry[] = [];
  for (const target of parsedTargets) {
    const channel = targetChannels.find((c) => c.id === target.channel_id);
    if (!channel) continue;
    const scheduledAt = postNow ? nowIso : intervalSlots(date, time, 1, 1, channel.timezone)[0];
    // "Post now" (skip_approval) means the person scheduling this send right now IS the
    // approver — see the same decision in lib/queries.ts's createPostWithPublications.
    const status = postNow || !channel.requires_approval ? "scheduled" : "pending_approval";
    entries.push({
      post_id: postId,
      channel_id: channel.id,
      scheduled_at: scheduledAt,
      status,
      surface: target.surface,
    });
  }

  try {
    const created = bulkCreatePublications(entries);
    return NextResponse.json({ created }, { status: 201 });
  } catch (err) {
    if (err instanceof IncompatiblePostTargetError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
