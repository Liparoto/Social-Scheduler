-- =====================================================================================
-- 0023 — archiving a post: getting it out of the Library WITHOUT destroying its record.
--
-- deletePost() refuses to delete a post with a 'posted'/'publishing' publication, on
-- purpose: erasing it would erase the record of something that is live on Instagram, and
-- the guard sits ON the DELETE so the worker can't race it. The cost of that correctness
-- is that a test post, a duplicate or a mistake is stuck in the Library forever, which
-- works against the Library's job of showing what is actually available to schedule.
--
-- archived_at is the way out: a LOCAL VISIBILITY flag and nothing more. The post row, its
-- publications, its metrics and its insights all stay exactly as they are — an archived
-- post is still counted in Insights and still shows its history, it just stops appearing
-- in the Library grid and in Compose's reuse picker.
--
-- Deliberately NOT an automation gate. content_status ('draft'/'ready'/'retired') already
-- decides whether auto-fill may pick a post up, and it is visible and editable in the UI;
-- teaching archived_at to ALSO block auto-fill would mean two switches doing one job, one
-- of them invisible. The Archive action instead offers to set content_status in the same
-- step (defaulting to 'retired'), so "this is inactive" stays legible in the bucket that
-- has always meant it. The worker is untouched by this migration for that reason.
--
-- NULL = live in the Library. A UTC ISO timestamp = archived, and when.
-- =====================================================================================

ALTER TABLE posts ADD COLUMN archived_at TEXT;

-- PARTIAL on purpose. A plain index on archived_at would be almost entirely NULL keys —
-- SQLite indexes NULLs — so it would neither shrink nor speed up the Library's
-- "archived_at IS NULL" scan, which is the common case and reads nearly every row anyway.
-- Indexing only the archived rows keeps it proportional to what is actually archived and
-- serves the one query that benefits: the Archived view.
CREATE INDEX IF NOT EXISTS idx_posts_archived_at
    ON posts(archived_at) WHERE archived_at IS NOT NULL;
