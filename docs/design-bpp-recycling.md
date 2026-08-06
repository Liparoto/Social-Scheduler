# Design — BPP (best-performing-post) recycling

Bring your keepers back around on purpose, on a cadence you control.

Status: implemented 2026-08-06. Read the last section first if you only read one — the
feature works but has almost nothing to act on until the back catalogue is linked.

---

## The workflow this reproduces

The owner already does this by hand:

> Go through the account every week or month, look at the stats. A post earns BPP status
> because its likes were way above average, or it was saved a lot, or several metrics were
> up together. Mark it, save it, repost it periodically. With 12 saved, post one a month;
> with 52, one a week — rotating through them. Sometimes a post is obviously jumping off
> the page and it gets marked immediately. When the account is underperforming, bump the
> frequency up.

Four things fall out of that, and the design is just those four:

1. **A person marks.** Not a score.
2. **The pool rotates** — every keeper is used before any repeats.
3. **The cadence is a dial in days**, adjustable, turned up during a slump.
4. **Pool size and cadence together** decide how often a given post reappears, and that
   number has to be visible.

## Why not a score — the version that was built first, and thrown away

The first attempt ranked posts automatically by engagement rate. It produced this on the
live account:

| post | reach | interactions | rate | |
|---|---|---|---|---|
| A | 59 | 25 | **42%** | ranked 1st |
| B | 1,462 | 151 | 10% | ranked below it |

A small denominator inflates a rate; raw reach has the mirror bias, over-rewarding
whatever the platform chose to push. Neither is "best". A minimum-reach floor moves the
arbitrary line around without removing it.

The judgement is about the *content* — whether it is worth showing again — and the person
who made it is better placed than any formula. So the numbers surface candidates and stop
there.

## Marking

`posts.is_bpp`, set by hand from the Insights leaderboard (while reviewing stats) or the
Library. Nothing in the app ever sets it. `bpp_marked_at` records when, so a periodic
re-review can start with the oldest marks.

Markable from three places, because a post is recognised as a keeper wherever you happen
to be looking at it: the **Insights leaderboard** (while reviewing stats), the **post
editor** (often the moment you notice), and unmarkable from the **BPP pool**. The Library
shows a ★ BPP badge on marked posts — the mark is a property of the post, so it appears
everywhere the post does, not only where it was set.

In the editor the mark saves on click rather than with the rest of the form: it is a
one-word decision, and making it wait behind an unrelated Save — or lose it on a discard —
would be worse than one extra request.

**Backups carry it.** `is_bpp` and `bpp_marked_at` are in `export.json` and get their own
column in the Posts tab (written as YES/blank, since that column is scanned by eye). The
pool is curation work, built up post by post, and is not recoverable from anything else in
the file — a restore without it would silently empty the pool and stop the rotation.

Only library posts can be marked — a repost needs the caption and image files. The
leaderboard shows every post on the account, so ones without a library entry say "not in
library" rather than offering a button that would fail.

## Surfacing candidates

A post is flagged when it is in the **top 5% of any one metric**, or the **top 10% of two
or more** — the three reasons given for marking something, encoded directly ("way above
average likes" is one metric; "multiple metrics well above average" is the other).

The badge names the metrics: **"top 5% · reach, views, likes"**. Never a score — "saved far
more than usual" is something you can act on.

**A post is judged against its contemporaries, not against all time.** At 1,000 followers
a strong post might take 40 likes; at 100,000 an ordinary one takes 400. Ranked in one
pool, nothing from the account's earlier life is ever flagged again — yet that post
performed at a high level *for the audience available to it*, which is exactly what makes
it worth reposting. A keeper stays a keeper. Each post is therefore ranked against the ~40
posts nearest it in time.

To qualify, a post must clear the threshold **and beat its peer group's median**. Both are
needed: with 41 peers a "top 5%" cutoff is two posts, and the second is usually
unremarkable, so a lone outlier would otherwise be missed — while in a flat stretch where
everyone scored the same, every post would tie the cutoff and be badged "outstanding".

**A metric must be able to separate posts before it can crown one.** Recomputed per
account, every time: this account's saves have a median of 0 and a top-10% cutoff of 1, so
"top 10% for saves" would mean "got one save" and would badge a third of the library —
saves are skipped *here*. On an account whose audience saves things, that cutoff comes out
high and saves rank like anything else. Saves are collected for every account regardless;
what varies is whether they can discriminate today.

A **★ Standouts** filter reduces a 146-row review to a short list.

## Reviewing the pool

`/insights/pool` shows the marked posts **as a set**, in the order auto-fill will actually
use them — longest-since-posted first, so "up next" is a fact rather than a guess.

Marking happens one post at a time while reviewing stats; this is the other half of that
workflow, where "do I have enough for the cadence I set" and "what is about to run again"
are answerable at a glance instead of inferred from the queue.

Per account it shows what that account can actually send, which is not the same as the
pool size — a post targeted only at Instagram is not in the Threads rotation, so a cadence
set against the raw count would quietly under-deliver.

## Scheduling the pool

`bpp_every_days` per unit — 0 is off, and off is the default.

**Days, not slots.** "One a month" is how it is thought about, and a slot-based share
silently changes meaning the moment the posting cadence changes. This dial gets turned up
during a slump, so it has to mean the same thing every time it is read.

Slots are walked in date order and one is taken whenever the cadence has elapsed since the
previous BPP — counting the ones being planned in the same batch, not just the last real
send, or filling a week of queue at once would stack several.

**Rotation** is oldest-sent first, so the whole pool cycles before anything repeats.

**A BPP may pass the reuse window.** Four posts on a monthly cadence return every four
months, which a 90-day reuse window would silently veto — the feature would look broken
rather than decline. The owner chose both the marks and the frequency; that is the
decision. One-time content is still never reposted: "never repost this" outranks "repost
my best".

Everything else still applies — periods, platform capability, caption limits,
already-queued — and no post can be queued twice in one batch.

## Saying what it will do

The setting shows the consequence, not just the number:

> **2 posts marked · each one comes back roughly every 28 days**
> ⚠️ Small pool — the same posts will come round often. Mark more, or increase the gap.

Two posts at every 14 days is not "every 14 days"; it is each post reappearing monthly.

`publications.is_recycled` records that a send was a BPP, badged in the queue — "why is
this old post going out again?" is exactly the question this prompts.

---

## What blocks it being useful today

Marking requires a library post. Metrics attach to publications *this tool made*, and the
146 other real Instagram posts sit in `remote_media` linked to nothing.

Measured after building it: **21 posts qualify as standouts, and 0 can be marked.** Every
one predates this install. The mechanism is correct and has nearly nothing to act on.

Automatic bridging was tried and rejected:

* **Captions** match 6 of 111 — the Apple Notes import left placeholders (mostly a bare 🔺).
* **Images** cannot be hashed against each other; stored thumbnails are downscaled
  re-encodes, so no hash agrees with the local originals.
* **Dates** do not help — `posts.created_at` is when the import ran, not when it posted.

So the pool fills from here forward: anything published through this tool becomes markable
as soon as it has numbers.

**The unblocker is a manual link** — "this library post is that Instagram post" — which
would make the whole back catalogue markable at once. Real scope, and a judgement per post,
so it is the next piece of work rather than something to guess at.

---

## The tolerance is the owner's

`channels.bpp_strong_pct` / `bpp_broad_pct` (defaults 5 and 10, per channel).

The original numbers came from one account's data and there is no reason they suit
another. Someone with a large back catalogue may want the strictest 2%; someone building
a rotation from a small library may want half of it. The right answer also moves as an
account grows — what was exceptional at 1,000 followers is ordinary at 20,000.

Per CHANNEL, not per install, because a personal account and a business account have
different baselines and different purposes, and this tool is explicitly built to run
several.

The control shows the **live count** — "suggests 16 of 146 posts" — because "top 5%" is
abstract and a count is not. On this account: 2% suggests 7, 5% suggests 16, 25% suggests
25. The setting is meant to be tuned by watching the result.

The badge quotes the owner's own threshold back ("top 25% · likes"), so a post flagged
under a loose setting never reads as though it cleared a strict one.
