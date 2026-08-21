import { NextResponse } from "next/server";
import { setPostArchived } from "@/lib/queries";
import type { ContentKind, ContentStatus } from "@/lib/types";

export const runtime = "nodejs";

const CONTENT_STATUSES: ContentStatus[] = ["draft", "ready", "retired"];
const CONTENT_KINDS: ContentKind[] = ["one_time", "evergreen"];

/**
 * Archive a post out of the Library, or bring it back.
 *
 * Sits beside DELETE /api/posts/[id] rather than replacing it: delete is still refused for
 * a post with a live send (409), because erasing it would erase the record of something
 * that is on Instagram. This is the way out of the Library that doesn't destroy anything.
 *
 * `content_status` / `content_kind` are optional and only honoured when archiving — the
 * Archive dialog sends them so "out of the Library" and "out of the auto-fill rotation"
 * happen in one step, in the bucket the UI already shows. Validated here rather than
 * trusted: they land in a CHECK-constrained column, and a bad value should be a 400 with a
 * readable message, not a raw SQLite constraint error.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    archived?: unknown;
    content_status?: unknown;
    content_kind?: unknown;
  };
  // Required and strictly boolean, NOT Boolean(body.archived): an unparseable body becomes
  // {} above, which would have made this false and silently UNARCHIVED the post while
  // answering 200. A dropped or truncated body has to be an error, not a state change.
  // (The string "false" would flip the same way, hence the type check rather than a
  // presence check.)
  if (typeof body.archived !== "boolean") {
    return NextResponse.json(
      { error: "Missing or invalid 'archived' — expected true or false." },
      { status: 400 }
    );
  }
  const archived = body.archived;

  const also: { content_status?: ContentStatus; content_kind?: ContentKind } = {};
  if (body.content_status !== undefined && body.content_status !== null) {
    if (!CONTENT_STATUSES.includes(body.content_status as ContentStatus)) {
      return NextResponse.json({ error: "Unknown content status." }, { status: 400 });
    }
    also.content_status = body.content_status as ContentStatus;
  }
  if (body.content_kind !== undefined && body.content_kind !== null) {
    if (!CONTENT_KINDS.includes(body.content_kind as ContentKind)) {
      return NextResponse.json({ error: "Unknown content kind." }, { status: 400 });
    }
    also.content_kind = body.content_kind as ContentKind;
  }

  if (setPostArchived(postId, archived, also) === "not_found") {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, archived });
}
