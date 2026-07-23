import { NextRequest, NextResponse } from "next/server";
import {
  getChannel,
  getPeriod,
  getPost,
  listTags,
  setCaptionVariants,
  setPostPeriods,
  setPostTags,
  setPostTargets,
  updatePostContentModel,
} from "@/lib/queries";
import type { ContentKind, ContentStatus, PeriodMode } from "@/lib/types";
import { parseTagIds } from "@/lib/content-model-validation";

export const runtime = "nodejs";

/**
 * Save a post's content-model fields in one call: kind/status/cooldown, target
 * accounts, green/blackout period links, and caption variants. Used by the composer
 * and any future edit UI (B2). Every field is optional — send only what changed.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const postId = Number(id);
  if (!getPost(postId)) {
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
  if (Object.keys(contentFields).length > 0) {
    updatePostContentModel(postId, contentFields);
  }

  if ("target_channel_ids" in body) {
    if (!Array.isArray(body.target_channel_ids)) {
      return NextResponse.json(
        { error: "target_channel_ids must be an array." },
        { status: 400 }
      );
    }
    const targetChannelIds = body.target_channel_ids.map(Number);
    const badChannelIds = targetChannelIds.filter((cid: number) => !getChannel(cid));
    if (badChannelIds.length > 0) {
      return NextResponse.json(
        { error: `Unknown channel(s): ${badChannelIds.join(", ")}.` },
        { status: 400 }
      );
    }
    setPostTargets(postId, targetChannelIds);
  }

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
    setPostPeriods(postId, links);
  }

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
    setCaptionVariants(postId, variants);
  }

  if ("tag_ids" in body) {
    const validTagIds = new Set(listTags().map((t) => t.id));
    const tagIds = parseTagIds(body.tag_ids, (id) => validTagIds.has(id));
    if (tagIds === "invalid") {
      return NextResponse.json({ error: "Invalid tag_ids." }, { status: 400 });
    }
    setPostTags(postId, tagIds ?? []);
  }

  return NextResponse.json({ ok: true });
}
