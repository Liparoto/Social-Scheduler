-- =====================================================================================
-- 0017 — first-comment failure text.
--
-- publications already carries first_comment_status ('none'|'pending'|'posted'|'failed')
-- and first_comment_remote_id from 0001_init, but nothing to say WHY a comment failed.
--
-- `last_error` is not reusable here: a first comment is attempted only AFTER the media
-- publishes, so the publication is already 'posted' with last_error cleared to NULL.
-- Writing a comment failure into last_error would make a successful publish look like a
-- failed one on every screen that reads it.
--
-- The project rule is that failures are visibly failed, never silent — a bare 'failed'
-- status with no reason is close enough to silent to be worth its own column.
-- =====================================================================================

ALTER TABLE publications ADD COLUMN first_comment_error TEXT;

-- A failed first comment is never retried automatically: the media is already live, so a
-- blind retry risks a SECOND comment on a real post, which is worse than a missing one.
-- Retrying is therefore an explicit human action, requested from the dashboard and swept
-- up by the worker — the same request/clear handshake channels.avatar_refresh_requested
-- already uses. A dedicated flag, not a status value, so it stays distinguishable from
-- the transient 'pending' written while an attempt is in flight.
ALTER TABLE publications ADD COLUMN first_comment_retry_requested INTEGER NOT NULL DEFAULT 0;
