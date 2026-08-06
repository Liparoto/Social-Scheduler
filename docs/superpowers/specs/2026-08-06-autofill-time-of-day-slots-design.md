# Design — Auto-fill: time-of-day bands as a filter, and days per posting time

**Status:** approved 2026-08-06, ready for implementation planning
**Depends on:** multi-time cadence (`3bcf5db`), the time_of_day tag taxonomy (`0003`), BPP
recycling (`0020`–`0022`), channel groups (`0013`) — all shipped.
**Schema:** **no migration.** `cadence_config` is an opaque TEXT column that both API routes
(`dashboard/app/api/channels/[id]/route.ts:50`, `.../channel-groups/[id]/route.ts:39`) pass
through untouched. Only its JSON shape changes.
**Feeds:** an account that posts several times a day can say *when* each kind of content goes
out, and can post a different number of times on weekends than on weekdays.

---

## 1. Purpose

Two gaps, both in auto-fill's cadence.

**Time-of-day tags are discarded the moment a second posting time exists.** `3bcf5db` made
that an explicit decision (`worker/autofill.py:703-712`): with one daily time a post's band
sets the send time, with two or more the band is ignored and the cadence decides. The reason
given was real — letting a band override one of several booked times would collapse two sends
onto the same minute or leave a booked slot empty — but the conclusion was wrong. A post
tagged `evening` should go out in the evening. That is the entire point of the tag.

**Days-of-week are one shared list.** `cadence_config.days` applies to every time, so "twice a
day on weekends, once on weekdays" cannot be expressed at all.

---

## 2. The rule

Today there are two rules fighting each other:

| cadence | band's job |
|---|---|
| one time | **sets** the slot's time (a band time replaces the cadence time) |
| two or more times | **ignored** |

This replaces both with one rule:

> **A cadence time is a slot. A slot has a band, derived from its clock time. A post is placed
> only in a slot its tags allow.**

The band stops being a *time source* and becomes a *filter*. This is a simplification, not an
addition: `resolve_slot_time`, `weekly_date_slots`, `daily_slots`, `parse_cadence_times` and
`parse_weekly_cadence` all become unreachable and are deleted, replaced by one slot generator
and one predicate.

**The consequence, stated plainly.** When the cadence has no slot in a post's band, that post is
**held back** — not auto-filled at all, rather than sent at the wrong time. This is the owner's
explicit choice (2026-08-06) over the two alternatives (fall back to the band's own clock time;
treat the post as untagged). §7 is the guard that makes it safe to live with.

---

## 3. Cadence shape

```json
{"slots": [{"time": "12:30", "days": ["mon","tue","wed","thu","fri","sat","sun"]},
           {"time": "18:00", "days": ["sat","sun"]}]}
```

Two posts on Saturday and Sunday, one on every other day.

**Three shapes are read, one is written.** `normalize_cadence()` accepts all of:

| shape | origin | normalizes to |
|---|---|---|
| `{"slots": [{"time","days"}, …]}` | new | itself |
| `{"days": […], "times": ["09:00","18:00"]}` | `3bcf5db` | one slot per time, all sharing `days` |
| `{"days": […], "time": "18:00"}` | original; **this install's live row** | a single slot |

The form always writes `slots`, so the stored shape stops depending on how the owner happens
to have configured it. Nothing rewrites a stored config until the owner presses Save — the
live `{"days":[…7…],"time":"12:30"}` row keeps working, read as one 12:30 slot on all seven
days.

Normalization rules: slots sharing an identical time are merged by unioning their days (two
sends booked for the same minute would collide on one slot); the result is sorted by time; a
slot with no days, or an unparseable time, is dropped; an empty result means "no valid
cadence" and `_fill_unit` skips the unit exactly as it does today.

---

## 4. Band derivation

`derive_band(hour, minute, band_times_map) -> "morning" | "afternoon" | "evening"`

Nearest configured band time by absolute clock-minute distance, **no midnight wraparound**,
ties broken toward the earlier band (`BAND_ORDER`). With the defaults
(`TOD_MORNING=09:00`, `TOD_AFTERNOON=13:00`, `TOD_EVENING=18:00`):

| time | band | why |
|---|---|---|
| `09:00` | morning | exact |
| `12:30` | afternoon | 30 min from 13:00, 210 from 09:00 — **this install's live cadence** |
| `18:00` | evening | exact |
| `23:00` | evening | 300 min from 18:00, 840 from 09:00 |
| `02:00` | morning | 420 min from 09:00, 960 from 18:00 |
| `11:00` | morning | exact tie (120/120) → earlier band wins |

Every slot resolves to one of the three specific bands. There is deliberately no "anytime"
slot: `anytime` means *the post* doesn't care, which is a property of content, not of a
booked time. A slot always happens at a definite hour.

Derivation lives in `worker/time_of_day.py` and is the authority. The dashboard mirrors it
**only to print the label next to each time** — a display convenience, never a decision.

---

## 5. Matching

```
post_allows_band(post_bands, slot_band):
    specific = post_bands ∩ {morning, afternoon, evening}
    return (not specific) or (slot_band in specific)
```

- **untagged** → fits any slot (unchanged from today)
- **`anytime`** → contributes no specific band, so fits any slot (unchanged)
- **`evening`** → fits evening slots only
- **`morning` + `evening`** → fits either. Today `resolve_slot_time` silently takes the
  earliest of several bands; "allowed in both" is what two tags plainly mean, so multi-tagging
  gets more expressive rather than less.

Slots are walked in chronological order. Each slot takes the **highest-ranked unused candidate
that fits its band**; ranking itself (never-posted → performance → staleness → age, per
`select_candidates` / `group_rank`) is untouched.

**A slot nothing fits is skipped, not wasted.** Generation is lazy: `iter_cadence_slots` yields
slots one at a time and auto-fill keeps consuming until `need` posts are *placed*, the
candidate pool is exhausted, or a 366-day horizon runs out. So the strict rule costs the owner
unused slots, never queue depth — with an evening time set and 17 evening posts, the queue
still fills to `target_queue_depth`, just entirely at 18:00.

**Early exit.** The set of bands the cadence *covers* is computed once up front. The walk stops
as soon as no remaining candidate fits any covered band — checked before the first slot and
again after each placement — rather than grinding through 366 days of slots that provably
cannot be filled. The candidates left over at that point are exactly what §7 reports on.

---

## 6. Slot generation

`worker/scheduling.py` keeps only calendar math and learns nothing about bands — that boundary
is why `derive_band` lives in `time_of_day.py` and the caller joins the two.

```python
def iter_cadence_slots(slot_defs, tz_name, after, horizon_days=366):
    """Yield (utc_dt, (hour, minute)) in chronological order, strictly after `after`."""
```

`slot_defs` is `[(hour, minute, weekdays:set[int]), …]` from `normalize_cadence`. It walks
local dates from `after`, and for each date emits every slot whose `weekdays` include that
weekday, in time order, skipping any whose UTC instant is not strictly after `after` (so a
time already past today does not book a send in the past).

The local `(hour, minute)` is yielded alongside the UTC instant because the caller needs it to
look up the band, and recovering it from the UTC datetime across a DST boundary is a needless
round trip.

`after` is unchanged: `latest_future_scheduled` if the queue has anything ahead, else `now`.

**Deleted as unreachable:** `weekly_date_slots`, `daily_slots`, `parse_cadence_times`,
`parse_weekly_cadence` (`worker/scheduling.py`) and `resolve_slot_time` (`worker/time_of_day.py`),
with their tests. `weekly_slots` is *already* dead before this change (nothing outside its own
test calls it) — out of scope, left alone rather than bundled into an unrelated cleanup.

---

## 7. The stall guard

The strict rule is only safe if the owner is told when it bites. Measured on this install
today, of **111 ready posts**: 89 carry no time_of_day tag, 3 are `anytime`, 17 `evening`,
1 `morning`, 1 `afternoon`.

The sole 12:30 slot derives to *afternoon*, so the moment this ships **18 posts — the 17
`evening` and the 1 `morning` — become unreachable**. The queue does **not** stall: 93 of 111
posts still fit any slot, so auto-fill keeps filling and looks perfectly healthy. That is
precisely what makes it dangerous. The most deliberately curated content in the library — the
posts the owner took the trouble to tag — would quietly stop being chosen, with every visible
signal saying everything is fine. The remedy is one edit (add an 18:00 time); the guard is that
nothing about this can happen unannounced.

**Worker log**, once per cycle per unit, whenever candidates are stranded:

```
[autofill Liparoto Meta] 17 candidate(s) held back — tagged evening, no evening time
in this cadence. Add one in the dashboard, or retag the posts.
```

A candidate is *stranded* when it carries at least one specific band tag and none of its tags
is in the cadence's covered bands. Grouped by band in the message so the owner knows which
time to add.

**Form warning**, in the existing queue-warning colour, directly under the times:

> ⚠ **17 ready posts are tagged evening** — no evening time set, so they will not be
> auto-filled.

Counts come from a new prop on `AutofillConfig`, following the `bppPoolSize` precedent
(computed server-side in `dashboard/lib/queries.ts`, passed down from
`dashboard/app/channels/page.tsx` and `dashboard/components/channel-groups.tsx`). The count is
deliberately cheap and approximate: **ready posts with a `feed` target on this channel — or on
any member of this group — grouped by `time_of_day` tag.** It does not re-run cooldown, period
or caption-length eligibility. Making the warning exact would mean running the full selection
pass on every page render to sharpen a number whose only job is to say "this band has content
and nowhere to put it".

---

## 8. Form

The shared "Post on" row is removed. Each posting time becomes a row carrying its own days:

```
Posting times
  [12:30]  afternoon   M T W T F S S     ×
  [18:00]  evening     M T W T F S S     ×
  + Add a time
```

- The band label is derived live from the typed time and is **read-only** — it tells the owner
  which tagged content the slot will accept.
- **Adding a time copies the days of the row above it**, so the ordinary "same days, one more
  time" case stays a single click and the removal of the shared row costs nothing.
- The last remaining time cannot be deleted (matching today's behaviour for the last time).
- Summary line becomes `12:30 daily, 18:00 Sat/Sun · keep ≥3, fill to 8`, with `daily` used in
  place of listing all seven days.
- The line stating "Time-of-day tags are ignored while more than one time is set"
  (`autofill-config.tsx:171-177`) is removed — it documents the behaviour being deleted.

The dashboard reads `TOD_MORNING` / `TOD_AFTERNOON` / `TOD_EVENING` through the existing
file-then-`process.env` helper at `dashboard/lib/config.ts:34` and passes them as a prop. The
form never derives a band the worker will not agree with, because both read the same `.env`.

---

## 9. BPP interaction

`_apply_bpp` currently projects its own slot dates (`worker/autofill.py:527`) via
`weekly_date_slots`, which is being deleted. It instead receives the already-generated slots.

Ordering — the two-pass structure exists because a BPP's due-ness depends on slot *dates*,
while a slot's occupant depends on band matching:

1. **Pass 1** assigns normally (§5), producing a fixed list of `(slot, candidate)` pairs. This
   establishes the slot dates.
2. `bpp_slot_indices` marks which of those positions fall due, from the dates of pass 1.
3. **Pass 2** re-fills the *same fixed slots*: a due slot takes the stalest unused pool post
   **that fits that slot's band**; every other slot takes the highest-ranked unused normal
   candidate that fits. A due slot with no band-fitting pool post falls through to normal
   selection and is **not** flagged as recycled — exactly the existing behaviour when the pool
   is empty (`_merge_bpp_slots`).

Pass 2 rarely strands a slot pass 1 filled — a due slot consuming a pool post *frees* a normal
candidate rather than consuming one — but it is not impossible: a pool post promoted to an
early slot may have been pass 1's only band-fitting pick for a later one. A slot left empty is
**dropped from the output**, never inserted blank, so the effect is one fewer publication that
cycle and never a send at the wrong time.

---

## 10. Files

| file | change |
|---|---|
| `worker/scheduling.py` | add `normalize_cadence`, `iter_cadence_slots`; delete `parse_weekly_cadence`, `parse_cadence_times`, `weekly_date_slots`, `daily_slots` |
| `worker/time_of_day.py` | add `derive_band`, `post_allows_band`; delete `resolve_slot_time` |
| `worker/autofill.py` | `_fill_unit` slot/candidate matching loop; `_apply_bpp` + `_merge_bpp_slots` take slots and a band-fit predicate; held-back logging |
| `dashboard/lib/config.ts` | expose the three `TOD_*` values |
| `dashboard/lib/queries.ts` | ready-post counts per `time_of_day` tag, per channel and per group |
| `dashboard/app/channels/page.tsx`, `dashboard/components/channel-groups.tsx` | pass band times + band counts down |
| `dashboard/components/autofill-config.tsx` | per-time day pickers, derived band labels, coverage warning, new summary |

---

## 11. Testing

**Worker unit** — `derive_band` (exact hits, the 11:00 tie, 02:00 and 23:00, non-default
`TOD_*` values); `post_allows_band` (untagged, `anytime`, single band, two bands);
`normalize_cadence` (all three shapes, same-time merge, empty/garbage → `[]`);
`iter_cadence_slots` (per-time days so a weekend-only time never appears midweek, strictly-after
on the first day, DST boundary in `America/New_York`, ordering across times).

**Worker end-to-end** — an `evening`-tagged post is never placed on a 12:30 slot; with an
evening time added it *is*; a cadence covering no band a candidate holds fills nothing from
that candidate and logs the held-back line; the queue still reaches `target_queue_depth` when
only some slots are usable; a BPP due on a slot whose band it doesn't fit falls back to normal
selection and is not flagged recycled. `3bcf5db`'s lesson applies directly here — that commit's
real bug was found only by the end-to-end test, because a config shape can be valid to the slot
helper and invisible to auto-fill.

**Dashboard** — `normalize`/summary rendering, and per-time day toggling.

**Browser** — against a **scratch DB copy on port 3940**, never the live one: this form writes
a cadence, and a bad save would silently change what the live install posts. Per
`verify-ui-against-scratch-db`, `sqlite3 .backup` a copy and point `DATABASE_PATH` at it via
`process.env`.

**Restart the worker afterwards** — a live heartbeat proves the daemon is running, not that it
is running this code.

---

## 12. After it ships

Add an **18:00** time to the *Liparoto Meta* group's auto-fill. Until then the rule chosen here
keeps 18 posts out of rotation while the queue goes on looking healthy. The form warning and
the worker log will both say so, but this is the first thing to do.
