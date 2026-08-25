-- 0028_autofill_lanes.sql
-- Auto-fill has had exactly ONE cadence per unit (a channel group, or an ungrouped
-- channel), and that cadence was hardwired to the feed: worker/autofill.py required a
-- post_targets row with surface='feed', and its publication insert took the 'feed'
-- default from 0014. The owner wants Stories on their own cadence, running ALONGSIDE
-- the feed cadence rather than instead of it.
--
-- The destination model was already right — post_targets.surface and
-- publications.surface both accept ('feed','story','reel') after 0027. What was wrong is
-- that auto-fill CONFIG was one-per-unit where it needs to be one-per-(unit, surface).
-- So the config moves out of columns and into rows. See docs/design-autofill-lanes.md.
--
-- TWO NULLABLE OWNER COLUMNS, not an owner_type/owner_id pair: SQLite cannot foreign-key
-- a polymorphic column, and a lane that outlives its deleted channel is a row the worker
-- keeps trying to fill forever. Two real foreign keys let ON DELETE CASCADE do the
-- cleanup. The cost is two partial unique indexes instead of one composite — cheaper
-- than an orphan.
--
-- Additive only: no table is rebuilt. The superseded columns on channels and
-- channel_groups (autofill_enabled, cadence_config, min_queue_depth,
-- target_queue_depth, reuse_min_age_days) are LEFT IN PLACE and go unread, exactly as
-- 0020 left bpp_every_n_slots. Rebuilding channels to delete five columns would be a
-- third full rebuild of a table with foreign-key children, for zero behaviour change.
--
-- This also retires 0013's mirroring rule (0013_channel_groups.sql:8-12), which required
-- every auto-fill setting to exist under identical names on BOTH tables. That rule was
-- already broken once — bpp_strong_pct/bpp_broad_pct exist only on channels (0022). One
-- lane table with one set of columns removes the obligation instead of adding a third
-- copy of it.
--
-- timezone is deliberately NOT on the lane: two surfaces on one account cannot be in
-- different timezones, and duplicating it only invites them to disagree. The bpp_* dials
-- stay on the owner too — BPP recycling is feed-only.

BEGIN;

CREATE TABLE autofill_lanes (
    id                 INTEGER PRIMARY KEY,
    channel_id         INTEGER REFERENCES channels(id)       ON DELETE CASCADE,
    group_id           INTEGER REFERENCES channel_groups(id) ON DELETE CASCADE,
    -- 'reel' is legal here so a Reel lane is later an INSERT rather than a migration.
    -- Nothing creates one yet.
    surface            TEXT    NOT NULL CHECK (surface IN ('feed', 'story', 'reel')),
    enabled            INTEGER NOT NULL DEFAULT 0,
    cadence_config     TEXT,
    -- Defaults match the live column defaults exactly (0025 for channels, 0013 for
    -- channel_groups) so a lane created by hand behaves like a unit created by hand.
    min_queue_depth    INTEGER NOT NULL DEFAULT 0,
    target_queue_depth INTEGER NOT NULL DEFAULT 0,
    reuse_min_age_days INTEGER NOT NULL DEFAULT 180,
    -- Exactly one owner: a group OR a channel, never both, never neither.
    CHECK ((channel_id IS NULL) <> (group_id IS NULL))
);

CREATE UNIQUE INDEX idx_autofill_lanes_channel
    ON autofill_lanes (channel_id, surface) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX idx_autofill_lanes_group
    ON autofill_lanes (group_id, surface)   WHERE group_id IS NOT NULL;

-- Backfill: every existing unit becomes a FEED lane holding its current settings, so the
-- install keeps filling on the same schedule with the same content the moment this lands.
INSERT INTO autofill_lanes
    (group_id, surface, enabled, cadence_config,
     min_queue_depth, target_queue_depth, reuse_min_age_days)
SELECT id, 'feed', autofill_enabled, cadence_config,
       min_queue_depth, target_queue_depth, reuse_min_age_days
  FROM channel_groups;

-- A channel that is IN a group gets no lane, matching _autofill_units, which never
-- returns a grouped channel as a solo unit. A channel that later leaves its group has
-- its feed lane created by the dashboard on first save; until then it is not auto-filled
-- — the same outcome as today, where a freshly ungrouped channel has autofill_enabled=0.
INSERT INTO autofill_lanes
    (channel_id, surface, enabled, cadence_config,
     min_queue_depth, target_queue_depth, reuse_min_age_days)
SELECT id, 'feed', autofill_enabled, cadence_config,
       min_queue_depth, target_queue_depth, reuse_min_age_days
  FROM channels WHERE group_id IS NULL;

COMMIT;
