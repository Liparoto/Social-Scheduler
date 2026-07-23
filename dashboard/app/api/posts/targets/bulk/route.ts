import { NextRequest, NextResponse } from "next/server";
import { bulkAddTargets, bulkRemoveTargets, getChannel } from "@/lib/queries";

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
  for (const channelId of channelIds) {
    if (!getChannel(channelId)) {
      return NextResponse.json({ error: `Unknown channel ${channelId}.` }, { status: 400 });
    }
  }

  if (action === "add") {
    bulkAddTargets(postIds, channelIds);
  } else {
    bulkRemoveTargets(postIds, channelIds);
  }

  return NextResponse.json({ updated: postIds.length }, { status: 200 });
}
