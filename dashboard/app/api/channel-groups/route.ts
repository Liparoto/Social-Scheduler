import { NextRequest, NextResponse } from "next/server";
import { createChannelGroup, listChannelGroups } from "@/lib/queries";
import { isValidTimezone } from "@/lib/timezones";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ groups: listChannelGroups() });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const name = (body.name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "Group name is required." }, { status: 400 });
  }
  // Same reasoning as POST /api/channels: an unvalidated zone is a render crash, not a
  // bad value — formatInTz() hands it straight to Intl.DateTimeFormat.
  const timezone = (body.timezone || "UTC").trim();
  if (!isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: `"${timezone}" isn't a timezone name. Use an IANA name like America/New_York.` },
      { status: 400 }
    );
  }
  try {
    const id = createChannelGroup({ name, timezone });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err: any) {
    if (String(err?.code || "").includes("SQLITE_CONSTRAINT")) {
      return NextResponse.json(
        { error: `A group named "${name}" already exists.` },
        { status: 400 }
      );
    }
    throw err;
  }
}
