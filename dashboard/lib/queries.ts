import "server-only";
import { getDb, nowIso } from "./db";
import type {
  Asset,
  CaptionVariant,
  Channel,
  ContentKind,
  ContentStatus,
  Period,
  PeriodMode,
  Post,
  Publication,
  PostPublicationRow,
  PostType,
  Tag,
} from "./types";
import type { Platform } from "./platforms";

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
  platform: Platform;
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
    autofill_enabled: number;
    cadence_config: string | null;
    min_queue_depth: number;
    target_queue_depth: number;
    reuse_min_age_days: number;
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
  publish_path?: string | null;
  conform_mode?: "none" | "crop" | "pad";
  needs_review?: number;
}

/** Insert an asset, or return the existing one if the content hash already exists (dedup). */
export function upsertAssetByHash(input: InsertAssetInput): { asset: Asset; deduped: boolean } {
  const existing = getAssetByHash(input.content_hash);
  if (existing) return { asset: existing, deduped: true };
  const info = getDb()
    .prepare(
      `INSERT INTO assets
        (content_hash, media_kind, original_filename, storage_path, public_url,
         thumbnail_path, mime_type, width, height, byte_size,
         publish_path, conform_mode, needs_review)
       VALUES (@content_hash, @media_kind, @original_filename, @storage_path, @public_url,
         @thumbnail_path, @mime_type, @width, @height, @byte_size,
         @publish_path, @conform_mode, @needs_review)`
    )
    .run({
      ...input,
      publish_path: input.publish_path ?? null,
      conform_mode: input.conform_mode ?? "none",
      needs_review: input.needs_review ?? 0,
    });
  return {
    asset: getAsset(Number(info.lastInsertRowid))!,
    deduped: false,
  };
}

/** Dynamic SET, same pattern as updateChannel. Assets have no updated_at column. */
export function updateAssetConform(
  id: number,
  fields: Partial<{
    publish_path: string | null;
    conform_mode: "none" | "crop" | "pad";
    needs_review: number;
  }>
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE assets SET ${setClause} WHERE id = @id`)
    .run({ ...fields, id });
}

export function recentAssets(limit = 60): Asset[] {
  return getDb()
    .prepare("SELECT * FROM assets ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit) as Asset[];
}

/** A post's assets in carousel order (for the edit screen's read-only image strip). */
export function getPostAssets(postId: number): Asset[] {
  return getDb()
    .prepare(
      `SELECT a.* FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
        WHERE pa.post_id = ? ORDER BY pa.sort_order ASC`
    )
    .all(postId) as Asset[];
}

// ---- Posts + publications (the scheduling write) --------------------------------

/** Shared shape for the content-model side-tables a post can optionally arrive with. */
interface ContentModelInput {
  target_channel_ids?: number[];
  content_kind?: ContentKind;
  content_status?: ContentStatus;
  cooldown_days?: number | null;
  caption_variants?: { platform: string | null; body: string; sort_order: number }[];
  period_links?: { periodId: number; mode: PeriodMode }[];
  tag_ids?: number[];
}

/** Writes the content-model side-table rows for a freshly-created post, INSIDE the caller's transaction. */
function insertContentModelRows(db: ReturnType<typeof getDb>, postId: number, data: ContentModelInput): void {
  if (data.target_channel_ids?.length) {
    // OR IGNORE: a duplicate channel id in the input is harmless, not a 500.
    const insert = db.prepare("INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?, ?)");
    for (const channelId of data.target_channel_ids) insert.run(postId, channelId);
  }
  if (data.period_links?.length) {
    const insert = db.prepare(
      "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?, ?, ?)"
    );
    for (const link of data.period_links) insert.run(postId, link.periodId, link.mode);
  }
  if (data.caption_variants?.length) {
    const insert = db.prepare(
      "INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?, ?, ?, ?)"
    );
    for (const v of data.caption_variants) insert.run(postId, v.platform, v.body, v.sort_order);
  }
  if (data.tag_ids?.length) {
    const insert = db.prepare("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)");
    for (const tagId of data.tag_ids) insert.run(postId, tagId);
  }
}

export interface CreatePostInput extends ContentModelInput {
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
 * Content-model fields (kind/status/cooldown/targets/periods/caption variants) are all
 * optional so existing callers keep working with today's schema defaults.
 * Returns the new post id and the created publication ids.
 */
export function createPostWithPublications(
  input: CreatePostInput
): { postId: number; publicationIds: number[] } {
  const db = getDb();
  const tx = db.transaction((data: CreatePostInput) => {
    const postInfo = db
      .prepare(
        `INSERT INTO posts
           (caption, first_comment, post_type, status, content_kind, content_status,
            cooldown_days, created_by)
         VALUES (@caption, @first_comment, @post_type, 'scheduled', @content_kind,
            @content_status, @cooldown_days, @created_by)`
      )
      .run({
        caption: data.caption || null,
        first_comment: data.first_comment || null,
        post_type: data.post_type,
        content_kind: data.content_kind || "evergreen",
        content_status: data.content_status || "draft",
        cooldown_days: data.cooldown_days ?? null,
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

    insertContentModelRows(db, postId, data);

    return { postId, publicationIds };
  });
  return tx(input);
}

// ---- Draft posts + library ------------------------------------------------------
export interface CreateDraftInput extends ContentModelInput {
  caption: string;
  first_comment: string;
  asset_ids: number[];
  created_by?: string;
}

/**
 * Create a post + ordered assets with NO publications (a reusable draft).
 * Content-model fields are optional — existing callers keep today's defaults.
 */
export function createDraftPost(input: CreateDraftInput): number {
  const db = getDb();
  const postType = input.asset_ids.length > 1 ? "carousel" : "single";
  const tx = db.transaction((data: CreateDraftInput) => {
    const info = db
      .prepare(
        `INSERT INTO posts
           (caption, first_comment, post_type, status, content_kind, content_status,
            cooldown_days, created_by)
         VALUES (@caption, @first_comment, @post_type, 'draft', @content_kind,
            @content_status, @cooldown_days, @created_by)`
      )
      .run({
        caption: data.caption || null,
        first_comment: data.first_comment || null,
        post_type: postType,
        content_kind: data.content_kind || "evergreen",
        content_status: data.content_status || "draft",
        cooldown_days: data.cooldown_days ?? null,
        created_by: data.created_by || null,
      });
    const postId = Number(info.lastInsertRowid);
    const link = db.prepare(
      "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, ?)"
    );
    data.asset_ids.forEach((a, i) => link.run(postId, a, i));

    insertContentModelRows(db, postId, data);

    return postId;
  });
  return tx(input);
}

export interface BulkDraftItem {
  asset_id: number;
  caption: string;
}

export interface BulkDraftShared {
  target_channel_ids?: number[];
  content_kind?: ContentKind;
  content_status?: ContentStatus;
  tag_ids?: number[];
  period_links?: { periodId: number; mode: PeriodMode }[];
}

/**
 * Create one single-image draft post per item, ALL in one transaction (better-sqlite3
 * nests createDraftPost's own transaction via savepoints, so the batch commits or rolls
 * back together). A non-empty caption becomes the post's single generic caption variant.
 * Returns the new post ids.
 */
export function createDraftPostsBulk(items: BulkDraftItem[], shared: BulkDraftShared): number[] {
  const db = getDb();
  const tx = db.transaction((rows: BulkDraftItem[]) => {
    const ids: number[] = [];
    for (const item of rows) {
      const caption = item.caption.trim();
      ids.push(
        createDraftPost({
          caption,
          first_comment: "",
          asset_ids: [item.asset_id],
          target_channel_ids: shared.target_channel_ids,
          content_kind: shared.content_kind,
          content_status: shared.content_status,
          tag_ids: shared.tag_ids,
          period_links: shared.period_links,
          caption_variants: caption
            ? [{ platform: null, body: caption, sort_order: 0 }]
            : undefined,
        })
      );
    }
    return ids;
  });
  return tx(items);
}

/** Fetch a single post by id (for existence checks in API routes). */
export function getPost(id: number): Post | undefined {
  return getDb().prepare("SELECT * FROM posts WHERE id = ?").get(id) as Post | undefined;
}

/**
 * Delete a post outright. Blocked if any of its publications is 'posted' or 'publishing'
 * (a live send must never be erased out from under the worker or the record of what
 * actually went out). FK ON DELETE CASCADE removes publications/post_assets/
 * caption_variants/post_tags/post_periods; assets are content-hash-shared and are NOT
 * deleted here.
 */
export function deletePost(id: number): "ok" | "not_found" | "has_live" {
  const db = getDb();
  const post = db.prepare("SELECT id FROM posts WHERE id = ?").get(id);
  if (!post) return "not_found";
  // Guard lives ON the DELETE so it can't race the worker: if any send went live
  // between here and now, NOT EXISTS fails and the DELETE no-ops (0 rows).
  const info = db
    .prepare(
      `DELETE FROM posts
       WHERE id = @id
         AND NOT EXISTS (
           SELECT 1 FROM publications
           WHERE post_id = @id AND status IN ('posted','publishing')
         )`
    )
    .run({ id });
  return info.changes > 0 ? "ok" : "has_live";
}

/** A post's publications joined with their channel, for the edit screen's per-channel queue view. */
export function getPostPublications(postId: number): PostPublicationRow[] {
  return getDb()
    .prepare(
      `SELECT pub.id, pub.channel_id, pub.scheduled_at, pub.status, pub.is_held,
              pub.is_dry_run, pub.remote_post_id,
              c.account_name AS channel_name, c.platform AS channel_platform,
              c.timezone AS channel_timezone
       FROM publications pub JOIN channels c ON c.id = pub.channel_id
       WHERE pub.post_id = ? ORDER BY pub.scheduled_at ASC`
    )
    .all(postId) as PostPublicationRow[];
}

export interface PostLibraryRow extends Post {
  first_asset_id: number | null;
  asset_count: number;
  scheduled_count: number;
  posted_count: number;
  last_posted_at: string | null;
  target_count: number;
  green_period_count: number;
  blackout_period_count: number;
  time_of_day_tags: string | null;
  topic_tags: string | null;
  target_platforms: string | null;
}

export function listPosts(limit = 200): PostLibraryRow[] {
  return getDb()
    .prepare(
      `SELECT p.*,
         (SELECT pa.asset_id FROM post_assets pa WHERE pa.post_id = p.id
            ORDER BY pa.sort_order LIMIT 1) AS first_asset_id,
         (SELECT COUNT(*) FROM post_assets pa WHERE pa.post_id = p.id) AS asset_count,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status IN ('scheduled','pending_approval','publishing')) AS scheduled_count,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status = 'posted') AS posted_count,
         (SELECT MAX(pub.published_at) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status = 'posted') AS last_posted_at,
         (SELECT COUNT(*) FROM post_targets pt WHERE pt.post_id = p.id) AS target_count,
         (SELECT COUNT(*) FROM post_periods pp WHERE pp.post_id = p.id
            AND pp.mode = 'green') AS green_period_count,
         (SELECT COUNT(*) FROM post_periods pp WHERE pp.post_id = p.id
            AND pp.mode = 'blackout') AS blackout_period_count,
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'time_of_day') AS time_of_day_tags,
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'topic') AS topic_tags,
         (SELECT GROUP_CONCAT(DISTINCT c.platform) FROM post_targets pt2
            JOIN channels c ON c.id = pt2.channel_id WHERE pt2.post_id = p.id) AS target_platforms
       FROM posts p
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`
    )
    .all(limit) as PostLibraryRow[];
}

export interface BulkEntry {
  post_id: number;
  channel_id: number;
  scheduled_at: string; // UTC ISO
  status: "scheduled" | "pending_approval";
}

/** Create many publications atomically and flip their posts out of 'draft'. */
export function bulkCreatePublications(entries: BulkEntry[]): number {
  if (entries.length === 0) return 0;
  const db = getDb();
  const tx = db.transaction((rows: BulkEntry[]) => {
    const insert = db.prepare(
      `INSERT INTO publications (post_id, channel_id, scheduled_at, status, created_by)
       VALUES (?, ?, ?, ?, 'bulk')`
    );
    const undraft = db.prepare(
      "UPDATE posts SET status = 'scheduled' WHERE id = ? AND status = 'draft'"
    );
    for (const r of rows) {
      insert.run(r.post_id, r.channel_id, r.scheduled_at, r.status);
      undraft.run(r.post_id);
    }
    return rows.length;
  });
  return tx(entries);
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
  m_reach: number | null;
  m_saves: number | null;
  m_likes: number | null;
  m_comments: number | null;
  m_shares: number | null;
  m_impressions: number | null;
  m_fetched_at: string | null;
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
            WHERE pa.post_id = p.id ORDER BY pa.sort_order ASC LIMIT 1) AS first_asset_id,
         lm.reach       AS m_reach,
         lm.saves       AS m_saves,
         lm.likes       AS m_likes,
         lm.comments    AS m_comments,
         lm.shares      AS m_shares,
         lm.impressions AS m_impressions,
         lm.fetched_at  AS m_fetched_at
       FROM publications pub
       JOIN posts p    ON p.id = pub.post_id
       JOIN channels c ON c.id = pub.channel_id
       LEFT JOIN post_metrics lm ON lm.id = (
         SELECT pm.id FROM post_metrics pm
         WHERE pm.publication_id = pub.id
         ORDER BY pm.fetched_at DESC, pm.id DESC LIMIT 1
       )
       ORDER BY
         CASE pub.status WHEN 'failed' THEN 0 WHEN 'publishing' THEN 1
                         WHEN 'scheduled' THEN 2 ELSE 3 END,
         pub.scheduled_at ASC
       LIMIT ?`
    )
    .all(limit) as PublicationRow[];
}

export function getPublication(id: number): Publication | undefined {
  return getDb().prepare("SELECT * FROM publications WHERE id = ?").get(id) as
    | Publication
    | undefined;
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

/**
 * Cancel a send that hasn't gone out yet. Only 'scheduled' or 'pending_approval'
 * publications are cancelable — the `WHERE status IN (...)` guard makes this atomic
 * against the worker: if it already flipped the row to 'publishing', 0 rows change
 * and we report the conflict rather than canceling an in-flight (or posted) send.
 * Canceling clears any retry state so the row rests cleanly in 'canceled'.
 */
export function cancelPublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications
       SET status = 'canceled', next_retry_at = NULL, updated_at = @now
       WHERE id = @id AND status IN ('scheduled', 'pending_approval')`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}

export function deletePublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `DELETE FROM publications
       WHERE id = @id AND status IN ('scheduled','pending_approval','canceled','failed')`
    )
    .run({ id });
  return info.changes > 0;
}

export function reschedulePublication(id: number, scheduledAtUtc: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications SET scheduled_at = @at, next_retry_at = NULL, updated_at = @now
       WHERE id = @id AND status IN ('scheduled','pending_approval')`
    )
    .run({ id, at: scheduledAtUtc, now: nowIso() });
  return info.changes > 0;
}

export function holdPublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications SET is_held = 1, updated_at = @now
       WHERE id = @id AND is_held = 0 AND status IN ('scheduled','pending_approval')`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}

export function resumePublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications SET is_held = 0, updated_at = @now
       WHERE id = @id AND is_held = 1 AND status IN ('scheduled','pending_approval')`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}

/** Flag a posted, non-dry-run publication for an on-demand metrics fetch. */
export function requestMetricsRefresh(
  publicationId: number
): "ok" | "not_found" | "not_posted" {
  const db = getDb();
  const pub = db
    .prepare("SELECT status, is_dry_run, remote_post_id FROM publications WHERE id = ?")
    .get(publicationId) as
    | { status: string; is_dry_run: number; remote_post_id: string | null }
    | undefined;
  if (!pub) return "not_found";
  // Must match what the worker can actually fetch (posted, real remote id, not dry-run),
  // so a queued flag is always picked up and cleared — never stuck reading "Queued".
  if (
    pub.status !== "posted" ||
    pub.is_dry_run === 1 ||
    !pub.remote_post_id ||
    pub.remote_post_id === "DRYRUN"
  ) {
    return "not_posted";
  }
  db.prepare(
    "UPDATE publications SET metrics_refresh_requested_at = ? WHERE id = ?"
  ).run(nowIso(), publicationId);
  return "ok";
}

/** Flag ALL eligible posted publications for a metrics fetch. Returns the count flagged. */
export function requestMetricsRefreshAll(): number {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE publications SET metrics_refresh_requested_at = ?
        WHERE status = 'posted' AND is_dry_run = 0
          AND remote_post_id IS NOT NULL AND remote_post_id != 'DRYRUN'`
    )
    .run(nowIso());
  return info.changes;
}

// ---- Periods (reusable in-season window library) ---------------------------------
export function listPeriods(): Period[] {
  return getDb().prepare("SELECT * FROM periods ORDER BY name ASC").all() as Period[];
}

export function getPeriod(id: number): Period | undefined {
  return getDb().prepare("SELECT * FROM periods WHERE id = ?").get(id) as
    | Period
    | undefined;
}

export interface CreatePeriodInput {
  name: string;
  recurs_yearly: boolean;
  start_month?: number | null;
  start_day?: number | null;
  end_month?: number | null;
  end_day?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

export function createPeriod(input: CreatePeriodInput): number {
  const info = getDb()
    .prepare(
      `INSERT INTO periods
         (name, recurs_yearly, start_month, start_day, end_month, end_day, start_date, end_date)
       VALUES (@name, @recurs_yearly, @start_month, @start_day, @end_month, @end_day,
         @start_date, @end_date)`
    )
    .run({
      name: input.name,
      recurs_yearly: input.recurs_yearly ? 1 : 0,
      start_month: input.start_month ?? null,
      start_day: input.start_day ?? null,
      end_month: input.end_month ?? null,
      end_day: input.end_day ?? null,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
    });
  return Number(info.lastInsertRowid);
}

export function updatePeriod(
  id: number,
  fields: Partial<{
    name: string;
    recurs_yearly: number;
    start_month: number | null;
    start_day: number | null;
    end_month: number | null;
    end_day: number | null;
    start_date: string | null;
    end_date: string | null;
  }>
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE periods SET ${setClause} WHERE id = @id`)
    .run({ ...fields, id });
}

/** Periods has no updated_at column and post_periods/CASCADE handles cleanup of links. */
export function deletePeriod(id: number): boolean {
  const info = getDb().prepare("DELETE FROM periods WHERE id = ?").run(id);
  return info.changes > 0;
}

// ---- Post targeting (explicit per-account "who is this for") ---------------------
export function getPostTargets(postId: number): number[] {
  const rows = getDb()
    .prepare("SELECT channel_id FROM post_targets WHERE post_id = ? ORDER BY channel_id ASC")
    .all(postId) as { channel_id: number }[];
  return rows.map((r) => r.channel_id);
}

/** Replace a post's target set atomically (delete-all then insert — the "all" snapshot). */
export function setPostTargets(postId: number, channelIds: number[]): void {
  const db = getDb();
  const tx = db.transaction((ids: number[]) => {
    db.prepare("DELETE FROM post_targets WHERE post_id = ?").run(postId);
    const insert = db.prepare("INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?, ?)");
    for (const id of ids) insert.run(postId, id);
  });
  tx(channelIds);
}

// ---- Tags (taxonomy: topic + time_of_day) -------------------------------------
export function listTags(kind?: "topic" | "time_of_day"): Tag[] {
  const db = getDb();
  if (kind) {
    return db
      .prepare("SELECT id, name, kind FROM tags WHERE kind = ? ORDER BY name COLLATE NOCASE")
      .all(kind) as Tag[];
  }
  return db
    .prepare("SELECT id, name, kind FROM tags ORDER BY kind, name COLLATE NOCASE")
    .all() as Tag[];
}

/** Create-or-get a free-form topic tag by name (case-insensitive). */
/** Thrown when a topic name collides with a reserved time-of-day band name. */
export class ReservedTagNameError extends Error {
  constructor(name: string) {
    super(`"${name}" is reserved for a time-of-day band.`);
    this.name = "ReservedTagNameError";
  }
}

/**
 * Create-or-get a free-form topic tag by name (case-insensitive). Names are globally
 * unique, so a name that already exists as a time-of-day band (morning/afternoon/…)
 * is rejected rather than silently returning the band — otherwise a user "adding a
 * topic" would quietly attach a scheduling tag.
 */
export function createTopicTag(name: string): Tag {
  const db = getDb();
  const clean = name.trim();
  const existing = db
    .prepare("SELECT id, name, kind FROM tags WHERE name = ? COLLATE NOCASE")
    .get(clean) as Tag | undefined;
  if (existing) {
    if (existing.kind !== "topic") throw new ReservedTagNameError(clean);
    return existing;
  }
  const info = db.prepare("INSERT INTO tags (name, kind) VALUES (?, 'topic')").run(clean);
  return db
    .prepare("SELECT id, name, kind FROM tags WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as Tag;
}

export function getPostTags(postId: number): Tag[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT t.id, t.name, t.kind
         FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.post_id = ?
        ORDER BY t.kind, t.name COLLATE NOCASE`
    )
    .all(postId) as Tag[];
}

/** Replace a post's tag set atomically. */
export function setPostTags(postId: number, tagIds: number[]): void {
  const db = getDb();
  const tx = db.transaction((ids: number[]) => {
    db.prepare("DELETE FROM post_tags WHERE post_id = ?").run(postId);
    const insert = db.prepare("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)");
    for (const id of ids) insert.run(postId, id);
  });
  tx(tagIds);
}

// ---- Post periods (green/blackout links; blackout wins — enforced in the worker) -
export interface PostPeriodLink {
  period_id: number;
  mode: PeriodMode;
}

export function getPostPeriods(postId: number): PostPeriodLink[] {
  return getDb()
    .prepare("SELECT period_id, mode FROM post_periods WHERE post_id = ? ORDER BY period_id ASC")
    .all(postId) as PostPeriodLink[];
}

/** Replace a post's period links atomically (delete-all then insert). */
export function setPostPeriods(
  postId: number,
  links: { periodId: number; mode: PeriodMode }[]
): void {
  const db = getDb();
  const tx = db.transaction((rows: { periodId: number; mode: PeriodMode }[]) => {
    db.prepare("DELETE FROM post_periods WHERE post_id = ?").run(postId);
    const insert = db.prepare(
      "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?, ?, ?)"
    );
    for (const r of rows) insert.run(postId, r.periodId, r.mode);
  });
  tx(links);
}

// ---- Caption variants (1..N per post; platform NULL = generic/rotated) -----------
export function getCaptionVariants(postId: number): CaptionVariant[] {
  return getDb()
    .prepare(
      "SELECT * FROM caption_variants WHERE post_id = ? ORDER BY sort_order ASC, id ASC"
    )
    .all(postId) as CaptionVariant[];
}

/** Replace a post's caption variants atomically (delete-all then insert). */
export function setCaptionVariants(
  postId: number,
  variants: { platform: string | null; body: string; sort_order: number }[]
): void {
  const db = getDb();
  const tx = db.transaction((rows: typeof variants) => {
    db.prepare("DELETE FROM caption_variants WHERE post_id = ?").run(postId);
    const insert = db.prepare(
      "INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?, ?, ?, ?)"
    );
    for (const v of rows) insert.run(postId, v.platform, v.body, v.sort_order);
  });
  tx(variants);
}

// ---- Bulk re-target (add/remove one or more channels across many posts) ----------
/** Idempotent: INSERT OR IGNORE so re-running "add" over already-targeted pairs is a no-op. */
export function bulkAddTargets(postIds: number[], channelIds: number[]): void {
  const db = getDb();
  const tx = db.transaction((posts: number[], channels: number[]) => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?, ?)"
    );
    for (const postId of posts) {
      for (const channelId of channels) insert.run(postId, channelId);
    }
  });
  tx(postIds, channelIds);
}

/** Exact-pair delete: only removes (post_id, channel_id) combinations that were passed in. */
export function bulkRemoveTargets(postIds: number[], channelIds: number[]): void {
  const db = getDb();
  const tx = db.transaction((posts: number[], channels: number[]) => {
    const del = db.prepare(
      "DELETE FROM post_targets WHERE post_id = ? AND channel_id = ?"
    );
    for (const postId of posts) {
      for (const channelId of channels) del.run(postId, channelId);
    }
  });
  tx(postIds, channelIds);
}

// ---- Post content-model fields (kind/status/cooldown) -----------------------------
/** Dynamic SET, same pattern as updateChannel. */
export function updatePostContentModel(
  postId: number,
  fields: Partial<{
    content_kind: ContentKind;
    content_status: ContentStatus;
    cooldown_days: number | null;
  }>
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE posts SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id: postId, updated_at: nowIso() });
}

// ---- Worker liveness --------------------------------------------------------------
/** The worker is a separate process that must be running for metrics refreshes,
 *  scheduled publishing, and auto-fill to happen. It stamps worker_heartbeat every
 *  poll (~30s); we treat it as online if that stamp is recent. Generous window so a
 *  slow poll or clock skew doesn't flap the indicator. */
const WORKER_ONLINE_WINDOW_MS = 120_000;

export function getWorkerStatus(): { online: boolean; lastSeenAt: string | null } {
  const row = getDb()
    .prepare("SELECT last_seen_at FROM worker_heartbeat WHERE id = 1")
    .get() as { last_seen_at: string } | undefined;
  if (!row) return { online: false, lastSeenAt: null };
  const ageMs = Date.now() - new Date(row.last_seen_at).getTime();
  return {
    online: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= WORKER_ONLINE_WINDOW_MS,
    lastSeenAt: row.last_seen_at,
  };
}
