import { NextRequest, NextResponse } from "next/server";
import {
  changeChannelTimezone,
  getChannel,
  getPendingPublicationsForChannel,
} from "@/lib/queries";
import { rebaseWallClock } from "@/lib/time";
import { isValidTimezone } from "@/lib/timezones";

export const runtime = "nodejs";

/**
 * Change a channel's timezone.
 *
 * This lives apart from the generic PATCH /api/channels/[id] on purpose: that
 * handler backs the Active / Approval toggles and must stay a plain field write.
 * A timezone change also rewrites every pending send's scheduled_at, which is
 * not something a generic field-setter should be able to do by accident.
 *
 *   { timezone, confirm: false }  -> preview: what would move, and to when
 *   { timezone, confirm: true }   -> apply, atomically
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channelId = Number(id);
  const channel = getChannel(channelId);
  if (!channel) {
    return NextResponse.json({ error: "Channel not found." }, { status: 404 });
  }
  // A grouped channel does NOT own its timezone — the group does. Rebasing one member
  // alone would move its pending sends away from the other members' matching slots,
  // and the next auto-fill would pair them again, leaving a permanently mixed queue.
  if (channel.group_id !== null) {
    return NextResponse.json(
      {
        error:
          "This channel is in an auto-fill group, so its timezone is set on the group. " +
          "Change the group's timezone instead — that moves every member's pending sends " +
          "together, which is what keeps them in step.",
      },
      { status: 400 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const toTz = typeof body.timezone === "string" ? body.timezone.trim() : "";
  if (!toTz) {
    return NextResponse.json({ error: "Pick a timezone." }, { status: 400 });
  }
  if (!isValidTimezone(toTz)) {
    return NextResponse.json(
      { error: `"${toTz}" isn't a timezone name. Use an IANA name like America/New_York.` },
      { status: 400 }
    );
  }

  const fromTz = channel.timezone;

  // Preview — no writes. Shows the owner exactly which sends move and to when,
  // so "keep the same clock time" is something they can see rather than trust.
  if (!body.confirm) {
    const sends = getPendingPublicationsForChannel(channelId).map((p) => ({
      id: p.id,
      post_id: p.post_id,
      is_held: p.is_held === 1,
      before: p.scheduled_at,
      after: rebaseWallClock(p.scheduled_at, fromTz, toTz),
    }));
    return NextResponse.json({
      ok: true,
      from: fromTz,
      to: toTz,
      unchanged: fromTz === toTz,
      sends,
    });
  }

  const { moved } = changeChannelTimezone(channelId, fromTz, toTz, rebaseWallClock);
  return NextResponse.json({ ok: true, from: fromTz, to: toTz, moved });
}
