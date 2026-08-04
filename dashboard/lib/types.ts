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
export type PostType = "single" | "carousel" | "reel" | "story" | "text";

// WHERE a send lands, as opposed to what the content IS (PostType, which is INFERRED from
// the assets). 'story' is an Instagram Story. Kept as a separate axis so one post can be a
// Story on Instagram AND an ordinary post on Telegram — see docs/design-instagram-stories.md.
export type Surface = "feed" | "story";

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
  is_active: number;
  created_at: string;
  updated_at: string | null;
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
  duration_ms: number | null;
  cover_frame_ms: number | null;
  has_audio: number;
  created_at: string;
}

export interface Post {
  id: number;
  caption: string | null;
  first_comment: string | null;
  post_type: PostType;
  status: PostStatus;
  content_kind: ContentKind;
  content_status: ContentStatus;
  cooldown_days: number | null;
  created_by: string | null;
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
  first_comment_status: "none" | "pending" | "posted" | "failed";
  first_comment_remote_id: string | null;
  is_dry_run: number;
  is_held: number;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface PostPublicationRow {
  id: number;
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
  /** Which destination this send is for. 'story' rows also carry an asset_id (one slide). */
  surface: Surface;
}
