import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestTimeGrid, buildKpis, compact, densify, engagementOf, exact, formatDelta,
  latestMetric, pctDelta, postKindLabel, shiftDay, sortAgeBuckets, sortPosts, sumMetric,
  topBuckets, windowRows,
  type DayRow, type PostRow,
} from "./insights";

const day = (d: string, values: Partial<DayRow> = {}): DayRow => ({
  day: d,
  followers_count: null, follows_count: null, media_count: null, reach: null,
  views: null, profile_views: null, accounts_engaged: null, total_interactions: null,
  likes: null, comments: null, saves: null, shares: null, replies: null,
  website_clicks: null, follows_gained: null, lifetime_likes: null,
  ...values,
});

const post = (p: Partial<PostRow> = {}): PostRow => ({
  id: 1, remote_post_id: "r1", permalink: null, caption: null,
  thumbnail_url: null, thumbnail_path: null,
  media_type: "IMAGE", media_product_type: "FEED", published_at: "2026-08-01T17:00:00+00:00",
  publication_id: null, reach: null, likes: null, comments: null, saves: null,
  shares: null, impressions: null,
  ...p,
});

// ---- null vs zero ---------------------------------------------------------------

test("sumMetric returns null when no row reported the metric", () => {
  // Threads has no reach. Returning 0 would render as a real zero and be
  // indistinguishable from a genuinely quiet week.
  assert.equal(sumMetric([day("2026-08-01"), day("2026-08-02")], "reach"), null);
});

test("sumMetric counts a real zero", () => {
  assert.equal(sumMetric([day("2026-08-01", { reach: 0 })], "reach"), 0);
});

test("sumMetric adds only the days that carry a value", () => {
  const rows = [day("2026-08-01", { reach: 10 }), day("2026-08-02"), day("2026-08-03", { reach: 5 })];
  assert.equal(sumMetric(rows, "reach"), 15);
});

test("latestMetric takes the most recent non-null, not the last row", () => {
  const rows = [day("2026-08-01", { followers_count: 100 }), day("2026-08-02")];
  assert.equal(latestMetric(rows, "followers_count"), 100);
});

// ---- deltas ---------------------------------------------------------------------

test("pctDelta computes an ordinary change", () => {
  assert.equal(pctDelta(150, 100), 50);
});

test("pctDelta refuses to divide by a zero baseline", () => {
  // Every change from zero is infinite; "+100%" or "+∞%" would both be inventions.
  assert.equal(pctDelta(50, 0), null);
});

test("pctDelta is null when either side is missing", () => {
  assert.equal(pctDelta(null, 100), null);
  assert.equal(pctDelta(100, null), null);
});

test("formatDelta signs and rounds", () => {
  assert.equal(formatDelta(12.34), "+12%");
  assert.equal(formatDelta(-4.26), "-4.3%");
  assert.equal(formatDelta(null), null);
});

// ---- KPI coverage ---------------------------------------------------------------

const thirtyDays = (metric: keyof DayRow, from: string, count: number): DayRow[] =>
  Array.from({ length: count }, (_, i) =>
    day(shiftDay(from, -i), { [metric]: 10 } as Partial<DayRow>),
  );

test("a fully covered window reports full coverage and a delta", () => {
  const rows = thirtyDays("reach", "2026-08-05", 60);
  const [kpi] = buildKpis(rows, [{ key: "reach", label: "Reach", kind: "flow" }], 30);
  assert.equal(kpi.daysWithData, 30);
  assert.equal(kpi.windowDays, 30);
  assert.equal(kpi.value, 300);
  assert.equal(kpi.delta, 0, "same value in both windows is a 0% change, not null");
});

test("a metric reported for only two days reports partial coverage", () => {
  // Instagram backfills reach for a year but only reports views for today and
  // yesterday. Without coverage the row shows a 2-day sum under a 30-day heading and a
  // reader concludes views are lower than reach.
  const rows = [
    ...thirtyDays("reach", "2026-08-05", 30),
    day("2026-08-05", { reach: 10, views: 500 }),
  ];
  const [views] = buildKpis(rows, [{ key: "views", label: "Views", kind: "flow" }], 30);
  assert.equal(views.daysWithData, 1);
  assert.equal(views.windowDays, 30);
  assert.equal(views.value, 500);
});

test("a delta is withheld when either window is only partly covered", () => {
  // Comparing a 2-day sum against a 30-day sum reads as a collapse that never happened.
  const rows = [
    day("2026-07-01", { views: 100 }),
    ...thirtyDays("reach", "2026-08-05", 40),
    day("2026-08-05", { views: 500 }),
  ];
  const [views] = buildKpis(rows, [{ key: "views", label: "Views", kind: "flow" }], 30);
  assert.equal(views.delta, null);
});

test("buildKpis survives an account with no rows at all", () => {
  const [kpi] = buildKpis([], [{ key: "reach", label: "Reach", kind: "flow" }], 30);
  assert.deepEqual(
    { value: kpi.value, delta: kpi.delta, daysWithData: kpi.daysWithData },
    { value: null, delta: null, daysWithData: 0 },
  );
});

// ---- windows and gaps -----------------------------------------------------------

test("shiftDay crosses month and year boundaries", () => {
  assert.equal(shiftDay("2026-08-31", 1), "2026-09-01");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
});

test("windowRows ends at the newest day present, not at today", () => {
  const rows = [day("2026-07-01", { reach: 1 }), day("2026-07-10", { reach: 2 })];
  const out = windowRows(rows, 5);
  assert.deepEqual(out.map((r) => r.day), ["2026-07-10"]);
});

test("densify fills missing days with nulls so a gap stays visible", () => {
  // A collection gap must not draw as a straight line between the days either side —
  // "nothing was recorded" and "nothing happened" are different facts.
  const rows = [day("2026-08-01", { reach: 5 }), day("2026-08-03", { reach: 7 })];
  const out = densify(rows, 3);
  assert.deepEqual(out.map((r) => r.day), ["2026-08-01", "2026-08-02", "2026-08-03"]);
  assert.equal(out[1].reach, null);
});

// ---- posts ----------------------------------------------------------------------

test("engagementOf sums the parts the platform reported", () => {
  assert.equal(engagementOf(post({ likes: 10, comments: 2, saves: 1, shares: 0 })), 13);
});

test("engagementOf is null when the platform reported none of them", () => {
  assert.equal(engagementOf(post()), null);
});

test("sorting pushes unknown metrics to the bottom, never the top", () => {
  // A post whose reach is unknown is missing, not best and not worst.
  const posts = [
    post({ id: 1, reach: null }),
    post({ id: 2, reach: 500 }),
    post({ id: 3, reach: 100 }),
  ];
  assert.deepEqual(sortPosts(posts, "reach").map((p) => p.id), [2, 3, 1]);
});

test("sorting by newest orders by published_at descending", () => {
  const posts = [
    post({ id: 1, published_at: "2026-01-01T00:00:00+00:00" }),
    post({ id: 2, published_at: "2026-08-01T00:00:00+00:00" }),
  ];
  assert.deepEqual(sortPosts(posts, "published_at").map((p) => p.id), [2, 1]);
});

test("post kinds read from the platform's own vocabulary", () => {
  assert.equal(postKindLabel(post({ media_product_type: "REELS" })), "Reel");
  assert.equal(postKindLabel(post({ media_type: "CAROUSEL_ALBUM" })), "Carousel");
  assert.equal(postKindLabel(post()), "Image");
});

// ---- demographics ---------------------------------------------------------------

test("bucket shares are of the whole breakdown, not of the shown top-N", () => {
  // Showing two countries as 100% when they are really 60% of the audience would
  // overstate both.
  const rows = [
    { dimension: "US", value: 60 },
    { dimension: "MX", value: 20 },
    { dimension: "BR", value: 20 },
  ];
  const { buckets, remainder, total } = topBuckets(rows, 2);
  assert.equal(total, 100);
  assert.equal(remainder, 20);
  assert.equal(buckets[0].share, 0.6);
  assert.equal(buckets[1].share, 0.2);
});

test("age buckets sort by their lower bound", () => {
  const rows = [
    { dimension: "65+", value: 1 },
    { dimension: "13-17", value: 2 },
    { dimension: "25-34", value: 3 },
  ];
  assert.deepEqual(
    sortAgeBuckets(rows).map((r) => r.dimension),
    ["13-17", "25-34", "65+"],
  );
});

// ---- best time ------------------------------------------------------------------

test("best-time cells need more than one post before they claim an average", () => {
  // One lucky post is not a reliable time to publish.
  const posts = [post({ published_at: "2026-08-03T17:00:00+00:00", likes: 100 })];
  const grid = bestTimeGrid(posts, "America/Los_Angeles", 2);
  assert.equal(grid.every((c) => c.avgEngagement === null), true);
  assert.equal(grid.find((c) => c.posts === 1)?.posts, 1, "the post is still counted");
});

test("best-time groups by the account's local hour, not UTC", () => {
  // 17:00 UTC is 10:00 in Los Angeles. Grouping by UTC would scatter a consistent
  // posting habit across two different hours.
  const posts = [
    post({ id: 1, published_at: "2026-08-03T17:00:00+00:00", likes: 10 }),
    post({ id: 2, published_at: "2026-08-10T17:00:00+00:00", likes: 20 }),
  ];
  const grid = bestTimeGrid(posts, "America/Los_Angeles", 2);
  const scored = grid.filter((c) => c.avgEngagement !== null);
  assert.equal(scored.length, 1);
  assert.equal(scored[0].hour, 10);
  assert.equal(scored[0].weekday, 1, "both dates are Mondays");
  assert.equal(scored[0].avgEngagement, 15);
});

// ---- formatting -----------------------------------------------------------------

test("compact keeps a decimal below 100k so a follower count stays readable", () => {
  assert.equal(compact(13727), "13.7k");
  assert.equal(compact(999), "999");
  assert.equal(compact(250000), "250k");
  assert.equal(compact(1_500_000), "1.5M");
});

test("a missing value renders as an em dash, never as zero", () => {
  assert.equal(compact(null), "—");
  assert.equal(exact(null), "—");
  assert.equal(exact(0), "0");
});

// TikTok's counters are LEVELS, not flows. Summing daily snapshots of a lifetime total
// would add the same cumulative number to itself once per day and produce a figure that
// means nothing — this pins that the distinction actually works.

test("a level metric reads the standing total, not the sum of the window", () => {
  const rows = [
    day("2026-08-01", { followers_count: 400, lifetime_likes: 9000 }),
    day("2026-08-02", { followers_count: 410, lifetime_likes: 9100 }),
    day("2026-08-03", { followers_count: 412, lifetime_likes: 9310 }),
  ];
  const [followers, likes] = buildKpis(
    rows,
    [
      { key: "followers_count", label: "Followers", kind: "level" },
      { key: "lifetime_likes", label: "Total likes", kind: "level" },
    ],
    3,
  );
  assert.equal(followers.value, 412, "a level takes the latest reading");
  assert.equal(likes.value, 9310);
  // The sum would be 1222 and 27410 — both meaningless.
  assert.notEqual(followers.value, 1222);
});

test("lifetime likes never collide with the daily likes column", () => {
  const row = day("2026-08-03", { lifetime_likes: 9310 });
  assert.equal(row.likes, null, "daily likes stays empty for a platform that reports none");
  assert.equal(row.lifetime_likes, 9310);
});
