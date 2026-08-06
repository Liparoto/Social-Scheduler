"""BPP — deciding which proven post deserves a second run.

Auto-fill already preferred top performers, but two things kept that from mattering; both
are described in docs/design-bpp-recycling.md and summarised here because they are the
whole reason this module exists.

**The tier gate.** Never-posted content outranks everything, so with 100 unposted items
against 11 posted the performance term could not touch a slot for about three months. This
module supplies the slots that deliberately bypass that gate.

**The score.** The old score was `reach + saves`, and on the live account `saves` peaks at
2 against a mean reach of 303 — so it was raw reach wearing a different name. Reach is
mostly distribution, not quality: a post that reached 754 with 2.7% engagement outranked
one that reached 661 with 6.5%. For "what deserves a second run", the rate is the better
question.

Everything here is pure — no database, no clock — so each rule can be tested on its own.
"""

from __future__ import annotations

from dataclasses import dataclass

# Below this reach a post has no score AT ALL, rather than a small one.
#
# Without a floor, a post that reached 3 people and got 1 like scores 33% and outranks
# everything on the account forever. Too little evidence is not the same as poor
# performance, and the honest representation of "we cannot tell yet" is None.
BPP_MIN_REACH = 50


@dataclass(frozen=True)
class Snapshot:
    """One metrics reading for one publication of a post."""

    reach: int | None
    likes: int | None
    comments: int | None
    saves: int | None
    shares: int | None


def interactions(snapshot: Snapshot) -> int:
    """Every deliberate action a viewer took. Absent fields count as zero — a platform
    that does not report saves has not reported *fewer* saves."""
    return sum(
        value or 0
        for value in (snapshot.likes, snapshot.comments, snapshot.saves, snapshot.shares)
    )


def engagement_rate(snapshot: Snapshot, min_reach: int = BPP_MIN_REACH) -> float | None:
    """Interactions per person reached, or None when there is not enough evidence.

    None rather than 0.0 for a below-floor post, and the distinction is load-bearing:
    0.0 means "we measured, nobody engaged" and should rank last, while None means "we
    cannot tell" and should be left out of the ranking rather than punished by it.
    """
    reach = snapshot.reach or 0
    if reach < min_reach:
        return None
    return interactions(snapshot) / reach


@dataclass(frozen=True)
class Candidate:
    """A post considered for a recycle slot, with the numbers the ranking needs."""

    post_id: int
    # Best rate across this post's publications, or None when none clears the floor.
    rate: float | None
    # Best reach across the same, used only to break ties.
    reach: int


def score_candidate(snapshots: list[Snapshot], post_id: int,
                    min_reach: int = BPP_MIN_REACH) -> Candidate:
    """Reduce one post's snapshots to a single comparable Candidate.

    Callers pass the LATEST snapshot per publication, not every snapshot ever taken. An
    early reading has both low reach and low interactions, so taking the best rate across
    a noisy series rewards whichever moment happened to look flattering rather than how
    the post actually did. Best-across-PUBLICATIONS is still right: a post that ran twice
    is fairly represented by its better run.
    """
    rates = [r for r in (engagement_rate(s, min_reach) for s in snapshots) if r is not None]
    reaches = [s.reach or 0 for s in snapshots]
    return Candidate(
        post_id=post_id,
        rate=max(rates) if rates else None,
        reach=max(reaches) if reaches else 0,
    )


def rank_candidates(candidates: list[Candidate]) -> list[Candidate]:
    """Best first. Candidates with no rate are dropped, not sorted to the bottom.

    Dropping is the point: a recycle slot exists to run something PROVEN. Handing it a
    post with no evidence would make it an ordinary slot wearing a badge that says
    otherwise — and the caller already falls back to normal selection when this is empty,
    which is the honest way to spend that slot.
    """
    scored = [c for c in candidates if c.rate is not None]
    return sorted(scored, key=lambda c: (c.rate, c.reach), reverse=True)


def is_recycle_slot(sequence: int, every_n: int) -> bool:
    """Whether the slot at `sequence` in this unit's publication history is a recycle slot.

    Deterministic on purpose. A random share would cluster, could not be reproduced in a
    test, and could not be explained when somebody asks why a particular post went out
    again. Counting from the unit's existing publications means the ratio holds across
    cycles instead of restarting with every batch.

    `every_n <= 0` is off — the caller should not even ask, but a guard here means a
    stray 0 can never divide by zero on the publish path.
    """
    if every_n <= 0:
        return False
    return sequence % every_n == 0


def merge_recycle_slots(normal, proven, recycle_positions, total, key):
    """Interleave proven picks into a normal candidate list at the recycle positions.

    Returns `[(item, is_recycled), ...]`, at most `total` long and possibly shorter when
    the pools run out — a short queue is the honest outcome when there is nothing left
    that passes the rules.

    Two properties that matter more than they look:

    * **No post appears twice in one batch.** Both pools are drawn from the same library
      and a proven post is often in both, so without the `used` set a recycle slot would
      happily queue the same post the next ordinary slot then queues again — two sends of
      one post, minutes apart, to a live account.
    * **A recycle position falls back to normal selection** when no unused proven
      candidate remains. Leaving the slot empty would shrink the queue to buy nothing;
      the flag reports what actually happened, so a fallback slot is not badged as a
      recycle.
    """
    used: set = set()
    out: list = []
    normal_i = proven_i = 0

    def take(pool, index):
        while index < len(pool):
            candidate = pool[index]
            index += 1
            if key(candidate) not in used:
                return candidate, index
        return None, index

    for position in range(total):
        item = None
        recycled = False
        if position in recycle_positions:
            item, proven_i = take(proven, proven_i)
            recycled = item is not None
        if item is None:
            item, normal_i = take(normal, normal_i)
        if item is None:
            break  # both pools exhausted
        used.add(key(item))
        out.append((item, recycled))
    return out
