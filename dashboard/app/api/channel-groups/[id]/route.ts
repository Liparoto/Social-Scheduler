import { NextRequest, NextResponse } from "next/server";
import { deleteChannelGroup, getChannelGroup, updateChannelGroup } from "@/lib/queries";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = Number(id);
  if (!getChannelGroup(groupId)) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  // `timezone` is intentionally NOT accepted here — it goes through
  // POST /api/channel-groups/[id]/timezone, which also rebases every member's queue.
  if ("timezone" in body) {
    return NextResponse.json(
      { error: "Change the timezone via POST /api/channel-groups/[id]/timezone." },
      { status: 400 }
    );
  }
  const fields: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Group name cannot be empty." }, { status: 400 });
    }
    fields.name = name;
  }
  if ("autofill_enabled" in body) fields.autofill_enabled = body.autofill_enabled ? 1 : 0;
  if ("cadence_config" in body) fields.cadence_config = body.cadence_config || null;
  if ("min_queue_depth" in body) fields.min_queue_depth = Number(body.min_queue_depth) || 0;
  if ("target_queue_depth" in body) fields.target_queue_depth = Number(body.target_queue_depth) || 0;
  if ("reuse_min_age_days" in body) fields.reuse_min_age_days = Number(body.reuse_min_age_days) || 0;
  if ("is_active" in body) fields.is_active = body.is_active ? 1 : 0;

  try {
    updateChannelGroup(groupId, fields);
  } catch (err: any) {
    if (String(err?.code || "").includes("SQLITE_CONSTRAINT")) {
      return NextResponse.json({ error: "Another group already has that name." }, { status: 400 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Members are returned to solo auto-fill by ON DELETE SET NULL. Nothing is published,
  // unpublished, or unscheduled — a group is a scheduling convenience, not an owner.
  const ok = deleteChannelGroup(Number(id));
  if (!ok) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
