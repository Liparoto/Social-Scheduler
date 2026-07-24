-- 0007_queue_control.sql
-- Hold/pause a scheduled send without canceling it: is_held=1 makes the worker skip the row
-- while preserving scheduled_at (Resume just clears it). A modifier on 'scheduled', not a new
-- status (avoids rewriting the status CHECK). Additive.
ALTER TABLE publications ADD COLUMN is_held INTEGER NOT NULL DEFAULT 0;
