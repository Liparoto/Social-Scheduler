import { NextRequest, NextResponse } from "next/server";
import {
  deleteChannelGroup,
  getChannelGroup,
  updateChannelGroup,
  upsertAutofillLane,
} from "@/lib/queries";
import { isSurface } from "@/lib/story-fanout";
import type { Surface } from "@/lib/types";

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
  // A parsed JSON body genuinely has no known shape; every field below is validated
  // before use. Matches the .catch(() => ...) idiom the other routes use, and avoids an
  // explicit `any` for a value that is only ever read through those checks.
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
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
  // Auto-fill config now lives per (owner, surface) in autofill_lanes, not in columns.
  // The body names its surface; a request without one predates lanes and means feed.
  //
  // An unrecognized surface is refused rather than read as feed. Coercing it wrote the
  // sending panel's cadence and depths onto the LIVE FEED lane — a typo like "stories"
  // silently reconfigured the wrong rotation, on a route that already answers 400 for a
  // bad color_hue and a stray timezone.
  if ("surface" in body && !isSurface(body.surface)) {
    return NextResponse.json(
      { error: 'surface must be one of "feed", "story" or "reel".' },
      { status: 400 }
    );
  }
  const surface: Surface = isSurface(body.surface) ? body.surface : "feed";
  const lane: Record<string, unknown> = {};
  if ("autofill_enabled" in body) lane.enabled = body.autofill_enabled ? 1 : 0;
  if ("cadence_config" in body) lane.cadence_config = body.cadence_config || null;
  if ("min_queue_depth" in body) lane.min_queue_depth = Number(body.min_queue_depth) || 0;
  if ("target_queue_depth" in body) lane.target_queue_depth = Number(body.target_queue_depth) || 0;
  if ("reuse_min_age_days" in body) lane.reuse_min_age_days = Number(body.reuse_min_age_days) || 0;
  if (Object.keys(lane).length > 0) {
    upsertAutofillLane({ kind: "group", id: groupId }, surface, lane);
  }
  // Math.max(0, …) rather than a bare Number: this value divides slot positions,
  // and a negative would silently mean "off" while reading as if it were on.
  if ("bpp_every_days" in body)
    fields.bpp_every_days = Math.max(0, Math.trunc(Number(body.bpp_every_days) || 0));
  if ("is_active" in body) fields.is_active = body.is_active ? 1 : 0;

  try {
    updateChannelGroup(groupId, fields);
  } catch (err) {
    // better-sqlite3 hangs the SQLite error name off `code`. The catch binding is
    // `unknown`, so narrow to it rather than asserting the whole error's shape.
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code ?? "")
        : "";
    if (code.includes("SQLITE_CONSTRAINT")) {
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
