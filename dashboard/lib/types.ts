// Row shapes mirroring migrations/0001_init.sql. Kept in sync by hand — the SQL
// remains the source of truth (see CLAUDE.md).

export type Platform = "instagram" | "facebook";
export type PostType = "single" | "carousel" | "reel" | "story";
export type PostStatus = "draft" | "scheduled" | "posted" | "failed";
export type PublicationStatus =
  | "scheduled"
  | "pending_approval"
  | "publishing"
  | "posted"
  | "failed"
  | "canceled";

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
  created_at: string;
}

export interface Post {
  id: number;
  caption: string | null;
  first_comment: string | null;
  post_type: PostType;
  status: PostStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
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
