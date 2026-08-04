import { NextRequest, NextResponse } from "next/server";
import {
  getCaptionVariants,
  getChannel,
  getPeriod,
  getPost,
  getPostTargets,
  listTags,
  setCaptionVariants,
  setPostPeriods,
  setPostTags,
  setPostTargets,
  updatePostCaption,
  updatePostContentModel,
} from "@/lib/queries";
import type { ContentKind, ContentStatus, PeriodMode } from "@/lib/types";
import { parseTagIds } from "@/lib/content-model-validation";
import { captionLimitError } from "@/lib/caption-limits";
import { syncedPostCaption } from "@/lib/quick-edit-captions";

export const runtime = "nodejs";

/**
 * Read a post's caption variants.
 *
 * Exists for the Library's quick-edit dialog, which opens one post at a time. The
 * alternative was carrying every post's variants in the Library list query, but captions
 * are the bulk of a post's text and per-platform variants multiply it — a few hundred KB
 * shipped on every Library load to serve a dialog that needs one post. A read on the
 * resource that already owns the write is the cheaper shape, and it adds no second write
 * path, which is the thing that actually had to stay singular.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const postId = Number(id);
  const post = getPost(postId);
  if (!post) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  return NextResponse.json({
    caption_variants: getCaptionVariants(postId).map((v) => ({
      platform: v.platform,
      body: v.body,
      sort_order: v.sort_order,
    })),
  });
}

/**
 * Save a post's content-model fields in one call: kind/status/cooldown, target
 * accounts, green/blackout period links, and caption variants. Used by the composer
 * and any future edit UI (B2). Every field is optional — send only what changed.
 *
 * Every field is parsed/validated FIRST, with nothing written until all of it checks
 * out — including a cross-field check (caption length vs. the platforms this post is
 * targeted at) that needs the parsed target_channel_ids and caption_variants together,
 * whichever of the two arrived in this request and whichever is left over from before.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const postId = Number(id);
  const post = getPost(postId);
  if (!post) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  const body = await req.json();

  const contentFields: Partial<{
    content_kind: ContentKind;
    content_status: ContentStatus;
    cooldown_days: number | null;
  }> = {};
  if ("content_kind" in body) {
    if (body.content_kind !== "one_time" && body.content_kind !== "evergreen") {
      return NextResponse.json(
        { error: "content_kind must be one_time or evergreen." },
        { status: 400 }
      );
    }
    contentFields.content_kind = body.content_kind;
  }
  if ("content_status" in body) {
    if (!["draft", "ready", "retired"].includes(body.content_status)) {
      return NextResponse.json(
        { error: "content_status must be draft, ready, or retired." },
        { status: 400 }
      );
    }
    contentFields.content_status = body.content_status;
  }
  if ("cooldown_days" in body) {
    if (body.cooldown_days === null || body.cooldown_days === undefined) {
      contentFields.cooldown_days = null;
    } else {
      const n = Number(body.cooldown_days);
      if (!Number.isInteger(n) || n < 0) {
        return NextResponse.json(
          { error: "cooldown_days must be a non-negative integer or null." },
          { status: 400 }
        );
      }
      contentFields.cooldown_days = n;
    }
  }

  let targetChannelIds: number[] | undefined;
  if ("target_channel_ids" in body) {
    if (!Array.isArray(body.target_channel_ids)) {
      return NextResponse.json(
        { error: "target_channel_ids must be an array." },
        { status: 400 }
      );
    }
    const parsed = body.target_channel_ids.map(Number);
    const badChannelIds = parsed.filter((cid: number) => !getChannel(cid));
    if (badChannelIds.length > 0) {
      return NextResponse.json(
        { error: `Unknown channel(s): ${badChannelIds.join(", ")}.` },
        { status: 400 }
      );
    }
    targetChannelIds = parsed;
  }

  let periodLinks: { periodId: number; mode: PeriodMode }[] | undefined;
  if ("period_links" in body) {
    if (!Array.isArray(body.period_links)) {
      return NextResponse.json({ error: "period_links must be an array." }, { status: 400 });
    }
    const links: { periodId: number; mode: PeriodMode }[] = [];
    const seen = new Set<string>();
    for (const link of body.period_links) {
      const mode = link?.mode;
      if (mode !== "green" && mode !== "blackout") {
        return NextResponse.json(
          { error: "period_links[].mode must be green or blackout." },
          { status: 400 }
        );
      }
      const periodId = Number(link.periodId ?? link.period_id);
      if (!Number.isInteger(periodId)) {
        return NextResponse.json(
          { error: "period_links[].periodId is required." },
          { status: 400 }
        );
      }
      if (!getPeriod(periodId)) {
        return NextResponse.json(
          { error: `Unknown period ${periodId}.` },
          { status: 400 }
        );
      }
      const key = `${periodId}:${mode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ periodId, mode });
    }
    periodLinks = links;
  }

  let captionVariants: { platform: string | null; body: string; sort_order: number }[] | undefined;
  if ("caption_variants" in body) {
    if (!Array.isArray(body.caption_variants)) {
      return NextResponse.json(
        { error: "caption_variants must be an array." },
        { status: 400 }
      );
    }
    const variants = body.caption_variants.map(
      (v: { platform?: string | null; body?: string; sort_order?: number }, i: number) => ({
        platform: v.platform || null,
        body: String(v.body || "").trim(),
        sort_order: typeof v.sort_order === "number" ? v.sort_order : i,
      })
    );
    if (variants.some((v: { body: string }) => !v.body)) {
      return NextResponse.json(
        { error: "Caption variants cannot be empty." },
        { status: 400 }
      );
    }
    captionVariants = variants;
  }

  let tagIds: number[] | undefined;
  if ("tag_ids" in body) {
    const validTagIds = new Set(listTags().map((t) => t.id));
    const parsed = parseTagIds(body.tag_ids, (tid) => validTagIds.has(tid));
    if (parsed === "invalid") {
      return NextResponse.json({ error: "Invalid tag_ids." }, { status: 400 });
    }
    tagIds = parsed ?? [];
  }

  // Cross-field check: whatever this post's targets and caption variants end up being
  // (this request's values where sent, the existing saved ones otherwise), does every
  // targeted channel's actual caption length fit its platform's limit for this post's
  // type? This route doesn't change post_type/assets, so post.post_type (unaffected by
  // this request) is the right postType to check against.
  const effectiveTargetIds = targetChannelIds ?? getPostTargets(postId);
  const effectiveVariants =
    captionVariants ?? getCaptionVariants(postId).map((v) => ({ platform: v.platform, body: v.body }));
  const effectiveChannels = effectiveTargetIds
    .map((cid) => getChannel(cid))
    .filter((c): c is NonNullable<typeof c> => !!c); // already rejected above if it came from this request
  const captionError = captionLimitError(effectiveChannels, effectiveVariants, post.caption, post.post_type);
  if (captionError) {
    return NextResponse.json({ error: captionError }, { status: 400 });
  }

  // All validated — now write.
  if (Object.keys(contentFields).length > 0) {
    updatePostContentModel(postId, contentFields);
  }
  if (targetChannelIds !== undefined) {
    setPostTargets(postId, targetChannelIds);
  }
  if (periodLinks !== undefined) {
    setPostPeriods(postId, periodLinks);
  }
  if (captionVariants !== undefined) {
    setCaptionVariants(postId, captionVariants);
    // Keep posts.caption — what the Library card shows, what the caption search filters
    // on, and the publish fallback — in step with what was just saved. undefined means
    // "leave it": a post whose variants are all platform-specific still needs that column
    // as the fallback for any targeted platform without a variant of its own.
    const syncedCaption = syncedPostCaption(captionVariants);
    if (syncedCaption !== undefined) {
      updatePostCaption(postId, syncedCaption);
    }
  }
  if (tagIds !== undefined) {
    setPostTags(postId, tagIds);
  }

  return NextResponse.json({ ok: true });
}
