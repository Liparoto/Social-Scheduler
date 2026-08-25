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
// supportsStory mirrors publisher._validate's story rule: Instagram is the only platform
// with a Stories surface, so it is the only one that offers the Story chip. A Story is a
// DESTINATION, not a post type — see docs/design-instagram-stories.md.
// supportsImages mirrors PlatformCaps.supports_images: TikTok is the only platform that
// cannot publish a still image, and the worker's _validate is the real gate.
// videoSurfaces mirrors worker/clients.py's PlatformCaps.video_surfaces: the list of
// destinations (feed, story, reel, ...) a platform's publish path accepts a post_type
// 'video' post for. An empty list means that adapter has no video publish path at all.
// Unlike the nine worker registries, THIS copy has no assert guarding it against
// drifting out of sync — a future adapter that grows a video surface has to be updated
// here by hand too.
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
    videoSurfaces: ["feed", "story"],
    supportsImages: true,
    supportsStory: true,
    maxCarousel: 10,
    captionChars: {},
    supportsAvatar: true,
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
    videoSurfaces: ["feed", "reel"],
    supportsImages: true,
    supportsStory: false,
    maxCarousel: 10,
    captionChars: {},
    supportsAvatar: true,
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
    videoSurfaces: [],
    supportsImages: true,
    supportsStory: false,
    maxCarousel: 20,
    captionChars: { text: 500, single: 500, carousel: 500 },
    supportsAvatar: true,
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
    videoSurfaces: [],
    supportsImages: true,
    supportsStory: false,
    maxCarousel: 10,
    captionChars: { text: 2000, single: 2000, carousel: 2000 },
    // A webhook has no insights/analytics API at all — there is nothing to ever fetch.
    supportsAvatar: false,
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
    videoSurfaces: [],
    supportsImages: true,
    supportsStory: false,
    maxCarousel: 10,
    captionChars: { text: 4096, single: 1024, carousel: 1024 },
    // The Bot API exposes no metrics/insights endpoint at all.
    supportsAvatar: false,
    supportsMetrics: false,
  },
  {
    value: "tiktok",
    label: "TikTok",
    badge: "TT",
    accountIdLabel: "TikTok open id",
    usesLinkedPage: false,
    usesAccountId: true,
    supportsText: false,
    videoSurfaces: ["feed"],
    // The only platform here that cannot take a still image. TikTok's photo endpoint
    // accepts PULL_FROM_URL only, from a DNS-verified domain — and this install serves
    // assets from an ephemeral trycloudflare URL it does not own.
    supportsImages: false,
    supportsStory: false,
    // No multi-image format to cap, hence 0 rather than a number that implies one exists.
    maxCarousel: 0,
    // Empty because the inbox upload endpoint has NO caption field at all — the creator
    // writes the caption in the TikTok app. Nothing to enforce, rather than a limit we
    // happen not to know.
    captionChars: {},
    supportsAvatar: true,
    supportsMetrics: true,
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

// Platforms whose account id can be read back from the access token itself, via a single
// identity call (see lib/account-lookup.ts). Only the three Meta-family platforms can:
// TikTok's open id already arrives with its OAuth callback, Discord has no account id
// field at all, and a Telegram chat id genuinely cannot be derived from a bot token —
// somebody has to message the bot before it knows the chat exists.
//
// Default FALSE for an unrecognised platform, which is the safe direction here: the cost
// is a missing convenience button, whereas the opposite default offers a lookup that can
// only ever fail and makes a working setup look broken.
const ID_LOOKUP = new Set(["instagram", "threads", "facebook"]);

export function supportsIdLookup(value: string): boolean {
  return ID_LOOKUP.has(value);
}

// Default false is the safe direction: worst case the composer is over-cautious about an
// unrecognised platform, rather than offering a text post to something that can't publish one.
export function supportsText(value: string): boolean {
  return BY_VALUE.get(value)?.supportsText ?? false;
}

// Mirrors worker/clients.py's PlatformCaps.video_surfaces. As the comment at the top of
// this file warns, THIS copy has no assert guarding it against drift — it must be updated
// by hand whenever the worker's set changes.
export function videoSurfaces(value: string): string[] {
  return [...(BY_VALUE.get(value)?.videoSurfaces ?? [])];
}

// Default false is the safe direction: worst case the composer is over-cautious about an
// unrecognised platform, rather than offering a video post to something that can't publish
// one on any surface.
export function supportsVideo(value: string): boolean {
  return videoSurfaces(value).length > 0;
}

// Default TRUE for an unrecognised platform — and note this is the OPPOSITE direction to
// supportsVideo above, deliberately. Nearly every platform takes images, so the risky
// mistake here is hiding image posting from one that supports it; offering an image post
// to one that refuses it merely earns a clear error from the worker.
// Mirrors worker/avatars.py's _URL_FETCHERS: a platform whose entry there is None has no
// account photo this worker can read. It matters beyond decoration — channels_needing_
// avatars() excludes those platforms in SQL, and the exclusion sits OUTSIDE the
// "avatar_refresh_requested = 1" branch, so a refresh requested for one of them is never
// picked up AND never cleared. The button would stick on "Requested" forever, so it must
// not be offered at all.
//
// Default TRUE for an unrecognised platform, matching supportsMetrics: worst case an
// always-empty button, rather than hiding a capability a platform actually has.
// Platforms whose credentials come from an OAuth round trip rather than a pasted token.
// They need a RECONNECT affordance on the channel card, not just a Connect button in the
// add form: the access token expires on its own, the refresh token expires yearly, and
// granting a new scope means re-authorizing an account that already exists. Without it
// the only route back is the add-channel form, which looks like it would create a second
// channel — so the fix for a broken connection is hidden behind an action that reads as
// the wrong one.
export function usesOAuth(value: string): boolean {
  return value === "tiktok";
}

/** Where to send someone to (re)authorize an OAuth platform. */
export function oauthConnectPath(value: string): string | null {
  return usesOAuth(value) ? `/api/channels/${value}/authorize` : null;
}

export function supportsAvatar(value: string): boolean {
  return BY_VALUE.get(value)?.supportsAvatar ?? true;
}

export function supportsImages(value: string): boolean {
  return BY_VALUE.get(value)?.supportsImages ?? true;
}

// Default FALSE for an unrecognised platform — the safe direction here: worst case the
// Story chip is hidden for a platform that could take one, rather than offering a
// destination the worker would refuse terminally.
export function supportsStory(value: string): boolean {
  return BY_VALUE.get(value)?.supportsStory ?? false;
}

/** Does ANY of these platforms have a Stories surface?
 *
 *  A channel group fills as one unit, and a story lane on a mixed group reaches only its
 *  story-capable members — so the group offers a Story lane as soon as one member can
 *  take one. Unknown platforms are false, matching supportsStory's safe default.
 */
export function anySupportsStory(platforms: string[]): boolean {
  return platforms.some(supportsStory);
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

// ---- Delivery state ---------------------------------------------------------------
// TikTok is the only platform here that DELIVERS rather than publishes: the worker hands
// the video to the creator's TikTok inbox and the creator finishes the post in the app.
// publications.status stays 'posted' — the worker's job did succeed — and what happened
// afterwards lives in publications.delivery_state.
//
// This is the single place that turns that column into words, so the queue, the post page
// and anything added later cannot describe the same row differently.
export interface DeliveryLike {
  platform: string;
  status: string;
  delivery_state: string | null;
}

/**
 * Extra wording for a send whose platform does not publish on command, or null when there
 * is nothing more to say than the status already says.
 *
 * Returns null for any send that did not reach 'posted'. That case matters: delivery_state
 * is only meaningful once the worker succeeded, and a failed row must keep saying failed
 * rather than borrowing a label left over from an earlier attempt.
 */
export function deliveryLabel(row: DeliveryLike): string | null {
  if (row.status !== "posted" || !row.delivery_state) return null;
  switch (row.delivery_state) {
    case "inbox":
      return "In your TikTok inbox — open TikTok to publish";
    case "published":
      return "Live on TikTok";
    case "gave_up":
      // Deliberately neither "failed" nor "live": the video was delivered and we never saw
      // it go public. Claiming either would be a guess.
      return "Delivered — publication unconfirmed";
    default:
      // An unrecognised state must look wrong on screen rather than quietly read as
      // published — the same reasoning as platformLabel's conspicuous fallback.
      return `Unknown delivery state: ${row.delivery_state}`;
  }
}

/**
 * True when a send was handed over but never published, so there is nothing on the
 * platform to link to, measure, or call "posted".
 *
 * One function rather than repeated `=== "inbox" || === "gave_up"` checks, because four
 * different places depend on it and they must not drift: the queue badge and the post
 * page's badge (neither may say "Posted"), the "Refresh metrics" button (which must not
 * offer a fetch that requestMetricsRefresh will refuse for want of a remote_post_id), and
 * the metrics wording.
 */
export function isAwaitingPublication(deliveryState: string | null | undefined): boolean {
  return deliveryState === "inbox" || deliveryState === "gave_up";
}

// ---- Post-type / channel compatibility -------------------------------------------
// The single place that decides "can this post_type go to this channel" client- and
// server-side. 'text' (caption, no media) is gated on supportsText, 'video' is gated on
// supportsVideo — every other post_type carries assets and every platform we know about
// accepts images/carousels. The worker (worker/publisher.py's _validate) is the real
// gate and re-checks this at publish time; this exists purely so the UI/API can reject
// (or hide) the mistake before it ever becomes a publication that dies terminally after
// being "scheduled".
export interface ChannelLikeForCompat {
  id: number;
  platform: string;
  account_name: string;
}

export function incompatibleChannelsForPostType<T extends ChannelLikeForCompat>(
  postType: string,
  channels: T[]
): T[] {
  if (postType === "text") return channels.filter((c) => !supportsText(c.platform));
  if (postType === "video") return channels.filter((c) => !supportsVideo(c.platform));
  return [];
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
export type PostCompatReason = "text" | "carousel" | "video" | "images";

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
    // A video post is caught here rather than left to the worker (same reasoning as
    // carousel below): only platforms with a non-empty videoSurfaces list have a
    // publish path for post_type='video' — everything else would die terminally
    // after being "scheduled".
    if (postType === "video") {
      if (!supportsVideo(c.platform)) out.push({ channel: c, reason: "video" });
      continue;
    }
    // Video-only platforms are caught BEFORE the carousel size rule below, or TikTok
    // would report "allows at most 0 images per carousel" — technically true and
    // completely unhelpful.
    if (postType === "single" || postType === "carousel") {
      if (!supportsImages(c.platform)) {
        out.push({ channel: c, reason: "images" });
        continue;
      }
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
          : issue.reason === "images"
            ? `${describeChannel(issue.channel)} publishes video only — it can't take an image post.`
          : `${describeChannel(issue.channel)} allows at most ${maxCarousel(
              issue.channel.platform
            )} images per carousel (this post has ${assetCount}).`
    )
    .join(" ");
}
