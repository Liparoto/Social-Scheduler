# Auto-fill Cadence: Bands as a Filter, Days per Time, Drifting Intervals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a post's `time_of_day` tag decide *which* cadence slot it may take (instead of being ignored whenever more than one posting time exists), give every posting time its own days-of-week, and add a drifting "every N hours/minutes" cadence mode.

**Architecture:** A cadence time becomes a *slot*; a slot's band is derived from its clock time; a post's band tags act as a *filter* on which slots it may occupy. This replaces two competing rules with one and deletes five functions. `worker/scheduling.py` owns calendar math and knows nothing about bands; `worker/time_of_day.py` owns band derivation and knows nothing about calendars; `worker/autofill.py` joins them. Slot generation is a lazy generator because auto-fill cannot know how many slots it needs until it knows how many it can fill.

**Tech Stack:** Python 3 (worker, stdlib only — `zoneinfo`, `dataclasses`, `math`), pytest. Next.js 16 App Router + TypeScript + Tailwind (dashboard), `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-06-autofill-time-of-day-slots-design.md`

## Global Constraints

- **No migration.** `cadence_config` is an opaque TEXT column; both API routes pass it through untouched. Only the JSON shape changes. Do not add a file to `/migrations`.
- **No new dependencies** in either `requirements.txt` or `dashboard/package.json`.
- **Python runs in the venv.** Activate with `source .venv/bin/activate` before any `pytest` or `pip` command.
- **Never point the dashboard at the live DB during verification.** Use a `sqlite3 .backup` copy on port 3940.
- **Lint stays at 0 errors** (`cd dashboard && npm run lint`).
- **Three legacy cadence shapes must keep parsing** — `{"days","time"}` (the live install's row), `{"days","times"}`, and the new `{"mode","slots"}`. A stored config is never rewritten until the owner presses Save.
- **Band times** come from `TOD_MORNING` / `TOD_AFTERNOON` / `TOD_EVENING` (defaults `09:00` / `13:00` / `18:00`). Worker and dashboard read the same `.env`.
- **Deleted symbols** (must not survive anywhere, including tests): `resolve_slot_time`, `weekly_date_slots`, `daily_slots`, `parse_cadence_times`, `parse_weekly_cadence`, `_merge_bpp_slots`.
- `weekly_slots` in `worker/scheduling.py` is *already* dead before this work. **Leave it alone** — removing it is unrelated cleanup.

---

## File Structure

| file | responsibility after this plan |
|---|---|
| `worker/time_of_day.py` | Bands only: the three band clock times, deriving a band from a time, and whether a post's tags permit a band. No calendar, no DB except `post_bands`. |
| `worker/scheduling.py` | Calendar only: parsing `cadence_config` into a `Cadence`, and generating slots from it. Never mentions a band. |
| `worker/autofill.py` | Joins the two: derives each slot's band, matches candidates, places BPPs, writes publications. |
| `dashboard/lib/config.ts` | Adds the three band times to the exported config. |
| `dashboard/lib/queries.ts` | Adds `getBandCounts` — ready posts per band for a set of channels. |
| `dashboard/lib/cadence.ts` | **New.** Pure parse/serialize/summarize for the cadence JSON, shared by the form and its tests. Keeps `autofill-config.tsx` about rendering. |
| `dashboard/components/autofill-config.tsx` | Rendering only: mode switch, the two panels, the coverage warning. |

---

## Task 1: Band derivation and the band filter

**Files:**
- Modify: `worker/time_of_day.py` (add two functions)
- Test: `worker/tests/test_time_of_day.py`

**Do not delete `resolve_slot_time` in this task.** `worker/autofill.py:41` imports it and `_fill_unit` still calls it until Task 7. Removing it here would break the import of `worker.autofill` — and therefore every test in `test_autofill.py` — for five tasks. Task 7 deletes it together with everything else it supersedes, in one step, so every intermediate state stays green.

**Interfaces:**
- Consumes: existing `BAND_ORDER`, `band_times(config)` from this module.
- Produces: `derive_band(hour: int, minute: int, band_times_map: dict[str, tuple[int,int]]) -> str` returning one of `"morning" | "afternoon" | "evening"`; `post_allows_band(bands: set[str], slot_band: str) -> bool`.

- [ ] **Step 1: Write the failing tests**

Add to `worker/tests/test_time_of_day.py`, and update its import block to pull in `derive_band` and `post_allows_band` while **removing** `resolve_slot_time`:

```python
def test_derive_band_exact_hits_and_nearest():
    bt = band_times(_Cfg())
    assert derive_band(9, 0, bt) == "morning"
    assert derive_band(13, 0, bt) == "afternoon"
    assert derive_band(18, 0, bt) == "evening"
    # 12:30 is 30 min from 13:00 and 210 from 09:00 — this install's live cadence time.
    assert derive_band(12, 30, bt) == "afternoon"


def test_derive_band_does_not_wrap_around_midnight():
    bt = band_times(_Cfg())
    assert derive_band(23, 0, bt) == "evening"   # 300 min from 18:00, 840 from 09:00
    assert derive_band(2, 0, bt) == "morning"    # 420 min from 09:00, 960 from 18:00


def test_derive_band_breaks_a_tie_toward_the_earlier_band():
    bt = band_times(_Cfg())
    assert derive_band(11, 0, bt) == "morning"   # exactly 120 min from 09:00 and from 13:00


def test_derive_band_follows_a_non_default_config():
    class Late:
        tod_morning = "06:00"
        tod_afternoon = "14:00"
        tod_evening = "22:00"

    bt = band_times(Late())
    assert derive_band(9, 0, bt) == "morning"
    assert derive_band(19, 0, bt) == "evening"   # 180 from 22:00, 300 from 14:00


def test_post_allows_band_untagged_and_anytime_fit_anything():
    assert post_allows_band(set(), "morning") is True
    assert post_allows_band(set(), "evening") is True
    assert post_allows_band({"anytime"}, "evening") is True


def test_post_allows_band_a_specific_band_fits_only_itself():
    assert post_allows_band({"evening"}, "evening") is True
    assert post_allows_band({"evening"}, "morning") is False
    # anytime alongside a specific band does NOT widen it: the specific tag is a request.
    assert post_allows_band({"anytime", "evening"}, "morning") is False


def test_post_allows_band_two_specific_bands_mean_either():
    assert post_allows_band({"morning", "evening"}, "morning") is True
    assert post_allows_band({"morning", "evening"}, "evening") is True
    assert post_allows_band({"morning", "evening"}, "afternoon") is False
```

- [ ] **Step 2: Leave the existing `resolve_slot_time` tests alone**

`test_resolve_earliest_specific_band_wins` and `test_resolve_anytime_and_untagged_use_cadence_time` stay green for now and are deleted in Task 7 alongside the function itself. Do not touch them here.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
source .venv/bin/activate && pytest worker/tests/test_time_of_day.py -v
```

Expected: `ImportError: cannot import name 'derive_band' from 'worker.time_of_day'`.

- [ ] **Step 4: Implement**

In `worker/time_of_day.py`, leave `resolve_slot_time` exactly where it is (Task 7 removes it) and add:

```python
def derive_band(hour: int, minute: int, band_times_map: dict[str, tuple[int, int]]) -> str:
    """Which band a clock time belongs to: the nearest configured band time.

    Absolute clock-minute distance, no midnight wraparound, ties to the earlier band. This is
    what gives a cadence TIME a band, which is in turn what lets a post's band tag act as a
    FILTER on slots rather than as a source of times. There is deliberately no "anytime"
    result: `anytime` describes content that does not care, and a slot always happens at a
    definite hour.
    """
    target = hour * 60 + minute
    best_name = BAND_ORDER[0]
    best_distance: int | None = None
    for name in BAND_ORDER:  # earliest-first, so `<` leaves ties with the earlier band
        band_hour, band_minute = band_times_map[name]
        distance = abs(target - (band_hour * 60 + band_minute))
        if best_distance is None or distance < best_distance:
            best_distance, best_name = distance, name
    return best_name


def post_allows_band(bands: set[str], slot_band: str) -> bool:
    """May a post carrying these time_of_day tags be placed in a slot of `slot_band`?

    No SPECIFIC band (untagged, or only `anytime`) fits anywhere — unchanged from before.
    Otherwise the slot's band must be one the post asked for; two specific tags mean either is
    acceptable, which is what two tags plainly say. `anytime` alongside a specific band does
    not widen it: the specific tag is a request, and honouring it is the point.
    """
    specific = bands & set(BAND_ORDER)
    return not specific or slot_band in specific
```

Leave the module docstring alone for now — it still describes `resolve_slot_time` accurately, and Task 7 rewrites it when that function goes.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
source .venv/bin/activate && pytest worker/tests/test_time_of_day.py -v
```

Expected: PASS. Then confirm nothing else broke — this task is purely additive, so the whole suite must still be green:

```bash
source .venv/bin/activate && pytest worker/tests/ -q
```

- [ ] **Step 6: Commit**

```bash
git add worker/time_of_day.py worker/tests/test_time_of_day.py
git commit -m "feat(autofill): a band is a filter on slots, not a source of times"
```

---

## Task 2: `Cadence` and `parse_cadence` — times mode

**Files:**
- Modify: `worker/scheduling.py`
- Test: `worker/tests/test_scheduling.py`

**Interfaces:**
- Consumes: existing `WEEKDAYS`, `UTC` from this module.
- Produces:
  - `Cadence` — frozen dataclass with fields `mode: str`, `slots: tuple[tuple[int,int,frozenset[int]], ...]`, `every_minutes: int`, `window: tuple[tuple[int,int], tuple[int,int]]`, `days: frozenset[int]`, and method `candidate_local_times() -> Iterator[tuple[int,int]]`.
  - `parse_cadence(cadence_config: str | None) -> Cadence | None`.
  - Private helpers `_parse_hhmm(value) -> tuple[int,int] | None`, `_weekday_ints(days) -> set[int]`, `_window_minutes(window)`, `_in_window(hour, minute, window) -> bool` — Tasks 3 and 5 use them.

- [ ] **Step 1: Write the failing tests**

Add to `worker/tests/test_scheduling.py`:

```python
from worker.scheduling import Cadence, parse_cadence  # noqa: E402


def test_parse_cadence_reads_the_original_single_time_shape():
    # The shape this install's live row is stored in.
    c = parse_cadence('{"days":["mon","wed"],"time":"18:00"}')
    assert c.mode == "times"
    assert c.slots == ((18, 0, frozenset({0, 2})),)


def test_parse_cadence_reads_the_multi_time_shape():
    c = parse_cadence('{"days":["sat"],"times":["18:00","09:00"]}')
    assert c.slots == ((9, 0, frozenset({5})), (18, 0, frozenset({5})))  # sorted by time


def test_parse_cadence_reads_per_time_days():
    c = parse_cadence(
        '{"mode":"times","slots":['
        '{"time":"18:00","days":["sat","sun"]},'
        '{"time":"12:30","days":["mon"]}]}'
    )
    assert c.slots == ((12, 30, frozenset({0})), (18, 0, frozenset({5, 6})))


def test_parse_cadence_merges_slots_sharing_a_time():
    # Two sends booked for the same minute would collide on one slot.
    c = parse_cadence(
        '{"mode":"times","slots":['
        '{"time":"18:00","days":["sat"]},{"time":"18:00","days":["sun"]}]}'
    )
    assert c.slots == ((18, 0, frozenset({5, 6})),)


def test_parse_cadence_drops_an_unusable_slot_but_keeps_the_rest():
    c = parse_cadence(
        '{"mode":"times","slots":['
        '{"time":"25:00","days":["mon"]},'      # impossible time
        '{"time":"09:00","days":[]},'           # no days
        '{"time":"18:00","days":["mon"]}]}'
    )
    assert c.slots == ((18, 0, frozenset({0})),)


def test_parse_cadence_returns_none_when_nothing_is_usable():
    assert parse_cadence(None) is None
    assert parse_cadence("") is None
    assert parse_cadence("not json") is None
    assert parse_cadence('["a list, not an object"]') is None
    assert parse_cadence('{"days":[],"time":"18:00"}') is None       # no days
    assert parse_cadence('{"days":["mon"],"time":"25:00"}') is None  # no valid time
    assert parse_cadence('{"days":["mon"]}') is None                 # no time at all


def test_candidate_local_times_in_times_mode_is_just_its_times():
    c = parse_cadence('{"days":["mon"],"times":["09:00","18:00"]}')
    assert sorted(c.candidate_local_times()) == [(9, 0), (18, 0)]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -k parse_cadence -v
```

Expected: `ImportError: cannot import name 'Cadence' from 'worker.scheduling'`.

- [ ] **Step 3: Implement**

At the top of `worker/scheduling.py`, add `import math` and `from dataclasses import dataclass, field` to the existing imports. Then add:

```python
@dataclass(frozen=True)
class Cadence:
    """A parsed auto-fill cadence, in either mode.

    ONE type for both modes so `_fill_unit` keeps exactly one validity gate: a `None` from
    `parse_cadence` means "no valid cadence, skip this unit", and there is no second way for a
    cadence to be half-usable.

    times mode:    `slots` is [(hour, minute, weekdays), ...] sorted by time.
    interval mode: `every_minutes`, `window` (local from/to, inclusive, may wrap midnight),
                   and `days`.
    """

    mode: str
    slots: tuple[tuple[int, int, frozenset[int]], ...] = ()
    every_minutes: int = 0
    window: tuple[tuple[int, int], tuple[int, int]] = ((0, 0), (23, 59))
    days: frozenset[int] = frozenset()

    def candidate_local_times(self):
        """Every local (hour, minute) a slot from this cadence could land on.

        In times mode that is simply its times. In interval mode the send time DRIFTS, so any
        minute inside the window is reachable. Auto-fill maps these through `derive_band` to
        learn which bands the cadence covers — the one question both modes must answer the
        same way, and the reason this module can stay entirely free of band concepts.
        """
        if self.mode == "interval":
            for minutes in _window_minutes(self.window):
                yield divmod(minutes, 60)
        else:
            for hour, minute, _ in self.slots:
                yield hour, minute


def _parse_hhmm(value) -> tuple[int, int] | None:
    """(hour, minute) from 'HH:MM', or None if it isn't one. Never raises: every caller here
    treats an unparseable time as a slot to drop, not as an error to propagate."""
    try:
        hour, minute = (int(x) for x in str(value).split(":"))
    except (ValueError, TypeError, AttributeError):
        return None
    if 0 <= hour < 24 and 0 <= minute < 60:
        return hour, minute
    return None


def _weekday_ints(days) -> set[int]:
    """Weekday names to Python weekday ints, silently skipping anything unrecognized."""
    out: set[int] = set()
    for day in days or []:
        key = str(day).lower()
        if key in WEEKDAYS:
            out.add(WEEKDAYS[key])
    return out


def _window_minutes(window):
    """Every minute-of-day inside `window`, inclusive of both ends, wrapping midnight when
    `from` is later than `to`."""
    (from_hour, from_minute), (to_hour, to_minute) = window
    start, end = from_hour * 60 + from_minute, to_hour * 60 + to_minute
    if start <= end:
        return range(start, end + 1)
    return [*range(start, 1440), *range(0, end + 1)]


def _in_window(hour: int, minute: int, window) -> bool:
    """Is this local time inside the window? Wraps midnight when `from` > `to`."""
    (from_hour, from_minute), (to_hour, to_minute) = window
    start, end = from_hour * 60 + from_minute, to_hour * 60 + to_minute
    at = hour * 60 + minute
    if start <= end:
        return start <= at <= end
    return at >= start or at <= end


def parse_cadence(cadence_config: str | None) -> Cadence | None:
    """The stored JSON as one Cadence, or None when there is nothing usable in it.

    `mode` defaults to "times" when absent, which is what makes every config written before
    this existed keep working untouched.
    """
    if not cadence_config:
        return None
    try:
        cfg = json.loads(cadence_config)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(cfg, dict):
        return None
    if cfg.get("mode") == "interval":
        return _parse_interval(cfg)
    return _parse_times(cfg)


def _parse_times(cfg) -> Cadence | None:
    raw_slots = cfg.get("slots")
    if isinstance(raw_slots, list):
        pairs = [
            (slot.get("time"), _weekday_ints(slot.get("days")))
            for slot in raw_slots
            if isinstance(slot, dict)
        ]
    else:
        # The two shapes that predate per-time days: every time shares one day list.
        shared = _weekday_ints(cfg.get("days"))
        times = cfg.get("times")
        if not isinstance(times, list) or not times:
            single = cfg.get("time")
            times = [single] if single else []
        pairs = [(t, set(shared)) for t in times]

    merged: dict[tuple[int, int], set[int]] = {}
    for raw_time, days in pairs:
        hhmm = _parse_hhmm(raw_time)
        if hhmm is None or not days:
            continue
        merged.setdefault(hhmm, set()).update(days)
    if not merged:
        return None
    slots = tuple(
        (hour, minute, frozenset(days)) for (hour, minute), days in sorted(merged.items())
    )
    return Cadence(mode="times", slots=slots)
```

`_parse_interval` is Task 3 — add a temporary stub so the module imports:

```python
def _parse_interval(cfg) -> Cadence | None:
    return None  # Task 3
```

Finally, replace the module docstring's example block so it describes both modes:

```python
"""Cadence + slot generation for auto-fill.

A cadence is stored as JSON in channels.cadence_config (or channel_groups.cadence_config) and
comes in two modes:

    {"mode": "times", "slots": [{"time": "12:30", "days": ["mon", ..., "sun"]},
                                {"time": "18:00", "days": ["sat", "sun"]}]}

    {"mode": "interval", "every_minutes": 585,
     "window": {"from": "08:00", "to": "21:00"}, "days": ["mon", ...]}

Two older shapes are still read — {"days": [...], "time": "18:00"} and
{"days": [...], "times": [...]} — because a stored config is never rewritten until the owner
saves the form.

This module is deliberately free of any time-of-day BAND concept: it answers "when could a
send happen", and worker/time_of_day.py answers "what band is that". worker/autofill.py joins
the two. (Bulk scheduling in the dashboard uses a simpler interval and lives in TypeScript;
see dashboard/lib/scheduling.ts.)
"""
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -k "parse_cadence or candidate_local" -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/scheduling.py worker/tests/test_scheduling.py
git commit -m "feat(autofill): parse every cadence shape into one Cadence"
```

---

## Task 3: `parse_cadence` — interval mode

**Files:**
- Modify: `worker/scheduling.py` (replace the `_parse_interval` stub)
- Test: `worker/tests/test_scheduling.py`

**Interfaces:**
- Consumes: `Cadence`, `_parse_hhmm`, `_weekday_ints`, `_window_minutes`, `WEEKDAYS` from Task 2.
- Produces: a working `_parse_interval`; `parse_cadence` now returns interval-mode `Cadence` objects.

- [ ] **Step 1: Write the failing tests**

Add to `worker/tests/test_scheduling.py`:

```python
def test_parse_cadence_interval_mode():
    c = parse_cadence(
        '{"mode":"interval","every_minutes":585,'
        '"window":{"from":"08:00","to":"21:00"},"days":["mon","tue"]}'
    )
    assert c.mode == "interval"
    assert c.every_minutes == 585           # 9h45m
    assert c.window == ((8, 0), (21, 0))
    assert c.days == frozenset({0, 1})


def test_parse_cadence_interval_defaults_to_the_unrestricted_sweep():
    # No window and no days is a legitimate choice — the full 24-hour, 7-day drift — so the
    # absent keys widen rather than invalidate.
    c = parse_cadence('{"mode":"interval","every_minutes":60}')
    assert c.window == ((0, 0), (23, 59))
    assert c.days == frozenset({0, 1, 2, 3, 4, 5, 6})


def test_parse_cadence_interval_rejects_a_non_positive_or_missing_interval():
    assert parse_cadence('{"mode":"interval","every_minutes":0}') is None
    assert parse_cadence('{"mode":"interval","every_minutes":-5}') is None
    assert parse_cadence('{"mode":"interval"}') is None
    assert parse_cadence('{"mode":"interval","every_minutes":"soon"}') is None


def test_parse_cadence_interval_rejects_an_explicitly_empty_day_list():
    # Absent days means "every day"; an empty list means the owner unchecked all seven, which
    # is a cadence that can never fire.
    assert parse_cadence('{"mode":"interval","every_minutes":60,"days":[]}') is None


def test_candidate_local_times_covers_the_window_only():
    c = parse_cadence(
        '{"mode":"interval","every_minutes":60,"window":{"from":"08:00","to":"12:00"}}'
    )
    times = set(c.candidate_local_times())
    assert (8, 0) in times and (12, 0) in times
    assert (7, 59) not in times and (12, 1) not in times


def test_candidate_local_times_wraps_midnight():
    c = parse_cadence(
        '{"mode":"interval","every_minutes":60,"window":{"from":"22:00","to":"02:00"}}'
    )
    times = set(c.candidate_local_times())
    assert (23, 0) in times and (0, 30) in times and (2, 0) in times
    assert (12, 0) not in times
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -k interval -v
```

Expected: FAIL — `AttributeError: 'NoneType' object has no attribute 'mode'` (the stub returns `None`).

- [ ] **Step 3: Implement**

Replace the `_parse_interval` stub in `worker/scheduling.py`:

```python
def _parse_interval(cfg) -> Cadence | None:
    """An interval cadence, or None when it could never fire.

    The window and day list WIDEN when absent (no window = all day, no `days` key = all week)
    because the unrestricted 24/7 drift is a real choice someone might want. An explicitly
    empty day list is different: the owner unchecked all seven, and a cadence that can never
    fire must read as invalid rather than silently doing nothing forever.
    """
    try:
        every_minutes = int(cfg.get("every_minutes"))
    except (TypeError, ValueError):
        return None
    if every_minutes <= 0:
        return None

    window_cfg = cfg.get("window")
    start = end = None
    if isinstance(window_cfg, dict):
        start = _parse_hhmm(window_cfg.get("from"))
        end = _parse_hhmm(window_cfg.get("to"))
    window = (start or (0, 0), end or (23, 59))

    if "days" in cfg:
        days = _weekday_ints(cfg.get("days"))
        if not days:
            return None
    else:
        days = set(WEEKDAYS.values())

    return Cadence(
        mode="interval",
        every_minutes=every_minutes,
        window=window,
        days=frozenset(days),
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -k "interval or candidate_local" -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/scheduling.py worker/tests/test_scheduling.py
git commit -m "feat(autofill): an interval cadence, with a window and days"
```

---

## Task 4: `iter_slots` — times mode

**Files:**
- Modify: `worker/scheduling.py`
- Test: `worker/tests/test_scheduling.py`

**Interfaces:**
- Consumes: `Cadence` (Task 2), `UTC`, `ZoneInfo`.
- Produces: `iter_slots(cadence: Cadence, tz_name: str, after: datetime, horizon_days: int = 366)` — a **generator** yielding `(utc_dt: datetime, (hour, minute))` chronologically, strictly after `after`. Task 7 consumes it; Task 5 adds the interval branch.

- [ ] **Step 1: Write the failing tests**

Add to `worker/tests/test_scheduling.py`:

```python
from worker.scheduling import iter_slots  # noqa: E402


def _take(gen, n):
    """First n items from a generator, without exhausting an endless one."""
    out = []
    for item in gen:
        out.append(item)
        if len(out) >= n:
            break
    return out


def test_iter_slots_times_respects_per_time_days():
    # 12:30 every day; 18:00 only at the weekend. Thu 2026-08-06 -> Thu, Fri, Sat, Sat, Sun.
    c = parse_cadence(
        '{"mode":"times","slots":['
        '{"time":"12:30","days":["mon","tue","wed","thu","fri","sat","sun"]},'
        '{"time":"18:00","days":["sat","sun"]}]}'
    )
    after = datetime(2026, 8, 6, 6, 0, tzinfo=timezone.utc)  # Thursday 06:00
    got = _take(iter_slots(c, "UTC", after), 5)
    assert [hm for _, hm in got] == [(12, 30), (12, 30), (12, 30), (18, 0), (12, 30)]
    assert [dt.day for dt, _ in got] == [6, 7, 8, 8, 9]


def test_iter_slots_times_are_strictly_after_the_starting_point():
    # 12:30 today has already passed at 18:00 — the first slot must be tomorrow, never a send
    # booked in the past.
    c = parse_cadence('{"mode":"times","slots":[{"time":"12:30",'
                      '"days":["mon","tue","wed","thu","fri","sat","sun"]}]}')
    after = datetime(2026, 8, 6, 18, 0, tzinfo=timezone.utc)
    first = _take(iter_slots(c, "UTC", after), 1)[0]
    assert first[0] == datetime(2026, 8, 7, 12, 30, tzinfo=timezone.utc)


def test_iter_slots_times_are_local_across_a_dst_boundary():
    # US DST ends 2026-11-01. 18:00 local stays 18:00 local; its UTC offset shifts by an hour.
    from zoneinfo import ZoneInfo as _ZI

    c = parse_cadence('{"mode":"times","slots":[{"time":"18:00",'
                      '"days":["mon","tue","wed","thu","fri","sat","sun"]}]}')
    after = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
    got = _take(iter_slots(c, "America/New_York", after), 2)
    local = [dt.astimezone(_ZI("America/New_York")) for dt, _ in got]
    assert [(d.hour, d.minute) for d in local] == [(18, 0), (18, 0)]
    assert got[0][0].hour == 22        # EDT, UTC-4
    assert got[1][0].hour == 23        # EST, UTC-5


def test_iter_slots_times_stops_at_the_horizon():
    # Mondays only, a 3-day horizon: at most one Monday can appear, often none.
    c = parse_cadence('{"mode":"times","slots":[{"time":"09:00","days":["mon"]}]}')
    after = datetime(2026, 8, 4, 9, 0, tzinfo=timezone.utc)   # Tuesday
    assert list(iter_slots(c, "UTC", after, horizon_days=3)) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -k iter_slots -v
```

Expected: `ImportError: cannot import name 'iter_slots' from 'worker.scheduling'`.

- [ ] **Step 3: Implement**

Add to `worker/scheduling.py`:

```python
def iter_slots(cadence: Cadence, tz_name: str, after: datetime, horizon_days: int = 366):
    """Yield (utc_dt, (hour, minute)) chronologically, strictly after `after`.

    The local (hour, minute) rides along because the caller needs it to derive the slot's band,
    and recovering it from the UTC instant would mean a second timezone conversion per slot.

    A GENERATOR on purpose: auto-fill cannot know how many slots it needs until it knows how
    many it can fill, because a slot no remaining candidate's band fits is SKIPPED rather than
    consumed. Returning a fixed-length list would force the caller to guess.
    """
    if cadence.mode == "interval":
        yield from _iter_interval_slots(cadence, tz_name, after, horizon_days)
    else:
        yield from _iter_time_slots(cadence, tz_name, after, horizon_days)


def _iter_time_slots(cadence: Cadence, tz_name: str, after: datetime, horizon_days: int):
    tz = ZoneInfo(tz_name)
    cursor = after.astimezone(tz).date()
    for _ in range(horizon_days):
        # cadence.slots is sorted by time, so a day's slots come out in clock order.
        for hour, minute, weekdays in cadence.slots:
            if cursor.weekday() not in weekdays:
                continue
            utc_dt = datetime.combine(cursor, dtime(hour, minute), tz).astimezone(UTC)
            if utc_dt > after:
                yield utc_dt, (hour, minute)
        cursor += timedelta(days=1)
```

`_iter_interval_slots` is Task 5 — add a temporary stub:

```python
def _iter_interval_slots(cadence, tz_name, after, horizon_days):
    return iter(())  # Task 5
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -k iter_slots -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/scheduling.py worker/tests/test_scheduling.py
git commit -m "feat(autofill): generate slots lazily, each time with its own days"
```

---

## Task 5: `iter_slots` — interval mode and its drift

**Files:**
- Modify: `worker/scheduling.py` (replace the `_iter_interval_slots` stub)
- Test: `worker/tests/test_scheduling.py`

**Interfaces:**
- Consumes: `Cadence`, `_in_window` (Task 2), `math`.
- Produces: a working `_iter_interval_slots`.

**The one thing to get right:** the cursor advances from where a *skipped* step would have been, never from the last *yielded* slot. Reset the phase on a skip and every overnight gap drops the next send onto the window's opening minute — turning a drifting cadence into a fixed-time one, which is exactly the behaviour the owner rejected.

- [ ] **Step 1: Write the failing tests**

Add to `worker/tests/test_scheduling.py`:

```python
def test_interval_slots_preserve_the_phase_across_a_skipped_step():
    # Every 9h45m from Mon 09:00, window 08:00-21:00:
    #   Mon 18:45 yield / Tue 04:30 SKIP / Tue 14:15 yield / Wed 00:00 SKIP / Wed 09:45 yield
    # The final 09:45 is the assertion that matters: reset the phase on either skip and it
    # would be 08:00 instead.
    c = parse_cadence(
        '{"mode":"interval","every_minutes":585,"window":{"from":"08:00","to":"21:00"}}'
    )
    after = datetime(2026, 8, 3, 9, 0, tzinfo=timezone.utc)  # Monday
    got = _take(iter_slots(c, "UTC", after), 3)
    assert [hm for _, hm in got] == [(18, 45), (14, 15), (9, 45)]
    assert [dt.day for dt, _ in got] == [3, 4, 5]


def test_interval_slots_skip_an_inactive_weekday_without_resetting_the_phase():
    # Every 25h, weekdays only, from Fri 10:00: Sat 11:00 and Sun 12:00 are skipped and the
    # first slot is Mon 13:00 — the drift kept accumulating through the weekend.
    c = parse_cadence(
        '{"mode":"interval","every_minutes":1500,'
        '"days":["mon","tue","wed","thu","fri"]}'
    )
    after = datetime(2026, 8, 7, 10, 0, tzinfo=timezone.utc)  # Friday
    first = _take(iter_slots(c, "UTC", after), 1)[0]
    assert first[0] == datetime(2026, 8, 10, 13, 0, tzinfo=timezone.utc)  # Monday 13:00


def test_interval_slots_wrapping_window_yields_both_sides_of_midnight():
    c = parse_cadence(
        '{"mode":"interval","every_minutes":60,"window":{"from":"22:00","to":"02:00"}}'
    )
    after = datetime(2026, 8, 3, 21, 0, tzinfo=timezone.utc)
    assert [hm[0] for _, hm in _take(iter_slots(c, "UTC", after), 5)] == [22, 23, 0, 1, 2]


def test_interval_slots_terminate_when_the_window_can_never_be_satisfied():
    # Exactly 24h from an instant at 03:00: the phase never moves, so no step is ever inside an
    # 08:00-21:00 window. The generator must END rather than spin to the horizon forever.
    c = parse_cadence(
        '{"mode":"interval","every_minutes":1440,"window":{"from":"08:00","to":"21:00"}}'
    )
    after = datetime(2026, 8, 3, 3, 0, tzinfo=timezone.utc)
    assert list(iter_slots(c, "UTC", after, horizon_days=10)) == []


def test_interval_slots_with_no_window_sweep_the_whole_day():
    c = parse_cadence('{"mode":"interval","every_minutes":600}')  # every 10h
    after = datetime(2026, 8, 3, 0, 0, tzinfo=timezone.utc)
    assert [hm for _, hm in _take(iter_slots(c, "UTC", after), 3)] == [(10, 0), (20, 0), (6, 0)]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -k interval_slots -v
```

Expected: FAIL — `IndexError: list index out of range` from `_take(...)[0]`, because the stub yields nothing.

- [ ] **Step 3: Implement**

Replace the `_iter_interval_slots` stub in `worker/scheduling.py`:

```python
def _iter_interval_slots(cadence: Cadence, tz_name: str, after: datetime, horizon_days: int):
    """Advance by `every_minutes` from `after`, yielding only steps that land inside the
    window on an active weekday.

    The cursor advances from where a SKIPPED step WOULD have been, never from the last yielded
    slot. That is the whole feature: a non-round interval drifts, so over a few weeks the
    account posts at every hour and the metrics can say which ones worked. Reset the phase on
    a skip and every overnight gap drops the next send back onto the window's opening minute,
    which is the "nudge it into the window" behaviour that was explicitly rejected.

    The horizon is expressed as a STEP count so a small interval cannot outrun it: a cadence
    whose window can never be satisfied ends after `steps` iterations instead of spinning.
    """
    tz = ZoneInfo(tz_name)
    step = timedelta(minutes=cadence.every_minutes)
    steps = math.ceil(horizon_days * 1440 / cadence.every_minutes)
    cursor = after
    for _ in range(steps):
        cursor += step
        local = cursor.astimezone(tz)
        if local.weekday() not in cadence.days:
            continue
        if not _in_window(local.hour, local.minute, cadence.window):
            continue
        yield cursor.astimezone(UTC), (local.hour, local.minute)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source .venv/bin/activate && pytest worker/tests/test_scheduling.py -v
```

Expected: the interval tests PASS. Tests referencing deleted functions still fail — Task 7 removes them.

- [ ] **Step 5: Commit**

```bash
git add worker/scheduling.py worker/tests/test_scheduling.py
git commit -m "feat(autofill): a drifting interval that skips without losing its phase"
```

---

## Task 6: `_assign` — band-matching placement

**Files:**
- Modify: `worker/autofill.py` (add one function; nothing is wired to it yet)
- Test: `worker/tests/test_autofill.py`

**Interfaces:**
- Consumes: `post_allows_band` (Task 1).
- Produces: `_assign(slots, items, bands_by_post, band_of, need, covered, *, pool=None, due=frozenset()) -> list[tuple[item, datetime, tuple[int,int], bool]]` where `item` is a `(row, recipients)` pair and the trailing `bool` is "this was a BPP". Task 7 calls it twice.

- [ ] **Step 1: Write the failing tests**

Add a new section at the end of `worker/tests/test_autofill.py`:

```python
# ---- _assign: band-matching placement ------------------------------------------
from worker.autofill import _assign  # noqa: E402
from worker.time_of_day import derive_band  # noqa: E402

_BT = {"morning": (9, 0), "afternoon": (13, 0), "evening": (18, 0)}


def _band_of(hm):
    return derive_band(hm[0], hm[1], _BT)


def _item(post_id):
    """An (row, recipients) pair — _assign only ever reads row["post_id"]."""
    return ({"post_id": post_id}, [])


def _slot(day, hour, minute):
    return (datetime(2026, 8, day, hour, minute, tzinfo=timezone.utc), (hour, minute))


def test_assign_skips_a_slot_no_candidate_fits():
    # An evening post must not take the 09:00 slot; it waits for 18:00, and 09:00 goes unused.
    out = _assign(
        iter([_slot(3, 9, 0), _slot(3, 18, 0)]),
        [_item(1)], {1: {"evening"}}, _band_of, 2, {"morning", "evening"},
    )
    assert [(item[0]["post_id"], hm) for item, _, hm, _ in out] == [(1, (18, 0))]


def test_assign_takes_the_highest_ranked_candidate_that_fits():
    # 1 ranks first but is a morning post, so the evening slot goes to 2.
    out = _assign(
        iter([_slot(3, 18, 0)]),
        [_item(1), _item(2)], {1: {"morning"}, 2: set()}, _band_of, 1,
        {"morning", "evening"},
    )
    assert out[0][0][0]["post_id"] == 2


def test_assign_fills_to_need_even_when_most_slots_are_unusable():
    # Two slots a day, only the evening one usable, three evening posts -> three days out.
    def slots():
        for day in range(3, 13):
            yield _slot(day, 9, 0)
            yield _slot(day, 18, 0)

    out = _assign(
        slots(), [_item(1), _item(2), _item(3)],
        {1: {"evening"}, 2: {"evening"}, 3: {"evening"}}, _band_of, 3,
        {"morning", "evening"},
    )
    assert [item[0]["post_id"] for item, _, _, _ in out] == [1, 2, 3]
    assert [hm for _, _, hm, _ in out] == [(18, 0), (18, 0), (18, 0)]
    assert [dt.day for _, dt, _, _ in out] == [3, 4, 5]


def test_assign_stops_when_nothing_left_can_fit_any_covered_band():
    # The generator is capped only so a REGRESSION fails instead of hanging the suite.
    def nearly_endless():
        for day in range(1, 5000):
            yield _slot(3, 9, 0)

    out = _assign(nearly_endless(), [_item(1)], {1: {"evening"}}, _band_of, 5, {"morning"})
    assert out == []


def test_assign_uses_the_pool_at_a_due_position_when_the_band_fits():
    out = _assign(
        iter([_slot(3, 18, 0), _slot(4, 18, 0)]),
        [_item(1), _item(2)], {1: set(), 2: set(), 9: {"evening"}}, _band_of, 2,
        {"evening"}, pool=[_item(9)], due={0},
    )
    assert [(item[0]["post_id"], flag) for item, _, _, flag in out] == [(9, True), (1, False)]


def test_assign_falls_back_to_normal_selection_when_the_pool_does_not_fit():
    # Position 0 is due, but the only pool post is evening-tagged and slot 0 is morning. The
    # slot is filled normally and must NOT be flagged as recycled — it isn't one.
    out = _assign(
        iter([_slot(3, 9, 0), _slot(3, 18, 0)]),
        [_item(1), _item(2)], {1: set(), 2: set(), 9: {"evening"}}, _band_of, 2,
        {"morning", "evening"}, pool=[_item(9)], due={0},
    )
    assert [(item[0]["post_id"], flag) for item, _, _, flag in out] == [(1, False), (2, False)]


def test_assign_never_places_the_same_post_twice():
    # The pool and the normal list are drawn from the same library, so overlap is routine.
    out = _assign(
        iter([_slot(3, 18, 0), _slot(4, 18, 0)]),
        [_item(9)], {9: set()}, _band_of, 2, {"evening"}, pool=[_item(9)], due={0},
    )
    assert [item[0]["post_id"] for item, _, _, _ in out] == [9]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source .venv/bin/activate && pytest worker/tests/test_autofill.py -k assign -v
```

Expected: `ImportError: cannot import name '_assign' from 'worker.autofill'`.

- [ ] **Step 3: Implement**

Add to `worker/autofill.py` (place it just above `_fill_unit`):

```python
def _assign(slots, items, bands_by_post, band_of, need, covered, *, pool=None,
            due=frozenset()):
    """Place items into slots, honouring each item's time_of_day bands.

    `slots` is an iterable of (utc_dt, (hour, minute)) — a lazy generator on the first pass and
    a fixed list on the BPP re-fill, which is why this takes an iterable rather than a list.
    Returns [(item, utc_dt, (hour, minute), is_bpp)].

    A slot nothing fits is SKIPPED, not consumed: holding a post back must cost an unused slot,
    never queue depth. Conversely the walk stops the moment nothing remaining can fit any band
    the cadence covers, so an impossible cadence ends in a few steps instead of grinding
    through a year of slots that provably cannot be filled.

    `pool`/`due` carry BPP: at a due POSITION the stalest pool post that fits the slot's band
    wins, and if none fits the slot falls through to normal selection and is NOT flagged —
    because it isn't a BPP.
    """
    remaining = list(items)
    remaining_pool = list(pool or [])
    used: set[int] = set()
    out: list = []

    def fits(item, band):
        return post_allows_band(bands_by_post.get(item[0]["post_id"], set()), band)

    def take(seq, band):
        for index, item in enumerate(seq):
            # A post taken from the OTHER list stays in this one; `used` is what stops it
            # being placed twice, since the pool and the candidates share a library.
            if item[0]["post_id"] in used:
                continue
            if fits(item, band):
                return seq.pop(index)
        return None

    def anything_left():
        return any(
            fits(item, band)
            for item in remaining + remaining_pool
            for band in covered
        )

    if not anything_left():
        return out
    for slot, hhmm in slots:
        if len(out) >= need:
            break
        band = band_of(hhmm)
        item = take(remaining_pool, band) if len(out) in due else None
        is_bpp = item is not None
        if item is None:
            item = take(remaining, band)
        if item is None:
            continue  # nothing fits this slot — skip it, do not consume it
        used.add(item[0]["post_id"])
        out.append((item, slot, hhmm, is_bpp))
        if not anything_left():
            break
    return out
```

Add `post_allows_band` to the existing import at `worker/autofill.py:41`, keeping `resolve_slot_time` — `_fill_unit` still calls it until Task 7:

```python
from .time_of_day import band_times, post_allows_band, post_bands, resolve_slot_time
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source .venv/bin/activate && pytest worker/tests/test_autofill.py -k assign -v
```

Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill.py
git commit -m "feat(autofill): place a post only in a slot its band allows"
```

---

## Task 7: Wire it up, delete the old paths

**Files:**
- Modify: `worker/autofill.py` (imports, `_apply_bpp`, `_fill_unit`; delete `_merge_bpp_slots`)
- Modify: `worker/scheduling.py` (delete `parse_weekly_cadence`, `parse_cadence_times`, `weekly_date_slots`, `daily_slots`)
- Test: `worker/tests/test_autofill.py`, `worker/tests/test_scheduling.py`, `worker/tests/test_autofill_groups.py`

**Interfaces:**
- Consumes: `parse_cadence`, `iter_slots` (Tasks 2-5); `derive_band`, `post_allows_band`, `band_times`, `post_bands` (Task 1); `_assign` (Task 6); existing `bpp_slot_indices`, `_last_bpp_date`, `bpp_pool`, `_group_bpp_pool`.
- Produces: no new public surface — `run_autofill(conn, config, now, logger=None) -> int` is unchanged.

- [ ] **Step 1: Write the failing end-to-end tests**

Replace `test_autofill_uses_time_of_day_for_slot_time` in `worker/tests/test_autofill.py` (it asserts the deleted behaviour) with:

```python
def test_autofill_never_places_a_post_outside_its_band(conn, config):
    # Cadence is 12:30 only, which derives to AFTERNOON. The evening post must be held back
    # entirely rather than sent at 12:30; the untagged one fills as normal.
    tz = "America/New_York"
    ch = make_channel(conn, min_depth=3, target=3,
                      cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],'
                              '"time":"12:30"}', tz=tz)
    p_even = make_post(conn, ch, created_at="2026-01-01T00:00:00+00:00")
    p_plain = make_post(conn, ch, created_at="2026-01-02T00:00:00+00:00")
    _tag(conn, p_even, "evening")

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    run_autofill(conn, config, now)

    placed = [r["post_id"] for r in conn.execute(
        "SELECT post_id FROM publications WHERE channel_id=?", (ch,)).fetchall()]
    assert p_plain in placed
    assert p_even not in placed


def test_autofill_places_a_banded_post_once_its_band_has_a_time(conn, config):
    # Same library, but the cadence now books an evening slot too.
    tz = "America/New_York"
    ch = make_channel(conn, min_depth=3, target=3,
                      cadence='{"mode":"times","slots":['
                              '{"time":"12:30","days":["mon","tue","wed","thu","fri","sat","sun"]},'
                              '{"time":"18:00","days":["mon","tue","wed","thu","fri","sat","sun"]}]}',
                      tz=tz)
    p_even = make_post(conn, ch, created_at="2026-01-01T00:00:00+00:00")
    p_plain = make_post(conn, ch, created_at="2026-01-02T00:00:00+00:00")
    _tag(conn, p_even, "evening")

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    run_autofill(conn, config, now)

    rows = conn.execute(
        "SELECT post_id, scheduled_at FROM publications WHERE channel_id=?", (ch,)).fetchall()
    at = {r["post_id"]: datetime.fromisoformat(r["scheduled_at"]).astimezone(ZoneInfo(tz))
          for r in rows}
    assert (at[p_even].hour, at[p_even].minute) == (18, 0)
    assert p_plain in at


def test_autofill_looks_past_the_top_ranked_candidates_to_find_a_fitting_one(conn, config):
    # The bug the uncapped fetch fixes: the top `need` ranked posts are ALL evening-tagged
    # while the cadence covers only afternoon. Fetching just `need` would place nothing.
    tz = "UTC"
    ch = make_channel(conn, min_depth=2, target=2,
                      cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],'
                              '"time":"12:30"}', tz=tz)
    for i in range(5):  # oldest first -> these rank ahead of the plain ones
        _tag(conn, make_post(conn, ch, created_at=f"2026-01-0{i + 1}T00:00:00+00:00"), "evening")
    plain = [make_post(conn, ch, created_at="2026-02-01T00:00:00+00:00"),
             make_post(conn, ch, created_at="2026-02-02T00:00:00+00:00")]

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    made = run_autofill(conn, config, now)
    assert made == 2
    placed = {r["post_id"] for r in conn.execute(
        "SELECT post_id FROM publications WHERE channel_id=?", (ch,)).fetchall()}
    assert placed == set(plain)


def test_autofill_logs_which_posts_are_held_back(conn, config):
    class Recorder:
        def __init__(self):
            self.lines = []

        def info(self, msg, *args):
            self.lines.append(msg % args if args else msg)

    ch = make_channel(conn, min_depth=2, target=2,
                      cadence='{"days":["mon","tue","wed","thu","fri","sat","sun"],'
                              '"time":"12:30"}', tz="UTC")
    for i in range(3):
        _tag(conn, make_post(conn, ch, created_at=f"2026-01-0{i + 1}T00:00:00+00:00"), "evening")
    make_post(conn, ch, created_at="2026-02-01T00:00:00+00:00")

    log = Recorder()
    run_autofill(conn, config, datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc), log)
    held = [line for line in log.lines if "held back" in line]
    assert held, log.lines
    assert "3" in held[0] and "evening" in held[0]


def test_autofill_interval_cadence_drifts(conn, config):
    ch = make_channel(conn, min_depth=3, target=3, tz="UTC",
                      cadence='{"mode":"interval","every_minutes":585,'
                              '"window":{"from":"08:00","to":"21:00"}}')
    for i in range(3):
        make_post(conn, ch, created_at=f"2026-01-0{i + 1}T00:00:00+00:00")

    now = datetime(2026, 8, 3, 9, 0, tzinfo=timezone.utc)  # Monday 09:00
    assert run_autofill(conn, config, now) == 3
    at = [datetime.fromisoformat(r["scheduled_at"]) for r in conn.execute(
        "SELECT scheduled_at FROM publications WHERE channel_id=? ORDER BY scheduled_at",
        (ch,)).fetchall()]
    assert [(d.hour, d.minute) for d in at] == [(18, 45), (14, 15), (9, 45)]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source .venv/bin/activate && pytest worker/tests/test_autofill.py -v
```

Expected: FAIL — the new tests assert behaviour that does not exist yet (`p_even` *is* placed, at 18:00, via the old single-time band path).

- [ ] **Step 3: Delete the superseded functions**

In `worker/scheduling.py`, delete `parse_weekly_cadence`, `weekly_date_slots`, `parse_cadence_times`, and `daily_slots` in full. **Keep `weekly_slots`** — it was already unused before this work.

In `worker/tests/test_scheduling.py`, delete every test naming a deleted function. Confirm the list first:

```bash
grep -n "weekly_date_slots\|daily_slots\|parse_cadence_times\|parse_weekly_cadence" worker/tests/test_scheduling.py
```

Delete those tests and the imports that pull the deleted names in. `test_weekly_slots_*` stays.

In `worker/time_of_day.py`, delete `resolve_slot_time` (deferred from Task 1 so the intermediate tasks stayed green) and replace the module docstring's first paragraph, which still describes a band resolving to a slot *time*:

```python
"""Time-of-day bands: which slots a post's time_of_day tag(s) permit.

A cadence TIME carries a band (`derive_band`), and a post's tags say which bands it will
accept (`post_allows_band`). morning/afternoon/evening are the specific bands; `anytime` (and
no time_of_day tag at all) place no constraint, so such a post fits any slot.
"""
```

In `worker/tests/test_time_of_day.py`, delete `test_resolve_earliest_specific_band_wins` and `test_resolve_anytime_and_untagged_use_cadence_time`, and drop `resolve_slot_time` from the import block.

In `worker/autofill.py`, delete `_merge_bpp_slots` in full — `_assign`'s `pool`/`due` handling replaces it. Delete any test that names it.

- [ ] **Step 4: Rewrite the imports, `_apply_bpp`, and `_fill_unit`**

Replace the two import blocks at `worker/autofill.py:37-41`:

```python
from .scheduling import iter_slots, parse_cadence, parse_iso
from .time_of_day import BAND_ORDER, band_times, post_allows_band, post_bands
from .time_of_day import derive_band
```

Replace `_apply_bpp` in full:

```python
def _apply_bpp(conn, unit, settings, now, placed, candidates, bands_by_post, band_of,
               covered, every_days, logger):
    """Re-fill the slots pass 1 chose, giving the due ones to the owner's marked posts.

    Two passes, because the two facts depend on each other in opposite directions: a BPP's
    due-ness depends on the slot DATES, while which post lands in a slot depends on band
    matching. So pass 1 (already done, in `placed`) fixes the dates, and this re-runs the same
    slots with the pool available at the due positions.

    A due slot whose band no pool post fits falls through to normal selection and is not
    flagged — the same behaviour as a due slot with an empty pool.
    """
    slots = [(slot, hhmm) for _, slot, hhmm, _ in placed]
    due = bpp_slot_indices(
        [slot.date() for slot, _ in slots],
        _last_bpp_date(conn, [m["id"] for m in unit.members]),
        every_days,
    )
    if not due:
        return placed

    if unit.is_group:
        pool = _group_bpp_pool(conn, settings, unit.members, now)
    else:
        channel = unit.members[0]
        pool = [(r, [channel]) for r in bpp_pool(conn, channel, now)]

    if not pool:
        if logger:
            logger.info(
                "[autofill %s] a BPP slot came due but the pool is empty — mark some posts "
                "in the dashboard, or this stays ordinary auto-fill", unit.label,
            )
        return placed

    for row, _ in pool:
        bands_by_post.setdefault(row["post_id"], post_bands(conn, row["post_id"]))

    refilled = _assign(slots, candidates, bands_by_post, band_of, len(slots), covered,
                       pool=pool, due=due)
    if logger and any(flag for _, _, _, flag in refilled):
        chosen = [item[0]["post_id"] for item, _, _, flag in refilled if flag]
        logger.info(
            "[autofill %s] BPP: %d slot(s) from a pool of %d — post(s) %s",
            unit.label, len(chosen), len(pool), ", ".join(str(p) for p in chosen),
        )
    return refilled


def _stranded_by_band(candidates, bands_by_post, covered) -> dict[str, int]:
    """How many eligible candidates carry a band the cadence has no slot for.

    This is the number behind the held-back log line. It counts over the FULL eligible list
    (the fetch is uncapped for exactly this reason), so it reports the real size of the
    problem rather than however many happened to fit in one cycle's need.
    """
    counts: dict[str, int] = {}
    for row, _ in candidates:
        bands = bands_by_post.get(row["post_id"], set()) & set(BAND_ORDER)
        if bands and not (bands & covered):
            for band in sorted(bands):
                counts[band] = counts.get(band, 0) + 1
    return counts
```

Replace `_fill_unit`'s body from the cadence gate through the insert loop. The unchanged parts (the group/member guard, queue-depth math, the transaction, the logging at the end) stay exactly as they are:

```python
    settings = unit.settings
    cadence = parse_cadence(settings["cadence_config"])
    if cadence is None:
        if logger:
            logger.info("[autofill %s] no valid cadence — skipping", unit.label)
        return 0

    member_ids = [m["id"] for m in unit.members]
    if unit.is_group:
        ahead = group_scheduled_ahead_count(conn, member_ids, now_iso)
        last_future = group_latest_future_scheduled(conn, member_ids, now_iso)
    else:
        ahead = scheduled_ahead_count(conn, member_ids[0], now_iso)
        last_future = latest_future_scheduled(conn, member_ids[0], now_iso)

    if ahead >= settings["min_queue_depth"]:
        return 0  # queue is healthy
    need = settings["target_queue_depth"] - ahead
    if need <= 0:
        return 0

    # Uncapped on purpose. Under band matching, a `need`-sized fetch is a bug: if the top-ranked
    # few all sit in a band this cadence has no slot for, auto-fill would place nothing while
    # hundreds of usable posts sat further down the ranking. The SLOTS do the limiting instead —
    # which is already how the group and BPP paths have always worked.
    if unit.is_group:
        candidates = group_eligible_candidates(conn, settings, unit.members, now, None)
    else:
        ch = unit.members[0]
        candidates = [(r, [ch]) for r in eligible_candidates(conn, ch, now, None)]

    if not candidates:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but no eligible content",
                unit.label, ahead, settings["min_queue_depth"],
            )
        return 0

    bt_map = band_times(config)

    def band_of(hhmm):
        return derive_band(hhmm[0], hhmm[1], bt_map)

    covered = {band_of(hm) for hm in cadence.candidate_local_times()}
    bands_by_post = {row["post_id"]: post_bands(conn, row["post_id"]) for row, _ in candidates}

    after = parse_iso(last_future) if last_future else now
    placed = _assign(
        iter_slots(cadence, settings["timezone"], after),
        candidates, bands_by_post, band_of, need, covered,
    )

    # BPP: give some slots to posts the OWNER marked as worth reposting, on their own cadence
    # in days. Nothing here judges content — the mark is the judgement, made by a person
    # looking at the stats (see worker/bpp.py for why an algorithm cannot).
    every_days = _setting(settings, "bpp_every_days")
    if every_days > 0 and placed:
        placed = _apply_bpp(conn, unit, settings, now, placed, candidates, bands_by_post,
                            band_of, covered, every_days, logger)

    stranded = _stranded_by_band(candidates, bands_by_post, covered)
    if stranded and logger:
        detail = ", ".join(f"{count} tagged {band}" for band, count in sorted(stranded.items()))
        logger.info(
            "[autofill %s] %s held back — this cadence has no slot in that band. Add a time "
            "in the dashboard, or retag the posts.", unit.label, detail,
        )

    if not placed:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but nothing could be placed",
                unit.label, ahead, settings["min_queue_depth"],
            )
        return 0

    made = 0
    try:
        for (row, recipients), slot, _hhmm, is_bpp in placed:
            for member in recipients:
                status = "pending_approval" if member["requires_approval"] else "scheduled"
                conn.execute(
                    """INSERT INTO publications
                         (post_id, channel_id, scheduled_at, status, created_by,
                          is_recycled)
                       VALUES (?, ?, ?, ?, 'autofill', ?)""",
                    (row["post_id"], member["id"], slot.isoformat(), status,
                     1 if is_bpp else 0),
                )
                made += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
```

Keep the closing `if logger and made:` block exactly as it is.

Note the `recycled_flags` dict is gone — `is_bpp` now rides on each placed tuple, so the flag can no longer disagree with the slot it was decided for.

- [ ] **Step 5: Run the full worker suite**

```bash
source .venv/bin/activate && pytest worker/tests/ -q
```

Expected: all PASS. If `test_autofill_groups.py` fails on a cadence string, update its fixture cadences — the legacy shapes still parse, so only tests asserting *deleted behaviour* should need changing.

- [ ] **Step 6: Confirm no deleted symbol survives**

```bash
grep -rn "resolve_slot_time\|weekly_date_slots\|daily_slots\|parse_cadence_times\|parse_weekly_cadence\|_merge_bpp_slots" worker/ --include="*.py"
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add worker/
git commit -m "feat(autofill): one cadence, one slot generator, one matching rule"
```

---

## Task 8: Dashboard — band times and per-band post counts

**Files:**
- Modify: `dashboard/lib/config.ts`
- Modify: `dashboard/lib/queries.ts`
- Modify: `dashboard/app/channels/page.tsx`, `dashboard/components/channel-groups.tsx`
- Test: `dashboard/lib/queries.bands.test.ts` (create)

**Interfaces:**
- Produces: `config.bandTimes: { morning: string; afternoon: string; evening: string }` from `dashboard/lib/config.ts`; `getBandCounts(channelIds: number[]): Record<string, number>` from `dashboard/lib/queries.ts`, keyed by `"morning" | "afternoon" | "evening"` with counts of ready feed-targeted posts. Task 9 consumes both as props.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/queries.bands.test.ts`. It uses the same `makeTestDb()` + dynamic-import setup as `dashboard/lib/queries.groups.test.ts` — read that file first and keep the pattern, including the `setupSeq` prefix (node --test gives each FILE one process, but `lib/db.ts` memoises its connection, so every `setup()` in a file shares the first temp DB):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db, prefix: `t${++setupSeq}` };
}

/** A ready post with a feed target on `channelId`, optionally tagged with a band.
 *  Raw SQL because this seeds three tables the query helpers don't cover together. */
function seedPost(
  db: ReturnType<typeof import("better-sqlite3")>,
  channelId: number,
  band: string | null,
  status = "ready",
): number {
  const postId = Number(
    db
      .prepare(
        `INSERT INTO posts (caption, post_type, status, content_status, content_kind)
         VALUES ('x','single','draft',?,'evergreen')`,
      )
      .run(status).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'feed')`,
  ).run(postId, channelId);
  if (band) {
    db.prepare(
      `INSERT INTO post_tags (post_id, tag_id)
       SELECT ?, id FROM tags WHERE name = ? AND kind = 'time_of_day'`,
    ).run(postId, band);
  }
  return postId;
}

async function seedTwoChannels() {
  const { q, db, prefix } = await setup();
  const a = q.createChannel({
    platform: "instagram", account_name: `${prefix}-a`, timezone: "UTC",
    remote_account_id: `${prefix}-a`, access_token: "tok",
  });
  const b = q.createChannel({
    platform: "instagram", account_name: `${prefix}-b`, timezone: "UTC",
    remote_account_id: `${prefix}-b`, access_token: "tok",
  });
  return { q, db, a, b };
}

test("getBandCounts counts ready feed posts per band", async () => {
  const { q, db, a } = await seedTwoChannels();
  seedPost(db, a, "evening");
  seedPost(db, a, "evening");
  seedPost(db, a, "morning");
  seedPost(db, a, "evening", "draft"); // not ready -> not counted
  seedPost(db, a, null);              // untagged -> not counted

  const counts = q.getBandCounts([a]);
  assert.equal(counts.evening, 2);
  assert.equal(counts.morning, 1);
  assert.equal(counts.afternoon ?? 0, 0);
});

test("getBandCounts spans every channel in a group", async () => {
  const { q, db, a, b } = await seedTwoChannels();
  seedPost(db, a, "evening");
  seedPost(db, b, "evening");

  assert.equal(q.getBandCounts([a]).evening, 1);
  assert.equal(q.getBandCounts([a, b]).evening, 2);
});

test("getBandCounts returns an empty object for no channels", async () => {
  const { q } = await setup();
  assert.deepEqual(q.getBandCounts([]), {});
});
```

If `createChannel`'s argument shape differs from the above, match whatever `queries.groups.test.ts` passes — do not change `createChannel` to suit the test.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard && npm test 2>&1 | grep -A5 bands
```

Expected: FAIL — `getBandCounts` is not exported.

- [ ] **Step 3: Implement `getBandCounts`**

Add to `dashboard/lib/queries.ts`:

```ts
/** Ready, feed-targeted posts per time_of_day band, across a set of channels.
 *
 *  Feeds the auto-fill form's coverage warning: a band with content but no slot in the
 *  cadence means those posts silently stop being auto-filled, and the queue goes on looking
 *  healthy because untagged posts keep filling it.
 *
 *  Deliberately approximate — it does NOT re-run cooldown, period or caption-length
 *  eligibility. Making it exact would mean running the full selection pass on every page
 *  render to sharpen a number whose only job is "this band has content and nowhere to put it".
 */
export function getBandCounts(channelIds: number[]): Record<string, number> {
  if (channelIds.length === 0) return {};
  const placeholders = channelIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT t.name AS band, COUNT(DISTINCT p.id) AS n
         FROM posts p
         JOIN post_tags pt ON pt.post_id = p.id
         JOIN tags t ON t.id = pt.tag_id AND t.kind = 'time_of_day'
        WHERE p.content_status = 'ready'
          AND t.name IN ('morning','afternoon','evening')
          AND EXISTS (SELECT 1 FROM post_targets ptg
                       WHERE ptg.post_id = p.id
                         AND ptg.channel_id IN (${placeholders})
                         AND ptg.surface = 'feed')
        GROUP BY t.name`,
    )
    .all(...channelIds) as { band: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.band, r.n]));
}
```

- [ ] **Step 4: Expose the band times**

In `dashboard/lib/config.ts`, add to the exported `config` object (line 68), using the existing `get()` helper so `.env` and `process.env` resolve the same way they do for every other setting:

```ts
  // The worker derives a cadence time's band from these (worker/time_of_day.py derive_band).
  // The form reads the SAME values purely to print the band label next to a time, so it can
  // never show a band the worker would disagree with.
  bandTimes: {
    morning: get("TOD_MORNING", "09:00"),
    afternoon: get("TOD_AFTERNOON", "13:00"),
    evening: get("TOD_EVENING", "18:00"),
  },
```

- [ ] **Step 5: Pass both down to the form**

In `dashboard/app/channels/page.tsx`, import `config` from `@/lib/config` and `getBandCounts` from `@/lib/queries`. Add to the `groups` map (beside `bpp_pool_size`):

```ts
    band_counts: getBandCounts(getGroupMembers(g.id).map((m) => m.id)),
```

Add two props to the solo-channel `<AutofillConfig>` at line 178:

```tsx
                    bandTimes={config.bandTimes}
                    bandCounts={getBandCounts([c.id])}
```

In `dashboard/components/channel-groups.tsx`, add `band_counts: Record<string, number>` to the group interface at line 20 and pass both props to `<AutofillConfig>` at line 115:

```tsx
              bandTimes={props.bandTimes}
              bandCounts={g.band_counts ?? {}}
```

`channel-groups.tsx` is a client component, so `bandTimes` must arrive as a prop from the server page — add `bandTimes` to its own props interface and pass `config.bandTimes` where `<ChannelGroups>` is rendered in `page.tsx`. Do **not** import `@/lib/config` into a client component; it is `server-only` and will fail the build.

While here, fix the mis-indented `bppEveryDays`/`bppPoolSize` lines at `channel-groups.tsx:122-123`.

- [ ] **Step 6: Run the tests and lint**

```bash
cd dashboard && npm test && npm run lint
```

Expected: tests PASS, lint reports 0 errors.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/config.ts dashboard/lib/queries.ts dashboard/lib/queries.bands.test.ts dashboard/app/channels/page.tsx dashboard/components/channel-groups.tsx
git commit -m "feat(autofill): surface how many ready posts sit in each band"
```

---

## Task 9: The auto-fill form — mode switch, per-time days, interval

**Files:**
- Create: `dashboard/lib/cadence.ts`
- Create: `dashboard/lib/cadence.test.ts`
- Modify: `dashboard/components/autofill-config.tsx`

**Interfaces:**
- Consumes: `bandTimes` and `bandCounts` props (Task 8).
- Produces (from `dashboard/lib/cadence.ts`):
  - `type CadenceSlot = { time: string; days: string[] }`
  - `type Cadence = { mode: "times"; slots: CadenceSlot[] } | { mode: "interval"; everyMinutes: number; from: string; to: string; days: string[] }`
  - `parseCadence(raw: string | null): Cadence`
  - `serializeCadence(c: Cadence): string`
  - `deriveBand(time: string, bandTimes: Record<string, string>): "morning" | "afternoon" | "evening"`
  - `coveredBands(c: Cadence, bandTimes: Record<string, string>): Set<string>`
  - `summarize(c: Cadence): string`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/lib/cadence.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coveredBands, deriveBand, parseCadence, serializeCadence, summarize,
} from "./cadence";

const BT = { morning: "09:00", afternoon: "13:00", evening: "18:00" };
const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

test("parseCadence reads the original single-time shape", () => {
  const c = parseCadence('{"days":["mon","wed"],"time":"18:00"}');
  assert.equal(c.mode, "times");
  assert.deepEqual(c.slots, [{ time: "18:00", days: ["mon", "wed"] }]);
});

test("parseCadence reads the multi-time shape, giving each time the shared days", () => {
  const c = parseCadence('{"days":["sat"],"times":["09:00","18:00"]}');
  assert.deepEqual(c.slots, [
    { time: "09:00", days: ["sat"] },
    { time: "18:00", days: ["sat"] },
  ]);
});

test("parseCadence reads per-time days and an interval cadence", () => {
  const t = parseCadence('{"mode":"times","slots":[{"time":"18:00","days":["sat"]}]}');
  assert.deepEqual(t.slots, [{ time: "18:00", days: ["sat"] }]);
  const i = parseCadence(
    '{"mode":"interval","every_minutes":585,"window":{"from":"08:00","to":"21:00"},'
    + '"days":["mon"]}',
  );
  assert.equal(i.mode, "interval");
  assert.equal(i.everyMinutes, 585);
  assert.equal(i.from, "08:00");
  assert.deepEqual(i.days, ["mon"]);
});

test("parseCadence falls back to a sane default on garbage", () => {
  const c = parseCadence("not json");
  assert.equal(c.mode, "times");
  assert.equal(c.slots.length, 1);
});

test("serialize round-trips both modes", () => {
  const t = parseCadence('{"mode":"times","slots":[{"time":"18:00","days":["sat"]}]}');
  assert.deepEqual(parseCadence(serializeCadence(t)), t);
  const i = parseCadence('{"mode":"interval","every_minutes":585,"days":["mon"]}');
  assert.deepEqual(parseCadence(serializeCadence(i)), i);
});

test("deriveBand matches the worker: nearest, no wrap, ties to the earlier band", () => {
  assert.equal(deriveBand("12:30", BT), "afternoon");
  assert.equal(deriveBand("18:00", BT), "evening");
  assert.equal(deriveBand("23:00", BT), "evening");
  assert.equal(deriveBand("02:00", BT), "morning");
  assert.equal(deriveBand("11:00", BT), "morning");
});

test("coveredBands is the slot times in times mode, the window in interval mode", () => {
  const t = parseCadence('{"mode":"times","slots":[{"time":"12:30","days":["mon"]}]}');
  assert.deepEqual([...coveredBands(t, BT)].sort(), ["afternoon"]);
  const i = parseCadence(
    '{"mode":"interval","every_minutes":60,"window":{"from":"08:00","to":"12:00"},'
    + '"days":["mon"]}',
  );
  assert.deepEqual([...coveredBands(i, BT)].sort(), ["afternoon", "morning"]);
});

test("summarize says daily rather than listing seven days", () => {
  const t = parseCadence(
    `{"mode":"times","slots":[{"time":"12:30","days":${JSON.stringify(ALL)}},`
    + '{"time":"18:00","days":["sat","sun"]}]}',
  );
  assert.match(summarize(t), /12:30 daily/);
  assert.match(summarize(t), /18:00 Sat\/Sun/);
  const i = parseCadence(
    `{"mode":"interval","every_minutes":585,"window":{"from":"08:00","to":"21:00"},`
    + `"days":${JSON.stringify(ALL)}}`,
  );
  assert.match(summarize(i), /Every 9h 45m/);
  assert.match(summarize(i), /08:00–21:00/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard && npm test 2>&1 | grep -A5 cadence
```

Expected: FAIL — `Cannot find module './cadence'`.

- [ ] **Step 3: Implement `dashboard/lib/cadence.ts`**

Pure functions, no React and no `server-only` import — the form is a client component and its tests run under `node --test`.

```ts
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const BAND_ORDER = ["morning", "afternoon", "evening"] as const;

export type Band = (typeof BAND_ORDER)[number];
export type CadenceSlot = { time: string; days: string[] };
export type Cadence =
  | { mode: "times"; slots: CadenceSlot[] }
  | { mode: "interval"; everyMinutes: number; from: string; to: string; days: string[] };

const DEFAULT: Cadence = { mode: "times", slots: [{ time: "18:00", days: [] }] };

function minutesOf(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function cleanDays(days: unknown): string[] {
  if (!Array.isArray(days)) return [];
  return DAYS.filter((d) => days.includes(d));
}

/** Mirrors worker/time_of_day.py derive_band: nearest band time by absolute clock-minute
 *  distance, NO midnight wraparound, ties to the earlier band. Kept identical so the label
 *  the form prints can never disagree with the slot the worker actually fills. */
export function deriveBand(time: string, bandTimes: Record<string, string>): Band {
  const at = minutesOf(time) ?? 0;
  let best: Band = BAND_ORDER[0];
  let bestDistance: number | null = null;
  for (const band of BAND_ORDER) {
    const target = minutesOf(bandTimes[band]) ?? 0;
    const distance = Math.abs(at - target);
    if (bestDistance === null || distance < bestDistance) {
      bestDistance = distance;
      best = band;
    }
  }
  return best;
}

export function parseCadence(raw: string | null): Cadence {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw || "");
  } catch {
    return DEFAULT;
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return DEFAULT;

  if (cfg.mode === "interval") {
    const window = (cfg.window ?? {}) as Record<string, string>;
    return {
      mode: "interval",
      everyMinutes: Number(cfg.every_minutes) > 0 ? Number(cfg.every_minutes) : 1440,
      from: minutesOf(window.from) === null ? "00:00" : window.from,
      to: minutesOf(window.to) === null ? "23:59" : window.to,
      days: "days" in cfg ? cleanDays(cfg.days) : [...DAYS],
    };
  }

  if (Array.isArray(cfg.slots)) {
    const slots = (cfg.slots as Record<string, unknown>[])
      .filter((s) => s && minutesOf(s.time as string) !== null)
      .map((s) => ({ time: s.time as string, days: cleanDays(s.days) }));
    return slots.length ? { mode: "times", slots } : DEFAULT;
  }

  // The two shapes that predate per-time days: every time shares one day list.
  const shared = cleanDays(cfg.days);
  const times = Array.isArray(cfg.times) && cfg.times.length
    ? (cfg.times as string[])
    : cfg.time
      ? [cfg.time as string]
      : ["18:00"];
  return {
    mode: "times",
    slots: times
      .filter((t) => minutesOf(t) !== null)
      .map((t) => ({ time: t, days: [...shared] })),
  };
}

export function serializeCadence(c: Cadence): string {
  if (c.mode === "interval") {
    return JSON.stringify({
      mode: "interval",
      every_minutes: c.everyMinutes,
      window: { from: c.from, to: c.to },
      days: c.days,
    });
  }
  return JSON.stringify({
    mode: "times",
    slots: [...c.slots]
      .filter((s) => minutesOf(s.time) !== null)
      .sort((a, b) => (minutesOf(a.time) ?? 0) - (minutesOf(b.time) ?? 0)),
  });
}

/** Which bands a slot from this cadence could land in — the slot times in times mode, every
 *  minute of the window in interval mode (the send time drifts, so all of it is reachable).
 *  Mirrors Cadence.candidate_local_times() in worker/scheduling.py. */
export function coveredBands(c: Cadence, bandTimes: Record<string, string>): Set<string> {
  const out = new Set<string>();
  if (c.mode === "times") {
    for (const slot of c.slots) {
      if (slot.days.length) out.add(deriveBand(slot.time, bandTimes));
    }
    return out;
  }
  const start = minutesOf(c.from) ?? 0;
  const end = minutesOf(c.to) ?? 1439;
  const minutes = start <= end
    ? Array.from({ length: end - start + 1 }, (_, i) => start + i)
    : [
        ...Array.from({ length: 1440 - start }, (_, i) => start + i),
        ...Array.from({ length: end + 1 }, (_, i) => i),
      ];
  for (const m of minutes) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    out.add(deriveBand(hhmm, bandTimes));
  }
  return out;
}

function labelDays(days: string[]): string {
  if (days.length === 7) return "daily";
  if (!days.length) return "no days";
  return DAYS.filter((d) => days.includes(d))
    .map((d) => d[0].toUpperCase() + d.slice(1))
    .join("/");
}

export function summarize(c: Cadence): string {
  if (c.mode === "interval") {
    const h = Math.floor(c.everyMinutes / 60);
    const m = c.everyMinutes % 60;
    return `Every ${h}h ${m}m, ${c.from}–${c.to}, ${labelDays(c.days)}`;
  }
  return [...c.slots]
    .sort((a, b) => (minutesOf(a.time) ?? 0) - (minutesOf(b.time) ?? 0))
    .map((s) => `${s.time} ${labelDays(s.days)}`)
    .join(", ");
}
```

- [ ] **Step 4: Rewrite `dashboard/components/autofill-config.tsx`**

Replace the local `parseCadence` (lines 23-37) with the import from `@/lib/cadence`. Add `bandTimes: Record<string, string>` and `bandCounts: Record<string, number>` to `Props`. State becomes a single `cadence` object plus the existing depth/reuse/BPP fields.

Render, in order:

1. **Mode switch** — two radios, `At set times` / `Every…`. Switching keeps the other mode's state in memory so a mis-click is recoverable; only Save commits.
2. **Times panel** — one row per slot: `<input type="time">`, the derived band as read-only text, seven day toggles reusing the existing `toggleDay` button styling, and a `×` that is hidden when only one slot remains. `+ Add a time` appends `{ time: "12:00", days: [...lastRow.days] }`.
3. **Interval panel** — two number inputs (hours, minutes), two `<input type="time">` for the window, one day-toggle row. Reject a total under 15 minutes by clamping on blur and showing `Minimum 15 minutes.` Below the inputs show the drift explainer; when `everyMinutes % 1440 === 0` show instead: *"A whole number of days — this always lands at the same time. Use 'At set times' unless you meant to drift."*
4. **Coverage warning** — for each band in `bandCounts` with a count > 0 that is not in `coveredBands(cadence, bandTimes)`, render in `text-status-publishing`: `⚠ {n} ready posts are tagged {band} — no {band} time set, so they will not be auto-filled.`
5. The existing depth / reuse / BPP fields and the BPP explainer, unchanged.

`save()` sends `cadence_config: serializeCadence(cadence)`; every other field in the PATCH body is unchanged. The summary line becomes `summarize(cadence)` plus the existing `· keep ≥N, fill to M`.

Delete the "Time-of-day tags are ignored while more than one time is set" paragraph (lines 171-177) — it documents the behaviour this work removes.

- [ ] **Step 5: Run the tests and lint**

```bash
cd dashboard && npm test && npm run lint
```

Expected: tests PASS, 0 lint errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/cadence.ts dashboard/lib/cadence.test.ts dashboard/components/autofill-config.tsx
git commit -m "feat(autofill): set days per posting time, or drift on an interval"
```

---

## Task 10: Verify in a browser, against a scratch database

**Files:**
- Modify: `docs/tasks.md`

**Interfaces:** none — this task ships nothing but proof.

**Why a scratch DB:** this form writes the cadence the live install actually posts on. A bad save is not a rendering bug, it is a change to what goes out. Per `verify-ui-against-scratch-db`, `process.env` beats `.env`, so pointing a second dev server at a copy is enough.

- [ ] **Step 1: Take a consistent copy of the live database**

```bash
sqlite3 "data/socialscheduler.db" ".backup '/tmp/scratch-autofill.db'"
```

Use `.backup`, never `cp` — a plain copy of a WAL database can be a torn read.

- [ ] **Step 2: Start a dev server against the copy on port 3940**

```bash
cd dashboard && DATABASE_PATH=/tmp/scratch-autofill.db npx next dev -p 3940
```

- [ ] **Step 3: Verify the times mode**

Open `http://localhost:3940/channels`. On the *Liparoto Meta* group's auto-fill:
- It opens in **At set times** with one row, `12:30`, all seven days — the live config, read through the legacy shape.
- The row shows the band **afternoon**.
- The coverage warning reads **17 ready posts are tagged evening**.
- Add a time; it appears as `12:00` with all seven days copied from the row above.
- Set it to `18:00`; its band label becomes **evening** and the evening warning disappears.
- Uncheck Mon–Fri on the 18:00 row; the summary reads `12:30 daily, 18:00 Sat/Sun`.
- Save, reload, and confirm it round-trips.

- [ ] **Step 4: Verify the interval mode**

Switch to **Every…**; set `9` h `45` m, window `08:00`–`21:00`, all days. Confirm the drift explainer appears, the summary reads `Every 9h 45m, 08:00–21:00, daily`, and no coverage warning shows (the window spans all three bands). Set the window to `08:00`–`12:00` and confirm the evening warning returns. Set the interval to `24` h `0` m and confirm the whole-days note appears. Try `0` h `5` m and confirm it clamps to 15 minutes. Save and reload.

- [ ] **Step 5: Prove the worker agrees with the form**

Against the same scratch copy, run one auto-fill cycle and read back what it scheduled:

```bash
source .venv/bin/activate && DATABASE_PATH=/tmp/scratch-autofill.db DRY_RUN=1 python -m worker.run --once
```

`--once` processes one batch and exits (`worker/run.py:277`), so this never starts a daemon. Confirm in the log that the held-back line names the evening posts when the cadence is 12:30-only, and that it disappears once an 18:00 time is saved.

`worker/run.py:258` refuses to start when another instance holds the lock, so stop the live worker first or expect this step to exit immediately.

- [ ] **Step 6: Take a screenshot of each mode**

Capture both panels for the commit message and to show the owner.

- [ ] **Step 7: Stop the scratch server and delete the copy**

```bash
rm -f /tmp/scratch-autofill.db /tmp/scratch-autofill.db-wal /tmp/scratch-autofill.db-shm
```

- [ ] **Step 8: Run every suite once more**

```bash
source .venv/bin/activate && pytest worker/tests/ -q && cd dashboard && npm test && npm run lint
```

Expected: worker and dashboard suites fully green, 0 lint errors. Record the counts.

- [ ] **Step 9: Update `docs/tasks.md`**

Add a section for this work, matching the file's existing format, marking every phase complete and noting the browser verification and the test counts.

- [ ] **Step 10: Commit**

```bash
git add docs/tasks.md
git commit -m "docs: record the cadence rework and how it was verified"
```

- [ ] **Step 11: Restart the live worker**

A live heartbeat proves the daemon is running, **not** that it is running this code. Restart it, then confirm from the log that the running process is the new one.

- [ ] **Step 12: Tell the owner the one action they need to take**

Add an **18:00** time to the *Liparoto Meta* group's auto-fill. Until they do, 18 posts (17 `evening`, 1 `morning`) stay out of rotation while the queue goes on looking healthy, because 89 untagged posts keep filling it.

---

## Self-Review Notes

- **Spec coverage:** §2 rule → Tasks 1, 6, 7. §3 cadence shape → Task 2. §4 derivation → Task 1. §5 matching, lazy generation, early exit, uncapped fetch → Tasks 4, 6, 7. §6 generator → Tasks 4, 5. §7 stall guard → Task 7 (log) and Tasks 8, 9 (warning). §8 form → Task 9. §9 BPP two-pass → Task 7. §10 files → all. §11 testing → every task. §12 interval → Tasks 3, 5, 9. §13 after-it-ships → Task 10 Step 12.
- **Naming consistency:** `parse_cadence` / `iter_slots` / `Cadence` / `candidate_local_times` / `derive_band` / `post_allows_band` / `_assign` / `_stranded_by_band` are used identically in every task that mentions them. The TypeScript mirror deliberately uses camelCase (`parseCadence`, `deriveBand`, `coveredBands`) and is a separate implementation, not an import.
- **Deliberate stubs:** Task 2 stubs `_parse_interval` and Task 4 stubs `_iter_interval_slots`, each filled by the next task. Both are named in the task that creates them and in the task that replaces them, so neither can be left behind.
