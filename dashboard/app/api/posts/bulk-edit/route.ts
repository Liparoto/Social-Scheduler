import { NextRequest, NextResponse } from "next/server";
import {
  bulkEditPosts,
  getPeriod,
  getPost,
  listTags,
  type BulkEditPostsInput,
} from "@/lib/queries";
import { parsePeriodLinks, parseTagIds } from "@/lib/content-model-validation";

export const runtime = "nodejs";

/** Apply local Library metadata to several posts only after the full request validates. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // 1. Validate every selected post before looking at any requested edit.
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

  // 2. Validate tag add/remove lists using the same shared parser as per-post writes.
  let tags: BulkEditPostsInput["tags"];
  if (body.tags !== undefined) {
    if (!body.tags || typeof body.tags !== "object" || Array.isArray(body.tags)) {
      return NextResponse.json({ error: "tags must contain add/remove arrays." }, { status: 400 });
    }
    const validTagIds = new Set(listTags().map((tag) => tag.id));
    const add = parseTagIds(body.tags.add ?? [], (id) => validTagIds.has(id));
    const remove = parseTagIds(body.tags.remove ?? [], (id) => validTagIds.has(id));
    if (add === "invalid" || remove === "invalid") {
      return NextResponse.json({ error: "Invalid tag add/remove list." }, { status: 400 });
    }
    tags = { add: add ?? [], remove: remove ?? [] };
  }

  // 3. Validate period add/remove links with the shared period parser.
  let periods: BulkEditPostsInput["periods"];
  if (body.periods !== undefined) {
    if (!body.periods || typeof body.periods !== "object" || Array.isArray(body.periods)) {
      return NextResponse.json(
        { error: "periods must contain add/remove arrays." },
        { status: 400 }
      );
    }
    const add = parsePeriodLinks(body.periods.add ?? [], getPeriod);
    const remove = parsePeriodLinks(body.periods.remove ?? [], getPeriod);
    if (add === "invalid" || remove === "invalid") {
      return NextResponse.json({ error: "Invalid period add/remove list." }, { status: 400 });
    }
    periods = { add: add ?? [], remove: remove ?? [] };
  }

  // 4. Validate scalar fields last. No write has happened above this line.
  const edit: BulkEditPostsInput = { post_ids: postIds, tags, periods };
  if (body.content_status !== undefined) {
    if (!['draft', 'ready', 'retired'].includes(body.content_status)) {
      return NextResponse.json(
        { error: "content_status must be draft, ready, or retired." },
        { status: 400 }
      );
    }
    edit.content_status = body.content_status;
  }
  if (body.content_kind !== undefined) {
    if (body.content_kind !== "one_time" && body.content_kind !== "evergreen") {
      return NextResponse.json(
        { error: "content_kind must be one_time or evergreen." },
        { status: 400 }
      );
    }
    edit.content_kind = body.content_kind;
  }
  if ("cooldown_days" in body) {
    if (body.cooldown_days === null || body.cooldown_days === undefined) {
      edit.cooldown_days = null;
    } else {
      const cooldownDays = Number(body.cooldown_days);
      if (!Number.isInteger(cooldownDays) || cooldownDays < 0) {
        return NextResponse.json(
          { error: "cooldown_days must be a non-negative integer or null." },
          { status: 400 }
        );
      }
      edit.cooldown_days = cooldownDays;
    }
  }

  return NextResponse.json(bulkEditPosts(edit), { status: 200 });
}
