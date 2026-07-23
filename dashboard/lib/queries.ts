import "server-only";
import { getDb, nowIso } from "./db";
import type { Asset, Channel, Post, Publication, PostType } from "./types";

// ---- Channels -------------------------------------------------------------------
export function getChannels(): Channel[] {
  return getDb()
    .prepare("SELECT * FROM channels ORDER BY is_active DESC, account_name ASC")
    .all() as Channel[];
}

export function getActiveChannels(): Channel[] {
  return getDb()
    .prepare("SELECT * FROM channels WHERE is_active = 1 ORDER BY account_name ASC")
    .all() as Channel[];
}

export function getChannel(id: number): Channel | undefined {
  return getDb().prepare("SELECT * FROM channels WHERE id = ?").get(id) as
    | Channel
    | undefined;
}

export interface CreateChannelInput {
  platform: "instagram" | "facebook";
  account_name: string;
  business_label?: string;
  timezone: string;
  remote_account_id?: string;
  linked_page_id?: string;
  access_token?: string;
  requires_approval?: boolean;
}

export function createChannel(input: CreateChannelInput): number {
  const info = getDb()
    .prepare(
      `INSERT INTO channels
        (platform, account_name, business_label, timezone, remote_account_id,
         linked_page_id, access_token, requires_approval)
       VALUES (@platform, @account_name, @business_label, @timezone, @remote_account_id,
         @linked_page_id, @access_token, @requires_approval)`
    )
    .run({
      platform: input.platform,
      account_name: input.account_name,
      business_label: input.business_label || null,
      timezone: input.timezone,
      remote_account_id: input.remote_account_id || null,
      linked_page_id: input.linked_page_id || null,
      access_token: input.access_token || null,
      requires_approval: input.requires_approval ? 1 : 0,
    });
  return Number(info.lastInsertRowid);
}

export function updateChannel(
  id: number,
  fields: Partial<{
    account_name: string;
    business_label: string | null;
    timezone: string;
    remote_account_id: string | null;
    linked_page_id: string | null;
    access_token: string | null;
    requires_approval: number;
    is_active: number;
  }>
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE channels SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: nowIso() });
}

// ---- Assets ---------------------------------------------------------------------
export function getAssetByHash(hash: string): Asset | undefined {
  return getDb()
    .prepare("SELECT * FROM assets WHERE content_hash = ?")
    .get(hash) as Asset | undefined;
}

export function getAsset(id: number): Asset | undefined {
  return getDb().prepare("SELECT * FROM assets WHERE id = ?").get(id) as
    | Asset
    | undefined;
}

export interface InsertAssetInput {
  content_hash: string;
  media_kind: "image" | "video";
  original_filename: string | null;
  storage_path: string;
  public_url: string | null;
  thumbnail_path: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  byte_size: number | null;
}

/** Insert an asset, or return the existing one if the content hash already exists (dedup). */
export function upsertAssetByHash(input: InsertAssetInput): { asset: Asset; deduped: boolean } {
  const existing = getAssetByHash(input.content_hash);
  if (existing) return { asset: existing, deduped: true };
  const info = getDb()
    .prepare(
      `INSERT INTO assets
        (content_hash, media_kind, original_filename, storage_path, public_url,
         thumbnail_path, mime_type, width, height, byte_size)
       VALUES (@content_hash, @media_kind, @original_filename, @storage_path, @public_url,
         @thumbnail_path, @mime_type, @width, @height, @byte_size)`
    )
    .run(input);
  return {
    asset: getAsset(Number(info.lastInsertRowid))!,
    deduped: false,
  };
}

export function recentAssets(limit = 60): Asset[] {
  return getDb()
    .prepare("SELECT * FROM assets ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit) as Asset[];
}

// ---- Posts + publications (the scheduling write) --------------------------------
export interface CreatePostInput {
  caption: string;
  first_comment: string;
  post_type: PostType;
  asset_ids: number[]; // in carousel order
  channel_ids: number[];
  scheduled_at: string; // ISO UTC
  created_by?: string;
}

/**
 * Create a post with its ordered assets and one publication PER target channel.
 * All in a single transaction — a post either lands fully or not at all.
 * Returns the new post id and the created publication ids.
 */
export function createPostWithPublications(
  input: CreatePostInput
): { postId: number; publicationIds: number[] } {
  const db = getDb();
  const tx = db.transaction((data: CreatePostInput) => {
    const postInfo = db
      .prepare(
        `INSERT INTO posts (caption, first_comment, post_type, status, created_by)
         VALUES (@caption, @first_comment, @post_type, 'scheduled', @created_by)`
      )
      .run({
        caption: data.caption || null,
        first_comment: data.first_comment || null,
        post_type: data.post_type,
        created_by: data.created_by || null,
      });
    const postId = Number(postInfo.lastInsertRowid);

    const linkAsset = db.prepare(
      "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, ?)"
    );
    data.asset_ids.forEach((assetId, i) => linkAsset.run(postId, assetId, i));

    const insertPub = db.prepare(
      `INSERT INTO publications (post_id, channel_id, scheduled_at, status, created_by)
       VALUES (?, ?, ?, ?, ?)`
    );
    const publicationIds: number[] = [];
    for (const channelId of data.channel_ids) {
      const ch = getChannel(channelId);
      const status = ch?.requires_approval ? "pending_approval" : "scheduled";
      const info = insertPub.run(
        postId,
        channelId,
        data.scheduled_at,
        status,
        data.created_by || null
      );
      publicationIds.push(Number(info.lastInsertRowid));
    }
    return { postId, publicationIds };
  });
  return tx(input);
}

// ---- Overview -------------------------------------------------------------------
export interface PublicationRow extends Publication {
  post_caption: string | null;
  post_type: PostType;
  channel_name: string;
  channel_platform: string;
  channel_timezone: string;
  asset_count: number;
  first_asset_id: number | null;
}

export function getPublicationsOverview(limit = 200): PublicationRow[] {
  return getDb()
    .prepare(
      `SELECT
         pub.*,
         p.caption   AS post_caption,
         p.post_type AS post_type,
         c.account_name AS channel_name,
         c.platform     AS channel_platform,
         c.timezone     AS channel_timezone,
         (SELECT COUNT(*) FROM post_assets pa WHERE pa.post_id = p.id) AS asset_count,
         (SELECT pa.asset_id FROM post_assets pa
            WHERE pa.post_id = p.id ORDER BY pa.sort_order ASC LIMIT 1) AS first_asset_id
       FROM publications pub
       JOIN posts p    ON p.id = pub.post_id
       JOIN channels c ON c.id = pub.channel_id
       ORDER BY
         CASE pub.status WHEN 'failed' THEN 0 WHEN 'publishing' THEN 1
                         WHEN 'scheduled' THEN 2 ELSE 3 END,
         pub.scheduled_at ASC
       LIMIT ?`
    )
    .all(limit) as PublicationRow[];
}

/** Reset a failed publication so the worker retries it on the next poll. */
export function retryPublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications
       SET status = 'scheduled', next_retry_at = NULL, last_error = NULL,
           attempt_count = 0, updated_at = @now
       WHERE id = @id AND status = 'failed'`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}

export function approvePublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications SET status = 'scheduled', updated_at = @now
       WHERE id = @id AND status = 'pending_approval'`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}
