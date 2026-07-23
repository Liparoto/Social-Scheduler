import { NextRequest, NextResponse } from "next/server";
import { bulkCreatePublications, getChannel, type BulkEntry } from "@/lib/queries";
import { intervalSlots } from "@/lib/scheduling";

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

  const entries: BulkEntry[] = [];
  for (const channelId of channelIds) {
    const channel = getChannel(channelId);
    if (!channel) {
      return NextResponse.json({ error: `Unknown channel ${channelId}.` }, { status: 400 });
    }
    const slots = intervalSlots(startDate, time, everyDays, postIds.length, channel.timezone);
    const status = channel.requires_approval ? "pending_approval" : "scheduled";
    postIds.forEach((postId, i) => {
      entries.push({ post_id: postId, channel_id: channelId, scheduled_at: slots[i], status });
    });
  }

  const created = bulkCreatePublications(entries);
  return NextResponse.json({ created }, { status: 201 });
}
