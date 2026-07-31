-- 0012_channel_avatar.sql
-- Cache each channel's account profile photo so a channel reads as the ACCOUNT it is,
-- not just as an accent colour:
--   channels.avatar_path               (new, nullable)
--   channels.avatar_fetched_at         (new, nullable)
--   channels.avatar_refresh_requested  (new, NOT NULL DEFAULT 0)
--   channels.avatar_error              (new, nullable)
--
-- avatar_path holds a path RELATIVE to the asset store (e.g. 'avatars/3.jpg'), matching
-- how assets.storage_path works — never an absolute path, and never the platform's URL.
-- Storing the URL would not work: Instagram's profile_picture_url and the Facebook Page
-- picture URL are short-lived SIGNED CDN links. They expire, so every avatar would turn
-- into a broken image within days, and the dashboard would be issuing a request to Meta
-- on every page render.
--
-- avatar_refresh_requested is the dashboard -> worker channel for the "Refresh photo"
-- button, mirroring publications.metrics_refresh_requested_at: the dashboard sets a flag,
-- the worker clears it. The dashboard never calls a platform API itself.
--
-- avatar_error keeps a failed fetch VISIBLE on the Channels page rather than silent. It
-- is redacted before it is written (worker/redact.py) — a Graph error body can carry the
-- access token as a query parameter.
--
-- Purely additive: no CHECK is involved, so SQLite's ALTER TABLE ... ADD COLUMN is enough
-- and there is no need for the table rebuild that 0008/0009 needed (and so none of the
-- cascade-delete risk a rebuild carries). Same shape as 0010_channel_colour.sql.
--
-- Every existing row defaults to "no photo yet", which the worker's selection rule picks
-- up on its next cycle.

ALTER TABLE channels ADD COLUMN avatar_path TEXT;
ALTER TABLE channels ADD COLUMN avatar_fetched_at TEXT;
ALTER TABLE channels ADD COLUMN avatar_refresh_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN avatar_error TEXT;
