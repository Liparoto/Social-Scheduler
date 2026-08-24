-- 0027_video_surface.sql
-- Facebook can publish one clip three ways (feed video, Reels, Stories), so post_type
-- cannot name the destination the way 'reel' tried to. post_type says what a post IS;
-- surface says where it LANDS. Same split 0014 made for Stories, now applied to video.
--
-- THREE rebuilds, because SQLite cannot alter a CHECK in place. 0014's header explains
-- why it avoided rebuilding publications: it carries indexes and cascading children
-- (post_metrics, remote_media). That risk is real and is accepted here only because
-- widening the CHECK leaves no alternative. It is paid ONCE: the new surface set
-- ('feed','story','reel') already covers Facebook Stories, which reuses 'story'.
--
-- DROP TABLE with foreign keys ENABLED fires ON DELETE CASCADE and would delete every
-- child row. Enforcement is disabled for the rebuild and restored at the end. The PRAGMAs
-- stay OUTSIDE the transaction: PRAGMA foreign_keys is a silent no-op while one is open.

PRAGMA foreign_keys = OFF;
BEGIN;

-- posts: post_type CHECK gains 'video'. 'story' stays listed but remains VESTIGIAL
-- (see 0014) — nothing creates it and publisher._validate refuses it.
CREATE TABLE posts_new (
    id             INTEGER PRIMARY KEY,
    caption        TEXT,
    first_comment  TEXT,
    post_type      TEXT    NOT NULL
                           CHECK (post_type IN ('single', 'carousel', 'video', 'reel', 'story', 'text')),
    status         TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'scheduled', 'posted', 'failed')),
    created_by     TEXT,
    created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT,
    content_kind   TEXT    NOT NULL DEFAULT 'evergreen'
                           CHECK (content_kind IN ('one_time', 'evergreen')),
    content_status TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (content_status IN ('draft', 'ready', 'retired')),
    cooldown_days  INTEGER,
    is_bpp         INTEGER NOT NULL DEFAULT 0,
    bpp_marked_at  TEXT,
    archived_at    TEXT
);

INSERT INTO posts_new
    SELECT id, caption, first_comment, post_type, status, created_by, created_at,
           updated_at, content_kind, content_status, cooldown_days, is_bpp,
           bpp_marked_at, archived_at
      FROM posts;

DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;
CREATE INDEX idx_posts_archived_at ON posts(archived_at) WHERE archived_at IS NOT NULL;

-- The rename itself. 'reel' is kept in the CHECK above only so this UPDATE is legal
-- within the same transaction; nothing writes it afterwards.
UPDATE posts SET post_type = 'video' WHERE post_type = 'reel';

-- post_targets: surface CHECK gains 'reel'.
CREATE TABLE post_targets_new (
    post_id    INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- 'feed'  = the normal post for that platform
    -- 'story' = Instagram Story today, Facebook Page Story when that adapter lands
    -- 'reel'  = Facebook Reels. FACEBOOK-ONLY BY DESIGN: all Instagram feed video is
    --           already Reels, so a separate IG value would mean the same as 'feed'.
    surface    TEXT    NOT NULL DEFAULT 'feed'
                       CHECK (surface IN ('feed', 'story', 'reel')),
    PRIMARY KEY (post_id, channel_id, surface)
);

INSERT INTO post_targets_new (post_id, channel_id, surface)
    SELECT post_id, channel_id, surface FROM post_targets;

DROP TABLE post_targets;
ALTER TABLE post_targets_new RENAME TO post_targets;
CREATE INDEX idx_post_targets_channel ON post_targets (channel_id);

-- publications: surface CHECK gains 'reel'. Every column and index below must survive.
CREATE TABLE publications_new (
    id                      INTEGER PRIMARY KEY,
    post_id                 INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id              INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    scheduled_at            TEXT    NOT NULL,
    status                  TEXT    NOT NULL DEFAULT 'scheduled'
                                    CHECK (status IN ('scheduled', 'pending_approval', 'publishing',
                                                      'posted', 'failed', 'canceled')),
    published_at            TEXT,
    remote_container_id     TEXT,
    remote_post_id          TEXT,
    attempt_count           INTEGER NOT NULL DEFAULT 0,
    next_retry_at           TEXT,
    last_error              TEXT,
    first_comment_status    TEXT    NOT NULL DEFAULT 'none'
                                    CHECK (first_comment_status IN ('none', 'pending', 'posted', 'failed')),
    first_comment_remote_id TEXT,
    is_dry_run              INTEGER NOT NULL DEFAULT 0,
    created_by              TEXT,
    created_at              TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT,
    metrics_refresh_requested_at TEXT,
    is_held                 INTEGER NOT NULL DEFAULT 0,
    surface                 TEXT    NOT NULL DEFAULT 'feed'
                                    CHECK (surface IN ('feed', 'story', 'reel')),
    asset_id                INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
    first_comment_error     TEXT,
    first_comment_retry_requested INTEGER NOT NULL DEFAULT 0,
    is_recycled             INTEGER NOT NULL DEFAULT 0,
    remote_missing_at       TEXT,
    remote_missing_reason   TEXT,
    metrics_failure_streak  INTEGER NOT NULL DEFAULT 0,
    delivery_state          TEXT    CHECK (delivery_state IS NULL OR
                                           delivery_state IN ('inbox', 'published', 'gave_up')),
    delivery_checked_at     TEXT
);

INSERT INTO publications_new
    SELECT id, post_id, channel_id, scheduled_at, status, published_at,
           remote_container_id, remote_post_id, attempt_count, next_retry_at, last_error,
           first_comment_status, first_comment_remote_id, is_dry_run, created_by,
           created_at, updated_at, metrics_refresh_requested_at, is_held, surface,
           asset_id, first_comment_error, first_comment_retry_requested, is_recycled,
           remote_missing_at, remote_missing_reason, metrics_failure_streak,
           delivery_state, delivery_checked_at
      FROM publications;

DROP TABLE publications;
ALTER TABLE publications_new RENAME TO publications;
CREATE INDEX idx_publications_channel_sched ON publications (channel_id, scheduled_at, status);
CREATE INDEX idx_publications_retry         ON publications (status, next_retry_at);
CREATE INDEX idx_publications_post          ON publications (post_id);

COMMIT;
PRAGMA foreign_keys = ON;
