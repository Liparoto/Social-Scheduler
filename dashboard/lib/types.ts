// Row shapes mirroring migrations/0001_init.sql. Kept in sync by hand — the SQL
// remains the source of truth (see CLAUDE.md).

export type Platform = "instagram" | "facebook";
export type TagKind = "topic" | "time_of_day";
export interface Tag {
  id: number;
  name: string;
  kind: TagKind;
}
export type PostType = "single" | "carousel" | "reel" | "story";
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
  conform_mode: "none" | "crop" | "pad";
  needs_review: number;
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
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}
