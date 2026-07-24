-- 0008_platform_foundation.sql
-- Widen two enum CHECKs so a third platform, and text-only posts, become possible:
--   channels.platform  += 'threads'
--   posts.post_type    += 'text'
--
-- SQLite cannot ALTER a CHECK, so each table is rebuilt. DROP TABLE with foreign keys
-- ENABLED performs an implicit delete that FIRES ON DELETE CASCADE — a naive rebuild
-- reports success while silently deleting every dependent row (channels has 3 cascading
-- children, posts has 6). Enforcement is therefore disabled for the rebuild and restored
-- at the end. Python's executescript() commits before running, which ends migrate.py's
-- BEGIN and is why these PRAGMAs take effect.
--
-- These tables have no indexes, triggers or views, so there is nothing else to recreate.
-- Column sets, defaults and all OTHER CHECKs are reproduced verbatim: widening the two
-- target enums is the only semantic change.

PRAGMA foreign_keys = OFF;

-- ---- channels: platform gains 'threads' -------------------------------------------
CREATE TABLE channels_new (
    id                  INTEGER PRIMARY KEY,
    platform            TEXT    NOT NULL CHECK (platform IN ('instagram', 'facebook', 'threads')),
    account_name        TEXT    NOT NULL,
    business_label      TEXT,
    timezone            TEXT    NOT NULL DEFAULT 'UTC',

    -- Per-channel credentials. Stored in the LOCAL, gitignored DB only.
    remote_account_id   TEXT,                        -- IG user id, FB Page id, or Threads user id
    linked_page_id      TEXT,                        -- FB Page id when publishing IG via a linked Page
    access_token        TEXT,                        -- per-channel long-lived token (NEVER logged)
    token_expires_at    TEXT,

    requires_approval   INTEGER NOT NULL DEFAULT 0,

    autofill_enabled    INTEGER NOT NULL DEFAULT 0,
    cadence_config      TEXT,
    min_queue_depth     INTEGER NOT NULL DEFAULT 0,
    target_queue_depth  INTEGER NOT NULL DEFAULT 0,
    reuse_min_age_days  INTEGER NOT NULL DEFAULT 180,

    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT
);

INSERT INTO channels_new (
    id, platform, account_name, business_label, timezone, remote_account_id,
    linked_page_id, access_token, token_expires_at, requires_approval,
    autofill_enabled, cadence_config, min_queue_depth, target_queue_depth,
    reuse_min_age_days, is_active, created_at, updated_at
)
SELECT
    id, platform, account_name, business_label, timezone, remote_account_id,
    linked_page_id, access_token, token_expires_at, requires_approval,
    autofill_enabled, cadence_config, min_queue_depth, target_queue_depth,
    reuse_min_age_days, is_active, created_at, updated_at
FROM channels;

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

-- ---- posts: post_type gains 'text' ------------------------------------------------
CREATE TABLE posts_new (
    id             INTEGER PRIMARY KEY,
    caption        TEXT,
    first_comment  TEXT,
    post_type      TEXT    NOT NULL
                           CHECK (post_type IN ('single', 'carousel', 'reel', 'story', 'text')),
    status         TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'scheduled', 'posted', 'failed')),
    created_by     TEXT,                             -- free-text label for shared installs (NOT auth)
    created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT,
    content_kind   TEXT    NOT NULL DEFAULT 'evergreen'
                           CHECK (content_kind IN ('one_time', 'evergreen')),
    content_status TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (content_status IN ('draft', 'ready', 'retired')),
    cooldown_days  INTEGER                           -- NULL = use channel.reuse_min_age_days
);

INSERT INTO posts_new (
    id, caption, first_comment, post_type, status, created_by, created_at,
    updated_at, content_kind, content_status, cooldown_days
)
SELECT
    id, caption, first_comment, post_type, status, created_by, created_at,
    updated_at, content_kind, content_status, cooldown_days
FROM posts;

DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;

PRAGMA foreign_keys = ON;
