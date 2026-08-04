-- 0014_story_surface.sql
-- Instagram Stories are a DESTINATION, not a post type. posts.post_type is inferred from
-- the content and says what a post IS; "story" says where it LANDS. Where a post lands
-- already lives on post_targets, so that is where the surface goes. This is what lets one
-- photo be a Story on Instagram AND an ordinary post on Telegram from a single Library
-- entry. See docs/design-instagram-stories.md.
--
-- posts.post_type still lists 'story' in its CHECK (from 0001). That value is VESTIGIAL and
-- unused: nothing creates it and publisher._validate refuses it. Do not reach for it — the
-- real story surface is post_targets.surface / publications.surface. It is left in place
-- only because removing it would mean a second full table rebuild for zero behaviour change.
--
-- post_targets must be REBUILT because its PRIMARY KEY widens and SQLite cannot ALTER one.
-- As in 0008: DROP TABLE with foreign keys ENABLED performs an implicit delete that FIRES
-- ON DELETE CASCADE, so enforcement is disabled for the rebuild and restored at the end.
-- The PRAGMAs stay OUTSIDE the explicit transaction, because PRAGMA foreign_keys is a
-- silent no-op while a transaction is open — it must run before BEGIN to actually disable
-- enforcement, and after COMMIT to actually restore it. Python's executescript() commits
-- before running, which ends migrate.py's own BEGIN and is why these PRAGMAs take effect.
-- Nothing currently references post_targets, so no child rows are at risk here, but the
-- pattern is kept identical so this file cannot be misread as an exception to it.
--
-- publications is NOT rebuilt. It carries three indexes and a cascading child
-- (post_metrics), which is exactly the risk 0008's header describes, and no key change here
-- forces a rebuild. Verified against SQLite before writing this: ALTER TABLE ADD COLUMN
-- accepts a NOT NULL DEFAULT together with a CHECK, and accepts
-- REFERENCES ... ON DELETE RESTRICT because the new column defaults to NULL. Both
-- constraints are genuinely enforced afterwards, and foreign keys are ON for every
-- connection (dashboard/lib/db.ts, worker/db.py), so the RESTRICT below actually bites.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE post_targets_new (
    post_id    INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    -- 'feed' = the normal post for that platform. 'story' = an Instagram Story.
    -- Named generically rather than "is_story" so Facebook Page Stories can adopt it when
    -- that adapter lands, without another migration.
    surface    TEXT    NOT NULL DEFAULT 'feed' CHECK (surface IN ('feed', 'story')),
    -- Widened from (post_id, channel_id): this is what allows ONE post to target ONE
    -- channel twice, once per surface (IG feed AND IG story).
    PRIMARY KEY (post_id, channel_id, surface)
);

-- Every existing target is a feed target: nothing today can be a story.
INSERT INTO post_targets_new (post_id, channel_id, surface)
    SELECT post_id, channel_id, 'feed' FROM post_targets;

DROP TABLE post_targets;
ALTER TABLE post_targets_new RENAME TO post_targets;
CREATE INDEX idx_post_targets_channel ON post_targets (channel_id);

COMMIT;
PRAGMA foreign_keys = ON;

-- publications: additive only.
--   surface  — which destination this send is for.
--   asset_id — NULL for a feed send (meaning "all of the post's assets, in order");
--              set for a story send (meaning "this ONE slide"). A multi-slide post aimed
--              at Stories fans out into one publication PER slide at scheduling time, so
--              each Story retries, fails, and reports metrics independently. RESTRICT so
--              deleting an asset a scheduled Story depends on is refused rather than
--              silently orphaning the send.
ALTER TABLE publications ADD COLUMN surface TEXT NOT NULL DEFAULT 'feed'
                                            CHECK (surface IN ('feed', 'story'));
ALTER TABLE publications ADD COLUMN asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT;
