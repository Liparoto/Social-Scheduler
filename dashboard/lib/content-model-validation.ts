import "server-only";
import type { Period, PeriodMode } from "./types";

/**
 * Shared shape-validation for the optional content-model fields the composer sends
 * (`caption_variants`, `period_links`). Both API routes (`/api/posts`, `/api/posts/draft`)
 * use these so the rules stay identical. Returns "invalid" on malformed input, undefined
 * when the field was omitted (so callers can distinguish "not sent" from "sent empty"),
 * or the parsed/deduped array otherwise.
 */

export type CaptionVariantOut = { platform: string | null; body: string; sort_order: number };

export function parseCaptionVariants(input: unknown): CaptionVariantOut[] | "invalid" | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return "invalid";
  const out: CaptionVariantOut[] = [];
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    if (!v || typeof v !== "object") return "invalid";
    const body = (v as Record<string, unknown>).body;
    const platform = (v as Record<string, unknown>).platform;
    if (typeof body !== "string" || body.trim().length === 0) return "invalid";
    if (platform !== null && platform !== undefined && typeof platform !== "string") return "invalid";
    if (typeof platform === "string" && platform.trim().length === 0) return "invalid";
    out.push({ platform: platform ? platform : null, body: body.trim(), sort_order: i });
  }
  return out;
}

export type PeriodLinkOut = { periodId: number; mode: PeriodMode };

export function parsePeriodLinks(
  input: unknown,
  getPeriod: (id: number) => Period | undefined
): PeriodLinkOut[] | "invalid" | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return "invalid";
  const seen = new Set<string>();
  const out: PeriodLinkOut[] = [];
  for (const link of input) {
    if (!link || typeof link !== "object") return "invalid";
    const periodId = (link as Record<string, unknown>).periodId;
    const mode = (link as Record<string, unknown>).mode;
    if (typeof periodId !== "number" || !Number.isInteger(periodId)) return "invalid";
    if (mode !== "green" && mode !== "blackout") return "invalid";
    if (!getPeriod(periodId)) return "invalid";
    const key = `${periodId}:${mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ periodId, mode });
  }
  return out;
}

export function parseTagIds(
  input: unknown,
  tagExists: (id: number) => boolean
): number[] | "invalid" | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return "invalid";
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of input) {
    if (typeof id !== "number" || !Number.isInteger(id)) return "invalid";
    if (!tagExists(id)) return "invalid";
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
