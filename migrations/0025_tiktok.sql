-- 0025_tiktok.sql
-- channels.platform gains 'tiktok'; channels gains its OAuth refresh pair; publications
-- gains a delivery state, so a video sitting in a creator's TikTok inbox can never read
-- as "posted".
--
-- SQLite cannot ALTER a CHECK, so channels is rebuilt. This follows 0009's pattern
-- INCLUDING its foreign-key trap: DROP TABLE with enforcement ON performs an implicit
-- delete that FIRES ON DELETE CASCADE across channels' children (publications,
-- publish_limits, post_targets), reporting success while silently deleting every one of
-- their rows. Enforcement is therefore disabled for the rebuild and restored at the end.
-- Python's executescript() commits before running, which ends migrate.py's BEGIN and is
-- why these PRAGMAs take effect at all — a PRAGMA foreign_keys inside an open transaction
-- is a silent no-op, so it must sit OUTSIDE the BEGIN below.
--
-- TWO THINGS DIFFER FROM 0009, and both would be silent data loss if copied blindly:
--
--   1. The column list below was taken from sqlite_master on a migrated database, NOT
--      from 0009. Migrations 0010-0023 added SIXTEEN columns to channels (colour, avatar,
--      group, media/insights sync state, BPP thresholds). Reproducing 0009's 18-column
--      list would drop all of them.
--   2. channels HAS an index now. 0009's comment says it has none, and that was true then;
--      0013 added idx_channels_group. DROP TABLE takes the index with it, so it is
--      recreated after the rename.
--
-- The rebuild is wrapped in its own explicit BEGIN/COMMIT so it is atomic even though
-- executescript() has already ended migrate.py's outer transaction — a crash between the
-- DROP and the RENAME must roll back rather than leave channels gone.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE channels_new (
    id                  INTEGER PRIMARY KEY,
    platform            TEXT    NOT NULL CHECK (platform IN ('instagram', 'facebook', 'threads', 'discord', 'telegram', 'tiktok')),
    account_name        TEXT    NOT NULL,
    business_label      TEXT,
    timezone            TEXT    NOT NULL DEFAULT 'UTC',

    -- Per-channel credentials. Stored in the LOCAL, gitignored DB only.
    remote_account_id   TEXT,                        -- IG user id, FB Page id, Threads user id, Discord channel/webhook id, Telegram chat id, or TikTok open id
    linked_page_id      TEXT,                        -- FB Page id when publishing IG via a linked Page
    access_token        TEXT,                        -- per-channel token (NEVER logged); for TikTok this expires every 24h
    token_expires_at    TEXT,

    requires_approval   INTEGER NOT NULL DEFAULT 0,

    autofill_enabled    INTEGER NOT NULL DEFAULT 0,
    cadence_config      TEXT,
    min_queue_depth     INTEGER NOT NULL DEFAULT 0,
    target_queue_depth  INTEGER NOT NULL DEFAULT 0,
    reuse_min_age_days  INTEGER NOT NULL DEFAULT 180,

    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT,

    color_hue                 INTEGER,
    avatar_path               TEXT,
    avatar_fetched_at         TEXT,
    avatar_refresh_requested  INTEGER NOT NULL DEFAULT 0,
    avatar_error              TEXT,
    group_id                  INTEGER REFERENCES channel_groups(id) ON DELETE SET NULL,
    media_synced_at           TEXT,
    insights_synced_at        TEXT,
    media_backfill_complete   INTEGER NOT NULL DEFAULT 0,
    insights_error            TEXT,
    insights_refresh_requested INTEGER NOT NULL DEFAULT 0,
    bpp_every_n_slots         INTEGER NOT NULL DEFAULT 0,
    bpp_every_days            INTEGER NOT NULL DEFAULT 0,
    bpp_strong_pct            INTEGER NOT NULL DEFAULT 5,
    bpp_broad_pct             INTEGER NOT NULL DEFAULT 10
);

-- Column-for-column, same order as the table above, which is the order the captured DDL
-- had. Named explicitly rather than SELECT * so a future column added between capture and
-- apply cannot line up against the wrong destination.
INSERT INTO channels_new (
    id, platform, account_name, business_label, timezone, remote_account_id,
    linked_page_id, access_token, token_expires_at, requires_approval,
    autofill_enabled, cadence_config, min_queue_depth, target_queue_depth,
    reuse_min_age_days, is_active, created_at, updated_at,
    color_hue, avatar_path, avatar_fetched_at, avatar_refresh_requested, avatar_error,
    group_id, media_synced_at, insights_synced_at, media_backfill_complete,
    insights_error, insights_refresh_requested,
    bpp_every_n_slots, bpp_every_days, bpp_strong_pct, bpp_broad_pct
)
SELECT
    id, platform, account_name, business_label, timezone, remote_account_id,
    linked_page_id, access_token, token_expires_at, requires_approval,
    autofill_enabled, cadence_config, min_queue_depth, target_queue_depth,
    reuse_min_age_days, is_active, created_at, updated_at,
    color_hue, avatar_path, avatar_fetched_at, avatar_refresh_requested, avatar_error,
    group_id, media_synced_at, insights_synced_at, media_backfill_complete,
    insights_error, insights_refresh_requested,
    bpp_every_n_slots, bpp_every_days, bpp_strong_pct, bpp_broad_pct
FROM channels;

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

-- Recreated because DROP TABLE took it with the old table. See note 2 in the header.
CREATE INDEX idx_channels_group ON channels(group_id);

COMMIT;
PRAGMA foreign_keys = ON;

-- Added AFTER the rebuild, so the rebuild's column list stays a pure copy of what already
-- existed and cannot be confused with what this migration is introducing.
--
-- TikTok is the only platform here whose credential needs upkeep: the access token lasts
-- 24 hours, and the refresh token ROTATES — every refresh returns a new one and kills the
-- old. Storing the returned value is not optional; losing it locks the channel out and
-- only a human re-authorising in the dashboard recovers it.
ALTER TABLE channels ADD COLUMN refresh_token TEXT;
ALTER TABLE channels ADD COLUMN refresh_token_expires_at TEXT;

-- NULL means "this platform publishes on command" — every platform except TikTok, and the
-- reason this is a new column rather than a new publications.status value: a new status
-- would ripple through the queue views, auto-fill depth counting and the metrics
-- due-query, while this touches only what renders TikTok.
--
-- publications.status keeps its existing meaning, "the worker's job succeeded". What
-- happened AFTER the handoff lives here:
--   inbox     — delivered; waiting on the creator to publish it in the TikTok app
--   published — confirmed live (TikTok returned a public post id)
--   gave_up   — still unconfirmed when the watch window closed. "We don't know", which is
--               the truth, rather than a state implying it failed or that it published.
ALTER TABLE publications ADD COLUMN delivery_state TEXT
    CHECK (delivery_state IS NULL OR delivery_state IN ('inbox', 'published', 'gave_up'));
ALTER TABLE publications ADD COLUMN delivery_checked_at TEXT;
