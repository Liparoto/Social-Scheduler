import { NextResponse } from "next/server";
import { extractSlidesFromCarousel } from "@/lib/queries";

// Thin passthrough, matching app/api/posts/[id]/unmerge/route.ts. Every real guard — is it a
// carousel, is it published, is a send queued, does the selection make sense — lives in
// lib/unmerge-plan.ts, reached through extractSlidesFromCarousel. The only things checked
// here are that the URL segment is a number and that asset_ids is a list of integers.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { asset_ids } = body as Record<string, unknown>;
  if (!Array.isArray(asset_ids) || !asset_ids.every((n) => Number.isInteger(n))) {
    return NextResponse.json(
      { error: "asset_ids must be an array of photo ids." },
      { status: 400 }
    );
  }

  const result = extractSlidesFromCarousel(postId, asset_ids as number[]);
  if (!result.ok) {
    return NextResponse.json({ error: result.problem.message }, { status: result.problem.status });
  }
  return NextResponse.json({ ok: true, post_ids: result.post_ids });
}
