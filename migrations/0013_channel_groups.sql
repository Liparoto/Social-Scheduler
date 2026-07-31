-- 0013_channel_groups.sql
-- Coordinated auto-fill: a channel_group is a named set of channels that auto-fills as
-- ONE unit — one cadence, one selection decision, one slot, one publication per member.
-- Without it, auto-fill runs per channel in isolation (worker/autofill.py), so an
-- Instagram channel and a Threads channel representing the same account pick different
-- content on different days.
--
-- The group deliberately repeats the auto-fill field NAMES that already exist on
-- channels (cadence_config, min_queue_depth, target_queue_depth, reuse_min_age_days,
-- timezone, autofill_enabled, is_active). That is not redundancy: it lets
-- parse_weekly_cadence(), weekly_date_slots() and band_times() accept a group row with
-- no modification, so the slot-generation code stays single-source.
--
-- channels.group_id is nullable and defaults to NULL, so every existing channel stays
-- ungrouped and behaves exactly as it does today. While group_id IS NOT NULL a channel's
-- OWN autofill_enabled/cadence_config/queue-depth/reuse columns go unread; clearing
-- group_id makes them authoritative again. Nothing is dropped.
--
-- ON DELETE SET NULL (not CASCADE) is deliberate and is the opposite of what channels'
-- own children use. A group is a scheduling convenience, not an owner of content:
-- deleting one must return its channels to solo operation, never destroy channels or
-- the publications hanging off them.
--
-- Purely additive: no CHECK constraint is involved on channels, so SQLite's
-- ALTER TABLE ... ADD COLUMN is enough and none of the table-rebuild cascade-delete risk
-- that 0008/0009 carried applies here. Same shape as 0010_channel_colour.sql and
-- 0012_channel_avatar.sql.

CREATE TABLE IF NOT EXISTS channel_groups (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  autofill_enabled    INTEGER NOT NULL DEFAULT 0,
  cadence_config      TEXT,
  min_queue_depth     INTEGER NOT NULL DEFAULT 0,
  target_queue_depth  INTEGER NOT NULL DEFAULT 0,
  reuse_min_age_days  INTEGER NOT NULL DEFAULT 180,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT
);

ALTER TABLE channels ADD COLUMN group_id INTEGER
  REFERENCES channel_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_id);
