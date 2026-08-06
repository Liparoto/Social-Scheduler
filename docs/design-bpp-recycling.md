# Design — BPP (best-performing-post) recycling

Bring proven content back around on purpose, instead of only when the library runs dry.

Status: implemented 2026-08-05. Built autonomously overnight at the owner's request, so
every judgement call is written down here rather than asked — read this first.

---

## What already existed

`worker/autofill.py` already ranks by performance. Its docstring says so: *"Among the
recyclable pool, prefer top performers (reach + saves)."* So this was never a missing
feature — it was a feature that could not reach the surface. Two reasons.

### 1. The tier gate makes it unreachable

The ordering is:

```sql
ORDER BY
  CASE WHEN last_posted IS NULL THEN 0 ELSE 1 END ASC,   -- never-posted ALWAYS first
  perf DESC,
  ...
```

Every never-posted item outranks every proven winner. On this install that is **100
never-posted against 11 posted**, so at roughly a post a day the performance term does not
influence a single slot for about three months. "Auto-prioritize re-posting top performers"
is, today, unreachable.

That gate is right as a default — new content should generally go out before repeats. The
fix is not to remove it but to let a *share* of slots deliberately bypass it.

### 2. `reach + saves` is effectively just reach

Measured on the live account: `saves` peaks at **2** while mean reach is **303**. Saves
move the score by about a tenth of a percent, so the ranking is raw reach in all but name.

Reach is mostly distribution — how far the platform chose to push a post — not how good it
was. Real numbers from this account:

| reach | interactions | engagement |
|---|---|---|
| 754 | 20 | 2.7% |
| 661 | 43 | **6.5%** |
| 661 | 14 | 2.1% |

Ranking by reach puts the 2.7% post above the 6.5% one. Ranking by engagement rate does
not. For deciding *what deserves a second run*, rate is the better question.

---

## The design

### Recycle slots

A per-unit setting, `bpp_every_n_slots`:

- `0` — **off. This is the default, and nothing changes until it is turned on.**
- `N > 0` — every Nth auto-filled slot is a *recycle slot* that picks the best proven
  performer instead of the next unposted item.

Deterministic, not random: the slot's position in the unit's own publication sequence
decides it (`(existing_publications + index) % N == 0`). A random share would be
untestable, unexplainable after the fact, and would cluster.

A recycle slot that finds no eligible proven post **falls back to normal selection**. A
slot is never wasted, and an install with nothing worth recycling behaves exactly as it
does today.

### The score

`engagement rate = (likes + comments + saves + shares) / reach`, taken from the **latest**
snapshot of each publication of that post, then the best across publications.

Latest rather than max-across-snapshots: an early snapshot has both low reach and low
interactions, and picking the flattering one from a noisy series rewards noise.

**Minimum reach floor** (`BPP_MIN_REACH`, default 50). Without it a post that reached 3
people and got 1 like scores 33% and beats everything on the account forever. Below the
floor a post has no score at all rather than a small one — too little evidence is not the
same as poor performance.

Ties break on reach, so between two equally-engaging posts the further-travelled one wins.

### What a recycle slot will not do

It applies **every rule normal selection applies** — reuse age, cooldown, blackout and
green periods, platform capability, caption limits, already-queued. It only changes *which*
eligible candidate is chosen, never *whether* one is eligible. A recycle slot cannot post
something that normal autofill would have refused.

---

## Why off by default

This changes what gets published to live accounts, and it was built while the owner slept.
An opt-in default means the change is inert until read and enabled — the only responsible
setting for an autonomous change to a publishing path. Turning it on is one field in the
channel's auto-fill settings.

Suggested starting value: **4** (one slot in four is a repeat).

---

## What this does NOT do, and why

**It cannot use the 146 posts already on the account.** Only 11 library posts have any
metrics, because metrics attach to publications *this tool made*. The other 146 real
Instagram posts live in `remote_media` with no link to a library post.

Bridging them was investigated and rejected: matching library posts to real posts by
caption succeeds for **6 of 111**, because the Apple Notes import left placeholder captions
(mostly a bare 🔺). Image matching is not possible either — the stored thumbnails are
downscaled re-encodes, so no content hash agrees with the local originals.

A manual "link this library post to this Instagram post" UI would work and would unlock a
lot of history. It is real scope, needs the owner's judgement per post, and is recorded as
follow-up rather than guessed at overnight.

**Practical consequence:** BPP is thin *today* (11 posts to draw on) and gets better every
time something publishes. It is worth turning on now precisely because the pool grows on
its own.
