-- 0003_tag_taxonomy.sql
-- Adds a taxonomy dimension to the existing flat `tags` table and seeds the fixed
-- time-of-day bands. Additive and safe on installs that already have (unused) tags:
-- new column defaults to 'topic', so any pre-existing tag stays a topic.

ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'topic';

-- The fixed time-of-day band vocabulary. INSERT OR IGNORE keeps this idempotent
-- against the existing UNIQUE(name COLLATE NOCASE) constraint.
INSERT OR IGNORE INTO tags (name, kind) VALUES
  ('morning',   'time_of_day'),
  ('afternoon', 'time_of_day'),
  ('evening',   'time_of_day'),
  ('anytime',   'time_of_day');

-- Reverse lookups ("posts carrying tag X", "tags on post Y") stay cheap.
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id);
