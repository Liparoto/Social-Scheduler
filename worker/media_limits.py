"""Per-platform, per-surface media limits, read from dashboard/media-limits.json.

That file is shared with the dashboard on purpose. Hand-mirroring ~100 numbers across
two languages is the drift bug waiting to happen: the composer would say a send is fine,
the worker would refuse it, and nobody would learn why until a post failed. One file
makes that impossible rather than merely discouraged. Same reasoning the schema lives in
/migrations - it is a fact about the platform, owned by neither language.

The file lives under dashboard/, not the repo root, even though the worker (here) reads
it too. That is backwards-looking on purpose: Turbopack — the bundler that serves the
dashboard's "use client" components — refuses to bundle an import from outside its own
project root. Widening its root (turbopack.root) was tried and rejected on 2026-08-24:
it built, but pulled the 1.6GB data/ asset store into the build's file-trace manifest.
A checked-in generated copy under dashboard/ was rejected too — two files that must be
kept in sync is the exact drift this design exists to eliminate. So the worker reaches
INTO dashboard/ instead. One awkwardly-placed file beats either alternative.

ABSENT MEANS NOT ENFORCED. A limit we cannot verify is omitted, never guessed. See the
spec's Principle section: a wrong number that refuses valid media is worse than no check,
because the platform itself is always the backstop.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

# worker/media_limits.py -> worker/ -> repo root -> dashboard/media-limits.json.
# See the module docstring for why this reaches into dashboard/ instead of the reverse.
RAW_PATH = Path(__file__).resolve().parent.parent / "dashboard" / "media-limits.json"


class MediaLimitsError(Exception):
    """The limits file is missing, malformed, or fails its schema check.

    Raised loudly and never swallowed: a broken config must not degrade into "allow
    everything", which would silently disable every media check in the app.
    """


@dataclass(frozen=True)
class Violation:
    kind: str      # too_short | too_long | too_small | too_large | wrong_aspect | wrong_format
    message: str   # a human sentence, safe to show in the UI
    severity: str  # "refuse" | "warn"


_NUMERIC = (
    "min_duration_ms", "max_duration_ms",
    "min_width", "min_height", "max_width", "max_height",
    "max_bytes",
)
_KNOWN = set(_NUMERIC) | {"min_aspect", "max_aspect", "formats", "note", "varies"}
_KNOWN_TOP_LEVEL = {"schema_version", "platforms", "_comment"}


@lru_cache(maxsize=1)
def load_limits() -> dict:
    try:
        raw = json.loads(RAW_PATH.read_text())
    except FileNotFoundError as exc:
        raise MediaLimitsError(f"media-limits.json not found at {RAW_PATH}") from exc
    except ValueError as exc:
        raise MediaLimitsError(f"media-limits.json is not valid JSON: {exc}") from exc

    if raw.get("schema_version") != 1:
        raise MediaLimitsError(f"unsupported schema_version {raw.get('schema_version')!r}")

    # The top level gets the same scrutiny as every entry below it. A typo here (e.g.
    # "paltforms") would otherwise load with zero exceptions and silently enforce
    # nothing — exactly the "malformed degrades into allow everything" outcome
    # Principle #2 forbids. An EMPTY platforms dict is legal (this file starts with
    # just Facebook and grows); only the wrong TYPE or a missing key is an error.
    unknown_top = set(raw) - _KNOWN_TOP_LEVEL
    if unknown_top:
        raise MediaLimitsError(f"media-limits.json has unrecognised top-level key(s): {sorted(unknown_top)}")
    if "platforms" not in raw:
        raise MediaLimitsError("media-limits.json has no 'platforms' key")
    if not isinstance(raw["platforms"], dict):
        raise MediaLimitsError("media-limits.json's 'platforms' must be an object")

    for platform, surfaces in raw.get("platforms", {}).items():
        for surface, kinds in surfaces.items():
            for kind, entry in kinds.items():
                where = f"{platform}.{surface}.{kind}"
                if not entry.get("note"):
                    raise MediaLimitsError(f"{where} has no note")
                unknown = set(entry) - _KNOWN
                if unknown:
                    raise MediaLimitsError(f"{where} has unrecognised field(s): {sorted(unknown)}")
                for field in ("min_aspect", "max_aspect"):
                    pair = entry.get(field)
                    if pair is not None and not (
                        isinstance(pair, list) and len(pair) == 2
                        and all(isinstance(n, int) and n > 0 for n in pair)
                    ):
                        raise MediaLimitsError(f"{where}.{field} must be [w, h] positive integers")
    return raw


def limits_for(platform: str, surface: str, media_kind: str) -> dict | None:
    """The recorded limits, or None when nothing is recorded — which means NOT ENFORCED."""
    return (
        load_limits()
        .get("platforms", {})
        .get(platform, {})
        .get(surface, {})
        .get(media_kind)
    )


def _get(asset, key):
    """Assets arrive as sqlite3.Row (no .get) or as plain dicts in tests."""
    if hasattr(asset, "keys"):
        return asset[key] if key in asset.keys() else None
    return asset.get(key)


def check(platform: str, surface: str, asset) -> list[Violation]:
    """Every limit this asset violates for this destination. Empty means publishable."""
    kind = _get(asset, "media_kind")
    entry = limits_for(platform, surface, kind)
    if entry is None:
        return []
    # A limit that VARIES by account (Discord's, which depends on Nitro tier and server
    # boost) can never be enforced honestly — it warns instead, so the send still happens.
    severity = "warn" if entry.get("varies") else "refuse"

    out: list[Violation] = []
    duration = _get(asset, "duration_ms")
    width, height = _get(asset, "width"), _get(asset, "height")
    size = _get(asset, "byte_size")

    # Every check below is guarded on the value being KNOWN. Unknown metadata must never
    # refuse: assets predating the video pipeline carry no duration at all.
    if duration is not None:
        lo, hi = entry.get("min_duration_ms"), entry.get("max_duration_ms")
        if lo is not None and duration < lo:
            out.append(Violation("too_short", f"shorter than {lo / 1000:g}s", severity))
        if hi is not None and duration > hi:
            out.append(Violation("too_long", f"longer than {hi / 1000:g}s", severity))

    # `is not None`, not truthiness: this file's whole purpose is that the two
    # languages cannot diverge, and the TypeScript side already guards on `!= null`.
    # A cosmetic `if width and height:` here would be a guard-style mismatch sitting
    # inside the one file that exists to prevent exactly that kind of drift.
    if width is not None and height is not None:
        mw, mh = entry.get("min_width"), entry.get("min_height")
        if (mw is not None and width < mw) or (mh is not None and height < mh):
            out.append(Violation(
                "too_small", f"smaller than {mw or '?'}x{mh or '?'}", severity
            ))
        xw, xh = entry.get("max_width"), entry.get("max_height")
        if (xw is not None and width > xw) or (xh is not None and height > xh):
            out.append(Violation(
                "too_large", f"larger than {xw or '?'}x{xh or '?'}", severity
            ))
        # Fraction, not float: a decimal comparison can exclude exactly 16:9 by rounding,
        # and 16:9 is a ratio Meta explicitly permits. Bounds are INCLUSIVE.
        ratio = Fraction(width, height)
        lo_a, hi_a = entry.get("min_aspect"), entry.get("max_aspect")
        if (lo_a is not None and ratio < Fraction(*lo_a)) or (
            hi_a is not None and ratio > Fraction(*hi_a)
        ):
            out.append(Violation("wrong_aspect", f"aspect ratio {width}x{height}", severity))

    if size is not None and entry.get("max_bytes") is not None and size > entry["max_bytes"]:
        out.append(Violation("too_large", f"larger than {entry['max_bytes']} bytes", severity))

    return out
