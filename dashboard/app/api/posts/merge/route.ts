import { NextResponse } from "next/server";
import { mergePostsIntoCarousel } from "@/lib/queries";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { post_ids, asset_order, caption } = body as Record<string, unknown>;
  if (!Array.isArray(post_ids) || !post_ids.every((n) => Number.isInteger(n))) {
    return NextResponse.json({ error: "post_ids must be an array of post ids." }, { status: 400 });
  }
  if (!Array.isArray(asset_order) || !asset_order.every((n) => Number.isInteger(n))) {
    return NextResponse.json({ error: "asset_order must be an array of asset ids." }, { status: 400 });
  }
  if (caption !== null && caption !== undefined && typeof caption !== "string") {
    return NextResponse.json({ error: "caption must be text or null." }, { status: 400 });
  }
  const result = mergePostsIntoCarousel(
    post_ids as number[], asset_order as number[], (caption as string) ?? null,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.problem.message }, { status: result.problem.status });
  }
  return NextResponse.json({ ok: true, post_id: result.post_id });
}
