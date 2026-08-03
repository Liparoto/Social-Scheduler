import { NextRequest, NextResponse } from "next/server";
import { getBulkEditContext, getPost } from "@/lib/queries";

export const runtime = "nodejs";

/** Return current metadata coverage for a validated selection without changing any posts. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!Array.isArray(body.post_ids) || body.post_ids.length === 0) {
    return NextResponse.json({ error: "Select at least one post." }, { status: 400 });
  }
  if (body.post_ids.some((id: unknown) => typeof id !== "number" || !Number.isInteger(id))) {
    return NextResponse.json({ error: "post_ids must contain integers." }, { status: 400 });
  }

  const postIds = [...new Set<number>(body.post_ids)];
  const unknownPostId = postIds.find((id) => !getPost(id));
  if (unknownPostId !== undefined) {
    return NextResponse.json({ error: `Unknown post ${unknownPostId}.` }, { status: 400 });
  }

  return NextResponse.json(getBulkEditContext(postIds), { status: 200 });
}
