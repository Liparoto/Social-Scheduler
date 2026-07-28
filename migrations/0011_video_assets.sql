-- 0011_video_assets.sql
-- Add the three video-only properties an asset needs:
--   assets.duration_ms      (new, nullable)  length in milliseconds; NULL for images
--   assets.cover_frame_ms   (new, nullable)  chosen cover frame; NULL = Meta's default frame 0
--   assets.has_audio        (new, 0/1)       whether a `soun` track is present
--
-- Stored on the ASSET, not the post, so an evergreen video that is recycled reuses the
-- cover frame chosen once — exactly the pattern 0006 established with conform_mode /
-- needs_review for image framing.
--
-- cover_frame_ms holds a MILLISECOND OFFSET, not an image. Instagram's thumb_offset and
-- TikTok's video_cover_timestamp_ms both take a millisecond offset and extract the frame
-- themselves, so no cover image is generated, stored, deduped or served anywhere.
--
-- Purely additive: assets.media_kind's CHECK already allows 'video' (0001_init.sql:55) and
-- posts.post_type already allows 'reel' (0001_init.sql:76), so no table rebuild is needed
-- and none of 0008/0009's cascade-delete risk applies.

ALTER TABLE assets ADD COLUMN duration_ms INTEGER;
ALTER TABLE assets ADD COLUMN cover_frame_ms INTEGER;
ALTER TABLE assets ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 0;
