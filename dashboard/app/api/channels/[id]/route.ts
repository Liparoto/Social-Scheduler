import { NextRequest, NextResponse } from "next/server";
import { getChannel, getChannelGroup, updateChannel, setChannelGroup } from "@/lib/queries";

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
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (
    "color_hue" in body &&
    body.color_hue !== null &&
    (!Number.isInteger(body.color_hue) || body.color_hue < 0 || body.color_hue > 360)
  ) {
    return NextResponse.json(
      { error: "color_hue must be null or an integer between 0 and 360." },
      { status: 400 }
    );
  }
  const fields: Record<string, unknown> = {};
  if (typeof body.account_name === "string") fields.account_name = body.account_name.trim();
  if ("business_label" in body) fields.business_label = body.business_label || null;
  // `timezone` is intentionally NOT accepted here — it goes through
  // POST /api/channels/[id]/timezone, which also rebases the pending queue.
  if ("timezone" in body) {
    return NextResponse.json(
      { error: "Change the timezone via POST /api/channels/[id]/timezone." },
      { status: 400 }
    );
  }
  if ("remote_account_id" in body) fields.remote_account_id = body.remote_account_id || null;
  if ("linked_page_id" in body) fields.linked_page_id = body.linked_page_id || null;
  if ("access_token" in body) fields.access_token = body.access_token || null;
  if ("requires_approval" in body) fields.requires_approval = body.requires_approval ? 1 : 0;
  if ("is_active" in body) fields.is_active = body.is_active ? 1 : 0;
  // Auto-fill config
  if ("autofill_enabled" in body) fields.autofill_enabled = body.autofill_enabled ? 1 : 0;
  if ("cadence_config" in body) fields.cadence_config = body.cadence_config || null;
  if ("min_queue_depth" in body) fields.min_queue_depth = Number(body.min_queue_depth) || 0;
  if ("target_queue_depth" in body) fields.target_queue_depth = Number(body.target_queue_depth) || 0;
  if ("reuse_min_age_days" in body) fields.reuse_min_age_days = Number(body.reuse_min_age_days) || 0;
  if ("color_hue" in body) fields.color_hue = body.color_hue ?? null;

  // group_id goes through setChannelGroup() rather than the generic field writer,
  // because updateChannel()'s Partial<> type deliberately does not list it — assignment
  // is a membership change, not a field edit.
  if ("group_id" in body) {
    const gid = body.group_id === null || body.group_id === "" ? null : Number(body.group_id);
    if (gid !== null && !getChannelGroup(gid)) {
      return NextResponse.json({ error: "Group not found." }, { status: 400 });
    }
    setChannelGroup(channelId, gid);
  }

  updateChannel(channelId, fields);
  return NextResponse.json({ ok: true });
}
