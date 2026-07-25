// The one place that knows which platforms exist and how to name them. Everything that
// renders or validates a platform reads from here, so adding one is a single edit
// instead of nine — and an unrecognised value degrades visibly rather than silently
// reading as Instagram or Facebook.

export const PLATFORMS = [
  {
    value: "instagram",
    label: "Instagram",
    badge: "IG",
    accountIdLabel: "IG user id",
    // Instagram published via a linked Facebook Page stores that Page id separately.
    usesLinkedPage: true,
  },
  {
    value: "facebook",
    label: "Facebook Page",
    badge: "FB",
    accountIdLabel: "Page id",
    usesLinkedPage: false,
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
