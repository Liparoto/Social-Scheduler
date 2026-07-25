import { NextRequest, NextResponse } from "next/server";
import {
  bulkAddTargets,
  bulkRemoveTargets,
  getCaptionVariants,
  getChannel,
  getPost,
} from "@/lib/queries";
import { captionLimitError } from "@/lib/caption-limits";

export const runtime = "nodejs";

/**
 * Bulk re-target: add or remove one or more channels as targets across many posts.
 * This is how a newly added account gets folded into existing content — targeting
 * controls which accounts auto-fill can post a given piece of content to.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const postIds: number[] = Array.isArray(body.post_ids) ? body.post_ids : [];
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const action = body.action;

  if (postIds.length === 0) {
    return NextResponse.json({ error: "Select at least one post." }, { status: 400 });
  }
  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (action !== "add" && action !== "remove") {
    return NextResponse.json({ error: "action must be 'add' or 'remove'." }, { status: 400 });
  }
  const channels = channelIds.map((cid) => getChannel(cid));
  const unknownIdx = channels.findIndex((c) => !c);
  if (unknownIdx !== -1) {
    return NextResponse.json({ error: `Unknown channel ${channelIds[unknownIdx]}.` }, { status: 400 });
  }
  const targetChannels = channels.map((c) => c!);

  // This is exactly the "recycle a good post to every channel" workflow the caption
  // limit exists for: an evergreen post fine on Instagram can be fine to LOOK at when
  // Telegram is added here, then autofill queues it and the worker fails it terminally
  // forever, with nothing in the UI having warned. Only "add" can introduce a new,
  // possibly-too-strict platform; "remove" can only relax constraints.
  if (action === "add") {
    for (const postId of postIds) {
      const post = getPost(postId);
      if (!post) continue; // unknown post ids are silently ignored elsewhere in this route today
      const variants = getCaptionVariants(postId).map((v) => ({ platform: v.platform, body: v.body }));
      const captionError = captionLimitError(targetChannels, variants, post.caption, post.post_type);
      if (captionError) {
        return NextResponse.json(
          { error: `Post ${postId}: ${captionError}` },
          { status: 400 }
        );
      }
    }
  }

  if (action === "add") {
    bulkAddTargets(postIds, channelIds);
  } else {
    bulkRemoveTargets(postIds, channelIds);
  }

  return NextResponse.json({ updated: postIds.length }, { status: 200 });
}
