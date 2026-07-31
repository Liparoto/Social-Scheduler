import { NextRequest, NextResponse } from "next/server";
import {
  changeChannelGroupTimezone,
  getChannelGroup,
  getGroupMembers,
  getPendingPublicationsForChannel,
} from "@/lib/queries";
import { rebaseWallClock } from "@/lib/time";
import { isValidTimezone } from "@/lib/timezones";

export const runtime = "nodejs";

/**
 * Change a group's timezone. Mirrors POST /api/channels/[id]/timezone, widened to every
 * member: a group owns the cadence, so its members' pending sends must move together or
 * they stop mirroring.
 *
 *   { timezone, confirm: false }  -> preview: what would move, and to when
 *   { timezone, confirm: true }   -> apply, atomically
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = Number(id);
  const group = getChannelGroup(groupId);
  if (!group) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
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

  const fromTz = group.timezone;

  if (!body.confirm) {
    const sends = getGroupMembers(groupId).flatMap((m) =>
      getPendingPublicationsForChannel(m.id).map((p) => ({
        id: p.id,
        post_id: p.post_id,
        channel_id: m.id,
        account_name: m.account_name,
        is_held: p.is_held === 1,
        before: p.scheduled_at,
        after: rebaseWallClock(p.scheduled_at, fromTz, toTz),
      }))
    );
    return NextResponse.json({
      ok: true,
      from: fromTz,
      to: toTz,
      unchanged: fromTz === toTz,
      sends,
    });
  }

  const { moved } = changeChannelGroupTimezone(groupId, fromTz, toTz, rebaseWallClock);
  return NextResponse.json({ ok: true, from: fromTz, to: toTz, moved });
}
