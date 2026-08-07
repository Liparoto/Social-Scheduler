"""Time-of-day bands: which slots a post's time_of_day tag(s) permit.

A cadence TIME carries a band (`derive_band`), and a post's tags say which bands it will
accept (`post_allows_band`). morning/afternoon/evening are the specific bands; `anytime` (and
no time_of_day tag at all) place no constraint, so such a post fits any slot.
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
