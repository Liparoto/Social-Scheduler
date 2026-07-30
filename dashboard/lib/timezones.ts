// The timezone shortlist offered in the UI, plus IANA validation.
//
// Deliberately NOT `server-only` — this is imported by client components (the
// picker) and by server route handlers (validation) alike.

/**
 * The four continental US zones, in west-to-east reading order that matches how
 * people say them. These are shortcuts, not a whitelist: any valid IANA name can
 * still be typed in via the picker's "Custom" option, which is what makes the
 * repo usable by a clone outside the US.
 */
export const US_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific" },
];

const US_TIMEZONE_VALUES = new Set(US_TIMEZONES.map((t) => t.value));

export function isPresetTimezone(tz: string): boolean {
  return US_TIMEZONE_VALUES.has(tz);
}

/**
 * Is this a real IANA zone name?
 *
 * `Intl.DateTimeFormat` throws a RangeError on an unknown `timeZone`, which is
 * the whole check — no dependency, and it's the same engine that will later
 * format with it. This matters more than it looks: an unvalidated typo saved to
 * `channels.timezone` makes `formatInTz` throw during render, which takes out the
 * Channels and Queue pages rather than showing a bad value.
 */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}
