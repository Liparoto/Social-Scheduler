"""BPP — a curated pool of proven posts, rotated on a cadence.

The owner already does this by hand: review the stats every week or so, mark a post
because its likes were way above average, or it was saved a lot, or several metrics were
up together, then repost the marked ones on a rotation — more often when the account is
having a rough stretch.

An earlier version of this module tried to make that decision automatically and got it
wrong in an instructive way: scoring by engagement rate ranked a post with 59 reach above
one with 1,462 reach and 151 interactions, because a small denominator inflates a rate.
Raw reach had the opposite bias. There is no scalar that captures "this one deserves
another run" — that is a judgement about the CONTENT, and the person who made it is
better placed than any formula.

So nothing here decides anything. It does two jobs:

  * **surface candidates** — which posts stand out against this account's own baseline,
    and on which metrics, so a review pass is a short list instead of 164 rows;
  * **schedule the pool** — whose turn it is, and when.

Pure functions only: no database, no clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

# Metrics a post can stand out on. Ordered for display.
STANDOUT_METRICS = ("reach", "views", "likes", "comments", "saves", "shares")

# A metric earns a place in the ranking only if its top decile is high enough to actually
# separate posts. Recomputed FOR EACH ACCOUNT, every time — this is not a list of metrics
# that count and metrics that do not.
#
# Worked example: on this owner's Instagram, `saves` has a median of 0 and a top-10%
# cutoff of 1, so "top 10% for saves" would mean "got one save" — true, useless, and it
# would badge a third of the library. On an account whose audience actually saves things,
# that cutoff comes out high and saves rank exactly like every other metric. Saves are
# collected for every account regardless (worker/metrics.py REQUESTED_METRICS); what
# varies is only whether they can tell posts apart HERE, today.
#
# Same logic protects every metric: a brand-new account with almost no engagement gets no
# standouts at all rather than badging noise, which is the honest answer.
MIN_DISCRIMINATING_CUTOFF = 3

# "Way above average on one metric" and "solidly good on several" are both reasons the
# owner marks a post, so both qualify. One number could not express that.
STRONG_PERCENTILE = 0.05      # top 5% on a single metric
BROAD_PERCENTILE = 0.10       # top 10% on two or more
BROAD_MIN_METRICS = 2


@dataclass(frozen=True)
class Standout:
    """Why a post is worth a look. Never why it was chosen — nothing here chooses."""

    post_id: int
    strong: tuple[str, ...]     # metrics where it is top STRONG_PERCENTILE
    broad: tuple[str, ...]      # metrics where it is top BROAD_PERCENTILE

    @property
    def is_candidate(self) -> bool:
        return bool(self.strong) or len(self.broad) >= BROAD_MIN_METRICS

    def reason(self) -> str:
        """Plain words for the badge — 'top 5% likes', not a score.

        The metric names are the point. "This was saved far more than usual" is
        actionable in a way that "0.42" never is.
        """
        if self.strong:
            return f"top 5% · {', '.join(self.strong)}"
        if len(self.broad) >= BROAD_MIN_METRICS:
            return f"top 10% · {', '.join(self.broad)}"
        return ""


def percentile_cutoff(values: list[int], fraction: float) -> int | None:
    """The value marking the top `fraction` of `values`, or None if there is no signal.

    None when the sample is too small to rank, and when the cutoff is too low to
    discriminate (see MIN_DISCRIMINATING_CUTOFF) — a metric everybody scores 0 or 1 on
    cannot tell good posts from ordinary ones, and pretending otherwise is how a
    "standout" badge ends up on a third of the account.
    """
    present = sorted((v for v in values if v is not None), reverse=True)
    if len(present) < 10:
        return None
    index = max(int(len(present) * fraction) - 1, 0)
    cutoff = present[index]
    return cutoff if cutoff >= MIN_DISCRIMINATING_CUTOFF else None


def find_standouts(posts: list[dict]) -> list[Standout]:
    """Rank every post against the others in the SAME set.

    "Above average" only means anything relative to this account over the period being
    looked at, so the caller decides the window (the dashboard reuses its existing
    7/30/90/365 range control) and this ranks whatever it is handed. There is no absolute
    threshold anywhere — an account averaging 11 likes and one averaging 11,000 both get
    a useful answer.
    """
    if not posts:
        return []

    usable = {}
    for metric in STANDOUT_METRICS:
        values = [p.get(metric) for p in posts]
        strong = percentile_cutoff(values, STRONG_PERCENTILE)
        broad = percentile_cutoff(values, BROAD_PERCENTILE)
        if strong is not None or broad is not None:
            usable[metric] = (strong, broad)

    out = []
    for post in posts:
        strong_hits, broad_hits = [], []
        for metric, (strong_cut, broad_cut) in usable.items():
            value = post.get(metric)
            if value is None:
                continue
            if strong_cut is not None and value >= strong_cut:
                strong_hits.append(metric)
            if broad_cut is not None and value >= broad_cut:
                broad_hits.append(metric)
        out.append(Standout(post["id"], tuple(strong_hits), tuple(broad_hits)))
    return out


def rotation_period_days(pool_size: int, every_days: int) -> int | None:
    """How long until a given BPP comes round again. None when BPP is off or empty.

    The number the owner actually needs and would otherwise have to work out: two posts
    at every 14 days is not "every 14 days", it is each post reappearing monthly. The UI
    states this rather than making somebody multiply.
    """
    if every_days <= 0 or pool_size <= 0:
        return None
    return pool_size * every_days


def pool_is_thin(pool_size: int, every_days: int, min_period_days: int = 90) -> bool:
    """True when the cadence would recycle the same posts uncomfortably often.

    A warning, never a block — the owner may genuinely want a tight rotation for a
    stretch, and this tool does not overrule them. It only makes the consequence visible
    before it happens rather than after somebody notices the same post twice in a month.
    """
    period = rotation_period_days(pool_size, every_days)
    return period is not None and period < min_period_days


def bpp_slot_indices(
    slot_dates: list[date], last_bpp_on: date | None, every_days: int
) -> set[int]:
    """Which of the upcoming slots should carry a BPP.

    Walks the slots in order and places one whenever `every_days` have passed since the
    previous BPP — counting the ones being planned in this same batch, not just the last
    real send. Without that, filling seven days of queue at once would put a BPP in every
    slot that cleared the gap against a now-stale date.

    `last_bpp_on` of None means none has ever gone out, so the first slot takes one:
    turning the feature on should do something visible, not wait a month.
    """
    if every_days <= 0 or not slot_dates:
        return set()
    chosen: set[int] = set()
    previous = last_bpp_on
    for index, day in enumerate(slot_dates):
        if previous is None or (day - previous) >= timedelta(days=every_days):
            chosen.add(index)
            previous = day
    return chosen
