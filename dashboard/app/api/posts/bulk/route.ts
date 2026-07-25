import { NextRequest, NextResponse } from "next/server";
import {
  bulkCreatePublications,
  getChannel,
  getPost,
  IncompatiblePostTargetError,
  type BulkEntry,
} from "@/lib/queries";
import { intervalSlots } from "@/lib/scheduling";
import { describeChannel, incompatibleChannelsForPostType } from "@/lib/platforms";

export const runtime = "nodejs";

/**
 * Bulk-schedule N posts at a fixed interval to one or more channels.
 * Each channel gets its own slot sequence (computed in the channel's timezone):
 * post i lands in slot i.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const postIds: number[] = Array.isArray(body.post_ids) ? body.post_ids : [];
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const everyDays = Number(body.every_days);
  const time: string = body.time || "";
  const startDate: string = body.start_date || ""; // "YYYY-MM-DD"

  if (postIds.length === 0) {
    return NextResponse.json({ error: "Select at least one post." }, { status: 400 });
  }
  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (!Number.isFinite(everyDays) || everyDays < 1) {
    return NextResponse.json({ error: "Frequency must be at least 1 day." }, { status: 400 });
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return NextResponse.json({ error: "Enter a time as HH:MM." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return NextResponse.json({ error: "Pick a start date." }, { status: 400 });
  }

  const channels = channelIds.map((cid) => getChannel(cid));
  const unknownChannelIdx = channels.findIndex((c) => !c);
  if (unknownChannelIdx !== -1) {
    return NextResponse.json({ error: `Unknown channel ${channelIds[unknownChannelIdx]}.` }, { status: 400 });
  }
  const targetChannels = channels.map((c) => c!);

  const posts = postIds.map((pid) => getPost(pid));
  const unknownPostIdx = posts.findIndex((p) => !p);
  if (unknownPostIdx !== -1) {
    return NextResponse.json({ error: `Unknown post ${postIds[unknownPostIdx]}.` }, { status: 400 });
  }
  const postTypes = new Set(posts.map((p) => p!.post_type));
  for (const postType of postTypes) {
    const incompatible = incompatibleChannelsForPostType(postType, targetChannels);
    if (incompatible.length > 0) {
      return NextResponse.json(
        { error: `${incompatible.map(describeChannel).join(", ")} can't publish a ${postType} post.` },
        { status: 400 }
      );
    }
  }

  const entries: BulkEntry[] = [];
  for (const channel of targetChannels) {
    const slots = intervalSlots(startDate, time, everyDays, postIds.length, channel.timezone);
    const status = channel.requires_approval ? "pending_approval" : "scheduled";
    postIds.forEach((postId, i) => {
      entries.push({ post_id: postId, channel_id: channel.id, scheduled_at: slots[i], status });
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
