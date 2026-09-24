-- 0029_token_health.sql
-- Meta tokens for Instagram and Threads die after ~60 days unless renewed, and an expired
-- one can never be renewed — only reconnected by hand. The worker now renews them
-- (worker/token_upkeep.py); these two columns let it pace itself and tell the owner when
-- it cannot.
--
-- token_error          what a human must do, shown on the Channels page. NULL = healthy.
-- token_next_check_at  ISO-8601 UTC; the worker skips the channel until then. NULL = due
--                      now, which is what the dashboard sets when a new token is saved.
--
-- Additive only: code that predates this migration ignores both columns.

ALTER TABLE channels ADD COLUMN token_error TEXT;
ALTER TABLE channels ADD COLUMN token_next_check_at TEXT;
