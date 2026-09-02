"""Ranking must not inherit IMPORT order.

The last tiebreak used to be `created_at ASC` at full precision. A bulk import (the
Apple Notes recovery wrote 133 posts inside four minutes) gives every post a distinct
created_at seconds apart, so that "tiebreak" was really a total order — and it was the
order the photos happened to sit in on the phone. Themed runs stayed glued together:
once Football Season opened, seven football posts came out back to back because they
had been imported back to back.

The fix ranks same-DAY posts by a stable scatter of the post id instead. Content
genuinely older by a day still ranks first; a batch is shuffled.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone

from worker.autofill import group_rank, select_candidates

from .test_autofill import make_channel, make_post

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)

# Same day, seconds apart — exactly the shape the Notes import produced.
BATCH = [f"2026-07-30 00:54:{s:02d}" for s in range(12)]


def _rank(conn, channel_id):
    return [r["post_id"] for r in select_candidates(conn, channel_id, NOW, "feed")]


def test_posts_imported_in_one_batch_are_not_ranked_in_import_order(conn):
    ch = make_channel(conn)
    ids = [make_post(conn, ch, created_at=ts) for ts in BATCH]

    order = _rank(conn, ch)

    assert sorted(order) == sorted(ids), "every post is still a candidate"
    assert order != ids, "a same-day batch must not come out in the order it was imported"


def test_content_older_by_a_day_still_ranks_ahead_of_a_newer_batch(conn):
    """The scatter is a TIEBREAK, not a replacement: staleness still wins. Without this
    the shuffle would also scramble genuinely-old against genuinely-new content."""
    ch = make_channel(conn)
    older = [make_post(conn, ch, created_at=f"2026-01-05 00:0{i}:00") for i in range(4)]
    newer = [make_post(conn, ch, created_at=f"2026-06-05 00:0{i}:00") for i in range(4)]

    order = _rank(conn, ch)

    assert set(order[:4]) == set(older), "the older day comes first, whatever the scatter"
    assert set(order[4:]) == set(newer)


def test_the_scatter_is_stable_across_calls(conn):
    """Deterministic, not RANDOM(): the same pool must rank the same way twice, so what
    the dashboard previews is what auto-fill actually queues."""
    ch = make_channel(conn)
    for ts in BATCH:
        make_post(conn, ch, created_at=ts)

    assert _rank(conn, ch) == _rank(conn, ch)


def test_group_rank_scatters_a_batch_too(conn):
    """The group path has its own copy of the ORDER BY. This install fills through a
    channel GROUP, so a fix that landed only on the solo query would change nothing here.
    """
    ch = make_channel(conn)
    ids = [make_post(conn, ch, created_at=ts) for ts in BATCH]

    order = [r["post_id"] for r in group_rank(conn, [ch], ids)]

    assert sorted(order) == sorted(ids)
    assert order != ids, "the group ranking must scatter an import batch as well"


def test_the_scatter_does_not_walk_the_ids_in_a_fixed_stride(conn):
    """A single `(id * K) % M` is a LINEAR map, and by the three-distance theorem sorting
    by one yields a walk with at most three step sizes — on the real database it marched
    145, 138, 131, 124..., a constant -7. That is a scatter only by appearance: any theme
    whose ids share a residue class rides the lattice straight back into a clump, which
    is what still put three football posts back to back. Mixing twice, through different
    moduli, breaks the arithmetic structure.

    Measured on the live pool (26 football posts among 96): import order gave a longest
    run of 5; one multiplication, 3; two, 2 — the same as an unstructured shuffle.
    """
    ch = make_channel(conn)
    for i in range(100):
        make_post(conn, ch, created_at=f"2026-07-30 00:{54 + i // 60:02d}:{i % 60:02d}")

    order = _rank(conn, ch)
    steps = Counter(b - a for a, b in zip(order, order[1:]))
    _, dominant = steps.most_common(1)[0]

    assert dominant <= len(order) // 2, (
        f"one id-step accounts for {dominant}/{len(order) - 1} of the ranking — "
        f"that is a lattice, not a scatter: {steps.most_common(3)}"
    )
