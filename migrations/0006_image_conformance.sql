-- 0006_image_conformance.sql
-- Store a Meta-conformed publish derivative per image asset, plus the framing decision.
-- The worker serves publish_path (falling back to storage_path for legacy rows). Additive.
ALTER TABLE assets ADD COLUMN publish_path TEXT;                       -- conformed JPEG the worker serves; NULL -> use storage_path
ALTER TABLE assets ADD COLUMN conform_mode TEXT NOT NULL DEFAULT 'none'; -- 'none' | 'crop' | 'pad'
ALTER TABLE assets ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;   -- 1 = framing auto-decided, awaiting user confirm
