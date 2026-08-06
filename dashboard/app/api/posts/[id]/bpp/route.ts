import { NextResponse } from "next/server";
import { setPostBpp } from "@/lib/insights-queries";

export const runtime = "nodejs";

/**
 * Mark or unmark a library post as a BPP.
 *
 * A person's decision, always — the app never sets this itself, so there is no
 * "auto-mark" path here on purpose.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const isBpp = Boolean(body.is_bpp);
  if (!setPostBpp(postId, isBpp)) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, is_bpp: isBpp });
}
