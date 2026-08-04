-- 0015_story_framing.sql
-- A SECOND derivative pair on assets, for the 9:16 story surface.
--
-- Until now an asset had exactly one derivative (publish_path/conform_mode), shaped for the
-- FEED's 4:5..1.91:1 range. A Story is 9:16 — outside that range — so one derivative cannot
-- serve both surfaces. That is why the story publish path sends the untouched original
-- (see 0014's header and docs/design-instagram-stories.md §4): correct for a source that is
-- already story-shaped, and wrong for a landscape one, where Instagram applies its own fit
-- and the owner has no say in it.
--
-- story_path NULL means "this source is already story-shaped, publish the original" — the
-- behaviour the first real Story shipped with, deliberately preserved. A canvas is generated
-- only when the source genuinely doesn't fit; the tolerance lives in
-- dashboard/lib/story-canvas.ts (needsStoryCanvas), which is also where the two treatments
-- are implemented.
--
-- story_mode is deliberately NOT the same enum as conform_mode. They overlap on 'crop' but
-- 'pad' is feed-only: white bars are a reasonable feed look and a mistake on a full-bleed
-- surface, so the CHECK below refuses it rather than letting a feed mode leak across.
--
-- Additive: no rebuild. Mirrors the existing publish_path/conform_mode pair rather than
-- introducing an asset_derivatives table — a table would generalise to a future Facebook
-- Page Story, but that adapter doesn't exist and this is the shape the codebase already uses
-- for exactly this job. Revisit if a third surface ever lands.

ALTER TABLE assets ADD COLUMN story_path TEXT;
ALTER TABLE assets ADD COLUMN story_mode TEXT NOT NULL DEFAULT 'blurred'
                                          CHECK (story_mode IN ('blurred', 'crop'));
