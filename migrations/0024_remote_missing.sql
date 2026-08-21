-- 0024_remote_missing.sql
-- Stop asking the platform about a post that is no longer there.
--
-- A post deleted on Instagram after publishing leaves our publication row behind, still
-- `posted`, still carrying its remote_post_id. Every metrics cycle asks Instagram for its
-- insights and gets error 100 / subcode 33 ("object does not exist, cannot be loaded due to
-- missing permissions, or does not support this operation"), forever. Publication 48 on the
-- owner's install had logged that 703 times in a single log file before this shipped.
--
-- It retried every 30-second cycle rather than every 6 hours, and the reason is worth
-- writing down: the refresh interval gate is `NOT EXISTS (a post_metrics row newer than the
-- cutoff)`. A FAILED fetch writes no post_metrics row, so it does not count as an attempt —
-- the gate only throttles publications that succeed. Nothing was tracking failure at all.
--
-- Why not reuse remote_media.is_deleted, which already means "gone from the account":
-- that flag is set by media_sync noticing a post has vanished from the account's media
-- list. It requires a mirror row to exist in the first place, and publication 48 has none —
-- the post was already gone before it was ever synced, so the sync can never see it and
-- will never create one. A terminal API error is first-hand evidence where absence-based
-- inference has nothing to work with. The dashboard folds both into the one badge it
-- already shows, so this is a second DETECTION path, not a second concept.
--
-- Deliberately recoverable. `remote_missing_at` is cleared by an explicit metrics refresh,
-- so a post frozen by a permissions problem rather than a deletion is one click from being
-- retried. That matters because error 100/33 genuinely covers both cases, which is also why
-- the streak below exists rather than marking on the first failure.

ALTER TABLE publications ADD COLUMN remote_missing_at TEXT;

-- Human-readable, for the dashboard and for anyone reading the row later. Never the raw
-- API response: that is logged, and it can carry material we do not want stored.
ALTER TABLE publications ADD COLUMN remote_missing_reason TEXT;

-- Consecutive gone-shaped failures. Reset to 0 by any successful fetch, so an intermittent
-- error can never accumulate its way to a mark across days. Marking only after several in a
-- row is what keeps a transient token/permission problem — which returns the SAME error
-- code as a deletion — from freezing every post on the account at once.
ALTER TABLE publications ADD COLUMN metrics_failure_streak INTEGER NOT NULL DEFAULT 0;
