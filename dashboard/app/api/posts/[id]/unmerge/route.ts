import { NextResponse } from "next/server";
import { unmergeCarousel } from "@/lib/queries";

// Thin passthrough, matching app/api/posts/merge/route.ts. Every real guard lives in
// lib/unmerge-plan.ts, reached through unmergeCarousel — the only thing validated here is
// that the URL segment is actually a number.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }
  const result = unmergeCarousel(postId);
  if (!result.ok) {
    return NextResponse.json({ error: result.problem.message }, { status: result.problem.status });
  }
  return NextResponse.json({ ok: true, post_ids: result.post_ids });
}
