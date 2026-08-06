# Design — Auto-fill cadence: bands as a filter, days per time, and drifting intervals

**Status:** approved 2026-08-06, ready for implementation planning
**Depends on:** multi-time cadence (`3bcf5db`), the time_of_day tag taxonomy (`0003`), BPP
recycling (`0020`–`0022`), channel groups (`0013`) — all shipped.
**Schema:** **no migration.** `cadence_config` is an opaque TEXT column that both API routes
(`dashboard/app/api/channels/[id]/route.ts:50`, `.../channel-groups/[id]/route.ts:39`) pass
through untouched. Only its JSON shape changes.
**Feeds:** an account that posts several times a day can say *when* each kind of content goes
out, can post a different number of times on weekends than on weekdays, and can sweep every
hour of the day by posting on a drifting interval instead of at fixed times.

---

## 1. Purpose

Three gaps, all in auto-fill's cadence.

**Time-of-day tags are discarded the moment a second posting time exists.** `3bcf5db` made
that an explicit decision (`worker/autofill.py:703-712`): with one daily time a post's band
sets the send time, with two or more the band is ignored and the cadence decides. The reason
given was real — letting a band override one of several booked times would collapse two sends
onto the same minute or leave a booked slot empty — but the conclusion was wrong. A post
tagged `evening` should go out in the evening. That is the entire point of the tag.

**Days-of-week are one shared list.** `cadence_config.days` applies to every time, so "twice a
day on weekends, once on weekdays" cannot be expressed at all.

A third gap, added to this spec on the same day (§12): the cadence can only express *fixed
clock times*. "Post every 9 hours 45 minutes" — a drifting interval that eventually sweeps
every hour of the day — cannot be said at all, and it is the natural way to find out which
hours an account actually performs at.

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

A cadence has a **mode**. `times` is the mode described here and is the default when `mode` is
absent; `interval` is §12. `parse_cadence()` returns one `Cadence` object either way, or
`None` for "no valid cadence" — the single validity gate `_fill_unit` already keys off.

```json
{"mode": "times",
 "slots": [{"time": "12:30", "days": ["mon","tue","wed","thu","fri","sat","sun"]},
           {"time": "18:00", "days": ["sat","sun"]}]}
```

Two posts on Saturday and Sunday, one on every other day.

**Three legacy shapes are read, one is written.** `parse_cadence()` accepts all of:

| shape | origin | parses to |
|---|---|---|
| `{"mode":"times", "slots": [{"time","days"}, …]}` | new | itself |
| `{"days": […], "times": ["09:00","18:00"]}` | `3bcf5db` | one slot per time, all sharing `days` |
| `{"days": […], "time": "18:00"}` | original; **this install's live row** | a single slot |

The form always writes the new shape, so the stored config stops depending on how the owner
happens to have configured it. Nothing rewrites a stored config until the owner presses Save —
the live `{"days":[…7…],"time":"12:30"}` row keeps working, read as one 12:30 slot on all
seven days.

Normalization rules: slots sharing an identical time are merged by unioning their days (two
sends booked for the same minute would collide on one slot); the result is sorted by time; a
slot with no days, or an unparseable time, is dropped; no valid slots means no valid cadence.

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

**A slot nothing fits is skipped, not wasted.** Generation is lazy: `iter_slots` yields
slots one at a time and auto-fill keeps consuming until `need` posts are *placed*, the
candidate pool is exhausted, or a 366-day horizon runs out. So the strict rule costs the owner
unused slots, never queue depth — with an evening time set and 17 evening posts, the queue
still fills to `target_queue_depth`, just entirely at 18:00.

**Early exit.** The set of bands the cadence *covers* is computed once up front. The walk stops
as soon as no remaining candidate fits any covered band — checked before the first slot and
again after each placement — rather than grinding through 366 days of slots that provably
cannot be filled. The candidates left over at that point are exactly what §7 reports on.

Covered bands come from `Cadence.candidate_local_times()`, which yields the times a slot could
land on: in `times` mode its slot times, in `interval` mode every minute inside the allowed
window. `autofill` maps those through `derive_band` and takes the set. This keeps
`scheduling.py` free of any band concept while giving both modes one definition of "covered".

**Candidates are fetched uncapped.** Today the solo path fetches only `need` candidates
(`eligible_candidates(conn, ch, now, need)`). Under band filtering that is a bug: if the top
`need` ranked posts all sit in a band the cadence doesn't cover, auto-fill would place nothing
while hundreds of usable posts sat further down the ranking. Both paths now pass `limit=None`
and the *slots* do the limiting — which is already how the group and BPP paths work. The cost
is one full eligibility pass per unit per cycle instead of a truncated one; on this install
that is 111 posts.

---

## 6. Slot generation

`worker/scheduling.py` keeps only calendar math and learns nothing about bands — that boundary
is why `derive_band` lives in `time_of_day.py` and the caller joins the two.

```python
def iter_slots(cadence, tz_name, after, horizon_days=366):
    """Yield (utc_dt, (hour, minute)) in chronological order, strictly after `after`."""
```

One entry point; it dispatches on `cadence.mode` to the times walker or the interval walker
(§12). In `times` mode it walks local dates from `after`, and for each date emits every slot
whose weekdays include that weekday, in time order, skipping any whose UTC instant is not
strictly after `after` (so a time already past today does not book a send in the past).

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

The form opens on a **mode switch** — two radio options, mutually exclusive per channel or
group, because a cadence is one thing or the other:

```
Post   (•) At set times     ( ) Every…
```

### Mode: At set times

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

### Mode: Every…

```
Post every  [ 9 ] h  [45] m     between [08:00] and [21:00]
                                on  M T W T F S S
```

- Hours and minutes are two inputs, not a raw minute count — nobody thinks in `585`.
- Minutes floor at **15** in total; the field refuses less rather than accepting a value the
  worker would fill a queue with minutes apart.
- One day picker for the whole cadence (there is only one stream of sends to skip days from).
- Summary line becomes `Every 9h 45m, 08:00–21:00, daily · keep ≥3, fill to 8`.
- Below the inputs, the drift is spelled out rather than left to be inferred: *"Send times
  drift by 9h 45m each post, so over time you'll post at every hour between 08:00 and 21:00."*
  A round interval like `24h 0m` says instead: *"A whole number of days — this always lands at
  the same time. Use 'At set times' unless you meant to drift."*

### Both modes

The coverage warning (§7) sits below whichever panel is active and is computed identically.
Switching modes does **not** discard the other mode's settings until Save, so a mis-click is
recoverable.

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
| `worker/scheduling.py` | add `Cadence`, `parse_cadence`, `iter_slots` (both modes); delete `parse_weekly_cadence`, `parse_cadence_times`, `weekly_date_slots`, `daily_slots` |
| `worker/time_of_day.py` | add `derive_band`, `post_allows_band`; delete `resolve_slot_time` |
| `worker/autofill.py` | `_assign` (band-matching placement, pool/due aware); `_fill_unit` rewired + uncapped candidate fetch; `_apply_bpp` two-pass; `_merge_bpp_slots` deleted (folded into `_assign`); held-back logging |
| `dashboard/lib/config.ts` | expose the three `TOD_*` values |
| `dashboard/lib/queries.ts` | ready-post counts per `time_of_day` tag, for a set of channel ids |
| `dashboard/app/channels/page.tsx`, `dashboard/components/channel-groups.tsx` | pass band times + band counts down |
| `dashboard/components/autofill-config.tsx` | mode switch, per-time day pickers, interval + window inputs, derived band labels, coverage warning, new summary |

---

## 11. Testing

**Worker unit** — `derive_band` (exact hits, the 11:00 tie, 02:00 and 23:00, non-default
`TOD_*` values); `post_allows_band` (untagged, `anytime`, single band, two bands);
`parse_cadence` (all three legacy shapes, both modes, same-time merge, empty/garbage → `None`);
`iter_slots` in times mode (per-time days so a weekend-only time never appears midweek, strictly-after
on the first day, DST boundary in `America/New_York`, ordering across times).

**Interval mode unit** — the drift is preserved across a skipped step (the §12 worked example,
asserted step by step — this is the one behaviour a naive implementation gets wrong); a wrapping
window `22:00–02:00` yields both sides of midnight; an unchecked weekday is skipped without
resetting the phase; `every_minutes <= 0` → `None`; the step-count horizon terminates when the
window can never be satisfied; `candidate_local_times()` over a `08:00–12:00` window covers
morning and afternoon but not evening.

**Worker end-to-end** — an `evening`-tagged post is never placed on a 12:30 slot; with an
evening time added it *is*; a cadence covering no band a candidate holds fills nothing from
that candidate and logs the held-back line; the queue still reaches `target_queue_depth` when
only some slots are usable; a BPP due on a slot whose band it doesn't fit falls back to normal
selection and is not flagged recycled. `3bcf5db`'s lesson applies directly here — that commit's
real bug was found only by the end-to-end test, because a config shape can be valid to the slot
helper and invisible to auto-fill.

**Dashboard** — cadence parse/serialize round-trip for both modes and all three legacy
shapes, summary-line rendering, per-time day toggling, and the 15-minute interval floor.

**Browser** — against a **scratch DB copy on port 3940**, never the live one: this form writes
a cadence, and a bad save would silently change what the live install posts. Per
`verify-ui-against-scratch-db`, `sqlite3 .backup` a copy and point `DATABASE_PATH` at it via
`process.env`.

**Restart the worker afterwards** — a live heartbeat proves the daemon is running, not that it
is running this code.

---

## 12. Interval mode — post every N, drifting

Added 2026-08-06 at the owner's request, in the same pass because it touches the same three
things (`parse_cadence`, `iter_slots`, the form) and doing it later would mean rebuilding the
form twice.

```json
{"mode": "interval", "every_minutes": 585,
 "window": {"from": "08:00", "to": "21:00"},
 "days": ["mon","tue","wed","thu","fri","sat","sun"]}
```

`585` is 9h45m. The point of a non-round interval is that the send time **drifts**: 09:00,
18:45, 04:30, 14:15 … so over a few weeks the account has posted at every hour and the metrics
can say which ones worked. A round `1440` would just be "daily at a fixed time" spelled
differently.

**This composes with §2 rather than competing with it.** An interval slot still lands at a
definite clock time, so it still derives a band, so band filtering applies unchanged — an
`evening`-tagged post simply waits for a drifted slot that happens to land in the evening.
Nothing in §5 needs a special case.

### Drift, precisely

The cursor starts at `after` (the last future send, else `now`) and advances by
`every_minutes` each step. A step is **yielded** only when its local time is inside the window
*and* its local weekday is in `days`; otherwise it is skipped. Crucially the cursor advances
from where the skipped step **would have been**, never from the last yielded slot — otherwise
every skip would reset the phase and the drift would collapse back onto the window edge,
which is exactly the "nudge it into the window" behaviour the owner rejected.

Worked example, `every_minutes=585`, window `08:00–21:00`, starting Mon 09:00:

| step | local | outcome |
|---|---|---|
| 1 | Mon 18:45 | yielded |
| 2 | Tue 04:30 | **skipped** — before 08:00 |
| 3 | Tue 14:15 | yielded |
| 4 | Wed 00:00 | **skipped** — before 08:00 |
| 5 | Wed 09:45 | yielded |

The phase is preserved across the two skips: step 5 is 09:45, not 08:00.

### Window

`from`/`to` are local `HH:MM`, inclusive of both ends. When `from > to` the window **wraps
midnight** (`22:00–02:00` means 22:00–23:59 plus 00:00–02:00) — supported because an
unsupported wrap yields *nothing at all*, which would look like a broken cadence rather than a
rejected setting. A window is required in this mode; its absence means `00:00–23:59`, the
unrestricted 24-hour sweep.

### Validity and bounds

- `every_minutes` must be `> 0`, else the cadence is invalid (`parse_cadence` → `None`) and
  `_fill_unit` skips the unit, exactly as a malformed `times` cadence does.
- The walk is bounded by the same 366-day horizon, expressed as a step count:
  `ceil(366 * 1440 / every_minutes)`. A pathologically small interval therefore cannot spin
  forever; it just fills its `need` slots minutes apart, which is the owner's business.
- The form enforces a **15-minute floor** and offers hours + minutes as two inputs, so
  "every 9 hours 45 minutes" is typed as `9` and `45` rather than `585`.

### Covered bands

`candidate_local_times()` yields **every minute inside the window** in this mode, so §5's
covered-band set and §7's warning work identically. A window of `08:00–12:00` covers morning
and afternoon only, and the form will say that evening-tagged posts have nowhere to go — the
same warning, computed the same way, for a completely different cadence shape.

---

## 13. After it ships

Add an **18:00** time to the *Liparoto Meta* group's auto-fill. Until then the rule chosen here
keeps 18 posts out of rotation while the queue goes on looking healthy. The form warning and
the worker log will both say so, but this is the first thing to do.
