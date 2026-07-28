// The one place that knows which platforms exist and how to name them. Everything that
// renders or validates a platform reads from here, so adding one is a single edit
// instead of nine — and an unrecognised value degrades visibly rather than silently
// reading as Instagram or Facebook.

// supportsText / maxCarousel / captionChars mirror worker/clients.py's PLATFORM_CAPS.
// The worker is authoritative and re-validates every publish against its own copy — this
// copy exists only to shape the composer (disable/hint fields before a request is ever sent).
//
// captionChars is per-post-type (not a single number) because Telegram's limit depends on
// whether media is attached: 4096 chars for a text-only message, 1024 once a photo/carousel
// is attached. A single maxCaptionChars would either wrongly reject a long text post or
// wrongly accept a too-long media caption. Empty {} means "no known limit enforced here"
// (Instagram/Facebook — same as the old `null`).
//
// usesAccountId is false only for Discord: its credential is a webhook URL, which is both
// the address and the secret, so there is no separate account id to collect.
// supportsVideo mirrors the worker's actual publish paths — worker/publisher.py's
// _publish_instagram is the authority (it has a 'reel' branch; _publish_facebook,
// _publish_threads, _publish_discord, _publish_telegram do not, and fall through to
// "adapter has no publish path for post_type 'reel'"). Unlike the nine worker
// registries, THIS copy has no assert guarding it against drifting out of sync — if a
// future adapter grows a reel path, this flag has to be updated here by hand too.
export const PLATFORMS = [
  {
    value: "instagram",
    label: "Instagram",
    badge: "IG",
    accountIdLabel: "IG user id",
    // Instagram published via a linked Facebook Page stores that Page id separately.
    usesLinkedPage: true,
    usesAccountId: true,
    supportsText: false,
    supportsVideo: true,
    maxCarousel: 10,
    captionChars: {},
    supportsMetrics: true,
  },
  {
    value: "facebook",
    label: "Facebook Page",
    badge: "FB",
    accountIdLabel: "Page id",
    usesLinkedPage: false,
    usesAccountId: true,
    supportsText: false,
    supportsVideo: false,
    maxCarousel: 10,
    captionChars: {},
    supportsMetrics: true,
  },
  {
    value: "threads",
    label: "Threads",
    badge: "TH",
    accountIdLabel: "Threads user id",
    usesLinkedPage: false,
    usesAccountId: true,
    supportsText: true,
    supportsVideo: false,
    maxCarousel: 20,
    captionChars: { text: 500, single: 500, carousel: 500 },
    supportsMetrics: true,
  },
  {
    value: "discord",
    label: "Discord",
    badge: "DC",
    accountIdLabel: "N/A",
    usesLinkedPage: false,
    // Its only credential is a webhook URL — no separate account id field at all.
    usesAccountId: false,
    supportsText: true,
    supportsVideo: false,
    maxCarousel: 10,
    captionChars: { text: 2000, single: 2000, carousel: 2000 },
    // A webhook has no insights/analytics API at all — there is nothing to ever fetch.
    supportsMetrics: false,
  },
  {
    value: "telegram",
    label: "Telegram",
    badge: "TG",
    accountIdLabel: "Channel (@name or chat id)",
    usesLinkedPage: false,
    usesAccountId: true,
    supportsText: true,
    supportsVideo: false,
    maxCarousel: 10,
    captionChars: { text: 4096, single: 1024, carousel: 1024 },
    // The Bot API exposes no metrics/insights endpoint at all.
    supportsMetrics: false,
  },
] as const;

export type Platform = (typeof PLATFORMS)[number]["value"];

const BY_VALUE = new Map(PLATFORMS.map((p) => [p.value as string, p]));

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && BY_VALUE.has(value);
}

// Fallbacks below are deliberately conspicuous: an unknown platform should look wrong,
// not quietly borrow another platform's label.
export function platformLabel(value: string): string {
  return BY_VALUE.get(value)?.label ?? value;
}

export function platformBadge(value: string): string {
  return BY_VALUE.get(value)?.badge ?? value.slice(0, 2).toUpperCase();
}

export function accountIdLabel(value: string): string {
  return BY_VALUE.get(value)?.accountIdLabel ?? "Account id";
}

export function usesLinkedPage(value: string): boolean {
  return BY_VALUE.get(value)?.usesLinkedPage ?? false;
}

// Default true is the safe direction for an unrecognised platform: it asks for an account
// id it might not need rather than silently dropping one it does.
export function usesAccountId(value: string): boolean {
  return BY_VALUE.get(value)?.usesAccountId ?? true;
}

// Default false is the safe direction: worst case the composer is over-cautious about an
// unrecognised platform, rather than offering a text post to something that can't publish one.
export function supportsText(value: string): boolean {
  return BY_VALUE.get(value)?.supportsText ?? false;
}

// Default false is the safe direction: worst case the composer is over-cautious about an
// unrecognised platform, rather than offering a Reel to something that can't publish video
// (worker/publisher.py's _publish_instagram is the only adapter with a 'reel' branch).
export function supportsVideo(value: string): boolean {
  return BY_VALUE.get(value)?.supportsVideo ?? false;
}

// Default true is the safe direction for an unrecognised platform: worst case it shows a
// "Refresh metrics" button / metrics strip that never produces a number, rather than
// hiding a real metrics capability an unrecognised platform might actually have.
export function supportsMetrics(value: string): boolean {
  return BY_VALUE.get(value)?.supportsMetrics ?? true;
}

// Per-post-type lookup — replaces the old single-number maxCaptionChars. Telegram is why:
// 4096 chars for a text post, 1024 once a photo/carousel is attached. Returns null when the
// platform has no known limit for that post type (Instagram/Facebook today, any post type
// not in a platform's captionChars map otherwise).
export function captionLimit(platform: string, postType: string): number | null {
  const chars = BY_VALUE.get(platform)?.captionChars as Record<string, number> | undefined;
  return chars?.[postType] ?? null;
}

// Default 10 (Instagram/Facebook's value) is the safe direction for an unrecognised
// platform: it under-promises rather than letting an unknown platform look infinitely
// permissive.
export function maxCarousel(value: string): number {
  return BY_VALUE.get(value)?.maxCarousel ?? 10;
}

// ---- Post-type / channel compatibility -------------------------------------------
// The single place that decides "can this post_type go to this channel" client- and
// server-side. Today only 'text' (caption, no media) is gated — every other post_type
// carries assets and every platform we know about accepts images/carousels. The worker
// (worker/publisher.py's _validate) is the real gate and re-checks this at publish
// time; this exists purely so the UI/API can reject (or hide) the mistake before it
// ever becomes a publication that dies terminally after being "scheduled".
export interface ChannelLikeForCompat {
  id: number;
  platform: string;
  account_name: string;
}

export function incompatibleChannelsForPostType<T extends ChannelLikeForCompat>(
  postType: string,
  channels: T[]
): T[] {
  if (postType !== "text") return [];
  return channels.filter((c) => !supportsText(c.platform));
}

/** "Account name (Platform)" — the consistent way to name an offending channel in an error. */
export function describeChannel(c: ChannelLikeForCompat): string {
  return `${c.account_name} (${platformLabel(c.platform)})`;
}

// ---- Post-type + asset-count / channel compatibility -----------------------------
// incompatibleChannelsForPostType above only ever gated 'text' vs. supportsText — every
// route that also needs to gate carousel size against maxCarousel used to hand-roll its
// own check, and one of those hand-rolled checks used Math.max (the MOST permissive
// selected channel) instead of Math.min (the strictest), which let a route accept a
// carousel guaranteed to fail on at least one of its own targets. This widened version
// is the one place that knows both rules, so every route enforces them identically.
export type PostCompatReason = "text" | "carousel" | "video";

export interface PostCompatIssue<T extends ChannelLikeForCompat = ChannelLikeForCompat> {
  channel: T;
  reason: PostCompatReason;
}

export function incompatibleChannelsForPost<T extends ChannelLikeForCompat>(
  postType: string,
  assetCount: number,
  channels: T[]
): PostCompatIssue<T>[] {
  const out: PostCompatIssue<T>[] = [];
  for (const c of channels) {
    if (postType === "text") {
      if (!supportsText(c.platform)) out.push({ channel: c, reason: "text" });
      continue;
    }
    // A reel is caught here rather than left to the worker (same reasoning as
    // carousel below): only Instagram has a publish path for post_type='reel'
    // (worker/publisher.py's _publish_instagram) — everything else would die
    // terminally after being "scheduled".
    if (postType === "reel") {
      if (!supportsVideo(c.platform)) out.push({ channel: c, reason: "video" });
      continue;
    }
    if (postType === "carousel" && assetCount > maxCarousel(c.platform)) {
      out.push({ channel: c, reason: "carousel" });
    }
  }
  return out;
}

/**
 * Renders incompatibleChannelsForPost's issues as one 400-ready message in the style the
 * routes already used ("<channel> can't publish a <type> post."), naming every offending
 * channel and, for a carousel, its actual limit. Returns null when everything fits.
 */
export function incompatiblePostError<T extends ChannelLikeForCompat>(
  postType: string,
  assetCount: number,
  channels: T[]
): string | null {
  const issues = incompatibleChannelsForPost(postType, assetCount, channels);
  if (issues.length === 0) return null;
  return issues
    .map((issue) =>
      issue.reason === "text"
        ? `${describeChannel(issue.channel)} can't publish a text post.`
        : issue.reason === "video"
          ? `${describeChannel(issue.channel)} can't publish a video/Reel.`
          : `${describeChannel(issue.channel)} allows at most ${maxCarousel(
              issue.channel.platform
            )} images per carousel (this post has ${assetCount}).`
    )
    .join(" ");
}
