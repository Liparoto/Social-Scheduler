// Display helpers. All timestamps are stored UTC; we render them in a channel's
// own IANA timezone (per-channel timezone is a core requirement).

export function formatInTz(
  iso: string | null,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {}
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  }).format(d);
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
export function channelColor(channelId: number): { fg: string; bg: string; dot: string } {
  const h = channelHue(channelId);
  return {
    fg: `hsl(${h} 55% 32%)`,
    bg: `hsl(${h} 60% 95%)`,
    dot: `hsl(${h} 60% 45%)`,
  };
}
