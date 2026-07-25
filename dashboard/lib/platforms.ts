// The one place that knows which platforms exist and how to name them. Everything that
// renders or validates a platform reads from here, so adding one is a single edit
// instead of nine — and an unrecognised value degrades visibly rather than silently
// reading as Instagram or Facebook.

// supportsText / maxCarousel / maxCaptionChars mirror worker/clients.py's PLATFORM_CAPS.
// The worker is authoritative and re-validates every publish against its own copy — this
// copy exists only to shape the composer (disable/hint fields before a request is ever sent).
export const PLATFORMS = [
  {
    value: "instagram",
    label: "Instagram",
    badge: "IG",
    accountIdLabel: "IG user id",
    // Instagram published via a linked Facebook Page stores that Page id separately.
    usesLinkedPage: true,
    supportsText: false,
    maxCarousel: 10,
    maxCaptionChars: null,
  },
  {
    value: "facebook",
    label: "Facebook Page",
    badge: "FB",
    accountIdLabel: "Page id",
    usesLinkedPage: false,
    supportsText: false,
    maxCarousel: 10,
    maxCaptionChars: null,
  },
  {
    value: "threads",
    label: "Threads",
    badge: "TH",
    accountIdLabel: "Threads user id",
    usesLinkedPage: false,
    supportsText: true,
    maxCarousel: 20,
    maxCaptionChars: 500,
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

// Default false is the safe direction: worst case the composer is over-cautious about an
// unrecognised platform, rather than offering a text post to something that can't publish one.
export function supportsText(value: string): boolean {
  return BY_VALUE.get(value)?.supportsText ?? false;
}

export function maxCaptionChars(value: string): number | null {
  return BY_VALUE.get(value)?.maxCaptionChars ?? null;
}
