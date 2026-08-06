-- =====================================================================================
-- 0020 — BPP (best-performing-post) recycling.
--
-- worker/autofill.py already ranked by performance, but the tier gate put every
-- never-posted item ahead of every proven one, so on this install (100 never-posted vs 11
-- posted) the performance term could not influence a slot for about three months. This
-- setting lets a SHARE of slots deliberately bypass that gate.
--
-- 0 means off, and that is the default: this changes what gets published to a live
-- account, so it stays inert until somebody turns it on. See docs/design-bpp-recycling.md.
--
-- Mirrored onto BOTH channels and channel_groups for the same reason 0013 mirrored the
-- other auto-fill fields: a group fills as one unit with one cadence and one selection
-- decision, and select-side code reads whichever row is the unit. A setting present on
-- only one of them would silently do nothing for grouped channels.
--
-- Purely additive: ALTER TABLE ... ADD COLUMN with a constant default, no CHECK widened,
-- so none of the table-rebuild cascade risk from 0008/0009 applies.
-- =====================================================================================

-- Every Nth auto-filled slot is a recycle slot. 0 = off (default).
--
-- Deliberately a COUNT, not a percentage: "one slot in four" is something an owner can
-- picture and predict, and it makes the choice deterministic and testable. A share like
-- 0.25 would have to be turned into a decision per slot anyway, and doing that randomly
-- would cluster and could not be explained after the fact.
ALTER TABLE channels       ADD COLUMN bpp_every_n_slots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_groups ADD COLUMN bpp_every_n_slots INTEGER NOT NULL DEFAULT 0;

-- Records that a publication was chosen BECAUSE it performed well, rather than by the
-- normal never-posted-first ordering.
--
-- Worth its own column rather than inferring it later: once the queue is full there is no
-- way to reconstruct why a given item was picked, and "why is this old post going out
-- again?" is exactly the question this feature will prompt. The dashboard badges it.
ALTER TABLE publications ADD COLUMN is_recycled INTEGER NOT NULL DEFAULT 0;
