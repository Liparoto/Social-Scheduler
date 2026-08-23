// Display helpers. All timestamps are stored UTC; we render them in a channel's
// own IANA timezone (per-channel timezone is a core requirement).

/**
 * Format a date through Intl, then pin the punctuation Intl itself keeps changing.
 *
 * Node and the browser ship DIFFERENT ICU/CLDR versions, and CLDR has twice changed how
 * a date is joined to a time. The same call therefore renders differently on the two
 * sides of a hydration boundary, and React reacts by throwing the server HTML away and
 * re-rendering the entire tree on the client:
 *
 *   1. The connector flipped from ", " to " at "  — "Aug 23, 6:00 PM" vs "Aug 23 at 6:00 PM".
 *   2. The space before AM/PM became U+202F (narrow no-break space) — which looks
 *      IDENTICAL in the error message React prints, so the diff reads as two matching
 *      strings and tells you nothing.
 *
 * Rebuilding from formatToParts and normalising the literals pins both, so the output is
 * byte-identical whatever ICU either end happens to have — including HTML Next cached
 * under a previously-installed Node, which is a third way the two can disagree. Only the
 * literals are touched; the locale-, calendar-, and timezone-aware values still come
 * straight from Intl.
 */
export function formatParts(
  d: Date,
  opts: Intl.DateTimeFormatOptions
): string {
  const pin = (literal: string) =>
    literal
      .replace(/\s+at\s+/i, ", ") // CLDR's date/time connector
      .replace(/[\u00a0\u202f\u2009]/g, " "); // any flavour of no-break/thin space
  return new Intl.DateTimeFormat("en-US", opts)
    .formatToParts(d)
    .map((p) => (p.type === "literal" ? pin(p.value) : p.value))
    .join("");
}

export function formatInTz(
  iso: string | null,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {}
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatParts(d, {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  });
}

export function tzAbbrev(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * URL for a `<video>` preview thumbnail, with a media-fragment (`#t=`) seek target.
 *
 * Chrome decodes and paints the first frame of a `preload="metadata"` video for free;
 * Safari paints nothing until the video is played or explicitly seeked. Appending
 * `#t=<seconds>` tells the browser to seek there on load, which forces Safari to
 * decode and paint that frame too.
 *
 * Uses the asset's chosen cover frame (`cover_frame_ms`) when there is one, so the
 * thumbnail shows the actual frame the owner picked for the Reel's cover. Falls back
 * to a small non-zero offset when no cover has been chosen (or it's exactly frame 0) —
 * `#t=0` does not reliably force a seek in Safari.
 */
export function videoPreviewSrc(assetId: number, coverFrameMs?: number | null): string {
  const seconds = coverFrameMs ? coverFrameMs / 1000 : 0.1;
  return `/api/media/${assetId}#t=${seconds}`;
}

export function humanBytes(n: number | null): string {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Plain-English description of a period's window. Shared by the server list and the
// client form's live preview, so both read identically.
export function describePeriod(p: {
  recurs_yearly: number;
  start_month: number | null;
  start_day: number | null;
  end_month: number | null;
  end_day: number | null;
  start_date: string | null;
  end_date: string | null;
}): string {
  if (p.recurs_yearly) {
    const sm = p.start_month ?? 1, sd = p.start_day ?? 1;
    const em = p.end_month ?? 1, ed = p.end_day ?? 1;
    const s = `${MONTHS_SHORT[sm - 1]} ${sd}`;
    if (sm === em && sd === ed) return `${s}, every year`; // single day
    const e = `${MONTHS_SHORT[em - 1]} ${ed}`;
    const wraps = sm * 100 + sd > em * 100 + ed; // start after end -> spans the New Year
    return `${s} – ${e}, every year${wraps ? " (spans the New Year)" : ""}`;
  }
  const fmt = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" })
          .format(new Date(`${iso}T00:00:00`))
      : "—";
  if (p.start_date && p.start_date === p.end_date) return fmt(p.start_date); // single day
  return `${fmt(p.start_date)} – ${fmt(p.end_date)}`;
}

// Deterministic per-channel accent so each account reads as its own lane.
// Golden-angle spacing keeps adjacent channel ids well-separated in hue.
export function channelHue(channelId: number): number {
  return Math.round((channelId * 137.508 + 200) % 360);
}

/**
 * `colorHue` is the owner's explicit pick (channels.color_hue). Omit it (or pass
 * `null`/`undefined`) to fall back to the deterministic per-id hue — this is what makes
 * an unconfigured channel look exactly as it did before this picker existed.
 */
export function channelColor(
  channelId: number,
  colorHue?: number | null
): { fg: string; bg: string; dot: string } {
  const h = typeof colorHue === "number" ? colorHue : channelHue(channelId);
  return {
    fg: `hsl(${h} 55% 32%)`,
    bg: `hsl(${h} 60% 95%)`,
    dot: `hsl(${h} 60% 45%)`,
  };
}

/**
 * A send the worker has tried and could not get out, which will nonetheless try again.
 *
 * Derived rather than stored, so nothing in the schema or the worker has to change: the
 * three facts are already in the row. All three are required —
 *   - still `scheduled`  : 'failed' is terminal and already reads as urgent
 *   - has a `last_error` : it actually attempted and something went wrong
 *   - overdue            : a future send carrying a stale error is simply waiting
 *
 * Without the overdue check a rescheduled send would keep wearing the badge purely
 * because an old error string is still on the row.
 *
 * Callers pass `now` so the queue's rows and the overview's counter judge against one
 * instant, instead of each re-reading the clock and disagreeing at a tick boundary.
 */
export function isBlocked(
  p: { status: string; last_error: string | null; scheduled_at: string },
  now: number = Date.now()
): boolean {
  if (p.status !== "scheduled") return false;
  if (!p.last_error) return false;
  const due = Date.parse(p.scheduled_at);
  // An unparseable date must not silently mark everything blocked.
  return Number.isFinite(due) && due <= now;
}

/**
 * Preset swatches for the accent-colour picker — evenly spread (36° apart) so every
 * choice stays visually distinct, with a human name for the accessible label/tooltip
 * (a hue number reads worse than a colour name).
 */
export const COLOR_SWATCHES: { hue: number; name: string }[] = [
  { hue: 0, name: "Red" },
  { hue: 36, name: "Orange" },
  { hue: 72, name: "Gold" },
  { hue: 108, name: "Lime" },
  { hue: 144, name: "Green" },
  { hue: 180, name: "Teal" },
  { hue: 216, name: "Blue" },
  { hue: 252, name: "Indigo" },
  { hue: 288, name: "Violet" },
  { hue: 324, name: "Pink" },
];
