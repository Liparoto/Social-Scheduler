-- 0001_init.sql — SocialScheduler initial schema
--
-- Source of truth for the database schema. Applied by migrate.py, which wraps this
-- file in a transaction and records it in schema_migrations. Do NOT edit an already-
-- applied migration; add a new numbered file instead.
--
-- Conventions:
--   * Timestamps are ISO-8601 UTC text. created_at defaults to CURRENT_TIMESTAMP (UTC).
--     updated_at is set by the application layer when it writes.
--   * Booleans are INTEGER 0/1.
--   * Foreign keys are ON (set per-connection by every client) with explicit ON DELETE.
--   * All scheduling times are stored in UTC; per-channel timezone governs display/interpretation.

-- =====================================================================================
-- channels — one row per social account. First-class, independently configured.
-- Per-channel credentials live HERE (not globally), so an install can manage several
-- accounts (e.g. a personal IG and a business IG) side by side.
-- =====================================================================================
CREATE TABLE channels (
    id                  INTEGER PRIMARY KEY,
    platform            TEXT    NOT NULL CHECK (platform IN ('instagram', 'facebook')),
    account_name        TEXT    NOT NULL,            -- e.g. "Liparoto", "Advantage Physical Therapy"
    business_label      TEXT,                        -- optional grouping: which business this belongs to
    timezone            TEXT    NOT NULL DEFAULT 'UTC',  -- IANA, e.g. "America/New_York"

    -- Per-channel Meta credentials. Stored in the LOCAL, gitignored DB only.
    -- NOTE: for IG-via-Facebook-Login, remote_account_id is the IG user id and
    -- linked_page_id is the connected Facebook Page id (see reference.md).
    remote_account_id   TEXT,                        -- IG user id, or FB Page id
    linked_page_id      TEXT,                        -- FB Page id when publishing IG via a linked Page
    access_token        TEXT,                        -- per-channel long-lived token (NEVER logged)
    token_expires_at    TEXT,                        -- ISO-8601 UTC, for refresh awareness

    -- Approval gate. The field exists now; installs default it OFF for frictionless solo use.
    requires_approval   INTEGER NOT NULL DEFAULT 0,

    -- Auto-fill configuration (used in Phase 4).
    autofill_enabled    INTEGER NOT NULL DEFAULT 0,
    cadence_config      TEXT,                        -- JSON, e.g. {"days":["tue","thu","sat"],"time":"18:00"}
    min_queue_depth     INTEGER NOT NULL DEFAULT 0,  -- top up when scheduled-ahead count drops below this
    target_queue_depth  INTEGER NOT NULL DEFAULT 0,  -- fill back up to this depth
    reuse_min_age_days  INTEGER NOT NULL DEFAULT 180, -- "not posted in N+ days" threshold (configurable)

    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT
);

-- =====================================================================================
-- assets — uploaded media. Dedup is by content_hash (NOT filename).
-- =====================================================================================
CREATE TABLE assets (
    id                  INTEGER PRIMARY KEY,
    content_hash        TEXT    NOT NULL UNIQUE,     -- dedup key (e.g. sha256 of file bytes)
    media_kind          TEXT    NOT NULL CHECK (media_kind IN ('image', 'video')),
    original_filename   TEXT,
    storage_path        TEXT    NOT NULL,            -- path within the local asset store
    public_url          TEXT,                        -- URL Meta will cURL; must return RAW bytes
    thumbnail_path      TEXT,
    mime_type           TEXT,
    width               INTEGER,
    height              INTEGER,
    byte_size           INTEGER,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================================
-- posts — the content unit: a caption (+ optional first comment) and ordered assets.
-- A post can be published many times over its life (recycling) via publications.
-- post.status is a COARSE lifecycle hint for the overview; publications are authoritative.
-- =====================================================================================
CREATE TABLE posts (
    id                  INTEGER PRIMARY KEY,
    caption             TEXT,
    first_comment       TEXT,                        -- auto-posted as first comment after publish (Phase 6)
    post_type           TEXT    NOT NULL CHECK (post_type IN ('single', 'carousel', 'reel', 'story')),
    status              TEXT    NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'scheduled', 'posted', 'failed')),
    created_by          TEXT,                        -- free-text label for shared installs (NOT auth)
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT
);

-- =====================================================================================
-- post_assets — ordered join between posts and assets (carousel/child order).
-- =====================================================================================
CREATE TABLE post_assets (
    id                  INTEGER PRIMARY KEY,
    post_id             INTEGER NOT NULL REFERENCES posts(id)  ON DELETE CASCADE,
    asset_id            INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (post_id, sort_order),                    -- deterministic ordering
    UNIQUE (post_id, asset_id)                       -- an asset appears at most once per post
);

-- =====================================================================================
-- publications — one row per time a post is scheduled/published to a channel.
-- This is the recycling + partial-failure primitive: each target is INDEPENDENT,
-- with its own status, retry state, and remote id. A failure on one channel does not
-- affect another. Metrics hang off publications, so performance is per-channel.
-- =====================================================================================
CREATE TABLE publications (
    id                      INTEGER PRIMARY KEY,
    post_id                 INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id              INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    scheduled_at            TEXT    NOT NULL,          -- ISO-8601 UTC
    status                  TEXT    NOT NULL DEFAULT 'scheduled'
                                    CHECK (status IN ('scheduled', 'pending_approval', 'publishing',
                                                      'posted', 'failed', 'canceled')),
    published_at            TEXT,                      -- ISO-8601 UTC when it actually went out
    remote_container_id     TEXT,                      -- Meta container creation_id (for status polling)
    remote_post_id          TEXT,                      -- Meta media id once published

    -- Failure handling: visible, never silent. Auto-retry with backoff, then rest in 'failed'.
    attempt_count           INTEGER NOT NULL DEFAULT 0,
    next_retry_at           TEXT,                      -- ISO-8601 UTC; NULL when not awaiting retry
    last_error              TEXT,

    -- First comment (hashtags) posted after the media publishes (Phase 6).
    first_comment_status    TEXT    NOT NULL DEFAULT 'none'
                                    CHECK (first_comment_status IN ('none', 'pending', 'posted', 'failed')),
    first_comment_remote_id TEXT,

    is_dry_run              INTEGER NOT NULL DEFAULT 0, -- this publication was a dry-run (nothing posted)
    created_by              TEXT,
    created_at              TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT
);

CREATE INDEX idx_publications_channel_sched ON publications (channel_id, scheduled_at, status);
CREATE INDEX idx_publications_retry         ON publications (status, next_retry_at);
CREATE INDEX idx_publications_post          ON publications (post_id);

-- =====================================================================================
-- post_metrics — time-series, one row per metrics fetch, linked to a publication.
-- Keeps full history in v1 (rollup/pruning is a later concern).
-- =====================================================================================
CREATE TABLE post_metrics (
    id                  INTEGER PRIMARY KEY,
    publication_id      INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    fetched_at          TEXT    NOT NULL,             -- ISO-8601 UTC
    reach               INTEGER,
    impressions         INTEGER,
    likes               INTEGER,
    comments            INTEGER,
    saves               INTEGER,
    shares              INTEGER,
    video_views         INTEGER,
    raw_json            TEXT,                          -- full payload, for metrics we don't column-ize yet
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_post_metrics_pub ON post_metrics (publication_id, fetched_at);

-- =====================================================================================
-- tags / post_tags — simple free-form labels for organizing and (later) smarter selection.
-- =====================================================================================
CREATE TABLE tags (
    id                  INTEGER PRIMARY KEY,
    name                TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE post_tags (
    post_id             INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag_id              INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
);

-- =====================================================================================
-- publish_limits — cached content_publishing_limit per channel so the worker paces
-- itself against Meta's REAL quota instead of discovering the cap via a rejected request.
-- (Meta's docs disagree on the number — always read it at runtime. See reference.md.)
-- =====================================================================================
CREATE TABLE publish_limits (
    id                  INTEGER PRIMARY KEY,
    channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    quota_usage         INTEGER,                       -- publishes used in the current window
    quota_total         INTEGER,                       -- max allowed in the window (read from Meta)
    quota_duration      INTEGER,                       -- window length in seconds (e.g. 86400)
    checked_at          TEXT    NOT NULL               -- ISO-8601 UTC of this check
);

CREATE INDEX idx_publish_limits_channel ON publish_limits (channel_id, checked_at);
