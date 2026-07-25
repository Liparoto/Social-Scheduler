-- 0010_channel_colour.sql
-- Add an optional per-channel accent colour:
--   channels.color_hue  (new, nullable)
--
-- Stored as an HSL hue (integer, 0-360) rather than a hex value: the dashboard already
-- derives each channel's accent colour from a hue via channelHue()/channelColor() in
-- dashboard/lib/format.ts, which builds the text/background/dot triple as HSL. Storing
-- a hue means a chosen colour reuses that exact derivation, so contrast and dark-mode
-- behavior stay guaranteed and an illegible colour is not possible.
--
-- NULL (the default, and every existing row) means "derive the colour from the channel
-- id, as before" — nothing about an unmodified channel's appearance changes.
--
-- Unlike 0008/0009, this is purely additive: SQLite can ALTER TABLE ... ADD COLUMN
-- for a nullable column with no CHECK involved, so there is no need to rebuild the
-- table and none of the cascade-delete risk that a rebuild carries.

ALTER TABLE channels ADD COLUMN color_hue INTEGER;
