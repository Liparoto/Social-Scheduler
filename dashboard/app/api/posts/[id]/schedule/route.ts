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
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const date: string = body.date || "";
  const time: string = body.time || "";

  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Pick a date." }, { status: 400 });
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return NextResponse.json({ error: "Enter a time as HH:MM." }, { status: 400 });
  }

  const channels = channelIds.map((cid) => getChannel(cid));
  const unknownIdx = channels.findIndex((c) => !c);
  if (unknownIdx !== -1) {
    return NextResponse.json({ error: `Unknown channel ${channelIds[unknownIdx]}.` }, { status: 400 });
  }
  const targetChannels = channels.map((c) => c!);

  const incompatible = incompatibleChannelsForPostType(post.post_type, targetChannels);
  if (incompatible.length > 0) {
    return NextResponse.json(
      { error: `${incompatible.map(describeChannel).join(", ")} can't publish a ${post.post_type} post.` },
      { status: 400 }
    );
  }

  const entries: BulkEntry[] = [];
  for (const channel of targetChannels) {
    const scheduledAt = intervalSlots(date, time, 1, 1, channel.timezone)[0];
    entries.push({
      post_id: postId,
      channel_id: channel.id,
      scheduled_at: scheduledAt,
      status: channel.requires_approval ? "pending_approval" : "scheduled",
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
