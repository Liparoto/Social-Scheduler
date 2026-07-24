import { NextRequest, NextResponse } from "next/server";
import { getChannel, getPublication, reschedulePublication } from "@/lib/queries";
import { intervalSlots } from "@/lib/scheduling";

export const runtime = "nodejs";

/** Reschedule an existing send to a new date/time (converted via its channel's tz). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const pubId = Number(id);
  const pub = getPublication(pubId);
  if (!pub) {
    return NextResponse.json({ error: "Publication not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const date: string = body.date || "";
  const time: string = body.time || "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Pick a date." }, { status: 400 });
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return NextResponse.json({ error: "Enter a time as HH:MM." }, { status: 400 });
  }

  const channel = getChannel(pub.channel_id);
  if (!channel) {
    return NextResponse.json({ error: "This send's channel no longer exists." }, { status: 400 });
  }

  const scheduledAtUtc = intervalSlots(date, time, 1, 1, channel.timezone)[0];
  const ok = reschedulePublication(pubId, scheduledAtUtc);
  if (!ok) {
    return NextResponse.json(
      { error: "Only a scheduled or awaiting-approval send can be rescheduled." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
