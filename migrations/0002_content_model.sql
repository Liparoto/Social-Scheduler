-- 0002_content_model.sql — content model: recycling kind, in-season periods,
-- per-account targeting, caption variants, and content status.
-- Additive + backfill so existing installs keep working. See docs/design-content-model.md.

-- posts: new axes. content_status is SEPARATE from the coarse posts.status (overview hint):
-- content_status governs automation eligibility.
ALTER TABLE posts ADD COLUMN content_kind   TEXT NOT NULL DEFAULT 'evergreen'
    CHECK (content_kind IN ('one_time', 'evergreen'));
ALTER TABLE posts ADD COLUMN content_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (content_status IN ('draft', 'ready', 'retired'));
ALTER TABLE posts ADD COLUMN cooldown_days  INTEGER;   -- NULL = use channel.reuse_min_age_days

-- Reusable library of named windows. recurs_yearly=1 -> month/day columns (wrap-around
-- allowed: start after end means the window spans the New Year). recurs_yearly=0 -> ISO dates.
CREATE TABLE periods (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    recurs_yearly INTEGER NOT NULL DEFAULT 1,
    start_month   INTEGER, start_day INTEGER,
    end_month     INTEGER, end_day   INTEGER,
    start_date    TEXT, end_date TEXT,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A post links to a period as 'green' (in-season) or 'blackout' (excluded). Blackout wins.
CREATE TABLE post_periods (
    post_id   INTEGER NOT NULL REFERENCES posts(id)   ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    mode      TEXT NOT NULL CHECK (mode IN ('green', 'blackout')),
    PRIMARY KEY (post_id, period_id, mode)
);

-- Explicit accounts a post is for. "All" is expanded to current channels at set-time (snapshot).
CREATE TABLE post_targets (
    post_id    INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, channel_id)
);
CREATE INDEX idx_post_targets_channel ON post_targets (channel_id);

-- 1..N captions per post. platform NULL = generic (rotated for variety); else platform-specific.
CREATE TABLE caption_variants (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform   TEXT,
    body       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_caption_variants_post ON caption_variants (post_id);

-- Backfill existing installs so nothing disappears:
--  * existing content stays eligible (ready), evergreen by default (column default);
--  * targets inferred from the channels each post already published/queued to;
--  * the single existing caption becomes one generic variant.
UPDATE posts SET content_status = 'ready';
INSERT INTO post_targets (post_id, channel_id)
    SELECT DISTINCT post_id, channel_id FROM publications
    WHERE status NOT IN ('failed', 'canceled');  -- a dead attempt is not a target
INSERT INTO caption_variants (post_id, platform, body, sort_order)
    SELECT id, NULL, caption, 0 FROM posts WHERE caption IS NOT NULL AND TRIM(caption) <> '';
