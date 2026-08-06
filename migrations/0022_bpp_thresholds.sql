-- =====================================================================================
-- 0022 — the standout thresholds become the owner's, not mine.
--
-- 0021 hardcoded "top 5% of one metric, or top 10% of two or more". Those numbers were
-- picked from ONE account's data and there is no reason they suit anybody else: a person
-- with a huge back catalogue may want the strictest 2%, someone building a rotation from
-- a small library may want half of it. The right tolerance also moves as an account grows
-- — what counted as exceptional at 1,000 followers does not at 20,000.
--
-- Per CHANNEL rather than per install: a personal account and a business account have
-- different baselines and different purposes, and this install is explicitly meant to run
-- several. Defaults reproduce 0021's behaviour exactly, so nothing changes until touched.
-- =====================================================================================

-- Top N% on a SINGLE metric — "way above average likes" on its own.
ALTER TABLE channels ADD COLUMN bpp_strong_pct INTEGER NOT NULL DEFAULT 5;

-- Top N% on TWO OR MORE metrics — "several things were up together". Normally looser than
-- the single-metric bar, since clearing it twice is the harder part, but nothing enforces
-- that: an owner who wants them equal, or inverted, can have it.
ALTER TABLE channels ADD COLUMN bpp_broad_pct INTEGER NOT NULL DEFAULT 10;
