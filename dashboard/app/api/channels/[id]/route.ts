import { NextRequest, NextResponse } from "next/server";
import { getChannel, updateChannel } from "@/lib/queries";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channelId = Number(id);
  if (!getChannel(channelId)) {
    return NextResponse.json({ error: "Channel not found." }, { status: 404 });
  }
  const body = await req.json();
  const fields: Record<string, unknown> = {};
  if (typeof body.account_name === "string") fields.account_name = body.account_name.trim();
  if ("business_label" in body) fields.business_label = body.business_label || null;
  if (typeof body.timezone === "string") fields.timezone = body.timezone;
  if ("remote_account_id" in body) fields.remote_account_id = body.remote_account_id || null;
  if ("linked_page_id" in body) fields.linked_page_id = body.linked_page_id || null;
  if ("access_token" in body) fields.access_token = body.access_token || null;
  if ("requires_approval" in body) fields.requires_approval = body.requires_approval ? 1 : 0;
  if ("is_active" in body) fields.is_active = body.is_active ? 1 : 0;

  updateChannel(channelId, fields);
  return NextResponse.json({ ok: true });
}
