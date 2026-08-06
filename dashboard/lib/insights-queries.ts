import "server-only";
import { getDb } from "./db";
import type { DayRow, PostRow } from "./insights";

/*
  Reads for the Insights hub. Kept out of queries.ts, which is already large and serves
  the compose/schedule path — these answer a different question against different tables
  and share none of its helpers.

  Every query is scoped to one channel. There is no cross-account aggregate anywhere:
  summing reach across two accounts double-counts the people who follow both, and no
  honest total exists for it.
*/

export interface InsightsChannel {
  id: number;
  platform: string;
  account_name: string;
  business_label: string | null;
  timezone: string;
  color_hue: number | null;
  avatar_path: string | null;
  media_synced_at: string | null;
  insights_synced_at: string | null;
  insights_error: string | null;
  insights_refresh_requested: number;
  media_backfill_complete: number;
  bpp_strong_pct: number;
  bpp_broad_pct: number;
}

const CHANNEL_FIELDS = `
  id, platform, account_name, business_label, timezone, color_hue, avatar_path,
  media_synced_at, insights_synced_at, insights_error, insights_refresh_requested,
  media_backfill_complete, bpp_strong_pct, bpp_broad_pct
`;

export function getInsightsChannels(): InsightsChannel[] {
  return getDb()
    .prepare(
      `SELECT ${CHANNEL_FIELDS} FROM channels
       WHERE is_active = 1 ORDER BY platform ASC, account_name ASC`,
    )
    .all() as InsightsChannel[];
}

export function getInsightsChannel(id: number): InsightsChannel | null {
  return (getDb()
    .prepare(`SELECT ${CHANNEL_FIELDS} FROM channels WHERE id = ?`)
    .get(id) as InsightsChannel | undefined) ?? null;
}

const DAY_FIELDS = `
  day, followers_count, follows_count, media_count, reach, views, profile_views,
  accounts_engaged, total_interactions, likes, comments, saves, shares, replies,
  website_clicks, follows_gained
`;

/** Daily account series, oldest first. `days` bounds how far back to read. */
export function getAccountDays(channelId: number, days = 400): DayRow[] {
  return getDb()
    .prepare(
      `SELECT ${DAY_FIELDS} FROM account_metrics
       WHERE channel_id = ? ORDER BY day DESC LIMIT ?`,
    )
    .all(channelId, days)
    .reverse() as DayRow[];
}

/**
 * Every post on the account with its most recent metrics reading.
 *
 * The correlated subquery picks the latest snapshot per post rather than joining the
 * whole media_metrics history — a plain join would return one row per reading and
 * multiply a post's presence in the leaderboard by how often it has been refreshed.
 *
 * Deleted posts are excluded: they cannot be opened and ranking them wastes the space.
 * Their history stays in the table for the day-series totals, which is why the flag
 * exists rather than a delete.
 */
export function getChannelPosts(channelId: number, limit = 500): PostRow[] {
  return getDb()
    .prepare(
      `
      SELECT
        rm.id, rm.remote_post_id, rm.permalink, rm.caption, rm.thumbnail_url,
        rm.media_type, rm.media_product_type, rm.published_at, rm.publication_id,
        rm.thumbnail_path,
        mm.reach, mm.likes, mm.comments, mm.saves, mm.shares, mm.impressions
      FROM remote_media rm
      LEFT JOIN media_metrics mm ON mm.id = (
        SELECT id FROM media_metrics
        WHERE remote_media_id = rm.id
        ORDER BY fetched_at DESC, id DESC
        LIMIT 1
      )
      WHERE rm.channel_id = ? AND rm.is_deleted = 0
      ORDER BY rm.published_at DESC
      LIMIT ?
      `,
    )
    .all(channelId, limit) as PostRow[];
}

export interface DemographicRow {
  audience: string;
  breakdown: string;
  dimension: string;
  value: number;
}

/**
 * The most recent day's demographics for a channel.
 *
 * Pinned to a single day so the breakdowns are internally consistent: mixing yesterday's
 * age split with today's country split would produce totals that disagree with each
 * other for no visible reason.
 */
export function getDemographics(channelId: number): DemographicRow[] {
  return getDb()
    .prepare(
      `
      SELECT audience, breakdown, dimension, value
      FROM audience_demographics
      WHERE channel_id = ?
        AND day = (SELECT MAX(day) FROM audience_demographics WHERE channel_id = ?)
      `,
    )
    .all(channelId, channelId) as DemographicRow[];
}

export function pickDemographics(
  rows: DemographicRow[],
  audience: string,
  breakdown: string,
): { dimension: string; value: number }[] {
  return rows
    .filter((r) => r.audience === audience && r.breakdown === breakdown)
    .map((r) => ({ dimension: r.dimension, value: r.value }));
}

export interface ChannelCounts {
  posts: number;
  withMetrics: number;
  ours: number;
}

export function getChannelCounts(channelId: number): ChannelCounts {
  return getDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS posts,
        SUM(EXISTS (SELECT 1 FROM media_metrics mm WHERE mm.remote_media_id = rm.id)) AS withMetrics,
        SUM(rm.publication_id IS NOT NULL) AS ours
      FROM remote_media rm
      WHERE rm.channel_id = ? AND rm.is_deleted = 0
      `,
    )
    .get(channelId) as ChannelCounts;
}

/**
 * Ask the worker to re-sync this channel now.
 *
 * Sets a flag rather than doing the work: the dashboard has no API credentials and no
 * business making Graph calls. Same request/clear handshake as avatar refresh — the
 * worker picks it up and clears it, so a flag left set means the worker is not running.
 */
export function requestInsightsRefresh(channelId: number): void {
  getDb()
    .prepare("UPDATE channels SET insights_refresh_requested = 1 WHERE id = ?")
    .run(channelId);
}

/**
 * Mark or unmark a post as a BPP — one of the owner's keepers, worth reposting.
 *
 * Always a person's decision. Nothing in this app sets this flag automatically: the
 * numbers surface candidates, a human decides, which is the whole point of the design
 * (see docs/design-bpp-recycling.md).
 */
export function setPostBpp(postId: number, isBpp: boolean): boolean {
  const info = getDb()
    .prepare(
      "UPDATE posts SET is_bpp = @flag, bpp_marked_at = @at, updated_at = @at WHERE id = @id",
    )
    .run({ id: postId, flag: isBpp ? 1 : 0, at: isBpp ? new Date().toISOString() : null });
  return info.changes > 0;
}

export interface BppPool {
  size: number;
  /** Marked posts that this unit could actually send — targeted here and still ready. */
  usable: number;
}

/**
 * How many keepers are marked, and how many this channel can actually use.
 *
 * The two differ and the difference matters: a post marked from another account's
 * leaderboard is in the pool but cannot go out here, so a cadence set against the raw
 * count would quietly under-deliver.
 */
export function getBppPool(channelId: number): BppPool {
  const db = getDb();
  const size = (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE is_bpp = 1").get() as {
    n: number;
  }).n;
  const usable = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts p
        WHERE p.is_bpp = 1 AND p.content_status = 'ready'
          AND EXISTS (SELECT 1 FROM post_targets pt
                       WHERE pt.post_id = p.id AND pt.channel_id = ? AND pt.surface = 'feed')`,
    )
    .get(channelId) as { n: number }).n;
  return { size, usable };
}

/** Which library post a synced Instagram post corresponds to, when we published it. */
export function getLibraryPostIds(channelId: number): Record<number, number> {
  const rows = getDb()
    .prepare(
      `SELECT rm.id AS remote_id, pub.post_id, p.is_bpp
         FROM remote_media rm
         JOIN publications pub ON pub.id = rm.publication_id
         JOIN posts p ON p.id = pub.post_id
        WHERE rm.channel_id = ?`,
    )
    .all(channelId) as { remote_id: number; post_id: number; is_bpp: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.remote_id] = r.post_id;
  return out;
}

export function getBppFlags(): Record<number, boolean> {
  const rows = getDb().prepare("SELECT id, is_bpp FROM posts WHERE is_bpp = 1").all() as {
    id: number;
  }[];
  const out: Record<number, boolean> = {};
  for (const r of rows) out[r.id] = true;
  return out;
}

export interface BppEntry {
  post_id: number;
  caption: string | null;
  post_type: string;
  content_status: string;
  marked_at: string | null;
  /** Most recent real send, across every channel. Null = marked but never re-posted yet. */
  last_posted: string | null;
  asset_id: number | null;
  /** Channels this post can actually go out on. */
  targets: string;
}

/**
 * The BPP pool, in rotation order — whose turn is next, first.
 *
 * Ordered by last send with nulls first, matching worker/autofill.py's `bpp_pool`: a
 * marked post that has not gone out since being marked is the stalest of all. The order
 * shown here IS the order it will be used, so "up next" is a fact rather than a guess.
 */
export function getBppEntries(): BppEntry[] {
  return getDb()
    .prepare(
      `
      SELECT
        p.id AS post_id, p.caption, p.post_type, p.content_status,
        p.bpp_marked_at AS marked_at,
        (SELECT MAX(pub.published_at) FROM publications pub
          WHERE pub.post_id = p.id AND pub.status = 'posted' AND pub.is_dry_run = 0
        ) AS last_posted,
        (SELECT pa.asset_id FROM post_assets pa
          WHERE pa.post_id = p.id ORDER BY pa.sort_order LIMIT 1) AS asset_id,
        (SELECT GROUP_CONCAT(c.account_name, ', ') FROM post_targets pt
           JOIN channels c ON c.id = pt.channel_id
          WHERE pt.post_id = p.id AND pt.surface = 'feed') AS targets
      FROM posts p
      WHERE p.is_bpp = 1
      ORDER BY (last_posted IS NOT NULL), last_posted ASC, p.id ASC
      `,
    )
    .all() as BppEntry[];
}

export interface BppUnit {
  id: number;
  label: string;
  everyDays: number;
  usable: number;
}

/** Each active channel's cadence and how much of the pool it can actually send. */
export function getBppUnits(): BppUnit[] {
  const rows = getDb()
    .prepare(
      `SELECT id, account_name, platform, bpp_every_days FROM channels WHERE is_active = 1
        ORDER BY platform, account_name`,
    )
    .all() as { id: number; account_name: string; platform: string; bpp_every_days: number }[];
  return rows.map((r) => ({
    id: r.id,
    label: `${r.account_name} · ${r.platform}`,
    everyDays: r.bpp_every_days ?? 0,
    usable: getBppPool(r.id).usable,
  }));
}
