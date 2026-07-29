-- 0016_cover_asset.sql
-- Let a VIDEO asset point at an IMAGE asset to use as its Reels cover:
--   assets.cover_asset_id  (new, nullable, references assets(id))
--
-- Instagram's cover_url takes a public image URL and OVERRIDES thumb_offset entirely
-- ("If you specify both cover_url and thumb_offset, we use cover_url and ignore
-- thumb_offset"). So a cover image and a cover frame are alternatives, not a stack --
-- assets.cover_frame_ms stays populated while an image overrides it, so removing the
-- image restores the previously chosen frame rather than losing it.
--
-- The cover is an ordinary assets row (media_kind='image') so it inherits content-hash
-- dedup, the local store, and the worker's URL resolution for free. The Library lists
-- POSTS rather than assets, so a cover does not show up as a spurious library entry.
--
-- Purely additive: a nullable column with no CHECK, so SQLite can ALTER TABLE ADD COLUMN
-- and no table rebuild is needed.

ALTER TABLE assets ADD COLUMN cover_asset_id INTEGER REFERENCES assets(id);
