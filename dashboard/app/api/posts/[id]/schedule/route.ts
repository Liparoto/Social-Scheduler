import { NextRequest, NextResponse } from "next/server";
import { bulkCreatePublications, getChannel, getPost, type BulkEntry } from "@/lib/queries";
import { intervalSlots } from "@/lib/scheduling";

export const runtime = "nodejs";

/** Schedule ONE existing post to one or more channels at a date/time (per-channel tz). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const postId = Number(id);
  if (!getPost(postId)) {
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

  const entries: BulkEntry[] = [];
  for (const channelId of channelIds) {
    const channel = getChannel(channelId);
    if (!channel) {
      return NextResponse.json({ error: `Unknown channel ${channelId}.` }, { status: 400 });
    }
    const scheduledAt = intervalSlots(date, time, 1, 1, channel.timezone)[0];
    entries.push({
      post_id: postId,
      channel_id: channelId,
      scheduled_at: scheduledAt,
      status: channel.requires_approval ? "pending_approval" : "scheduled",
    });
  }

  const created = bulkCreatePublications(entries);
  return NextResponse.json({ created }, { status: 201 });
}
