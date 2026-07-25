-- 0009_discord_telegram.sql
-- Widen channels.platform's CHECK to add 'discord' and 'telegram':
--   channels.platform  += 'discord', 'telegram'
--
-- SQLite cannot ALTER a CHECK, so the table is rebuilt. DROP TABLE with foreign keys
-- ENABLED performs an implicit delete that FIRES ON DELETE CASCADE — a naive rebuild
-- reports success while silently deleting every dependent row (channels has 3 cascading
-- children: publications, publish_limits, post_targets). Enforcement is therefore
-- disabled for the rebuild and restored at the end. Python's executescript() commits
-- before running, which ends migrate.py's BEGIN and is why these PRAGMAs take effect.
-- See 0008_platform_foundation.sql, which solved this same problem first.
--
-- channels has no indexes, triggers or views, so there is nothing else to recreate.
-- The column set, defaults and all OTHER CHECKs are reproduced verbatim (18 columns,
-- taken from sqlite_master): widening the platform enum is the only semantic change.
--
-- The rebuild DDL below is wrapped in its own explicit BEGIN/COMMIT so it is atomic
-- even though executescript() already ended migrate.py's outer transaction — a crash or
-- error partway through (e.g. between the DROP and the RENAME) must roll back instead of
-- leaving channels dropped and channels_new orphaned. The PRAGMAs stay OUTSIDE this
-- transaction: PRAGMA foreign_keys is a silent no-op while a transaction is open, so it
-- must run before BEGIN (to actually disable enforcement) and after COMMIT (to actually
-- restore it).

PRAGMA foreign_keys = OFF;
BEGIN;

-- ---- channels: platform gains 'discord', 'telegram' -------------------------------
CREATE TABLE channels_new (
    id                  INTEGER PRIMARY KEY,
    platform            TEXT    NOT NULL CHECK (platform IN ('instagram', 'facebook', 'threads', 'discord', 'telegram')),
    account_name        TEXT    NOT NULL,
    business_label      TEXT,
    timezone            TEXT    NOT NULL DEFAULT 'UTC',

    -- Per-channel credentials. Stored in the LOCAL, gitignored DB only.
    remote_account_id   TEXT,                        -- IG user id, FB Page id, Threads user id, Discord channel/webhook id, or Telegram chat id
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

COMMIT;
PRAGMA foreign_keys = ON;
