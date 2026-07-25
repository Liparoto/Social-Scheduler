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
  updatePostContentModel,
} from "@/lib/queries";
import type { ContentKind, ContentStatus, PeriodMode } from "@/lib/types";
import { parseTagIds } from "@/lib/content-model-validation";
import { maxCaptionChars, platformLabel } from "@/lib/platforms";

export const runtime = "nodejs";

/** Mirrors worker/publisher.py's _select_caption (minus rotation, which doesn't matter
 *  for a length check): platform-specific variant if present, else the generic ("Any")
 *  one, else the post's base caption. */
function selectCaptionForPlatform(
  platform: string,
  variants: { platform: string | null; body: string }[],
  fallback: string | null
): string {
  if (variants.length > 0) {
    const specific = variants.find((v) => v.platform === platform);
    if (specific) return specific.body;
    const generic = variants.find((v) => v.platform === null);
    if (generic) return generic.body;
  }
  return fallback ?? "";
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
  // targeted channel's actual caption length fit its platform's limit? Threads' 500-char
  // cap is the only one today, but this reads any platform's maxCaptionChars.
  const effectiveTargetIds = targetChannelIds ?? getPostTargets(postId);
  const effectiveVariants =
    captionVariants ?? getCaptionVariants(postId).map((v) => ({ platform: v.platform, body: v.body }));
  const overLimit: { platform: string; length: number; limit: number }[] = [];
  for (const cid of effectiveTargetIds) {
    const channel = getChannel(cid);
    if (!channel) continue; // already rejected above if it came from this request
    const limit = maxCaptionChars(channel.platform);
    if (limit === null) continue;
    const caption = selectCaptionForPlatform(channel.platform, effectiveVariants, post.caption);
    if (caption.length > limit) {
      overLimit.push({ platform: channel.platform, length: caption.length, limit });
    }
  }
  if (overLimit.length > 0) {
    const names = overLimit
      .map((v) => `${platformLabel(v.platform)} (${v.length}/${v.limit})`)
      .join(", ");
    return NextResponse.json(
      { error: `Caption is over the limit for: ${names}.` },
      { status: 400 }
    );
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
  }
  if (tagIds !== undefined) {
    setPostTags(postId, tagIds);
  }

  return NextResponse.json({ ok: true });
}
