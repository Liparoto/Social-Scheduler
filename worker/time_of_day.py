"""Time-of-day bands: resolve a post's time_of_day tag(s) into a clock time.

A post's slot TIME comes from its time_of_day tag; its slot DAY comes from the
channel cadence (see autofill). morning/afternoon/evening map to configured clock
times; `anytime` (and no time_of_day tag at all) fall back to the channel's own
cadence time. When several specific bands are present, the earliest wins.
"""

from __future__ import annotations

# Earliest -> latest. Only the specific bands; `anytime` is intentionally absent
# because it means "no specific time" and defers to the channel cadence time.
BAND_ORDER = ("morning", "afternoon", "evening")
VALID_BANDS = ("morning", "afternoon", "evening", "anytime")


def parse_hhmm(value: str) -> tuple[int, int]:
    """Parse 'HH:MM' -> (hour, minute); raise ValueError if out of range."""
    hh, mm = (int(x) for x in value.split(":"))
    if not (0 <= hh < 24 and 0 <= mm < 60):
        raise ValueError(f"bad time {value!r}")
    return hh, mm


def band_times(config) -> dict[str, tuple[int, int]]:
    """The three specific bands mapped to (hour, minute) from config."""
    return {
        "morning": parse_hhmm(config.tod_morning),
        "afternoon": parse_hhmm(config.tod_afternoon),
        "evening": parse_hhmm(config.tod_evening),
    }


def post_bands(conn, post_id: int) -> set[str]:
    """The set of time_of_day tag names attached to a post (may be empty)."""
    rows = conn.execute(
        """SELECT t.name AS name
             FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = ? AND t.kind = 'time_of_day'""",
        (post_id,),
    ).fetchall()
    return {r["name"] for r in rows}


def resolve_slot_time(
    bands: set[str],
    band_times_map: dict[str, tuple[int, int]],
    cadence_hm: tuple[int, int],
) -> tuple[int, int]:
    """Earliest specific band wins; anytime/none -> the channel cadence time."""
    for b in BAND_ORDER:
        if b in bands:
            return band_times_map[b]
    return cadence_hm


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
