/*
  Insights — pure shaping of metric rows into what the hub renders.

  No database and no React here, so every rule below is directly testable: which day a
  range starts on, what counts as a real change, how a null differs from a zero.

  The null/zero distinction runs through all of it. A platform that does not report a
  metric stores NULL, and NULL must never render as 0 — "Threads has no reach" and
  "reach was zero" are different facts, and collapsing them is how a dashboard starts
  lying quietly.
*/

export interface DayRow {
  day: string;
  followers_count: number | null;
  follows_count: number | null;
  media_count: number | null;
  reach: number | null;
  views: number | null;
  profile_views: number | null;
  accounts_engaged: number | null;
  total_interactions: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  replies: number | null;
  website_clicks: number | null;
  follows_gained: number | null;
}

export type MetricKey = keyof Omit<DayRow, "day">;

export const RANGES = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "365d", label: "1 year", days: 365 },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export function rangeDays(key: string): number {
  return RANGES.find((r) => r.key === key)?.days ?? 30;
}

/** ISO day `n` days before `day`, month and year boundaries included. */
export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Sum a metric across rows, preserving "no data at all" as null.
 *
 * Returning 0 for a metric the platform never reported would render as a real zero and
 * be indistinguishable from a genuinely quiet week. Only rows that actually carry a
 * number contribute, and if none do, the answer is null.
 */
export function sumMetric(rows: DayRow[], metric: MetricKey): number | null {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = row[metric];
    if (value !== null && value !== undefined) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** The most recent non-null value — for snapshot metrics like followers_count, where
 *  summing across days would be meaningless (it is a level, not a flow). */
export function latestMetric(rows: DayRow[], metric: MetricKey): number | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = rows[i][metric];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/**
 * Percentage change, or null when it cannot honestly be computed.
 *
 * Null when either side is missing (no basis for comparison) AND when the previous
 * period is 0: every change from zero is +infinity, and rendering that as "+100%" or
 * "+∞%" tells the reader nothing true.
 */
export function pctDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export interface Kpi {
  key: MetricKey;
  label: string;
  value: number | null;
  delta: number | null;
  /** Snapshot metrics are read as a level, flows are summed. */
  kind: "flow" | "level";
  /**
   * How many days in the window actually carried a value, against how many it spans.
   *
   * Without this the row lies by omission. Instagram backfills reach for a full year but
   * only reports views for today and yesterday, so a "past 30 days" column can hold a
   * 30-day sum of reach beside a 2-day sum of views — and a reader comparing them
   * concludes views are lower than reach, which is false. The UI states the coverage
   * whenever it is short, so a partial number is never mistaken for a whole one.
   */
  daysWithData: number;
  windowDays: number;
}

/**
 * The headline row: each metric for the selected window, against the window before it.
 *
 * The comparison window is the same length immediately prior, so "last 30 days" is
 * measured against the 30 before that rather than against a calendar month — a calendar
 * comparison would make every 31-day month look like growth.
 */
export function buildKpis(
  rows: DayRow[],
  metrics: { key: MetricKey; label: string; kind: "flow" | "level" }[],
  days: number,
): Kpi[] {
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const end = sorted.at(-1)?.day;
  if (!end) {
    return metrics.map((m) => ({
      ...m, value: null, delta: null, daysWithData: 0, windowDays: days,
    }));
  }
  const currentStart = shiftDay(end, -(days - 1));
  const previousStart = shiftDay(currentStart, -days);

  const current = sorted.filter((r) => r.day >= currentStart);
  const previous = sorted.filter((r) => r.day >= previousStart && r.day < currentStart);

  return metrics.map((m) => {
    const pick = m.kind === "level" ? latestMetric : sumMetric;
    const value = pick(current, m.key);
    const prior = pick(previous, m.key);
    const daysWithData = current.filter(
      (r) => r[m.key] !== null && r[m.key] !== undefined,
    ).length;
    // A delta between two partly-covered windows compares different numbers of days and
    // reads as a trend that never happened, so it is withheld unless BOTH windows are
    // fully covered.
    const priorDays = previous.filter(
      (r) => r[m.key] !== null && r[m.key] !== undefined,
    ).length;
    const comparable =
      m.kind === "level" || (daysWithData >= days && priorDays >= days);
    return {
      ...m,
      value,
      delta: comparable ? pctDelta(value, prior) : null,
      daysWithData,
      windowDays: days,
    };
  });
}

/** Rows within the window ending at the newest day present, oldest first. */
export function windowRows(rows: DayRow[], days: number): DayRow[] {
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const end = sorted.at(-1)?.day;
  if (!end) return [];
  const start = shiftDay(end, -(days - 1));
  return sorted.filter((r) => r.day >= start);
}

/**
 * Fill missing days with null-valued rows so a chart's x-axis is real time.
 *
 * Without this, a gap in collection (worker stopped for two days) draws as a straight
 * line between the days either side, which reads as "nothing happened" rather than
 * "nothing was recorded". Those are different, and only one of them is the account's
 * fault.
 */
export function densify(rows: DayRow[], days: number): DayRow[] {
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const end = sorted.at(-1)?.day;
  if (!end) return [];
  const byDay = new Map(sorted.map((r) => [r.day, r]));
  const out: DayRow[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = shiftDay(end, -i);
    out.push(byDay.get(day) ?? (EMPTY_DAY(day) as DayRow));
  }
  return out;
}

const EMPTY_DAY = (day: string): DayRow => ({
  day,
  followers_count: null, follows_count: null, media_count: null, reach: null,
  views: null, profile_views: null, accounts_engaged: null, total_interactions: null,
  likes: null, comments: null, saves: null, shares: null, replies: null,
  website_clicks: null, follows_gained: null,
});

export interface PostRow {
  id: number;
  remote_post_id: string;
  permalink: string | null;
  caption: string | null;
  thumbnail_url: string | null;
  media_type: string | null;
  media_product_type: string | null;
  published_at: string | null;
  publication_id: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  impressions: number | null;
}

export const POST_SORTS = [
  { key: "reach", label: "Reach" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "saves", label: "Saves" },
  { key: "shares", label: "Shares" },
  { key: "engagement", label: "Engagement" },
  { key: "published_at", label: "Newest" },
] as const;

export type PostSortKey = (typeof POST_SORTS)[number]["key"];

/** Likes + comments + saves + shares. Null only when the platform reported none of them. */
export function engagementOf(post: PostRow): number | null {
  const parts = [post.likes, post.comments, post.saves, post.shares];
  const present = parts.filter((p): p is number => p !== null && p !== undefined);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/**
 * Sort posts, always pushing nulls to the bottom.
 *
 * A post whose metric is unknown must not outrank one with a real number in either
 * direction — it is missing, not best and not worst.
 */
export function sortPosts(posts: PostRow[], key: PostSortKey): PostRow[] {
  const valueOf = (p: PostRow): number | string | null =>
    key === "engagement" ? engagementOf(p)
      : key === "published_at" ? p.published_at
        : p[key];

  return [...posts].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return typeof av === "string" || typeof bv === "string"
      ? String(bv).localeCompare(String(av))
      : (bv as number) - (av as number);
  });
}

/** Human label for the platform's own media vocabulary, which we store verbatim. */
export function postKindLabel(post: PostRow): string {
  if (post.media_product_type === "REELS") return "Reel";
  if (post.media_product_type === "STORY") return "Story";
  if (post.media_type === "CAROUSEL_ALBUM") return "Carousel";
  if (post.media_type === "VIDEO") return "Video";
  if (post.media_type === "TEXT_POST") return "Text";
  return "Image";
}

export function postKinds(posts: PostRow[]): string[] {
  return [...new Set(posts.map(postKindLabel))].sort();
}

export interface Bucket {
  dimension: string;
  value: number;
  share: number;
}

/**
 * Top `limit` buckets by value, with each one's share of the WHOLE breakdown.
 *
 * Share is computed against the full total, not the truncated top-N: showing five
 * countries that sum to 100% when they are really 61% of the audience would overstate
 * every one of them.
 */
export function topBuckets(
  rows: { dimension: string; value: number }[],
  limit = 5,
): { buckets: Bucket[]; total: number; remainder: number } {
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const buckets = sorted.slice(0, limit).map((r) => ({
    dimension: r.dimension,
    value: r.value,
    share: total > 0 ? r.value / total : 0,
  }));
  const shown = buckets.reduce((sum, b) => sum + b.value, 0);
  return { buckets, total, remainder: total - shown };
}

/** Age buckets sort by their lower bound, not alphabetically — "13-17" must precede
 *  "25-34", and string order happens to agree until a bucket like "65+" appears. */
export function sortAgeBuckets(rows: { dimension: string; value: number }[]) {
  return [...rows].sort(
    (a, b) => parseInt(a.dimension, 10) - parseInt(b.dimension, 10),
  );
}

export const GENDER_LABELS: Record<string, string> = {
  F: "Women",
  M: "Men",
  U: "Not specified",
};

export interface HourCell {
  weekday: number;
  hour: number;
  posts: number;
  avgEngagement: number | null;
}

/**
 * Engagement by weekday × hour, from this account's own posts.
 *
 * More useful than the platform's version because it reflects what actually happened
 * here. Cells with too few posts return null rather than an average of one, which would
 * present a single lucky post as a reliable time to publish.
 */
export function bestTimeGrid(
  posts: PostRow[],
  timeZone: string,
  minPosts = 2,
): HourCell[] {
  const totals = new Map<string, { sum: number; count: number }>();

  for (const post of posts) {
    if (!post.published_at) continue;
    const engagement = engagementOf(post);
    if (engagement === null) continue;
    const { weekday, hour } = localParts(post.published_at, timeZone);
    const key = `${weekday}:${hour}`;
    const cell = totals.get(key) ?? { sum: 0, count: 0 };
    cell.sum += engagement;
    cell.count += 1;
    totals.set(key, cell);
  }

  const cells: HourCell[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = totals.get(`${weekday}:${hour}`);
      cells.push({
        weekday,
        hour,
        posts: cell?.count ?? 0,
        avgEngagement:
          cell && cell.count >= minPosts ? cell.sum / cell.count : null,
      });
    }
  }
  return cells;
}

/**
 * Weekday and hour of an instant in a given zone.
 *
 * Uses Intl rather than the Date getters because "when did this post go out" only means
 * anything in the account's own timezone — a 9am local post is a 4pm UTC post, and
 * grouping by UTC would scatter a consistent posting habit across two different hours.
 */
export function localParts(iso: string, timeZone: string): { weekday: number; hour: number } {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Intl renders midnight as "24" in some locales/zones under hour12:false.
  const hour = parseInt(hourRaw, 10) % 24;
  return { weekday: Math.max(0, WEEKDAYS.indexOf(weekdayName)), hour };
}

/** Compact number for dense readouts: 13727 -> "13.7k". Exact below 1000. */
export function compact(value: number | null): string {
  if (value === null || value === undefined) return "—";
  const abs = Math.abs(value);
  if (abs < 1000) return String(value);
  if (abs < 1_000_000) {
    const k = value / 1000;
    // One decimal up to 100k: a follower count is a headline number, and rounding 13,727
    // to "14k" throws away the precision someone is actually watching move.
    return `${abs < 100_000 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Full number with thousands separators, or an em dash for "not reported". */
export function exact(value: number | null): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

export function formatDelta(delta: number | null): string | null {
  if (delta === null) return null;
  const rounded = Math.abs(delta) >= 10 ? Math.round(delta) : Number(delta.toFixed(1));
  return `${delta > 0 ? "+" : ""}${rounded}%`;
}
