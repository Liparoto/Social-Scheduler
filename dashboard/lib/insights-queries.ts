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
}

const CHANNEL_FIELDS = `
  id, platform, account_name, business_label, timezone, color_hue, avatar_path,
  media_synced_at, insights_synced_at, insights_error, insights_refresh_requested,
  media_backfill_complete
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
