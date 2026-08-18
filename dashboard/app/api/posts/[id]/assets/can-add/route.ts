import { NextRequest, NextResponse } from "next/server";
import {
  countQueuedPerSlideSendsForPost,
  getPost,
  postHasLiveSend,
} from "@/lib/queries";
import { checkCanAddMedia } from "@/lib/post-media-edit";

export const runtime = "nodejs";

/**
 * Could this post take a new slide right now? Read-only, writes nothing, answers before
 * a single byte is uploaded.
 *
 * The problem it solves: uploading is `POST /api/assets/upload`, which writes the original,
 * conforms it, and writes a derivative and a thumbnail into /data — all BEFORE
 * `POST /api/posts/[id]/assets` is ever called and gets to refuse the add. On a post that
 * is already live, has a Story send queued, or is text-only, every attempt therefore left
 * another conformed copy sitting in the library as an unused asset with nothing to say
 * where it came from. The strip now asks this first and stops there.
 *
 * Only the rules that can be answered from the POST ITSELF live here — checkCanAddMedia()
 * is the same function `POST .../assets` runs, so there is one rule and one sentence, not
 * a copy that can drift. The rules that need to see the file (video mixing, already on this
 * post, carousel size) stay on the POST: they cannot be judged without an asset row, and
 * content-hash dedup means re-uploading the same file after such a refusal resolves to the
 * asset that already exists rather than making another one.
 *
 * A refusal is a 200 with `ok: false`, not an error status. The question was asked and
 * answered successfully; the answer is just "no". `error` is the exact sentence the POST
 * would have returned, so the strip can render it verbatim either way.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  const post = Number.isInteger(postId) ? getPost(postId) : undefined;
  if (!post) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }

  const gate = checkCanAddMedia(
    { postType: post.post_type, hasLiveSend: postHasLiveSend(postId) },
    countQueuedPerSlideSendsForPost(postId)
  );

  return NextResponse.json(
    gate.ok ? { ok: true } : { ok: false, code: gate.code, error: gate.error }
  );
}
