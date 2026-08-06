import { NextResponse } from "next/server";
import { requestFirstCommentRetry } from "@/lib/queries";

export const runtime = "nodejs";

/**
 * Queue one more attempt at a failed first comment. Distinct from ../retry, which
 * re-queues the POST: this post is already live, so the only thing left to retry is the
 * comment, and the only safe way to do it is to ask the worker rather than act here.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = requestFirstCommentRetry(Number(id));
  if (!ok) {
    return NextResponse.json(
      { error: "Only a failed first comment on a published send can be retried." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
