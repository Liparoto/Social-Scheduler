-- =====================================================================================
-- 0021 — BPP becomes CURATED, not computed.
--
-- 0020 built BPP as an algorithm: score every post by engagement rate, recycle the
-- winners. Wrong model. The owner already does this by hand and better — reviewing stats
-- periodically, marking a post because its likes were way above average, or it was saved
-- a lot, or several metrics were up together, then rotating the marked set at a frequency
-- they raise when the account is having a rough stretch.
--
-- An algorithm cannot make that judgement, and trying to encode it produced a score that
-- ranked a post with 59 reach above one with 1,462 reach and 151 interactions, purely
-- because a small denominator inflates a rate. The numbers' job is to SURFACE candidates;
-- the decision is the owner's.
--
-- So: a flag the owner sets, a pool that rotates, and a cadence in days.
-- See docs/design-bpp-recycling.md.
-- =====================================================================================

-- The mark. Set by a person, from the Insights leaderboard or the Library — never
-- automatically, which is the whole point of the redesign.
ALTER TABLE posts ADD COLUMN is_bpp INTEGER NOT NULL DEFAULT 0;

-- When it was marked. Not decoration: it answers "is this still one of my best?" months
-- later, and lets the UI show the pool oldest-mark-first for a periodic re-review.
ALTER TABLE posts ADD COLUMN bpp_marked_at TEXT;

-- How often a BPP goes out, in DAYS. 0 = off (default).
--
-- Days, not slots (which is what 0020 used), because that is how the owner thinks about
-- it — "one a month", "one a week" — and because a slot-based share silently changes
-- meaning the moment the posting cadence changes. The dial gets turned up when account
-- performance dips, so it has to mean the same thing each time it is read.
ALTER TABLE channels       ADD COLUMN bpp_every_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_groups ADD COLUMN bpp_every_days INTEGER NOT NULL DEFAULT 0;

-- NOTE: 0020's `bpp_every_n_slots` is superseded and no code reads it any more. It is
-- left in place rather than dropped: removing a column from `channels` means rebuilding
-- the table, and channels has cascading children — 0008's header documents how a naive
-- rebuild reports success while silently deleting every dependent row. A dead integer
-- column costs nothing; that risk is not worth taking to reclaim it. It was never
-- enabled on any install (default 0), so nothing is lost by ignoring it.
