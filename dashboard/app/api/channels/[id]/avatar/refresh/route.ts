import { NextResponse } from "next/server";
import { getChannel, requestAvatarRefresh } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * Queue an avatar refresh for a channel.
 *
 * Deliberately does no network work: the worker owns every platform call, and the DB is
 * the contract between the two. The response says "queued", never "refreshed" — the photo
 * changes when the worker next runs, which is what the UI tells the owner.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = getChannel(Number(id));
  if (!channel) {
    return NextResponse.json({ error: "Channel not found." }, { status: 404 });
  }
  if (!channel.remote_account_id || !channel.access_token) {
    return NextResponse.json(
      { error: "Add an account id and access token first." },
      { status: 400 }
    );
  }
  requestAvatarRefresh(channel.id);
  return NextResponse.json({ ok: true, queued: true });
}
