import "server-only";
import { getDb, nowIso } from "./db";
import type {
  Asset,
  CaptionVariant,
  Channel,
  ChannelGroup,
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
import { describeChannel, incompatibleChannelsForPostType, isPlatform } from "./platforms";
import { planMerge, type MergeCandidate, type MergeProblem } from "./merge-plan";
import type { PeriodWindow } from "./periods";

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

/**
 * Ask the worker to re-fetch this channel's profile photo on its next cycle.
 *
 * This sets a flag and nothing else — the dashboard never calls a platform API. Same
 * dashboard-to-worker handoff as metrics_refresh_requested_at on publications. The worker
 * clears the flag whether the fetch succeeds or fails, so a persistently failing channel
 * cannot wedge itself into retrying every cycle.
 */
export function requestAvatarRefresh(channelId: number): void {
  getDb()
    .prepare("UPDATE channels SET avatar_refresh_requested = 1 WHERE id = ?")
    .run(channelId);
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
  color_hue?: number | null;
}

export function createChannel(input: CreateChannelInput): number {
  const info = getDb()
    .prepare(
      `INSERT INTO channels
        (platform, account_name, business_label, timezone, remote_account_id,
         linked_page_id, access_token, requires_approval, color_hue)
       VALUES (@platform, @account_name, @business_label, @timezone, @remote_account_id,
         @linked_page_id, @access_token, @requires_approval, @color_hue)`
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
      color_hue: input.color_hue ?? null,
    });
  return Number(info.lastInsertRowid);
}

export function updateChannel(
  id: number,
  fields: Partial<{
    account_name: string;
    business_label: string | null;
    // NOTE: `timezone` is deliberately absent. It moves through
    // changeChannelTimezone() below, which also rebases the pending queue —
    // routing it through here would silently skip that. Enforced by the type.
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
    color_hue: number | null;
  }>
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE channels SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: nowIso() });
}

/**
 * The sends a timezone change would move: everything still waiting to go out on
 * this channel.
 *
 * 'publishing' is excluded on purpose — the worker already has that row in
 * flight, and moving its scheduled_at mid-publish is a race we gain nothing
 * from. 'posted'/'failed'/'canceled' are history and must stay honest.
 *
 * Held sends ARE included: is_held is a pause, not a cancellation, so they are
 * still pending and the owner still expects them at the wall-clock time shown.
 */
export function getPendingPublicationsForChannel(
  channelId: number
): { id: number; post_id: number; scheduled_at: string; is_held: number }[] {
  return getDb()
    .prepare(
      `SELECT id, post_id, scheduled_at, is_held
         FROM publications
        WHERE channel_id = @channelId
          AND status IN ('scheduled', 'pending_approval')
        ORDER BY scheduled_at`
    )
    .all({ channelId }) as {
    id: number;
    post_id: number;
    scheduled_at: string;
    is_held: number;
  }[];
}

/**
 * Change a channel's timezone, keeping every pending send at the same WALL CLOCK
 * time (a 9:00 AM send stays 9:00 AM in the new zone, so its UTC instant moves).
 *
 * The timezone write and the queue rebase happen in ONE transaction. Splitting
 * them would let a crash land the channel on the new zone while its sends still
 * hold instants computed for the old one — every queued post silently off by the
 * offset difference, with nothing on screen to indicate it.
 *
 * `rebase` is injected rather than imported so this stays a dumb data layer and
 * the (pure, unit-tested) time math has exactly one home.
 *
 * Unlike reschedulePublication(), this does NOT clear next_retry_at. A row
 * retrying after a failure keeps status='scheduled' with a backoff stamp, and
 * the worker gates on scheduled_at AND next_retry_at (worker/db.py). Clearing it
 * would collapse a deliberate backoff into an immediate re-attempt — the owner
 * corrected a timezone, they didn't ask to retry now.
 */
export function changeChannelTimezone(
  channelId: number,
  fromTz: string,
  toTz: string,
  rebase: (iso: string, fromTz: string, toTz: string) => string
): { moved: number } {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE channels SET timezone = @tz, updated_at = @now WHERE id = @id").run({
      tz: toTz,
      now: nowIso(),
      id: channelId,
    });

    if (fromTz === toTz) return { moved: 0 };

    const pending = getPendingPublicationsForChannel(channelId);
    const move = db.prepare(
      "UPDATE publications SET scheduled_at = @at, updated_at = @now WHERE id = @id"
    );
    let moved = 0;
    for (const p of pending) {
      const next = rebase(p.scheduled_at, fromTz, toTz);
      if (next === p.scheduled_at) continue; // zone changed, this instant didn't
      move.run({ at: next, now: nowIso(), id: p.id });
      moved += 1;
    }
    return { moved };
  });
  return tx();
}

// ---- Channel groups ---------------------------------------------------------------

export function listChannelGroups(): ChannelGroup[] {
  return getDb()
    .prepare("SELECT * FROM channel_groups ORDER BY name COLLATE NOCASE")
    .all() as ChannelGroup[];
}

export function getChannelGroup(id: number): ChannelGroup | undefined {
  return getDb().prepare("SELECT * FROM channel_groups WHERE id = ?").get(id) as
    | ChannelGroup
    | undefined;
}

export function getGroupMembers(groupId: number): Channel[] {
  return getDb()
    .prepare("SELECT * FROM channels WHERE group_id = ? ORDER BY id")
    .all(groupId) as Channel[];
}

export function createChannelGroup(input: { name: string; timezone: string }): number {
  const info = getDb()
    .prepare("INSERT INTO channel_groups (name, timezone) VALUES (@name, @timezone)")
    .run({ name: input.name, timezone: input.timezone });
  return Number(info.lastInsertRowid);
}

export function updateChannelGroup(
  id: number,
  fields: Partial<{
    name: string;
    // NOTE: `timezone` is deliberately absent, exactly as on updateChannel(). It moves
    // through changeChannelGroupTimezone() below, which also rebases every member's
    // pending queue — routing it through here would silently skip that.
    autofill_enabled: number;
    cadence_config: string | null;
    min_queue_depth: number;
    target_queue_depth: number;
    reuse_min_age_days: number;
    is_active: number;
  }>
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE channel_groups SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: nowIso() });
}

/** Delete a group. Members are returned to solo auto-fill by the migration's
 *  ON DELETE SET NULL — their publications are never touched. */
export function deleteChannelGroup(id: number): boolean {
  const info = getDb().prepare("DELETE FROM channel_groups WHERE id = ?").run(id);
  return info.changes > 0;
}

export function setChannelGroup(channelId: number, groupId: number | null): void {
  getDb()
    .prepare("UPDATE channels SET group_id = @gid, updated_at = @now WHERE id = @id")
    .run({ gid: groupId, now: nowIso(), id: channelId });
}

/**
 * Change a group's timezone, keeping every member's pending sends at the same WALL
 * CLOCK time. Same contract as changeChannelTimezone(), widened to every member: the
 * group owns the cadence, so its members must move together or they stop mirroring.
 * One transaction for the same reason — a crash between the two writes would leave the
 * group on a new zone while its sends held instants computed for the old one.
 */
export function changeChannelGroupTimezone(
  groupId: number,
  fromTz: string,
  toTz: string,
  rebase: (iso: string, fromTz: string, toTz: string) => string
): { moved: number } {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE channel_groups SET timezone = @tz, updated_at = @now WHERE id = @id").run({
      tz: toTz,
      now: nowIso(),
      id: groupId,
    });
    if (fromTz === toTz) return { moved: 0 };

    const move = db.prepare(
      "UPDATE publications SET scheduled_at = @at, updated_at = @now WHERE id = @id"
    );
    let moved = 0;
    for (const member of getGroupMembers(groupId)) {
      for (const p of getPendingPublicationsForChannel(member.id)) {
        const next = rebase(p.scheduled_at, fromTz, toTz);
        if (next === p.scheduled_at) continue; // zone changed, this instant didn't
        move.run({ at: next, now: nowIso(), id: p.id });
        moved += 1;
      }
    }
    return { moved };
  });
  return tx();
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
  conform_mode?: "none" | "crop" | "pad" | "downscale";
  needs_review?: number;
  duration_ms?: number | null;
  cover_frame_ms?: number | null;
  has_audio?: number;
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
         publish_path, conform_mode, needs_review,
         duration_ms, cover_frame_ms, has_audio)
       VALUES (@content_hash, @media_kind, @original_filename, @storage_path, @public_url,
         @thumbnail_path, @mime_type, @width, @height, @byte_size,
         @publish_path, @conform_mode, @needs_review,
         @duration_ms, @cover_frame_ms, @has_audio)`
    )
    .run({
      ...input,
      publish_path: input.publish_path ?? null,
      conform_mode: input.conform_mode ?? "none",
      needs_review: input.needs_review ?? 0,
      duration_ms: input.duration_ms ?? null,
      cover_frame_ms: input.cover_frame_ms ?? null,
      has_audio: input.has_audio ?? 0,
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
    conform_mode: "none" | "crop" | "pad" | "downscale";
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

/** Persist the chosen cover frame. Assets have no updated_at column. */
export function updateAssetCoverFrame(id: number, coverFrameMs: number): void {
  getDb()
    .prepare("UPDATE assets SET cover_frame_ms = ? WHERE id = ?")
    .run(coverFrameMs, id);
}

export interface AssetWithUsage {
  id: number;
  content_hash: string;
  media_kind: "image" | "video";
  original_filename: string | null;
  storage_path: string;
  publish_path: string | null;
  thumbnail_path: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  byte_size: number | null;
  duration_ms: number | null;
  cover_frame_ms: number | null;
  created_at: string;
  post_count: number;
  first_post_id: number | null;
  first_post_status: string | null;
}

/**
 * Every asset with how many posts use it. The nested SELECT does the GROUP BY, then the
 * outer join resolves the post's status — an aggregate (MIN) can't be referenced from a
 * correlated subquery in the same SELECT list, so it has to happen one level up.
 */
export function listAssetsWithUsage(): AssetWithUsage[] {
  return getDb()
    .prepare(
      `SELECT u.*, p.status AS first_post_status
         FROM (
           SELECT a.*,
                  COUNT(pa.post_id) AS post_count,
                  MIN(pa.post_id)   AS first_post_id
             FROM assets a
             LEFT JOIN post_assets pa ON pa.asset_id = a.id
            GROUP BY a.id
         ) u
         LEFT JOIN posts p ON p.id = u.first_post_id
        ORDER BY u.created_at DESC, u.id DESC`
    )
    .all() as AssetWithUsage[];
}

/**
 * Delete an asset row. The guard lives ON the DELETE so it can't race a compose that
 * attaches this asset a millisecond from now: if a post_assets row appears in between,
 * NOT EXISTS fails and the DELETE no-ops (0 rows) instead of the FK throwing.
 *
 * The catch is deliberate and broader than post_assets. Any foreign key pointing at
 * assets gets to veto — including assets.cover_asset_id, which exists on the
 * custom-cover-image branch (migration 0012) but not here. That branch will not need
 * to touch this function.
 */
export function deleteAsset(id: number): "ok" | "not_found" | "in_use" {
  const db = getDb();
  const row = db.prepare("SELECT id FROM assets WHERE id = ?").get(id);
  if (!row) return "not_found";
  try {
    const info = db
      .prepare(
        `DELETE FROM assets
          WHERE id = @id
            AND NOT EXISTS (SELECT 1 FROM post_assets WHERE asset_id = @id)`
      )
      .run({ id });
    return info.changes > 0 ? "ok" : "in_use";
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code.startsWith("SQLITE_CONSTRAINT")) return "in_use";
    throw err;
  }
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
  /** "Post now" from the composer: force every publication straight to 'scheduled',
   *  bypassing each channel's requires_approval. See the comment at the status
   *  decision below for why this is intentional, not a bug. */
  skip_approval?: boolean;
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
      // Approval gates content nobody reviewed individually (queued/auto-filled sends).
      // "Post now" (skip_approval) means the person composing this post right now IS
      // the approver — clicking publish is the review. Don't "fix" this back to
      // honoring requires_approval for post_now; that would silently swallow the post
      // into pending_approval and it would never go out.
      const status = !data.skip_approval && ch?.requires_approval ? "pending_approval" : "scheduled";
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
  post_type?: PostType;
  asset_ids: number[];
  created_by?: string;
}

/**
 * Create a post + ordered assets with NO publications (a reusable draft).
 * Content-model fields are optional — existing callers keep today's defaults.
 */
export function createDraftPost(input: CreateDraftInput): number {
  const db = getDb();
  const postType: PostType =
    input.post_type ?? (input.asset_ids.length > 1 ? "carousel" : "single");
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

// ---- Merge several drafts into one carousel --------------------------------------
// The decision half of this lives in lib/merge-plan.ts (pure, no DB). Everything here is
// the other half: load the rows planMerge needs, then — only if it says yes — perform the
// writes. No guard from spec §5 is re-implemented here; if a rule is missing, it belongs
// in merge-plan.ts so the unit tests can see it.

/**
 * Everything merge-plan.ts needs to judge one post, and nothing else. Returns undefined for
 * an id that no longer exists (deleted between page load and submit) so planMerge reports it
 * as post_not_found rather than crashing on an undefined candidate.
 */
function loadMergeCandidate(
  db: ReturnType<typeof getDb>,
  postId: number
): MergeCandidate | undefined {
  const post = db
    .prepare("SELECT id, post_type, status FROM posts WHERE id = ?")
    .get(postId) as { id: number; post_type: string; status: string } | undefined;
  if (!post) return undefined;
  const slides = db
    .prepare(
      `SELECT pa.asset_id, a.media_kind
         FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
        WHERE pa.post_id = ? ORDER BY pa.sort_order ASC`
    )
    .all(postId) as { asset_id: number; media_kind: string }[];
  // Same live-send definition deletePost uses: 'posted' means it exists on the platform,
  // 'publishing' means the worker is mid-flight with it right now.
  const live = db
    .prepare(
      `SELECT 1 FROM publications
        WHERE post_id = ? AND status IN ('posted','publishing') LIMIT 1`
    )
    .get(postId);
  return {
    post_id: post.id,
    post_type: post.post_type,
    status: post.status,
    has_live_publication: live !== undefined,
    asset_ids: slides.map((s) => s.asset_id),
    media_kinds: slides.map((s) => s.media_kind),
  };
}

/**
 * The distinct platforms the merged post could end up going to — planMerge caps the carousel
 * at the STRICTEST of these (Instagram 10, Threads 20).
 *
 * Never return an empty list. planMerge computes the cap with `Math.min(...platforms.map(...))`,
 * and `Math.min()` of an empty array is **Infinity** — an empty list does not mean "no cap
 * known", it silently switches the size cap off completely, and a 30-photo merge would sail
 * through here only to die at publish time. Targets are optional on a post, so the empty case
 * is reachable whenever every merged post happens to be untargeted (a freshly composed draft,
 * or one whose only target channel was deleted).
 *
 * Falling back to Instagram is the conservative choice: 10 is the strictest cap any platform
 * here has, it matches platforms.ts's own `maxCarousel` default for an unrecognised platform,
 * and it makes planMerge's "Instagram allows at most 10" message literally true. An untargeted
 * draft can be pointed at any channel later, so it has to satisfy the tightest limit, not the
 * loosest.
 */
function mergeTargetPlatforms(db: ReturnType<typeof getDb>, postIds: number[]): Platform[] {
  if (postIds.length === 0) return ["instagram"];
  const placeholders = postIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT c.platform
         FROM post_targets pt JOIN channels c ON c.id = pt.channel_id
        WHERE pt.post_id IN (${placeholders})`
    )
    .all(...postIds) as { platform: string }[];
  const platforms = rows.map((r) => r.platform).filter(isPlatform);
  return platforms.length > 0 ? platforms : ["instagram"];
}

/**
 * Fold several draft posts into a single carousel: the first id in `postIds` survives and
 * collects every asset in `assetOrder`, the rest are emptied and deleted. Assets themselves
 * are never touched — only the post_assets join rows move.
 *
 * **Caption contract — `null` and `""` mean the same thing: CLEAR the caption.** Both wipe
 * `posts.caption` to NULL *and* delete every `caption_variants` row on the survivor. There is
 * no "leave the existing caption alone" value; the merge modal's "No caption" option has to
 * genuinely clear the text, or it doesn't mean what it says. The two are cleared together,
 * never one without the other: the worker prefers `caption_variants` over `posts.caption`, so
 * clearing only one would publish text the post record says isn't there. A non-empty string
 * sets `posts.caption` and replaces the survivor's variants with that single body.
 *
 * Returns the plan's own problem (with its HTTP status) on rejection, having written nothing.
 */
export function mergePostsIntoCarousel(
  postIds: number[],
  assetOrder: number[],
  caption: string | null
): { ok: true; post_id: number } | { ok: false; problem: MergeProblem } {
  const db = getDb();
  const tx = db.transaction(():
    | { ok: true; post_id: number }
    | { ok: false; problem: MergeProblem } => {
    // The same id twice would otherwise be deleted twice and counted twice; collapse it
    // once, up front, so every list below is a true set of posts.
    const merged = [...new Set(postIds)];
    const candidates = merged
      .map((id) => loadMergeCandidate(db, id))
      .filter((c): c is MergeCandidate => c !== undefined);

    const plan = planMerge(
      candidates,
      { post_ids: postIds, asset_order: assetOrder },
      mergeTargetPlatforms(db, merged)
    );
    // Rejected: return before a single write happens. (The transaction commits empty.)
    if (!plan.ok) return { ok: false, problem: plan.problem };

    // spec §3: post_type is not decoration. worker/publisher.py re-validates it against the
    // real asset count at publish time and fails NON-retryably on a mismatch — a merge that
    // moves the photos but hardcodes 'carousel' looks perfect in the UI and then dies at send
    // time. So it is DERIVED from the slides about to be written. Merging a text post (no
    // assets) into one single-image draft legitimately leaves one slide, which is 'single'.
    if (plan.slides.length === 0) {
      return {
        ok: false,
        problem: {
          code: "no_assets",
          message: "Those posts have no photos to merge.",
          status: 400,
        },
      };
    }
    const postType: PostType = plan.slides.length > 1 ? "carousel" : "single";

    const survivor = plan.survivorId;
    const others = merged.filter((id) => id !== survivor);
    const allPlaceholders = merged.map(() => "?").join(",");

    // post_assets carries no data worth preserving — (id, post_id, asset_id, sort_order), and
    // nothing references its id. So instead of shuffling rows through a temporary high offset
    // to dodge UNIQUE (post_id, sort_order) — which SQLite checks per-row, immediately — we
    // delete every involved row and rebuild them on the survivor. Simpler and provably
    // collision-free.
    //
    // Order matters: the join rows must be rebuilt BEFORE the emptied posts are deleted.
    // Deleting the posts first would cascade their join rows away and take the asset links
    // with them.
    db.prepare(`DELETE FROM post_assets WHERE post_id IN (${allPlaceholders})`).run(...merged);
    const link = db.prepare(
      "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, ?)"
    );
    for (const slide of plan.slides) link.run(survivor, slide.asset_id, slide.sort_order);

    // See the caption contract in this function's doc comment. `null` and `""` are
    // deliberately NOT distinguished — both collapse to an empty body here, which clears
    // posts.caption and leaves the survivor with zero caption_variants rows. Keeping one
    // code path for all three cases is what guarantees the two never drift apart.
    const now = nowIso();
    const body = (caption ?? "").trim();
    db.prepare(
      `UPDATE posts SET post_type = @post_type, caption = @caption, updated_at = @now
        WHERE id = @id`
    ).run({ post_type: postType, caption: body || null, now, id: survivor });
    // Replace, don't add: the survivor's old variants describe the pre-merge post, and the
    // worker reads caption_variants in preference to posts.caption — a stale variant left
    // behind here is the text that would actually go out.
    db.prepare("DELETE FROM caption_variants WHERE post_id = ?").run(survivor);
    if (body) {
      db.prepare(
        `INSERT INTO caption_variants (post_id, platform, body, sort_order)
         VALUES (?, NULL, ?, 0)`
      ).run(survivor, body);
    }

    if (others.length > 0) {
      const otherPlaceholders = others.map(() => "?").join(",");
      // Union, not replace: a merge should never lose a channel/tag/season the user had
      // already set on one of the slides. OR IGNORE absorbs the overlap, which is the
      // common case (the same drafts usually share targets).
      db.prepare(
        `INSERT OR IGNORE INTO post_targets (post_id, channel_id)
           SELECT ?, channel_id FROM post_targets WHERE post_id IN (${otherPlaceholders})`
      ).run(survivor, ...others);
      db.prepare(
        `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
           SELECT ?, tag_id FROM post_tags WHERE post_id IN (${otherPlaceholders})`
      ).run(survivor, ...others);
      db.prepare(
        `INSERT OR IGNORE INTO post_periods (post_id, period_id, mode)
           SELECT ?, period_id, mode FROM post_periods WHERE post_id IN (${otherPlaceholders})`
      ).run(survivor, ...others);

      // Last, once nothing else needs to read from them. CASCADE clears their remaining
      // side-table rows; assets are ON DELETE RESTRICT and are not deleted by any of this.
      db.prepare(`DELETE FROM posts WHERE id IN (${otherPlaceholders})`).run(...others);
    }

    return { ok: true, post_id: survivor };
  });
  // .immediate() takes the write lock at BEGIN instead of on the first write statement.
  // This function reads the rows it validates (loadMergeCandidate) and then writes based on
  // what it read, so a deferred transaction only holds together thanks to WAL snapshot
  // isolation — and under a concurrent writer it would surface as an opaque SQLITE_BUSY
  // mid-merge rather than a clean result. deletePost avoids this by folding its guard into
  // the DELETE itself; a multi-statement plan-then-write can't, so it takes the lock up front.
  return tx.immediate();
}

/** A post's publications joined with their channel, for the edit screen's per-channel queue view. */
export function getPostPublications(postId: number): PostPublicationRow[] {
  return getDb()
    .prepare(
      `SELECT pub.id, pub.channel_id, pub.scheduled_at, pub.status, pub.is_held,
              pub.is_dry_run, pub.remote_post_id,
              c.account_name AS channel_name, c.platform AS channel_platform,
              c.timezone AS channel_timezone, c.color_hue AS channel_color_hue,
              c.avatar_path AS channel_avatar_path
       FROM publications pub JOIN channels c ON c.id = pub.channel_id
       WHERE pub.post_id = ? ORDER BY pub.scheduled_at ASC`
    )
    .all(postId) as PostPublicationRow[];
}

export interface PostLibraryRow extends Post {
  first_asset_id: number | null;
  first_asset_media_kind: "image" | "video" | null;
  first_asset_cover_frame_ms: number | null;
  first_asset_width: number | null;
  first_asset_height: number | null;
  asset_count: number;
  // Every asset this post holds, in slide order, as a comma-joined string of ids —
  // GROUP_CONCAT can't return an array, so the caller (app/library/page.tsx) splits it.
  // Exists so the merge-into-carousel modal can seed SlideReorder from Library data alone,
  // without an N+1 getPostAssets() call per selected post.
  asset_ids_csv: string | null;
  scheduled_count: number;
  posted_count: number;
  last_posted_at: string | null;
  target_count: number;
  periods: PostLibraryPeriod[];
  time_of_day_tags: string | null;
  topic_tags: string | null;
  target_platforms: string | null;
  // Distinct from scheduled_count (which also counts 'publishing'): specifically the
  // statuses that mergePostsIntoCarousel's cascade DELETE would silently wipe out for a
  // non-surviving post. 'posted'/'publishing' posts are already refused by the merge API,
  // so those don't belong in this warning — see the merge modal's queued-send notice.
  queued_publication_count: number;
}

export interface PostLibraryPeriod extends PeriodWindow {
  id: number;
  name: string;
  mode: PeriodMode;
}

export function listPosts(limit = 200): PostLibraryRow[] {
  const db = getDb();
  const posts = db
    .prepare(
      `SELECT p.*,
         (SELECT pa.asset_id FROM post_assets pa WHERE pa.post_id = p.id
            ORDER BY pa.sort_order LIMIT 1) AS first_asset_id,
         (SELECT a.media_kind FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
            WHERE pa.post_id = p.id ORDER BY pa.sort_order LIMIT 1) AS first_asset_media_kind,
         (SELECT a.cover_frame_ms FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
            WHERE pa.post_id = p.id ORDER BY pa.sort_order LIMIT 1) AS first_asset_cover_frame_ms,
         (SELECT a.width FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
            WHERE pa.post_id = p.id ORDER BY pa.sort_order LIMIT 1) AS first_asset_width,
         (SELECT a.height FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
            WHERE pa.post_id = p.id ORDER BY pa.sort_order LIMIT 1) AS first_asset_height,
         (SELECT COUNT(*) FROM post_assets pa WHERE pa.post_id = p.id) AS asset_count,
         (SELECT GROUP_CONCAT(sub.asset_id) FROM (
            SELECT asset_id FROM post_assets WHERE post_id = p.id ORDER BY sort_order ASC
          ) sub) AS asset_ids_csv,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status IN ('scheduled','pending_approval','publishing')) AS scheduled_count,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status = 'posted') AS posted_count,
         (SELECT MAX(pub.published_at) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status = 'posted') AS last_posted_at,
         (SELECT COUNT(*) FROM post_targets pt WHERE pt.post_id = p.id) AS target_count,
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'time_of_day') AS time_of_day_tags,
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'topic') AS topic_tags,
         (SELECT GROUP_CONCAT(DISTINCT c.platform) FROM post_targets pt2
            JOIN channels c ON c.id = pt2.channel_id WHERE pt2.post_id = p.id) AS target_platforms,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status IN ('scheduled','pending_approval')) AS queued_publication_count
       FROM posts p
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`
    )
    .all(limit) as Omit<PostLibraryRow, "periods">[];

  if (posts.length === 0) return [];

  // Fetch every visible post's period rows together. Keeping this as one batched query
  // avoids a getPostPeriods() call per card and leaves room to add more period fields later.
  const placeholders = posts.map(() => "?").join(",");
  const periodRows = db
    .prepare(
      `SELECT pp.post_id, p.id, p.name, pp.mode,
              p.recurs_yearly, p.start_month, p.start_day, p.end_month, p.end_day,
              p.start_date, p.end_date
         FROM post_periods pp
         JOIN periods p ON p.id = pp.period_id
        WHERE pp.post_id IN (${placeholders})
        ORDER BY p.name COLLATE NOCASE ASC, p.id ASC, pp.mode ASC`
    )
    .all(...posts.map((post) => post.id)) as (PostLibraryPeriod & { post_id: number })[];
  const periodsByPost = new Map<number, PostLibraryPeriod[]>();
  for (const { post_id, ...period } of periodRows) {
    const periods = periodsByPost.get(post_id) ?? [];
    periods.push(period);
    periodsByPost.set(post_id, periods);
  }

  return posts.map((post) => ({
    ...post,
    periods: periodsByPost.get(post.id) ?? [],
  }));
}

export interface BulkEntry {
  post_id: number;
  channel_id: number;
  scheduled_at: string; // UTC ISO
  status: "scheduled" | "pending_approval";
}

/** Thrown when a caller (route or otherwise) tries to target a channel that can't publish
 *  the post's type — e.g. a text post at an Instagram channel. Every entry point that can
 *  create publications should already have rejected this earlier with a 400; this is the
 *  last line of defense in the one write path they all funnel through. */
export class IncompatiblePostTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatiblePostTargetError";
  }
}

/** Create many publications atomically and flip their posts out of 'draft'. */
export function bulkCreatePublications(entries: BulkEntry[]): number {
  if (entries.length === 0) return 0;
  const db = getDb();
  for (const entry of entries) {
    const post = getPost(entry.post_id);
    const channel = getChannel(entry.channel_id);
    if (!post || !channel) continue; // let the transaction below hit the FK constraint
    const incompatible = incompatibleChannelsForPostType(post.post_type, [channel]);
    if (incompatible.length > 0) {
      throw new IncompatiblePostTargetError(
        `${describeChannel(channel)} can't publish a ${post.post_type} post.`
      );
    }
  }
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
  channel_color_hue: number | null;
  channel_avatar_path: string | null;
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
         c.color_hue    AS channel_color_hue,
         c.avatar_path  AS channel_avatar_path,
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
