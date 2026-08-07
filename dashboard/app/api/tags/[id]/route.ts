import { NextRequest, NextResponse } from "next/server";
import {
  deleteTopicTag,
  renameTopicTag,
  DuplicateTagNameError,
  ProtectedTagError,
  ReservedTagNameError,
} from "@/lib/queries";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tagId = Number(id);
  if (!Number.isInteger(tagId)) {
    return NextResponse.json({ error: "Invalid tag id." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Give the tag a name." }, { status: 400 });
  }
  try {
    const tag = renameTopicTag(tagId, name);
    if (!tag) {
      return NextResponse.json({ error: "Tag not found." }, { status: 404 });
    }
    return NextResponse.json(tag);
  } catch (e) {
    if (
      e instanceof ProtectedTagError ||
      e instanceof ReservedTagNameError ||
      e instanceof DuplicateTagNameError
    ) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tagId = Number(id);
  if (!Number.isInteger(tagId)) {
    return NextResponse.json({ error: "Invalid tag id." }, { status: 400 });
  }
  try {
    const { deleted, postCount } = deleteTopicTag(tagId);
    if (!deleted) {
      return NextResponse.json({ error: "Tag not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, postCount });
  } catch (e) {
    if (e instanceof ProtectedTagError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
