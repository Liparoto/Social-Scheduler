import "server-only";
import type DatabaseType from "better-sqlite3";
import { getDb, nowIso } from "./db";
import { isBlocked } from "./format";
import { FINISHED_STATUSES_SQL } from "./queue-sections";
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
  PostTarget,
  PostType,
  Surface,
  Tag,
} from "./types";
import type { ChannelLikeForCompat, Platform } from "./platforms";
import { describeChannel, incompatibleChannelsForPostType, isPlatform } from "./platforms";
import {
  derivePostTypeFromKinds,
  type OtherAssetReferences,
  type Slide,
} from "./post-media-edit";
import { planMerge, type MergeCandidate, type MergeProblem } from "./merge-plan";
import {
  planUnmerge,
  planExtractSlides,
  type UnmergeCandidate,
  type UnmergeProblem,
} from "./unmerge-plan";
import { expandTarget } from "./story-fanout";
import type { BulkEditContext } from "./bulk-edit-context";
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
    bpp_every_days: number;
    bpp_strong_pct: number;
    bpp_broad_pct: number;
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

/** Ready, feed-targeted posts per time_of_day band, across a set of channels.
 *
 *  Feeds the auto-fill form's coverage warning: a band with content but no slot in the
 *  cadence means those posts silently stop being auto-filled, and the queue goes on looking
 *  healthy because untagged posts keep filling it.
 *
 *  Deliberately approximate — it does NOT re-run cooldown, period or caption-length
 *  eligibility. Making it exact would mean running the full selection pass on every page
 *  render to sharpen a number whose only job is "this band has content and nowhere to put it".
 */
export function getBandCounts(channelIds: number[]): Record<string, number> {
  if (channelIds.length === 0) return {};
  const placeholders = channelIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT t.name AS band, COUNT(DISTINCT p.id) AS n
         FROM posts p
         JOIN post_tags pt ON pt.post_id = p.id
         JOIN tags t ON t.id = pt.tag_id AND t.kind = 'time_of_day'
        WHERE p.content_status = 'ready'
          AND t.name IN ('morning','afternoon','evening')
          AND EXISTS (SELECT 1 FROM post_targets ptg
                       WHERE ptg.post_id = p.id
                         AND ptg.channel_id IN (${placeholders})
                         AND ptg.surface = 'feed')
        GROUP BY t.name`,
    )
    .all(...channelIds) as { band: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.band, r.n]));
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
    bpp_every_days: number;
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
/**
 * Persist a story framing choice. Both fields always move together — a mode without its
 * rendered path (or vice versa) would leave the asset describing a derivative that isn't
 * there. Always re-runnable: framing is never one-way.
 */
export function updateAssetStoryFraming(
  id: number,
  fields: { story_path: string | null; story_mode: "blurred" | "crop" }
): void {
  getDb()
    .prepare("UPDATE assets SET story_path = @story_path, story_mode = @story_mode WHERE id = @id")
    .run({ ...fields, id });
}

/**
 * Scheduled-but-unsent publications whose framing this asset governs. Posted sends are
 * excluded deliberately: changing framing cannot alter what is already on Instagram, and
 * saying otherwise would be a lie the dialog then tells the owner.
 */
export function countScheduledSendsForAsset(assetId: number): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM publications pub
           WHERE pub.status IN ('scheduled', 'pending_approval')
             AND (pub.asset_id = @assetId
                  OR (pub.asset_id IS NULL
                      AND EXISTS (SELECT 1 FROM post_assets pa
                                   WHERE pa.post_id = pub.post_id
                                     AND pa.asset_id = @assetId)))`
      )
      .get({ assetId }) as { n: number }
  ).n;
}

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

/** Point a video asset at an image asset to use as its Reels cover, or clear it. */
export function setAssetCoverImage(videoAssetId: number, coverAssetId: number | null): void {
  getDb()
    .prepare("UPDATE assets SET cover_asset_id = ? WHERE id = ?")
    .run(coverAssetId, videoAssetId);
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
  /**
   * How many VIDEO assets point at this one as their Reels cover (assets.cover_asset_id,
   * migration 0016). A second, entirely separate way to be referenced: a cover carries no
   * post_assets row, so post_count alone reports it as unused — and deleteAsset() then
   * refuses it anyway, because the foreign key vetoes. /media must treat this as usage.
   */
  cover_use_count: number;
  /**
   * EVERY post this asset is a slide in, in creation order — not one representative post.
   *
   * This replaced `first_post_id`/`first_post_status`, which were `MIN(pa.post_id)`: the
   * lowest-numbered post using the asset, picked by id with no relation to relevance, while
   * every other post collapsed into plain text on the page. An asset reused across posts —
   * the normal case for evergreen recycling — had most of its posts unreachable.
   *
   * Carries the whole caption, not a shortened label: trimming it to a line is the
   * renderer's decision, and keeping it whole leaves the query useful to other callers.
   */
  posts: AssetPostRef[];
}

/** One post an asset appears in, with enough to recognise it without opening it. */
export interface AssetPostRef {
  post_id: number;
  caption: string | null;
  status: string;
}

/**
 * Every asset with how many things reference it. The nested SELECT does the GROUP BY, then
 * the outer join resolves the post's status — an aggregate (MIN) can't be referenced from a
 * correlated subquery in the same SELECT list, so it has to happen one level up.
 *
 * TWO kinds of reference, counted separately because they mean different things to the page:
 *   - post_count      — post_assets rows: this asset is a slide in a post.
 *   - cover_use_count — assets.cover_asset_id: a video uses this image as its Reels cover.
 *
 * Both must be reported, and for one reason: /media decides whether to offer a Delete button
 * (and what to add up as reclaimable space) from what this returns, while deleteAsset() lets
 * ANY foreign key veto. Counting only post_assets is what made a cover show as "Unused" with
 * a Delete button that could only ever fail, its bytes inflating the reclaim total.
 *
 * The cover count is a correlated scalar subquery rather than another LEFT JOIN: joining a
 * second one-to-many table would multiply the post_assets rows and silently inflate
 * post_count. Not an aggregate over the join, so it needs no GROUP BY entry of its own.
 */
export function listAssetsWithUsage(): AssetWithUsage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.*,
              COUNT(pa.post_id) AS post_count,
              (SELECT COUNT(*) FROM assets cov WHERE cov.cover_asset_id = a.id)
                AS cover_use_count
         FROM assets a
         LEFT JOIN post_assets pa ON pa.asset_id = a.id
        GROUP BY a.id
        ORDER BY a.created_at DESC, a.id DESC`
    )
    .all() as (Omit<AssetWithUsage, "posts"> & { posts?: never })[];

  // ONE more query for the whole store, not one per asset. /media renders every asset on the
  // page, so a per-asset lookup is an N+1 that stays invisible until the store grows.
  //
  // Deliberately a second statement rather than a join onto the query above: joining a
  // one-to-many table into that GROUP BY is what would multiply the rows and corrupt
  // post_count, the same trap cover_use_count avoids by being a scalar subquery.
  const links = db
    .prepare(
      `SELECT pa.asset_id, p.id AS post_id, p.caption, p.status
         FROM post_assets pa
         JOIN posts p ON p.id = pa.post_id
        ORDER BY pa.asset_id, p.id`
    )
    .all() as ({ asset_id: number } & AssetPostRef)[];

  const byAsset = new Map<number, AssetPostRef[]>();
  for (const link of links) {
    const list = byAsset.get(link.asset_id);
    const ref = { post_id: link.post_id, caption: link.caption, status: link.status };
    if (list) list.push(ref);
    else byAsset.set(link.asset_id, [ref]);
  }

  return rows.map((row) => ({ ...row, posts: byAsset.get(row.id) ?? [] })) as AssetWithUsage[];
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

/**
 * True while any of this post's sends is mid-flight in the worker.
 *
 * The guard on reordering. Unlike merge — which refuses posted and publishing posts
 * because it DELETES posts and their queued sends — a reorder destroys nothing, so the
 * only genuinely dangerous moment is the one where the worker is reading post_assets for
 * this post right now to build a container. Reordering a 'posted' post is the whole point
 * for evergreen content, and reordering a 'scheduled' one is expected (the UI says so).
 */
export function postHasPublishingPublication(postId: number): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM publications WHERE post_id = ? AND status = 'publishing' LIMIT 1")
    .get(postId);
  return row !== undefined;
}

/**
 * Rewrite a post's slide order.
 *
 * `assetIds` MUST already have been checked against this post's current assets by
 * lib/asset-order.ts — this function trusts it completely and will happily write whatever
 * it is handed. Validation lives at the route because that is where the 400 is returned.
 *
 * DELETE-then-INSERT rather than a loop of UPDATEs, for the reason mergePostsIntoCarousel
 * documents: UNIQUE (post_id, sort_order) is checked per-row and immediately, so any
 * in-place shuffle collides at the first move. post_assets is (id, post_id, asset_id,
 * sort_order) and nothing references its id, so rebuilding the rows loses nothing. The
 * assets themselves are ON DELETE RESTRICT and are not reachable from here.
 */
export function reorderPostAssets(postId: number, assetIds: number[]): void {
  const db = getDb();
  const clear = db.prepare("DELETE FROM post_assets WHERE post_id = ?");
  const link = db.prepare(
    "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, ?)"
  );
  const touch = db.prepare("UPDATE posts SET updated_at = ? WHERE id = ?");
  const tx = db.transaction(() => {
    clear.run(postId);
    assetIds.forEach((assetId, index) => link.run(postId, assetId, index));
    touch.run(nowIso(), postId);
  });
  tx();
}

// ---- Adding and removing a post's slides ------------------------------------------
// The write half of lib/post-media-edit.ts. Every guard here is ON the write statement
// rather than in front of it, for the same reason deletePost()'s is: the worker may take
// this post live between the check and the write, and a slide list rewritten underneath a
// container being built is the one way this can publish something genuinely wrong.

/** A post's slides with the one extra field the media rules need: media_kind. */
export function getPostSlides(postId: number): Slide[] {
  return getDb()
    .prepare(
      `SELECT pa.asset_id AS asset_id, a.media_kind AS media_kind
         FROM post_assets pa JOIN assets a ON a.id = pa.asset_id
        WHERE pa.post_id = ? ORDER BY pa.sort_order ASC`
    )
    .all(postId) as Slide[];
}

/**
 * Has this post actually gone out, or is it going out right now?
 *
 * The same live-send definition deletePost() uses. Deliberately NOT posts.status, which
 * migrations/0001_init.sql documents as the coarse overview lifecycle hint: a post can sit
 * at status='scheduled' while one of its two sends is already on Instagram.
 */
export function postHasLiveSend(postId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM publications WHERE post_id = ? AND status IN ('posted','publishing') LIMIT 1"
    )
    .get(postId);
  return row !== undefined;
}

/**
 * The channels a media change on this post still has to satisfy: what it is targeted at,
 * plus what it already has queued. A send can exist without a target row and vice versa,
 * and either would fail at publish if the slide count outgrew it.
 *
 * An untargeted draft falls back to Instagram for the same reason mergeTargetPlatforms
 * does: 10 is the strictest carousel cap here, and a draft that isn't pointed anywhere yet
 * can be pointed anywhere later, so it has to satisfy the tightest limit rather than none.
 * That fallback row is synthetic — `id: 0` is never a real `channels.id` — and stands in
 * only long enough for `incompatiblePostError` to read its `platform`; nothing here ever
 * treats it as a real channel.
 */
export function getPostCompatChannels(postId: number): ChannelLikeForCompat[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT c.id AS id, c.platform AS platform, c.account_name AS account_name
         FROM channels c
        WHERE c.id IN (SELECT channel_id FROM post_targets WHERE post_id = @id)
           OR c.id IN (SELECT channel_id FROM publications
                        WHERE post_id = @id AND status <> 'canceled')`
    )
    .all({ id: postId }) as ChannelLikeForCompat[];
  return rows.length > 0 ? rows : [{ id: 0, platform: "instagram", account_name: "Instagram" }];
}

/** How many OTHER posts hold this asset — what makes "delete entirely" safe or not. */
export function countOtherPostsUsingAsset(postId: number, assetId: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM post_assets WHERE asset_id = ? AND post_id <> ?")
    .get(assetId, postId) as { n: number };
  return row.n;
}

/**
 * Scheduled or pending-approval sends pinned to THIS slide specifically —
 * publications.asset_id = assetId, the Story-send marker from migration 0014. What makes
 * removing a slide from a post unsafe: the worker would otherwise still publish this asset
 * as a Story for a post it is no longer part of.
 *
 * Deliberately narrower than countScheduledSendsForAsset() above, which also matches
 * asset_id IS NULL (a feed send). That NULL case is excluded here on purpose: a feed send
 * publishes whatever slides the post holds AT PUBLISH TIME rather than naming this asset,
 * so removing the slide from the post is exactly what a feed send is supposed to reflect —
 * blocking on it would refuse an edit that is actually safe. Only a direct asset_id match
 * means "this send goes out with THIS asset or not at all," which removing the slide would
 * silently break.
 */
export function countQueuedDirectSendsForSlide(postId: number, assetId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM publications
        WHERE post_id = ? AND asset_id = ? AND status IN ('scheduled', 'pending_approval')`
    )
    .get(postId, assetId) as { n: number };
  return row.n;
}

/**
 * Queued sends on this post that name ONE slide directly — publications.asset_id IS NOT
 * NULL, which is the Instagram Story fan-out from migration 0014 (one row per slide).
 *
 * The mirror of countQueuedDirectSendsForSlide() above, and a deliberately different
 * question: that one asks "is a queued send pinned to THIS asset", which is the right
 * question when removing a slide. Adding a slide has to ask "does this post have ANY
 * per-slide send queued", because the new slide is by definition the one with no
 * publications row — the fan-out happened at scheduling time and never re-runs.
 *
 * asset_id IS NULL (a feed send) is excluded for the same reason it is excluded there: a
 * feed send publishes whatever slides the post holds at publish time, so adding a slide is
 * exactly what it should pick up. Blocking on it would refuse a safe edit.
 */
export function countQueuedPerSlideSendsForPost(postId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM publications
        WHERE post_id = ? AND asset_id IS NOT NULL
          AND status IN ('scheduled', 'pending_approval')`
    )
    .get(postId) as { n: number };
  return row.n;
}

/**
 * Everything besides post_assets that references this asset row, counted BEFORE any write
 * so `mode=everywhere` can refuse honestly instead of letting SQLite raise a foreign-key
 * error the caller can only describe vaguely.
 *
 * Both of these are references the `DELETE FROM assets ... NOT EXISTS (post_assets)` guard
 * in removePostAsset() cannot see:
 *  - publications.asset_id — ON DELETE RESTRICT (migrations/0014_story_surface.sql). ANY
 *    status counts, not just the queued ones: a 'failed' or 'canceled' Story row restricts
 *    the delete just as hard, and 'failed' is the case this whole feature exists to serve.
 *  - assets.cover_asset_id — a video's custom cover image (migrations/0016_cover_asset.sql).
 */
export function countOtherAssetReferences(assetId: number): OtherAssetReferences {
  const db = getDb();
  const sends = db
    .prepare("SELECT COUNT(*) AS n FROM publications WHERE asset_id = ?")
    .get(assetId) as { n: number };
  const covers = db
    .prepare("SELECT COUNT(*) AS n FROM assets WHERE cover_asset_id = ?")
    .get(assetId) as { n: number };
  return { sends: sends.n, covers: covers.n };
}

/** Append slides to a post. `postType` comes from checkAddAssets — never re-derived here. */
export function addPostAssets(
  postId: number,
  assetIds: number[],
  postType: PostType
): "ok" | "has_live" {
  const db = getDb();
  const nextOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM post_assets WHERE post_id = ?"
  );
  // The NOT EXISTS is the guard: if a send went live since checkAddAssets ran, this
  // inserts 0 rows and the whole transaction rolls back.
  const link = db.prepare(
    `INSERT INTO post_assets (post_id, asset_id, sort_order)
     SELECT @post, @asset, @order
      WHERE NOT EXISTS (SELECT 1 FROM publications
                         WHERE post_id = @post AND status IN ('posted','publishing'))`
  );
  const retype = db.prepare("UPDATE posts SET post_type = ?, updated_at = ? WHERE id = ?");

  const tx = db.transaction(() => {
    let order = (nextOrder.get(postId) as { n: number }).n;
    for (const assetId of assetIds) {
      const info = link.run({ post: postId, asset: assetId, order });
      if (info.changes === 0) throw new LiveSendError();
      order += 1;
    }
    retype.run(postType, nowIso(), postId);
  });

  try {
    // .immediate(): this reads MAX(sort_order) and then writes based on what it read, so a
    // deferred transaction only holds together thanks to WAL snapshot isolation — under a
    // concurrent writer (the Python worker) the write-lock upgrade can fail with an opaque
    // SQLITE_BUSY_SNAPSHOT instead of a clean "has_live"/"ok". Same reasoning as
    // unmergeCarousel and extractSlidesFromCarousel. removePostAsset doesn't need this: its
    // first statement is the guarded DELETE, so it takes the write lock immediately.
    tx.immediate();
    return "ok";
  } catch (err) {
    if (err instanceof LiveSendError) return "has_live";
    throw err;
  }
}

/**
 * Remove one slide, optionally deleting the asset outright.
 *
 * Order inside the transaction matters: post_assets.asset_id is REFERENCES assets(id) ON
 * DELETE RESTRICT, so the link has to go first. And the asset DELETE carries its own
 * NOT EXISTS so a second post that picked this asset up mid-request cannot lose its file.
 *
 * Deleting the FILES is the caller's job, deliberately: it happens after this returns "ok",
 * so a failed row delete can never leave files deleted. Same order DELETE /api/assets/[id]
 * already uses.
 *
 * The hole a removal leaves in sort_order is closed by clearing and reinserting every
 * surviving row for the post — the same approach reorderPostAssets uses, and for the same
 * reason: UNIQUE (post_id, sort_order) is checked per-row and immediately, so an in-place
 * `sort_order = sort_order - 1` shuffle can collide with a row SQLite hasn't updated yet
 * depending on the order it visits rows in. Clear-and-reinsert never collides because
 * nothing is ever written to a sort_order another surviving row still occupies.
 *
 * A DELETE that matches 0 rows is ambiguous by itself — wrong assetId, wrong postId, or a
 * slide already removed, versus a slide that IS on the post but the live-send guard just
 * blocked. Those need different results (checkRemoveAsset already has a `not_on_post` code
 * for the first one), so a 0-row delete is followed by a plain existence check — safe to do
 * AFTER the DELETE attempt because that statement already took the write lock; it is not a
 * read-before-write that could race the worker the way addPostAssets's MAX(sort_order)
 * read does.
 */
export function removePostAsset(
  postId: number,
  assetId: number,
  postType: PostType,
  alsoDeleteAsset: boolean
): "ok" | "has_live" | "still_used" | "referenced_asset" | "not_found" {
  const db = getDb();
  const unlink = db.prepare(
    `DELETE FROM post_assets
      WHERE post_id = @post AND asset_id = @asset
        AND NOT EXISTS (SELECT 1 FROM publications
                         WHERE post_id = @post AND status IN ('posted','publishing'))`
  );
  const stillLinked = db.prepare(
    "SELECT 1 FROM post_assets WHERE post_id = ? AND asset_id = ?"
  );
  const remaining = db.prepare(
    "SELECT asset_id AS asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order ASC"
  );
  const clear = db.prepare("DELETE FROM post_assets WHERE post_id = ?");
  const relink = db.prepare(
    "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, ?)"
  );
  const dropAsset = db.prepare(
    `DELETE FROM assets
      WHERE id = @asset
        AND NOT EXISTS (SELECT 1 FROM post_assets WHERE asset_id = @asset)`
  );
  const retype = db.prepare("UPDATE posts SET post_type = ?, updated_at = ? WHERE id = ?");

  const tx = db.transaction(() => {
    if (unlink.run({ post: postId, asset: assetId }).changes === 0) {
      // The row is still there (guard rejected the delete) vs. it was never there.
      if (stillLinked.get(postId, assetId)) throw new LiveSendError();
      throw new NotFoundError();
    }
    // UNIQUE(post_id, sort_order) means the hole left behind must be closed, or the next
    // append lands on a number that is already taken.
    const survivors = remaining.all(postId) as { asset_id: number }[];
    clear.run(postId);
    survivors.forEach((row, index) => relink.run(postId, row.asset_id, index));
    if (alsoDeleteAsset && dropAsset.run({ asset: assetId }).changes === 0) {
      throw new StillUsedError();
    }
    retype.run(postType, nowIso(), postId);
  });

  try {
    tx();
    return "ok";
  } catch (err) {
    if (err instanceof LiveSendError) return "has_live";
    if (err instanceof StillUsedError) return "still_used";
    if (err instanceof NotFoundError) return "not_found";
    // dropAsset's own NOT EXISTS only covers post_assets. publications.asset_id (a Story
    // send pinned to one slide, migration 0014) and assets.cover_asset_id (migration 0016)
    // are ON DELETE RESTRICT/NO ACTION references the DELETE statement itself can't see, so
    // SQLite raises the FK error instead of the DELETE just no-opping.
    //
    // Reported SEPARATELY from "still_used" on purpose. "still_used" means the NOT EXISTS
    // matched a post_assets row that appeared mid-request — a real race, and the caller
    // says so. A foreign key is not that: nothing raced, the reference was there all along,
    // and countOtherAssetReferences() is meant to have caught it first. Folding the two
    // together is what let the route tell people "another post picked this file up while
    // you were editing" about a failed Story send that had sat there for a week.
    const code = (err as { code?: string }).code ?? "";
    if (code.startsWith("SQLITE_CONSTRAINT")) return "referenced_asset";
    throw err;
  }
}

/** Rollback signals. Thrown only inside the transactions above, never escaping this file. */
class LiveSendError extends Error {}
class StillUsedError extends Error {}
class NotFoundError extends Error {}

// ---- Posts + publications (the scheduling write) --------------------------------

/** Shared shape for the content-model side-tables a post can optionally arrive with. */
interface ContentModelInput {
  targets?: PostTarget[];
  content_kind?: ContentKind;
  content_status?: ContentStatus;
  cooldown_days?: number | null;
  caption_variants?: { platform: string | null; body: string; sort_order: number }[];
  period_links?: { periodId: number; mode: PeriodMode }[];
  tag_ids?: number[];
}

/** Writes the content-model side-table rows for a freshly-created post, INSIDE the caller's transaction. */
function insertContentModelRows(db: ReturnType<typeof getDb>, postId: number, data: ContentModelInput): void {
  if (data.targets?.length) {
    // OR IGNORE: a duplicate (channel, surface) pair in the input is harmless, not a 500.
    const insert = db.prepare(
      "INSERT OR IGNORE INTO post_targets (post_id, channel_id, surface) VALUES (?, ?, ?)"
    );
    for (const t of data.targets) insert.run(postId, t.channel_id, t.surface);
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
  targets: PostTarget[]; // channel + surface (feed/story), not just channel
  scheduled_at: string; // ISO UTC
  created_by?: string;
  /** "Post now" from the composer: force every publication straight to 'scheduled',
   *  bypassing each channel's requires_approval. See the comment at the status
   *  decision below for why this is intentional, not a bug. */
  skip_approval?: boolean;
}

/**
 * Create a post with its ordered assets and its publications: one PER TARGET, and for a
 * story target one per SLIDE (a 4-slide post aimed at Stories becomes 4 consecutive
 * Stories — there is no carousel Story in the API). See lib/story-fanout.ts.
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
      `INSERT INTO publications
         (post_id, channel_id, scheduled_at, status, created_by, surface, asset_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const publicationIds: number[] = [];
    for (const target of data.targets) {
      const ch = getChannel(target.channel_id);
      // Approval gates content nobody reviewed individually (queued/auto-filled sends).
      // "Post now" (skip_approval) means the person composing this post right now IS
      // the approver — clicking publish is the review. Don't "fix" this back to
      // honoring requires_approval for post_now; that would silently swallow the post
      // into pending_approval and it would never go out.
      const status = !data.skip_approval && ch?.requires_approval ? "pending_approval" : "scheduled";
      // One row for a feed target; one row PER SLIDE for a story target. Inserted in
      // slide order, which is what makes ascending publication id the publish order.
      for (const assetId of expandTarget(db, postId, target.surface)) {
        const info = insertPub.run(
          postId,
          target.channel_id,
          data.scheduled_at,
          status,
          data.created_by || null,
          target.surface,
          assetId
        );
        publicationIds.push(Number(info.lastInsertRowid));
      }
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
/**
 * The post type implied by a set of assets, when the caller did not state one.
 *
 * Asset COUNT alone is not enough, which is what this used to use: a lone video became
 * "single", so a bulk import of a video produced a post the publisher cannot send as a
 * Reel. `/api/posts/draft` had already worked around it by passing post_type explicitly,
 * but createDraftPostsBulk does not — that path is where the wrong type actually reached
 * the database.
 *
 * Reading media_kind fixes it at the derivation instead of at each caller, so the next
 * caller does not have to know.
 */
function derivePostType(db: DatabaseType.Database, assetIds: number[]): PostType {
  // The rule itself lives in lib/post-media-edit.ts so the add/remove endpoints and this
  // creation path can never disagree about what a post's type is. This function is only
  // the database half: fetch the kinds, then ask.
  if (assetIds.length === 0) return derivePostTypeFromKinds([]);
  // "image", "image" here are placeholders standing in only for the COUNT (2), not real
  // kinds — derivePostTypeFromKinds only checks kinds.length > 1 in this branch and never
  // inspects the values themselves, so a fake pair is harmless today. But if that function
  // ever needs to look at the actual kinds (e.g. to reject a carousel containing a video),
  // this call site must start fetching the real per-asset kinds instead of faking them.
  if (assetIds.length > 1) return derivePostTypeFromKinds(["image", "image"]);
  const row = db
    .prepare("SELECT media_kind FROM assets WHERE id = ?")
    .get(assetIds[0]) as { media_kind: string } | undefined;
  return derivePostTypeFromKinds([row?.media_kind ?? "image"]);
}

export function createDraftPost(input: CreateDraftInput): number {
  const db = getDb();
  const postType: PostType = input.post_type ?? derivePostType(db, input.asset_ids);
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
  targets?: PostTarget[];
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
          targets: shared.targets,
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

/**
 * Archive a post out of the Library, or bring it back.
 *
 * The answer to the one thing deletePost() can't do: a post with a live send is permanent
 * by design (erasing it would erase the record of something that is on Instagram), which
 * left test posts and mistakes cluttering the Library forever. Archiving hides the post
 * instead of destroying it — every publication, metric and insight stays exactly where it
 * was, and unarchiving is a single click.
 *
 * Deliberately NOT an automation gate, and deliberately unguarded:
 *  - Auto-fill eligibility still runs entirely off content_status, the switch that is
 *    visible in the UI and has always meant "may this be picked up". Archiving OFFERS to
 *    set it (the caller passes `also`, and the UI defaults that to 'retired'), so the
 *    post lands in a bucket you can see rather than behind a second, invisible rule.
 *  - There is no live-send guard here, unlike deletePost(): nothing is destroyed and
 *    nothing the worker is mid-flight with changes, so there is no race to lose. An
 *    already-scheduled send on an archived post still goes out — the Archive control says
 *    so on screen rather than silently cancelling a decision that was made on purpose.
 */
export function setPostArchived(
  id: number,
  archived: boolean,
  also?: { content_status?: ContentStatus; content_kind?: ContentKind }
): "ok" | "not_found" {
  const db = getDb();
  const fields: string[] = ["archived_at = @archived_at", "updated_at = @updated_at"];
  const params: Record<string, string | number | null> = {
    id,
    archived_at: archived ? nowIso() : null,
    updated_at: nowIso(),
  };
  // Only ever applied on the way IN. Unarchiving restores visibility and nothing else:
  // guessing which content_status a post had before it was archived would be inventing
  // an answer, and quietly making a retired post 'ready' again is the wrong guess to make.
  if (archived && also?.content_status) {
    fields.push("content_status = @content_status");
    params.content_status = also.content_status;
  }
  if (archived && also?.content_kind) {
    fields.push("content_kind = @content_kind");
    params.content_kind = also.content_kind;
  }
  const info = db
    .prepare(`UPDATE posts SET ${fields.join(", ")} WHERE id = @id`)
    .run(params);
  return info.changes > 0 ? "ok" : "not_found";
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
 * Everything planUnmerge needs about one post, in two cheap queries plus two EXISTS probes.
 * Not exported: the plan layer is the only consumer, and it must stay the only place that
 * decides what these booleans MEAN.
 */
function loadUnmergeCandidate(
  db: ReturnType<typeof getDb>,
  postId: number
): UnmergeCandidate | undefined {
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

  // Same live-send definition deletePost and loadMergeCandidate use: 'posted' means it exists
  // on the platform, 'publishing' means the worker is mid-flight with it right now.
  const live = db
    .prepare(
      `SELECT 1 FROM publications
        WHERE post_id = ? AND status IN ('posted','publishing') LIMIT 1`
    )
    .get(postId);

  // Deliberately a SEPARATE probe from `live`, not folded into one IN (...) list: a queued
  // send gets its own 409 with its own message, because unlike a published one it is
  // something the owner can actually resolve (cancel or hold it in queue control).
  const queued = db
    .prepare(
      `SELECT 1 FROM publications
        WHERE post_id = ? AND status IN ('scheduled','pending_approval') LIMIT 1`
    )
    .get(postId);

  return {
    post_id: post.id,
    post_type: post.post_type,
    status: post.status,
    has_live_publication: live !== undefined,
    has_queued_publication: queued !== undefined,
    slides,
  };
}

/**
 * Every channel the merged post could end up going to — the UNION across all merged posts,
 * because mergePostsIntoCarousel unions their post_targets onto the survivor. Two callers
 * need it: the carousel size cap (via mergeTargetPlatforms) and planMerge's guard 8, which
 * measures the caption against each of these platforms' limits.
 *
 * Empty is a real answer here, unlike for the cap below: targets are optional, so a merge of
 * freshly composed drafts legitimately targets nothing yet. No channels means no caption limit
 * applies — and note that is not a hole, because the conservative Instagram fallback the cap
 * uses would say the same thing: Instagram enforces no caption limit in platforms.ts.
 */
function mergeTargetChannels(
  db: ReturnType<typeof getDb>,
  postIds: number[]
): ChannelLikeForCompat[] {
  if (postIds.length === 0) return [];
  const placeholders = postIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT DISTINCT c.id, c.platform, c.account_name
         FROM post_targets pt JOIN channels c ON c.id = pt.channel_id
        WHERE pt.post_id IN (${placeholders})`
    )
    .all(...postIds) as ChannelLikeForCompat[];
}

/**
 * The distinct platforms those channels belong to — planMerge caps the carousel at the
 * STRICTEST of these (Instagram 10, Threads 20).
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
function mergeTargetPlatforms(channels: ChannelLikeForCompat[]): Platform[] {
  const platforms = [...new Set(channels.map((c) => c.platform))].filter(isPlatform);
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

    // One read, two uses: the size cap needs the platforms, guard 8 needs the channels
    // themselves (a caption limit is per platform, but captionLimitError names the account).
    // This is the union across EVERY merged post, which is what post_targets becomes below.
    const targetChannels = mergeTargetChannels(db, merged);
    const plan = planMerge(
      candidates,
      { post_ids: postIds, asset_order: assetOrder },
      mergeTargetPlatforms(targetChannels),
      { caption, channels: targetChannels }
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

/** The original's content model, read ONCE before any new post is written. */
interface CarouselSourceRows {
  source: {
    caption: string | null;
    first_comment: string | null;
    content_kind: string;
    content_status: string;
    cooldown_days: number | null;
    created_by: string | null;
  };
  variants: { platform: string | null; body: string; sort_order: number }[];
  targets: { channel_id: number; surface: string }[];
  tags: { tag_id: number }[];
  periods: { period_id: number; mode: string }[];
}

/** Everything a new post inherits from the carousel it came out of, read in one place. */
function readCarouselSourceRows(
  db: ReturnType<typeof getDb>,
  postId: number
): CarouselSourceRows {
  return {
    source: db
      .prepare(
        `SELECT caption, first_comment, content_kind, content_status, cooldown_days, created_by
           FROM posts WHERE id = ?`
      )
      .get(postId) as CarouselSourceRows["source"],
    variants: db
      .prepare("SELECT platform, body, sort_order FROM caption_variants WHERE post_id = ?")
      .all(postId) as CarouselSourceRows["variants"],
    targets: db
      .prepare("SELECT channel_id, surface FROM post_targets WHERE post_id = ?")
      .all(postId) as CarouselSourceRows["targets"],
    tags: db.prepare("SELECT tag_id FROM post_tags WHERE post_id = ?")
      .all(postId) as CarouselSourceRows["tags"],
    periods: db
      .prepare("SELECT period_id, mode FROM post_periods WHERE post_id = ?")
      .all(postId) as CarouselSourceRows["periods"],
  };
}

/**
 * Create one new single-slide draft post per part, each carrying a COPY of the carousel's
 * content model. Returns the new ids in the order the parts were given.
 *
 * Shared by unmergeCarousel and extractSlidesFromCarousel. They must copy IDENTICALLY — the
 * promise of both operations is that a resulting post is a fully-formed post — and one helper
 * is what guarantees they cannot drift apart as fields are added later.
 *
 * Callers must read `rows` BEFORE any of this runs; re-reading per post would start picking
 * up the rows this loop itself inserts.
 */
function spawnPostsFromSlides(
  db: ReturnType<typeof getDb>,
  parts: { asset_id: number; post_type: PostType }[],
  rows: CarouselSourceRows,
  now: string
): number[] {
  const insertPost = db.prepare(
    `INSERT INTO posts (caption, first_comment, post_type, status, content_kind,
                        content_status, cooldown_days, created_by, updated_at)
     VALUES (@caption, @first_comment, @post_type, 'draft', @content_kind,
             @content_status, @cooldown_days, @created_by, @now)`
  );
  const insertSlide = db.prepare(
    "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, 0)"
  );
  const insertVariant = db.prepare(
    "INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?, ?, ?, ?)"
  );
  const insertTarget = db.prepare(
    "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?, ?, ?)"
  );
  const insertTag = db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)");
  const insertPeriod = db.prepare(
    "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?, ?, ?)"
  );

  const created: number[] = [];
  for (const part of parts) {
    // status is hardcoded 'draft' in the statement above: a brand-new post has no
    // publications, and 'draft' is what that means. Copying the original's status would
    // claim a send history this post does not have.
    const newId = Number(
      insertPost.run({
        caption: rows.source.caption,
        first_comment: rows.source.first_comment,
        post_type: part.post_type,
        content_kind: rows.source.content_kind,
        content_status: rows.source.content_status,
        cooldown_days: rows.source.cooldown_days,
        created_by: rows.source.created_by,
        now,
      }).lastInsertRowid
    );
    insertSlide.run(newId, part.asset_id);
    // posts.caption and caption_variants always move together: the worker reads variants in
    // preference to posts.caption, so copying one without the other would publish text the
    // post record says isn't there.
    for (const v of rows.variants) insertVariant.run(newId, v.platform, v.body, v.sort_order);
    for (const t of rows.targets) insertTarget.run(newId, t.channel_id, t.surface);
    for (const t of rows.tags) insertTag.run(newId, t.tag_id);
    for (const p of rows.periods) insertPeriod.run(newId, p.period_id, p.mode);
    created.push(newId);
  }
  return created;
}

/**
 * Split one carousel into separate posts — the return trip for mergePostsIntoCarousel.
 *
 * The ORIGINAL post survives and keeps slide 1, along with its id, its publications, and the
 * metrics hanging off them. Each remaining slide becomes a NEW draft post carrying a COPY of
 * the original's caption, caption variants, channel targets (surface included), tags, and
 * season links. Copies, not moves: editing one afterwards does not change the others, which
 * is what the confirm modal's "each keeps" promises.
 *
 * **Assets are shared, never copied.** They are deduped by content hash, so every resulting
 * post references the same `assets` row. Nothing is written to /data, and no asset row is
 * created, changed, or deleted by this function.
 *
 * **Each post's `post_type` is derived from its OWN asset's media_kind** (a video slide
 * becomes a 'reel'), never from asset count. This deliberately does NOT go through
 * createDraftPost, which derives post_type from count alone and would leave a video slide as
 * an unpublishable 'single'.
 *
 * Returns the plan's own problem (with its HTTP status) on rejection, having written nothing.
 * `post_ids[0]` is always `postId`.
 */
export function unmergeCarousel(
  postId: number
): { ok: true; post_ids: number[] } | { ok: false; problem: UnmergeProblem } {
  const db = getDb();
  const tx = db.transaction(():
    | { ok: true; post_ids: number[] }
    | { ok: false; problem: UnmergeProblem } => {
    const plan = planUnmerge(loadUnmergeCandidate(db, postId));
    // Rejected: return before a single write happens. (The transaction commits empty.)
    if (!plan.ok) return { ok: false, problem: plan.problem };

    const now = nowIso();
    const [first, ...rest] = plan.parts;

    // Read the source ONCE, before anything is written. Re-reading per child would also
    // start picking up rows the loop itself just inserted.
    const rows = readCarouselSourceRows(db, postId);

    // post_assets carries no data worth preserving — (id, post_id, asset_id, sort_order), and
    // nothing references its id. UNIQUE (post_id, sort_order) is checked per-row and
    // IMMEDIATELY, and the original's sort_order values are not guaranteed contiguous from
    // zero, so rather than reasoning about which rows can safely stay, every row is deleted
    // and the one slide the original keeps is rebuilt at 0. Same resolution
    // mergePostsIntoCarousel uses, for the same reason.
    db.prepare("DELETE FROM post_assets WHERE post_id = ?").run(postId);
    db.prepare("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, 0)").run(
      postId,
      first.asset_id
    );
    // Retyped from slide 1's OWN media_kind — not assumed to be 'single'. Everything else on
    // the original (status, caption, variants, targets, tags, periods, publications) is
    // deliberately untouched.
    db.prepare("UPDATE posts SET post_type = ?, updated_at = ? WHERE id = ?").run(
      first.post_type,
      now,
      postId
    );

    const created = spawnPostsFromSlides(db, rest, rows, now);

    return { ok: true, post_ids: [postId, ...created] };
  });
  // .immediate() takes the write lock at BEGIN instead of on the first write statement. This
  // function reads the rows it validates (loadUnmergeCandidate) and then writes based on what
  // it read, so a deferred transaction would hold together only thanks to WAL snapshot
  // isolation — and under a concurrent writer it would surface as an opaque SQLITE_BUSY
  // partway through the split rather than a clean rejection. Same reasoning as
  // mergePostsIntoCarousel.
  return tx.immediate();
}

/**
 * Pull selected slides out of a carousel as their own posts, leaving the rest a carousel.
 *
 * The narrower half of unmergeCarousel. The ORIGINAL survives and keeps every slide that was
 * NOT selected, along with its id, its publications, and the metrics hanging off them. Each
 * selected slide becomes a NEW draft post carrying a COPY of the original's content model —
 * the same copy unmergeCarousel makes, via the same helper, so the two cannot drift.
 *
 * **Assets are shared, never copied.** Nothing is written to /data, and no `assets` row is
 * created, changed, or deleted.
 *
 * Returns the plan's own problem (with its HTTP status) on rejection, having written nothing.
 * `post_ids[0]` is always `postId`; the rest are the extracted posts in carousel order.
 *
 * Throws (rather than returning a problem) if the database itself fails mid-transaction —
 * better-sqlite3 rolls the whole thing back, which is what puts the original's slides back.
 */
export function extractSlidesFromCarousel(
  postId: number,
  assetIds: number[]
): { ok: true; post_ids: number[] } | { ok: false; problem: UnmergeProblem } {
  const db = getDb();
  const tx = db.transaction(():
    | { ok: true; post_ids: number[] }
    | { ok: false; problem: UnmergeProblem } => {
    const plan = planExtractSlides(loadUnmergeCandidate(db, postId), assetIds);
    // Rejected: return before a single write happens. (The transaction commits empty.)
    if (!plan.ok) return { ok: false, problem: plan.problem };

    const now = nowIso();
    // Read the source ONCE, before anything is written — re-reading per extracted post would
    // start picking up the rows the loop itself inserts.
    const rows = readCarouselSourceRows(db, postId);

    // The keepers must come out CONTIGUOUS from 0. `post_assets` has
    // UNIQUE (post_id, sort_order) checked per-row and immediately, so renumbering in place
    // collides with itself the moment a survivor moves onto a number a later survivor still
    // holds. A join row is (id, post_id, asset_id, sort_order) and nothing references its id,
    // so every row is deleted and the keepers are rebuilt — the same resolution merge and the
    // full split use, and the reason this operation could not reuse the split's "rebuild one
    // row at 0" shortcut.
    db.prepare("DELETE FROM post_assets WHERE post_id = ?").run(postId);
    const keep = db.prepare(
      "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?, ?, ?)"
    );
    plan.keeperAssetIds.forEach((assetId, i) => keep.run(postId, assetId, i));

    // Retyped from what it is LEFT holding: two or more keepers stay a carousel, a lone
    // survivor takes its own asset's type. Everything else on the original — status, caption,
    // variants, targets, tags, periods, publications — is deliberately untouched.
    db.prepare("UPDATE posts SET post_type = ?, updated_at = ? WHERE id = ?").run(
      plan.originalType,
      now,
      postId
    );

    const created = spawnPostsFromSlides(db, plan.extracted, rows, now);
    return { ok: true, post_ids: [postId, ...created] };
  });
  // .immediate(): this reads the rows it validates and then writes based on what it read, so
  // a deferred transaction would surface a concurrent writer as an opaque SQLITE_BUSY partway
  // through rather than a clean rejection. Same reasoning as unmergeCarousel.
  return tx.immediate();
}

/** A post's publications joined with their channel, for the edit screen's per-channel queue view. */
export function getPostPublications(postId: number): PostPublicationRow[] {
  return getDb()
    .prepare(
      `SELECT pub.id, pub.channel_id, pub.scheduled_at, pub.status, pub.is_held,
              pub.is_dry_run, pub.remote_post_id, pub.surface,
              pub.first_comment_status, pub.first_comment_error,
              pub.first_comment_retry_requested,
              c.account_name AS channel_name, c.platform AS channel_platform,
              c.timezone AS channel_timezone, c.color_hue AS channel_color_hue,
              c.avatar_path AS channel_avatar_path,
              pub.published_at,
              -- How THIS run did. Latest snapshot per publication, via a correlated
              -- lookup rather than a join on post_metrics: metrics are a time series, and
              -- joining them would return one row per refresh and show the same send
              -- several times over.
              --
              -- Per RUN, not per post, and that is the point: reposting only earns its
              -- place if you can see whether run two beat run one.
              pm.reach, pm.impressions, pm.likes, pm.comments, pm.saves, pm.shares,
              -- WHETHER we have numbers, which is a different question from whether any
              -- single metric came back. Platforms do not report the same set: Threads has
              -- no reach at all, and Facebook's is best-effort. Reading "has metrics" off
              -- one column marks a whole platform as never-fetched.
              pm.fetched_at AS metrics_fetched_at,
              -- Whether the post this run created is still on the platform. NULL means we
              -- have no mirror row for it at all — which is the normal case for a Story
              -- (they are not on the /media edge) and for anything published before this
              -- install started syncing. Absence is not deletion, and the UI must not
              -- present it as such.
              --
              -- TWO detection paths, ONE fact, so the page keeps showing one badge:
              --   * rm.is_deleted — media_sync noticed the post vanish from the account's
              --     media list. Inference from absence, and it needs a mirror row to exist.
              --   * publications.remote_missing_at — the metrics fetch asked about the post
              --     and the platform said it is not there. First-hand, and it works where
              --     the sync cannot: a post deleted before it was ever synced has no mirror
              --     row, so absence-based inference has nothing to notice it missing FROM.
              -- The direct evidence wins; rm.is_deleted still answers when it has not spoken.
              CASE WHEN pub.remote_missing_at IS NOT NULL THEN 1 ELSE rm.is_deleted END
                AS removed_from_platform
       FROM publications pub
       JOIN channels c ON c.id = pub.channel_id
       LEFT JOIN remote_media rm ON rm.publication_id = pub.id
       LEFT JOIN post_metrics pm ON pm.id = (
         SELECT id FROM post_metrics WHERE publication_id = pub.id
         ORDER BY fetched_at DESC, id DESC LIMIT 1)
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
  // How many of those targets are Instagram Stories. >0 means this post is designated
  // for Stories — a DESTINATION, which is why it can't be read off post_type.
  story_target_count: number;
  periods: PostLibraryPeriod[];
  time_of_day_tags: string | null;
  topic_tags: string | null;
  // The same tags again, as ids rather than names — the name lists above are for display,
  // but quick edit has to seed <TagEditor>, which works in tag ids. Names can't be mapped
  // back safely (nothing stops a time_of_day and a topic tag sharing a name).
  tag_ids_csv: string | null;
  target_platforms: string | null;
  // Distinct from scheduled_count (which also counts 'publishing'): specifically the
  // statuses that mergePostsIntoCarousel's cascade DELETE would silently wipe out for a
  // non-surviving post. 'posted'/'publishing' posts are already refused by the merge API,
  // so those don't belong in this warning — see the merge modal's queued-send notice.
  queued_publication_count: number;
  // Sends that reached the platform: 'posted' or 'publishing' — postHasLiveSend()'s rule,
  // batched into the list query so quick edit can gate its media controls without a
  // per-row fetch. Deliberately NOT posted_count, which misses a send mid-flight, and NOT
  // posts.status, which migrations/0001_init.sql documents as a coarse overview hint.
  live_send_count: number;
}

export interface PostLibraryPeriod extends PeriodWindow {
  id: number;
  name: string;
  mode: PeriodMode;
}

/**
 * Every post in the library, newest first.
 *
 * `limit` is OPTIONAL and unset means unlimited. It used to default to 200, which the
 * Library and Compose both silently inherited: an install with 419 posts showed 200 and
 * said nothing, and because the order is `created_at DESC` the 219 it dropped were the
 * OLDEST — on a multi-account install that quietly swallowed a second account's entire
 * back catalogue. The filters and the search on top of this are client-side, so a post
 * that never arrives reads as a post that does not exist.
 *
 * A few thousand rows is nothing for better-sqlite3, and the card grid lazy-loads its
 * thumbnails, so the honest default is "all of them".
 */
/**
 * Which side of the archive line a listing wants.
 *
 * 'active' is every caller's default and the Library's normal view. 'archived' is the
 * Library's Archived view, and 'all' exists so ONE query can feed a page that offers both
 * without a second round trip. See migrations/0023_archive_library.sql — this is a
 * visibility split, never an eligibility one.
 */
export type LibraryScope = "active" | "archived" | "all";

const LIBRARY_SCOPE_SQL: Record<LibraryScope, string> = {
  active: "WHERE p.archived_at IS NULL",
  archived: "WHERE p.archived_at IS NOT NULL",
  all: "WHERE 1 = 1",
};

export function listPosts(limit?: number, scope: LibraryScope = "active"): PostLibraryRow[] {
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
         (SELECT COUNT(*) FROM post_targets pt WHERE pt.post_id = p.id
            AND pt.surface = 'story') AS story_target_count,
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'time_of_day') AS time_of_day_tags,
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'topic') AS topic_tags,
         (SELECT GROUP_CONCAT(pt.tag_id) FROM post_tags pt
            WHERE pt.post_id = p.id) AS tag_ids_csv,
         (SELECT GROUP_CONCAT(DISTINCT c.platform) FROM post_targets pt2
            JOIN channels c ON c.id = pt2.channel_id WHERE pt2.post_id = p.id) AS target_platforms,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status IN ('scheduled','pending_approval')) AS queued_publication_count,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status IN ('posted','publishing')) AS live_send_count
       FROM posts p
       ${LIBRARY_SCOPE_SQL[scope]}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`
    )
    // SQLite reads a negative LIMIT as "no upper bound", which keeps this one prepared
    // statement serving both the capped and the uncapped call.
    .all(limit ?? -1) as Omit<PostLibraryRow, "periods">[];

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

/**
 * Everything the quick-edit dialog needs about ONE post, for a caller that has only a
 * post id.
 *
 * The Library gets these fields free — `listPosts` already computes them for every card,
 * and its dialog is handed the row it was opened from. The Overview queue can't do that:
 * a queue row is a SEND, so it carries `post_id` and send-shaped data and none of the
 * post's content model. Widening PUBLICATION_ROW_SELECT to cover it would ship a post's
 * tags and period links once per send — four times over for a four-slide story — on a
 * page that already renders the whole queue, all to serve a dialog that opens one post
 * at a time.
 *
 * So: the same subqueries as `listPosts`, for a single post, read when a dialog actually
 * opens. Deliberately mirrors the shape `listPosts` produces (CSV columns and all) so the
 * two callers hand the dialog the same thing and can't drift into disagreeing about what
 * a post's tags are.
 */
export interface PostQuickEditRow {
  id: number;
  caption: string | null;
  post_type: PostType;
  content_status: ContentStatus;
  content_kind: ContentKind;
  cooldown_days: number | null;
  tag_ids: number[];
  /** Every link as stored — a period appears twice when it has both modes. */
  periods: { id: number; mode: PeriodMode }[];
  /** Distinct platforms this post targets, i.e. what a generic caption is held to. */
  target_platforms: string[];
  asset_count: number;
  /**
   * Sends still genuinely queued. Excludes 'publishing' for the same reason the Library's
   * copy does: a send already mid-publish can't be reordered or re-read, so counting it
   * would overstate what an edit can still reach.
   */
  queued_publication_count: number;
  /**
   * Has any send actually reached the platform — 'posted' or 'publishing'? The same
   * live-send rule postHasLiveSend() enforces server-side, carried to the quick-edit
   * dialog so its media strip can disable controls the server would only refuse.
   */
  has_live_send: boolean;
}

export function getPostQuickEdit(postId: number): PostQuickEditRow | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.id, p.caption, p.post_type, p.content_status, p.content_kind,
              p.cooldown_days,
         (SELECT COUNT(*) FROM post_assets pa WHERE pa.post_id = p.id) AS asset_count,
         (SELECT GROUP_CONCAT(pt.tag_id) FROM post_tags pt
            WHERE pt.post_id = p.id) AS tag_ids_csv,
         (SELECT GROUP_CONCAT(DISTINCT c.platform) FROM post_targets pt2
            JOIN channels c ON c.id = pt2.channel_id WHERE pt2.post_id = p.id)
              AS target_platforms,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status IN ('scheduled','pending_approval'))
              AS queued_publication_count,
         (SELECT COUNT(*) FROM publications pub WHERE pub.post_id = p.id
            AND pub.status IN ('posted','publishing')) AS live_send_count
       FROM posts p
      WHERE p.id = ?`
    )
    .get(postId) as
    | {
        id: number;
        caption: string | null;
        post_type: PostType;
        content_status: ContentStatus;
        content_kind: ContentKind;
        cooldown_days: number | null;
        asset_count: number;
        tag_ids_csv: string | null;
        target_platforms: string | null;
        queued_publication_count: number;
        live_send_count: number;
      }
    | undefined;
  if (!row) return undefined;

  // ORDER BY mode matters, and only looks cosmetic. A post can hold BOTH a green and a
  // blackout link on the same period (post_periods' PK is (post_id, period_id, mode), and
  // bulk edit and carousel merges both produce it), and the dialog's one-mode-per-period
  // control collapses that with LATER ROWS WINNING. Unordered, the winner is whatever the
  // query planner happened to emit, so the Overview could show Blackout for a period the
  // Library shows as Green. `pp.mode ASC` is the order listPosts already uses — matching
  // it is what keeps the two dialogs saying the same thing about the same post.
  const periods = db
    .prepare(
      "SELECT period_id, mode FROM post_periods WHERE post_id = ? ORDER BY period_id ASC, mode ASC"
    )
    .all(postId) as { period_id: number; mode: PeriodMode }[];

  // GROUP_CONCAT gives NULL for no rows and never an empty string, so the guard is enough
  // — ''.split(',') would otherwise yield [''] and, for the tags, [NaN].
  const csv = (value: string | null) => (value ? value.split(",") : []);

  return {
    id: row.id,
    caption: row.caption,
    post_type: row.post_type,
    content_status: row.content_status,
    content_kind: row.content_kind,
    cooldown_days: row.cooldown_days,
    asset_count: row.asset_count,
    tag_ids: csv(row.tag_ids_csv).map(Number),
    target_platforms: csv(row.target_platforms),
    queued_publication_count: row.queued_publication_count,
    has_live_send: row.live_send_count > 0,
    periods: periods.map((p) => ({ id: p.period_id, mode: p.mode })),
  };
}

export interface BulkEntry {
  post_id: number;
  channel_id: number;
  scheduled_at: string; // UTC ISO
  status: "scheduled" | "pending_approval";
  /** Defaults to 'feed' so callers with no surface concept keep working unchanged. */
  surface?: Surface;
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

/** Create many publications atomically and flip their posts out of 'draft'.
 *
 * A story entry fans out to one publication PER SLIDE here rather than at the call site,
 * so every route that schedules through this path gets the rule for free and none of them
 * can forget it. See lib/story-fanout.ts. */
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
      `INSERT INTO publications
         (post_id, channel_id, scheduled_at, status, created_by, surface, asset_id)
       VALUES (?, ?, ?, ?, 'bulk', ?, ?)`
    );
    const undraft = db.prepare(
      "UPDATE posts SET status = 'scheduled' WHERE id = ? AND status = 'draft'"
    );
    let created = 0;
    for (const r of rows) {
      const surface = r.surface ?? "feed";
      for (const assetId of expandTarget(db, r.post_id, surface)) {
        insert.run(r.post_id, r.channel_id, r.scheduled_at, r.status, surface, assetId);
        created += 1;
      }
      undraft.run(r.post_id);
    }
    // The COUNT of publications, not of entries: one story entry becomes several sends.
    return created;
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
  /** Describes first_asset_id — i.e. a story send's OWN slide, not the post's first. */
  first_asset_media_kind: "image" | "video" | null;
  first_asset_cover_frame_ms: number | null;
  first_asset_width: number | null;
  first_asset_height: number | null;
  /** 1-based slide number for a story send, NULL for a feed send. Lets the queue say
   *  "Story 2 of 4" instead of the post's type, which describes the SOURCE not this send. */
  story_slide_no: number | null;
  m_reach: number | null;
  m_saves: number | null;
  m_likes: number | null;
  m_comments: number | null;
  m_shares: number | null;
  m_impressions: number | null;
  m_fetched_at: string | null;
}

/**
 * Ids of sends that tried, couldn't get out, and will try again (see isBlocked).
 *
 * Lives here rather than in the page because reading the clock is request-time data, the
 * same as every other query in this file — doing it inside a component's render is an
 * impure call, and React's lint rule is right to reject it. One clock read for the whole
 * request, so the queue's badges and the overview's counter cannot disagree.
 */
export function blockedPublicationIds(pubs: PublicationRow[]): number[] {
  const now = Date.now();
  return pubs.filter((p) => isBlocked(p, now)).map((p) => p.id);
}

/**
 * Everything a queue or calendar row needs, in one shape.
 *
 * Shared rather than copied because the Overview and the calendar must agree about what a
 * send IS — the same thumbnail, the same channel, the same metrics. Two hand-maintained
 * copies of a forty-line SELECT drift, and the drift shows up as one screen quietly
 * missing a column the other has. Callers append their own WHERE and ORDER BY.
 */
const PUBLICATION_ROW_SELECT = `
      SELECT
         pub.*,
         p.caption   AS post_caption,
         p.post_type AS post_type,
         c.account_name AS channel_name,
         c.platform     AS channel_platform,
         c.timezone     AS channel_timezone,
         c.color_hue    AS channel_color_hue,
         c.avatar_path  AS channel_avatar_path,
         (SELECT COUNT(*) FROM post_assets pa WHERE pa.post_id = p.id) AS asset_count,
         -- A story send shows ITS OWN slide, not the post's first asset — otherwise
         -- slide 3 of a carousel would show slide 1's thumbnail.
         COALESCE(pub.asset_id,
           (SELECT pa.asset_id FROM post_assets pa
              WHERE pa.post_id = p.id ORDER BY pa.sort_order ASC LIMIT 1)) AS first_asset_id,
         (SELECT pa.sort_order + 1 FROM post_assets pa
            WHERE pa.post_id = p.id AND pa.asset_id = pub.asset_id) AS story_slide_no,
         -- Enough to open this send in the lightbox without a round trip. Joined off the
         -- SAME resolved asset as first_asset_id above (fa), so a story send describes
         -- its own slide rather than the post's first one.
         fa.media_kind     AS first_asset_media_kind,
         fa.cover_frame_ms AS first_asset_cover_frame_ms,
         fa.width          AS first_asset_width,
         fa.height         AS first_asset_height,
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
       -- The COALESCE is repeated rather than aliased because SQLite cannot reference a
       -- SELECT alias from a JOIN clause. It must stay identical to first_asset_id above.
       LEFT JOIN assets fa ON fa.id = COALESCE(pub.asset_id,
         (SELECT pa.asset_id FROM post_assets pa
            WHERE pa.post_id = p.id ORDER BY pa.sort_order ASC LIMIT 1))
       LEFT JOIN post_metrics lm ON lm.id = (
         SELECT pm.id FROM post_metrics pm
         WHERE pm.publication_id = pub.id
         ORDER BY pm.fetched_at DESC, pm.id DESC LIMIT 1
       )`;

export function getPublicationsOverview(limit = 200): PublicationRow[] {
  return getDb()
    .prepare(
      `${PUBLICATION_ROW_SELECT}
       ORDER BY
         -- Live work first, most urgent kind first, then the history block. 'posted' and
         -- 'canceled' share the last rank because both are over; everything above is still
         -- waiting on something. An unrecognised status lands at 4 — just above the
         -- history block rather than inside it — so a status added to the schema and
         -- forgotten here surfaces among live work instead of being buried (the same
         -- fallback direction as lib/queue-sections.isFinished, which labels these).
         CASE pub.status
           WHEN 'failed'           THEN 0
           WHEN 'publishing'       THEN 1
           WHEN 'pending_approval' THEN 2
           WHEN 'scheduled'        THEN 3
           WHEN 'posted'           THEN 5
           WHEN 'canceled'         THEN 5
           ELSE 4
         END,
         -- Both the clock and the DIRECTION depend on the rank above.
         --
         -- Clock: place a send by when it ACTUALLY went out, falling back to when it is
         -- due. published_at is only ever written on the transition to 'posted', so the
         -- COALESCE selects itself. Sorting a delayed post by its original slot put it
         -- back among the posts it was PLANNED beside instead of the ones it actually
         -- landed among — the same lie the WHEN column told before lib/send-time.
         --
         -- Direction: upcoming work runs forward, because the next thing to happen is the
         -- thing you care about. Finished work runs backward, because history reads newest
         -- first — otherwise the post that just went out sits below every older one.
         --
         -- Two keys rather than one, since SQLite cannot flip direction per group. Each is
         -- NULL for the rows it does not govern, and the split is the SAME one the section
         -- headings use (lib/queue-sections.FINISHED_STATUSES, interpolated so the two
         -- cannot drift), so within any one block the key that applies is the only one
         -- that varies and the other is a constant that cannot disturb it.
         CASE WHEN pub.status NOT IN (${FINISHED_STATUSES_SQL})
              THEN COALESCE(pub.published_at, pub.scheduled_at) END ASC,
         CASE WHEN pub.status IN (${FINISHED_STATUSES_SQL})
              THEN COALESCE(pub.published_at, pub.scheduled_at) END DESC,
         -- Tie-break, and load-bearing for Stories: the slides of one fan-out share a
         -- scheduled_at, and when they publish in a single worker cycle they share a
         -- published_at too. Ascending id is slide order (slides are inserted in
         -- sort_order); without this, tied rows come back in whatever order the query
         -- plan happens to produce, which is luck rather than a guarantee. It stays
         -- ascending inside the newest-first block too: slide 1 → 2 → 3 reads the same
         -- way wherever the Story itself sits.
         pub.id ASC
       LIMIT ?`
    )
    .all(limit) as PublicationRow[];
}

/**
 * Sends whose effective moment falls in [startIso, endIso) — the calendar's data.
 *
 * "Effective moment" is the same COALESCE the queue sorts by: a posted send is placed by
 * when it actually went out, everything else by when it is due. Filtering on scheduled_at
 * alone would drop a post that slipped into the range from the day before, and show a
 * ghost of it on a day it never appeared.
 *
 * Ordered by that moment ascending regardless of status. The queue's two-directional sort
 * exists to put live work at the top of a list; a grid has no top, and a day cell reading
 * backwards would be nonsense.
 *
 * The CALLER widens the range. A channel-local date can resolve outside the UTC window
 * that produced it (an evening send in New York is already tomorrow in UTC), so the page
 * asks for a day's slack at each end and lets bucketByDay discard what falls outside.
 */
export function getPublicationsInRange(startIso: string, endIso: string): PublicationRow[] {
  return getDb()
    .prepare(
      `${PUBLICATION_ROW_SELECT}
       WHERE COALESCE(pub.published_at, pub.scheduled_at) >= @start
         AND COALESCE(pub.published_at, pub.scheduled_at) <  @end
       ORDER BY COALESCE(pub.published_at, pub.scheduled_at) ASC, pub.id ASC`
    )
    .all({ start: startIso, end: endIso }) as PublicationRow[];
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

/**
 * Cancel a retry backoff so a waiting send goes out on the next poll.
 *
 * Narrower than it sounds, and deliberately so. The only rows this can touch are ones the
 * worker ALREADY committed to retrying on its own: `scheduled` with a `next_retry_at` it
 * wrote on the way out of a failed attempt. Clearing that timestamp changes WHEN the retry
 * happens, never WHETHER — so it cannot produce a double-post that the automatic retry
 * would not have produced anyway.
 *
 * Each guard earns its place:
 *   - `status = 'scheduled'` keeps 'publishing' out of reach. That row is either in flight
 *     or was orphaned by a restart and may already be live on the platform; forcing it is
 *     exactly the double-post that claiming exists to prevent. It recovers to 'failed'
 *     instead (worker/db.recover_stale_claims) and a human uses Retry after checking.
 *   - `is_held = 0` because a hold is a person saying stop.
 *   - `next_retry_at IS NOT NULL` so a click that would change nothing reports 409 rather
 *     than a success it did not earn.
 *
 * `attempt_count` is deliberately NOT reset (unlike retryPublication, where the send has
 * come to rest and the human is starting over). Resetting it would restart the backoff
 * ladder and push max_attempts out of reach, letting repeated clicks keep a doomed send
 * cycling forever instead of coming to rest in 'failed'.
 */
export function sendPublicationNow(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications
       SET next_retry_at = NULL, updated_at = @now
       WHERE id = @id AND status = 'scheduled' AND is_held = 0
         AND next_retry_at IS NOT NULL`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}

/**
 * Ask the worker to have one more go at a failed first comment.
 *
 * Deliberately NOT the same shape as retryPublication above: that one re-queues the post
 * itself, which is safe because nothing went out. This one runs against a post that is
 * already live, so it only ever sets a request flag — the worker does the work and clears
 * the flag, and the guard below means only a genuinely failed comment can be re-requested.
 * A 'posted' comment must never be retried; that would put a second one on a live post.
 */
export function requestFirstCommentRetry(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications
       SET first_comment_retry_requested = 1, updated_at = @now
       WHERE id = @id AND status = 'posted' AND is_dry_run = 0
         AND first_comment_status = 'failed'`
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
export function getPostTargets(postId: number): PostTarget[] {
  return getDb()
    .prepare(
      "SELECT channel_id, surface FROM post_targets WHERE post_id = ? " +
        "ORDER BY channel_id ASC, surface ASC"
    )
    .all(postId) as PostTarget[];
}

/** Replace a post's target set atomically (delete-all then insert — the "all" snapshot). */
export function setPostTargets(postId: number, targets: PostTarget[]): void {
  const db = getDb();
  const tx = db.transaction((rows: PostTarget[]) => {
    db.prepare("DELETE FROM post_targets WHERE post_id = ?").run(postId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO post_targets (post_id, channel_id, surface) VALUES (?, ?, ?)"
    );
    for (const t of rows) insert.run(postId, t.channel_id, t.surface);
  });
  tx(targets);
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

/** Thrown when a delete targets a tag the install is not allowed to remove. */
export class ProtectedTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedTagError";
  }
}

/** Thrown when a rename would collide with a tag that already exists. */
export class DuplicateTagNameError extends Error {
  constructor(name: string) {
    super(`A tag named "${name}" already exists.`);
    this.name = "DuplicateTagNameError";
  }
}

/**
 * Rename a topic tag in place. Returns the updated row, or null if the tag is gone.
 *
 * This is the non-destructive fix for a typo: the tag's id never changes, so every
 * post_tags row survives and the posts keep the label under its new spelling. Deleting
 * and re-adding would drop the tag off every post it was on.
 *
 * Refused for the four time_of_day bands (see deleteTopicTag) and for a name another tag
 * already holds — tags.name is UNIQUE COLLATE NOCASE, so the bare UPDATE would otherwise
 * surface as a 500 rather than something the page can explain.
 */
export function renameTopicTag(tagId: number, name: string): Tag | null {
  const db = getDb();
  const clean = name.trim();
  if (!clean) throw new Error("Tag name cannot be empty.");

  const tag = db.prepare("SELECT id, name, kind FROM tags WHERE id = ?").get(tagId) as
    | Tag
    | undefined;
  if (!tag) return null;
  if (tag.kind !== "topic") {
    throw new ProtectedTagError(
      `"${tag.name}" is a time-of-day band used for scheduling and cannot be renamed.`
    );
  }

  // Exclude the row itself: renaming "beach" -> "Beach" is a legitimate case fix, and
  // COLLATE NOCASE would otherwise report the tag as colliding with its own old name.
  const clash = db
    .prepare("SELECT id, name, kind FROM tags WHERE name = ? COLLATE NOCASE AND id != ?")
    .get(clean, tagId) as Tag | undefined;
  if (clash) {
    if (clash.kind !== "topic") throw new ReservedTagNameError(clean);
    throw new DuplicateTagNameError(clean);
  }

  db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(clean, tagId);
  return db.prepare("SELECT id, name, kind FROM tags WHERE id = ?").get(tagId) as Tag;
}

/** Topic tags with how many posts each is attached to, for the Tags admin page. */
export function listTopicTagsWithUsage(): (Tag & { post_count: number })[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.name, t.kind, COUNT(pt.post_id) AS post_count
         FROM tags t
         LEFT JOIN post_tags pt ON pt.tag_id = t.id
        WHERE t.kind = 'topic'
        GROUP BY t.id
        ORDER BY t.name COLLATE NOCASE`
    )
    .all() as (Tag & { post_count: number })[];
}

/**
 * Delete a topic tag and detach it from every post that carries it.
 *
 * post_tags cascades on tags(id) (and db.ts sets `foreign_keys = ON`), so the join rows
 * go with it — the POSTS are untouched, they just stop carrying this label.
 *
 * The four time_of_day bands are refused: they are a fixed vocabulary the worker's
 * auto-fill matches on BY NAME (worker/time_of_day.py), so deleting one would silently
 * change which slots posts are eligible for rather than just tidying a label.
 */
export function deleteTopicTag(tagId: number): { deleted: boolean; postCount: number } {
  const db = getDb();
  const tag = db.prepare("SELECT id, name, kind FROM tags WHERE id = ?").get(tagId) as
    | Tag
    | undefined;
  if (!tag) return { deleted: false, postCount: 0 };
  if (tag.kind !== "topic") {
    throw new ProtectedTagError(
      `"${tag.name}" is a time-of-day band used for scheduling and cannot be deleted.`
    );
  }
  const tx = db.transaction(() => {
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM post_tags WHERE tag_id = ?")
      .get(tagId) as { n: number };
    db.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
    return n;
  });
  return { deleted: true, postCount: tx() };
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

/**
 * Set the post's own `caption` column.
 *
 * That column is NOT decoration: the Library card renders it, the caption search filters
 * on it, and `captionsForPlatform()` falls back to it for any platform with no matching
 * variant. `setCaptionVariants()` never wrote it, so the two drifted apart on real posts —
 * a caption saved in the editor left the card showing the old text. Callers that replace
 * caption variants should decide what this becomes; see `syncedPostCaption()`.
 */
/**
 * Set the first comment (hashtags) posted after this post publishes.
 *
 * Until this existed, `first_comment` could only be written at creation time by the
 * composer — so anything created by bulk import or slide extraction could never get one
 * at all. Empty normalises to NULL so "no first comment" is one value everywhere, which
 * is what the worker's own normaliser expects.
 */
export function updatePostFirstComment(
  postId: number,
  firstComment: string | null
): void {
  getDb()
    .prepare(
      "UPDATE posts SET first_comment = @first_comment, updated_at = @updated_at WHERE id = @id"
    )
    .run({
      first_comment: firstComment?.trim() || null,
      id: postId,
      updated_at: nowIso(),
    });
}

export function updatePostCaption(postId: number, caption: string | null): void {
  getDb()
    .prepare("UPDATE posts SET caption = @caption, updated_at = @updated_at WHERE id = @id")
    .run({ caption, id: postId, updated_at: nowIso() });
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

// ---- Bulk content-model context --------------------------------------------------
/** Return the selected post ids that exist using one parameterized database query. */
export function getExistingPostIds(postIds: number[]): number[] {
  const uniquePostIds = [...new Set(postIds)];
  if (uniquePostIds.length === 0) return [];

  const placeholders = uniquePostIds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(`SELECT id FROM posts WHERE id IN (${placeholders}) ORDER BY id`)
    .all(...uniquePostIds) as { id: number }[];
  return rows.map((row) => row.id);
}

/** Summarize the metadata currently attached to a selected set of posts. */
export function getBulkEditContext(postIds: number[]): BulkEditContext {
  const uniquePostIds = [...new Set(postIds)];
  if (uniquePostIds.length === 0) {
    return {
      post_count: 0,
      tags: [],
      periods: [],
      content_statuses: [],
      content_kinds: [],
      cooldowns: [],
    };
  }

  const db = getDb();
  const placeholders = uniquePostIds.map(() => "?").join(", ");
  const read = db.transaction((): BulkEditContext => {
    const tags = db
      .prepare(
        `SELECT tag_id, COUNT(*) AS count
           FROM post_tags
          WHERE post_id IN (${placeholders})
          GROUP BY tag_id
          ORDER BY tag_id`
      )
      .all(...uniquePostIds) as BulkEditContext["tags"];
    const periods = db
      .prepare(
        `SELECT period_id, mode, COUNT(*) AS count
           FROM post_periods
          WHERE post_id IN (${placeholders})
          GROUP BY period_id, mode
          ORDER BY period_id, mode`
      )
      .all(...uniquePostIds) as BulkEditContext["periods"];
    const content_statuses = db
      .prepare(
        `SELECT content_status AS value, COUNT(*) AS count
           FROM posts
          WHERE id IN (${placeholders})
          GROUP BY content_status
          ORDER BY content_status`
      )
      .all(...uniquePostIds) as BulkEditContext["content_statuses"];
    const content_kinds = db
      .prepare(
        `SELECT content_kind AS value, COUNT(*) AS count
           FROM posts
          WHERE id IN (${placeholders})
          GROUP BY content_kind
          ORDER BY content_kind`
      )
      .all(...uniquePostIds) as BulkEditContext["content_kinds"];
    const cooldowns = db
      .prepare(
        `SELECT cooldown_days AS value, COUNT(*) AS count
           FROM posts
          WHERE id IN (${placeholders})
          GROUP BY cooldown_days
          ORDER BY cooldown_days IS NOT NULL, cooldown_days`
      )
      .all(...uniquePostIds) as BulkEditContext["cooldowns"];

    return {
      post_count: content_statuses.reduce((total, row) => total + row.count, 0),
      tags,
      periods,
      content_statuses,
      content_kinds,
      cooldowns,
    };
  });

  return read();
}

// ---- Bulk content-model edit -----------------------------------------------------
export interface BulkEditPostsInput {
  post_ids: number[];
  tags?: { add: number[]; remove: number[] };
  periods?: {
    add: { periodId: number; mode: PeriodMode }[];
    remove: { periodId: number; mode: PeriodMode }[];
  };
  content_status?: ContentStatus;
  content_kind?: ContentKind;
  cooldown_days?: number | null;
}

export interface BulkEditPostsResult {
  tags_added: number;
  tags_removed: number;
  periods_added: number;
  periods_removed: number;
  posts_updated: number;
}

/**
 * Apply local content-model metadata to several posts in one transaction.
 *
 * Tags and periods use exact add/remove pairs so unrelated links are never replaced.
 * Callers validate foreign keys and scalar values before invoking this write layer.
 */
export function bulkEditPosts(input: BulkEditPostsInput): BulkEditPostsResult {
  const db = getDb();
  const tx = db.transaction((edit: BulkEditPostsInput): BulkEditPostsResult => {
    const result: BulkEditPostsResult = {
      tags_added: 0,
      tags_removed: 0,
      periods_added: 0,
      periods_removed: 0,
      posts_updated: 0,
    };

    const deleteTag = db.prepare(
      "DELETE FROM post_tags WHERE post_id = ? AND tag_id = ?"
    );
    const addTag = db.prepare(
      "INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)"
    );
    for (const postId of edit.post_ids) {
      for (const tagId of edit.tags?.remove ?? []) {
        result.tags_removed += deleteTag.run(postId, tagId).changes;
      }
      for (const tagId of edit.tags?.add ?? []) {
        result.tags_added += addTag.run(postId, tagId).changes;
      }
    }

    const deletePeriod = db.prepare(
      "DELETE FROM post_periods WHERE post_id = ? AND period_id = ? AND mode = ?"
    );
    const addPeriod = db.prepare(
      "INSERT OR IGNORE INTO post_periods (post_id, period_id, mode) VALUES (?, ?, ?)"
    );
    for (const postId of edit.post_ids) {
      for (const link of edit.periods?.remove ?? []) {
        result.periods_removed += deletePeriod.run(postId, link.periodId, link.mode).changes;
      }
      for (const link of edit.periods?.add ?? []) {
        result.periods_added += addPeriod.run(postId, link.periodId, link.mode).changes;
      }
    }

    const scalarFields: Record<string, string | number | null> = {};
    if (edit.content_status !== undefined) scalarFields.content_status = edit.content_status;
    if (edit.content_kind !== undefined) scalarFields.content_kind = edit.content_kind;
    if (edit.cooldown_days !== undefined) scalarFields.cooldown_days = edit.cooldown_days;
    const scalarKeys = Object.keys(scalarFields);
    if (scalarKeys.length > 0 && edit.post_ids.length > 0) {
      const setClause = scalarKeys.map((key) => `${key} = @${key}`).join(", ");
      const postParams = Object.fromEntries(edit.post_ids.map((id, i) => [`post_${i}`, id]));
      const postPlaceholders = edit.post_ids.map((_, i) => `@post_${i}`).join(", ");
      result.posts_updated = db
        .prepare(
          `UPDATE posts SET ${setClause}, updated_at = @updated_at
            WHERE id IN (${postPlaceholders})`
        )
        .run({ ...scalarFields, ...postParams, updated_at: nowIso() }).changes;
    }

    return result;
  });

  return tx(input);
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
