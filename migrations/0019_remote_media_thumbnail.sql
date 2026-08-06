-- =====================================================================================
-- 0019 — cache the Insights leaderboard's thumbnails locally.
--
-- remote_media.thumbnail_url is a SIGNED CDN link with an expiry, exactly like the
-- profile-photo URLs 0012 dealt with. Hotlinking it works on the day it is synced and
-- then quietly rots: within weeks the top-content table becomes a grid of broken images,
-- and for a post this install did not publish there is no local original to fall back on
-- (the asset store only holds media WE uploaded).
--
-- So the worker downloads a copy, exactly as it already does for avatars, and the
-- dashboard serves it from our own disk. Same shape as 0012_channel_avatar.sql: a
-- store-relative path plus the time it was fetched.
--
-- Purely additive: two nullable columns on remote_media, no CHECK involved, so
-- ALTER TABLE ... ADD COLUMN is enough and none of the table-rebuild cascade risk from
-- 0008/0009 applies.
-- =====================================================================================

-- Store-relative path (e.g. 'thumbnails/12.jpg'), NULL until the worker has fetched one.
-- NULL is a normal state, not an error: the row may be newly synced, the CDN link may
-- have expired before we got to it, or the platform may serve no thumbnail at all (a
-- Threads text post has none). The UI renders a plain tinted square for all three.
ALTER TABLE remote_media ADD COLUMN thumbnail_path TEXT;

-- When that copy was taken. Lets the job skip work it has already done without having to
-- stat the file, and distinguishes "never tried" (NULL) from "tried and got nothing"
-- (set, with thumbnail_path still NULL) — otherwise a post whose CDN link had already
-- expired would be retried on every single cycle, forever.
ALTER TABLE remote_media ADD COLUMN thumbnail_fetched_at TEXT;
