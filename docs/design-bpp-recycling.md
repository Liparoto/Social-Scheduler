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

Only library posts can be marked — a repost needs the caption and image files. The
leaderboard shows every post on the account, so ones without a library entry say "not in
library" rather than offering a button that would fail.

## Surfacing candidates

A post is flagged when it is in the **top 5% of any one metric**, or the **top 10% of two
or more** — the three reasons given for marking something, encoded directly ("way above
average likes" is one metric; "multiple metrics well above average" is the other).

The badge names the metrics: **"top 5% · reach, views, likes"**. Never a score — "saved far
more than usual" is something you can act on.

**A metric must be able to separate posts before it can crown one.** Recomputed per
account, every time: this account's saves have a median of 0 and a top-10% cutoff of 1, so
"top 10% for saves" would mean "got one save" and would badge a third of the library —
saves are skipped *here*. On an account whose audience saves things, that cutoff comes out
high and saves rank like anything else. Saves are collected for every account regardless;
what varies is whether they can discriminate today.

A **★ Standouts** filter reduces a 146-row review to a short list.

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
