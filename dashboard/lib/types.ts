// Row shapes mirroring migrations/0001_init.sql. Kept in sync by hand — the SQL
// remains the source of truth (see CLAUDE.md).

import type { Platform } from "./platforms";
export type { Platform } from "./platforms";
export type TagKind = "topic" | "time_of_day";
export interface Tag {
  id: number;
  name: string;
  kind: TagKind;
}
// NOTE: 'story' here is VESTIGIAL and unused — see migration 0014's header. A Story is a
// DESTINATION, not a content shape, and lives on Surface below. Nothing creates a post with
// post_type 'story' and the worker refuses it.
export type PostType = "single" | "carousel" | "video" | "story" | "text";

// WHERE a send lands, as opposed to what the content IS (PostType, which is INFERRED from
// the assets). 'story' is an Instagram Story; 'reel' is a Facebook Reel (Instagram has no
// separate reel surface — its feed video IS a Reel, so it never uses this value). Kept as
// a separate axis so one post can be a Story on Instagram AND an ordinary post on Telegram
// — see docs/design-instagram-stories.md.
//
// NOTE: "reel" is a fully wired target, not merely a type-level placeholder. The schedule
// route's runtime parsing (lib/story-fanout.ts's parseTargets) accepts it, and the worker
// (worker/publisher.py's _publish_facebook / _publish_fb_video) publishes it to a Facebook
// Page's Reels edge. _validate additionally enforces, terminally, that a 'reel' surface
// target has post_type='video' on a platform whose caps declare a Reels surface — so a
// stale/malformed target can't reach the create call and publish the wrong media.
export type Surface = "feed" | "story" | "reel";

/** One destination for a post: a channel plus which of its surfaces to publish to. */
export interface PostTarget {
  channel_id: number;
  surface: Surface;
}
export type PostStatus = "draft" | "scheduled" | "posted" | "failed";
export type PublicationStatus =
  | "scheduled"
  | "pending_approval"
  | "publishing"
  | "posted"
  | "failed"
  | "canceled";

/**
 * The first comment's outcome, tracked separately from the send's own status because it
 * happens AFTER the media is live. 'none' covers both "no first comment was written" and
 * "this platform has no first-comment concept" — neither is a failure.
 */
export type FirstCommentStatus = "none" | "pending" | "posted" | "failed";

// Content model (migration 0002_content_model.sql). content_status is a SEPARATE axis
// from PostStatus above: content_status governs automation eligibility (draft/ready/
// retired), while PostStatus stays the coarse overview lifecycle hint. Never conflate them.
export type ContentKind = "one_time" | "evergreen";
export type ContentStatus = "draft" | "ready" | "retired";
export type PeriodMode = "green" | "blackout";
export interface PeriodLink {
  periodId: number;
  mode: PeriodMode;
}

export interface Channel {
  id: number;
  platform: Platform;
  account_name: string;
  business_label: string | null;
  timezone: string;
  remote_account_id: string | null;
  linked_page_id: string | null;
  access_token: string | null;
  token_expires_at: string | null;
  requires_approval: number;
  autofill_enabled: number;
  cadence_config: string | null;
  min_queue_depth: number;
  target_queue_depth: number;
  reuse_min_age_days: number;
  bpp_every_days: number;
  is_active: number;
  group_id: number | null;
  created_at: string;
  updated_at: string | null;
  color_hue: number | null;
  avatar_path: string | null;
  avatar_fetched_at: string | null;
  avatar_refresh_requested: number;
  avatar_error: string | null;
}

/** A named set of channels that auto-fills as ONE unit — one cadence, one selection
 *  decision, one slot, one publication per member. Carries the same auto-fill field
 *  names a Channel does; while a channel's group_id is set, its own copies go unread. */
export interface ChannelGroup {
  id: number;
  name: string;
  timezone: string;
  autofill_enabled: number;
  cadence_config: string | null;
  min_queue_depth: number;
  target_queue_depth: number;
  reuse_min_age_days: number;
  bpp_every_days: number;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

/** One auto-fill lane: an owner (a channel OR a group, never both) plus a surface.
 *  Replaces the auto-fill columns that used to live on Channel and ChannelGroup — those
 *  columns still exist but nothing reads them. See docs/design-autofill-lanes.md. */
export interface AutofillLane {
  id: number;
  channel_id: number | null;
  group_id: number | null;
  surface: Surface;
  enabled: number;
  cadence_config: string | null;
  min_queue_depth: number;
  target_queue_depth: number;
  reuse_min_age_days: number;
}

export interface Asset {
  id: number;
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
  publish_path: string | null;
  conform_mode: "none" | "crop" | "pad" | "downscale";
  needs_review: number;
  // The 9:16 STORY derivative — a second, differently-shaped copy. NULL means the source is
  // already story-shaped and the untouched original is published (migration 0015).
  story_path: string | null;
  // Deliberately not ConformMode: 'pad' is feed-only, since white bars are a mistake on a
  // full-bleed surface. See migrations/0015_story_framing.sql.
  story_mode: "blurred" | "crop";
  duration_ms: number | null;
  cover_frame_ms: number | null;
  cover_asset_id: number | null;
  has_audio: number;
  created_at: string;
}

export interface Post {
  id: number;
  is_bpp: number;
  bpp_marked_at: string | null;
  caption: string | null;
  first_comment: string | null;
  post_type: PostType;
  status: PostStatus;
  content_kind: ContentKind;
  content_status: ContentStatus;
  cooldown_days: number | null;
  created_by: string | null;
  is_recycled: number;
  // Local visibility only — see migrations/0023_archive_library.sql. NULL means the post
  // is in the Library; a UTC ISO timestamp means it has been archived out of it. It is
  // NOT an automation gate: content_status still decides what auto-fill may pick up.
  archived_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Period {
  id: number;
  name: string;
  recurs_yearly: 0 | 1;
  start_month: number | null;
  start_day: number | null;
  end_month: number | null;
  end_day: number | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export interface CaptionVariant {
  id: number;
  post_id: number;
  platform: string | null;
  body: string;
  sort_order: number;
}

export interface Publication {
  id: number;
  post_id: number;
  channel_id: number;
  scheduled_at: string;
  status: PublicationStatus;
  published_at: string | null;
  remote_container_id: string | null;
  remote_post_id: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  first_comment_status: FirstCommentStatus;
  first_comment_remote_id: string | null;
  first_comment_error: string | null;
  first_comment_retry_requested: number;
  is_dry_run: number;
  is_held: number;
  /**
   * What happened AFTER the worker handed the post over, for platforms that deliver
   * rather than publish. NULL for every platform that publishes on command. TikTok's
   * three states are 'inbox' (waiting on the creator), 'published' (confirmed live) and
   * 'gave_up' (delivered, never confirmed). Read it through deliveryLabel(), never raw.
   */
  delivery_state: string | null;
  /** When the delivery watcher last asked TikTok about this send. */
  delivery_checked_at: string | null;
  /** Which destination this send is for — 'story' rows target ONE slide via asset_id. */
  surface: Surface;
  /** NULL for a feed send (all assets, in order); the single slide for a story send. */
  asset_id: number | null;
  created_by: string | null;
  is_recycled: number;
  created_at: string;
  updated_at: string | null;
}

export interface PostPublicationRow {
  id: number;
  published_at: string | null;
  /** How this particular run did. Null until the worker has fetched metrics for it —
   *  and null FOREVER on platforms that do not report it, so never treat a null metric
   *  as "not fetched". Use metrics_fetched_at for that. */
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  /** 1 = gone from the platform, 0 = still there, null = not mirrored (Stories, or
   *  anything published before syncing began). Null is NOT deletion. */
  removed_from_platform: number | null;
  channel_id: number;
  channel_name: string;
  channel_platform: string;
  channel_timezone: string;
  channel_color_hue: number | null;
  channel_avatar_path: string | null;
  scheduled_at: string;
  status: PublicationStatus;
  is_held: number;
  is_dry_run: number;
  remote_post_id: string | null;
  /**
   * What happened after the handoff, for a platform that delivers rather than publishes.
   * NULL everywhere but TikTok. status='posted' means the WORKER succeeded; this says
   * whether TikTok ever published it. Render via deliveryLabel().
   */
  delivery_state: string | null;
  /** Which destination this send is for. 'story' rows also carry an asset_id (one slide). */
  surface: Surface;
  /**
   * The first comment's own outcome, independent of the send's. A comment is attempted
   * only after the media is live, so 'failed' here always means "the post went out, the
   * comment did not" — never a failed post.
   */
  first_comment_status: FirstCommentStatus;
  first_comment_error: string | null;
  /** 1 while a human-requested retry is waiting for the worker to pick it up. */
  first_comment_retry_requested: number;
  /** When the worker last fetched metrics for this run, or null if it never has. This —
   *  not the presence of any one metric — is the answer to "do we have numbers yet". */
  metrics_fetched_at: string | null;
}
