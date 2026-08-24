# Media-vs-Destination Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app offering a destination that cannot publish the attached media, and stop it refusing media that some destination *could* publish.

**Architecture:** One `media-limits.json` at the repo root holds every platform's per-surface media limits. A Python loader and a TypeScript loader read that same file, so the worker and the dashboard cannot disagree. Three checkpoints consume it: the upload route (refuse only what nothing can take), the composer (grey out a destination with its reason), and `publisher._validate` (terminal backstop).

**Tech Stack:** Python 3.11 worker (`venv`, pytest), Next.js 16 / TypeScript dashboard (`node --test`, Turbopack), SQLite.

**Spec:** `docs/superpowers/specs/2026-08-24-media-limits-design.md`

## Global Constraints

- **Only refuse what we can verify.** A limit that cannot be confirmed from live documentation is OMITTED, and nothing is enforced for it. A guessed number that refuses a valid upload is worse than no check — the platform is always the backstop.
- **Every number is read from live platform docs during implementation**, and its `note` records the source and the date. No number is carried from memory, and none is carried from the spec without re-reading its source.
- **All bounds are inclusive**, everywhere, with no exceptions.
- **Aspect ratios are `[w, h]` integer pairs**, compared as exact fractions — never decimals. Float comparison can exclude exactly 16:9, which Meta explicitly permits.
- **A malformed limits file fails LOUDLY at startup** — worker refuses to start, dashboard fails to build. This is the one place the permissive principle does not apply.
- **Never alter media to fit a limit.** Refuse or warn; trimming and cropping are editorial decisions this app does not make.
- **Stale targets are pruned, not hidden.** A hidden-but-live target has already published wrong media twice on this codebase.
- Worker tests: `.venv/bin/python -m pytest worker/tests/ -q` (from repo root). Dashboard: `cd dashboard && npm test`. Lint `npm run lint` must stay at **0 errors**.
- Baselines at plan time: worker **1067 pass, 0 fail**; dashboard **928 pass**; lint 0 errors; `tsc --noEmit` clean except one pre-existing unrelated error in `lib/queries.tags.test.ts`.

---

# Phase 1 — The shared file and its two loaders

## Task 1: The file format, the Python loader, and the TS bundling proof

**The riskiest unknown in this plan is not the validation logic — it is whether the dashboard can import a JSON file that lives OUTSIDE `dashboard/`.** Settle that first, because every later task depends on it.

Why it is uncertain: `dashboard/components/channel-surface-picker.tsx` is a `"use client"` component, so it cannot read from disk — the data must be bundled. Nothing in the dashboard currently imports from above `dashboard/`. `dashboard/tsconfig.json` maps `@/*` to `./*` (dashboard-relative), its `include` is dashboard-relative, and `dashboard/test/hook.mjs` resolves `@/` against the dashboard root only.

**Files:**
- Create: `media-limits.json` (repo root)
- Create: `worker/media_limits.py`
- Create: `worker/tests/test_media_limits.py`
- Modify: `dashboard/tsconfig.json` (add a `@shared/*` path)
- Modify: `dashboard/test/hook.mjs` and `dashboard/test/ui-hook.mjs` (resolve `@shared/`)

**Interfaces:**
- Produces: `media-limits.json` with the shape below; `worker.media_limits.load_limits()`, `limits_for(platform, surface, media_kind)`, `check(platform, surface, asset)`; a working `@shared/media-limits.json` import specifier for the dashboard.

- [ ] **Step 1: Create the file with exactly two entries**

Only Facebook, because those numbers were read on 2026-08-23 and are already mirrored in `worker/publisher.py`. Every other platform is added in a later task, after its own research. Do NOT invent entries here.

```json
{
  "schema_version": 1,
  "platforms": {
    "facebook": {
      "feed": {
        "video": {
          "max_duration_ms": 1200000,
          "max_bytes": 1073741824,
          "note": "Meta Page video docs read 2026-08-23: <=1GB, <=20 min via file_url, any aspect ratio. Not yet confirmed by a live publish."
        }
      },
      "reel": {
        "video": {
          "min_duration_ms": 3000,
          "max_duration_ms": 90000,
          "min_width": 540,
          "min_height": 960,
          "min_aspect": [9, 16],
          "max_aspect": [16, 9],
          "note": "Meta Reels publishing docs read 2026-08-23. Aspect range INCLUSIVE both ends - 16:9 landscape IS permitted. Mirrors worker/publisher.py's _validate. Not yet confirmed by a live publish."
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing Python tests**

Create `worker/tests/test_media_limits.py`:

```python
"""The shared media-limits file, read from Python.

The point of a shared file is that the worker and the dashboard cannot disagree. These
tests cover THIS side; test_media_limits_agreement.py (Task 2) proves both sides agree.
"""

import json

import pytest

from worker import media_limits


def test_facebook_reel_limits_are_loaded():
    lim = media_limits.limits_for("facebook", "reel", "video")
    assert lim is not None
    assert lim["min_duration_ms"] == 3000
    assert lim["max_duration_ms"] == 90_000


def test_an_unknown_platform_has_no_limits():
    """Absent means NOT ENFORCED — never a guess, never a default."""
    assert media_limits.limits_for("myspace", "feed", "video") is None


def test_a_platform_with_no_entry_for_that_surface_has_no_limits():
    assert media_limits.limits_for("facebook", "story", "video") is None


def test_an_in_spec_reel_has_no_violations():
    asset = {"media_kind": "video", "duration_ms": 30_000, "width": 1080, "height": 1920}
    assert media_limits.check("facebook", "reel", asset) == []


@pytest.mark.parametrize("duration_ms,kind", [
    (2_999, "too_short"),
    (90_001, "too_long"),
])
def test_out_of_spec_duration_is_reported(duration_ms, kind):
    asset = {"media_kind": "video", "duration_ms": duration_ms, "width": 1080, "height": 1920}
    kinds = [v.kind for v in media_limits.check("facebook", "reel", asset)]
    assert kinds == [kind]


@pytest.mark.parametrize("duration_ms", [3_000, 90_000])
def test_the_exact_boundaries_are_ACCEPTED(duration_ms):
    """Inclusive at both ends, per the global constraint. This is the assertion most
    likely to drift between the two languages, which is why it is pinned on both sides."""
    asset = {"media_kind": "video", "duration_ms": duration_ms, "width": 1080, "height": 1920}
    assert media_limits.check("facebook", "reel", asset) == []


def test_exactly_16_by_9_is_ACCEPTED():
    """Meta documents 'between 16:9 and 9:16'. A float comparison can exclude this
    boundary by rounding; exact fractions cannot."""
    asset = {"media_kind": "video", "duration_ms": 30_000, "width": 1920, "height": 1080}
    assert media_limits.check("facebook", "reel", asset) == []


def test_ultrawide_is_refused():
    asset = {"media_kind": "video", "duration_ms": 30_000, "width": 2520, "height": 1080}
    kinds = [v.kind for v in media_limits.check("facebook", "reel", asset)]
    assert kinds == ["wrong_aspect"]


def test_unknown_metadata_never_refuses():
    """duration_ms/width/height are NULL for assets predating the video pipeline. The
    platform is the backstop; refusing on 'we don't know' would block valid media."""
    asset = {"media_kind": "video", "duration_ms": None, "width": None, "height": None}
    assert media_limits.check("facebook", "reel", asset) == []


def test_every_entry_carries_a_note():
    """A number with no recorded source is a number nobody can re-verify later."""
    raw = json.loads(media_limits.RAW_PATH.read_text())
    for platform, surfaces in raw["platforms"].items():
        for surface, kinds in surfaces.items():
            for kind, entry in kinds.items():
                assert entry.get("note"), f"{platform}.{surface}.{kind} has no note"


def test_a_malformed_file_fails_loudly(tmp_path, monkeypatch):
    """A broken config is a bug, not a platform fact. It must NEVER degrade into
    'allow everything' — that would silently disable every check in the app."""
    bad = tmp_path / "bad.json"
    bad.write_text("{ not json")
    monkeypatch.setattr(media_limits, "RAW_PATH", bad)
    media_limits.load_limits.cache_clear()
    with pytest.raises(media_limits.MediaLimitsError):
        media_limits.load_limits()
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_media_limits.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.media_limits'`

- [ ] **Step 4: Implement the Python loader**

Create `worker/media_limits.py`:

```python
"""Per-platform, per-surface media limits, read from the repo-root media-limits.json.

That file is shared with the dashboard on purpose. Hand-mirroring ~100 numbers across
two languages is the drift bug waiting to happen: the composer would say a send is fine,
the worker would refuse it, and nobody would learn why until a post failed. One file
makes that impossible rather than merely discouraged. Same reasoning the schema lives in
/migrations - it is a fact about the platform, owned by neither language.

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

# Repo root: worker/media_limits.py -> worker/ -> repo root.
RAW_PATH = Path(__file__).resolve().parent.parent / "media-limits.json"


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

    if width and height:
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
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `.venv/bin/python -m pytest worker/tests/test_media_limits.py -q`
Expected: PASS (12 tests).

- [ ] **Step 6: Prove the dashboard can import the file — THE RISKY PART**

Add to `dashboard/tsconfig.json`'s `paths`:

```json
"paths": {
  "@/*": ["./*"],
  "@shared/*": ["../*"]
}
```

Add to BOTH `dashboard/test/hook.mjs` and `dashboard/test/ui-hook.mjs`, inside the `resolve` hook, immediately after the existing `@/` branch:

```js
    // "@shared/..." reaches OUT of dashboard/ to the repo root, where media-limits.json
    // lives. It is deliberately shared with the Python worker (see the file's own note),
    // so it cannot live inside dashboard/ without one language owning a fact neither
    // should own. This is the only specifier that escapes the dashboard root.
    if (spec.startsWith("@shared/")) {
      const repoRoot = new URL("../../", import.meta.url);
      return next(new URL(spec.slice("@shared/".length), repoRoot).href, ctx);
    }
```

Then prove it loads in ALL THREE contexts, because each uses a different resolver:

```bash
cd dashboard
# 1. Node's ESM resolver (npm test)
node --import ./test/hook.mjs -e 'import("@shared/media-limits.json", {with:{type:"json"}}).then(m => console.log("node ok:", m.default.schema_version))'
# 2. TypeScript
npx tsc --noEmit
# 3. Turbopack (the bundler that serves the client component)
npm run build 2>&1 | tail -20
```

Expected: all three succeed.

**If the bundler step fails**, STOP and report rather than working around it. The documented fallback is to keep `media-limits.json` at the repo root as the source of truth and add a checked-in generated copy under `dashboard/lib/`, with a test that fails when the two differ — but do not take that path unless the alias genuinely does not work, because a generated copy reintroduces the drift risk this whole design exists to remove.

- [ ] **Step 7: Commit**

```bash
git add media-limits.json worker/media_limits.py worker/tests/test_media_limits.py dashboard/tsconfig.json dashboard/test/hook.mjs dashboard/test/ui-hook.mjs
git commit -m "feat(limits): shared media-limits.json and the Python loader

One file read by both languages, because hand-mirroring ~100 numbers is
the drift bug waiting to happen. Absent means not enforced; a malformed
file fails loudly rather than silently allowing everything."
```

---

## Task 2: The TypeScript loader and the cross-language agreement test

**Files:**
- Create: `dashboard/lib/media-limits.ts`
- Create: `dashboard/lib/media-limits.test.ts`
- Create: `worker/tests/test_media_limits_agreement.py`
- Create: `dashboard/lib/media-limits-matrix.json` (the shared test matrix)

**Interfaces:**
- Consumes: `@shared/media-limits.json` (Task 1), `worker.media_limits.check` (Task 1).
- Produces: `limitsFor(platform, surface, mediaKind)`, `checkMedia(platform, surface, asset)` returning `Violation[]` with `{kind, message, severity}` — the SAME `kind` strings the Python side uses.

- [ ] **Step 1: Write the shared matrix**

Create `dashboard/lib/media-limits-matrix.json`. Both languages read it, so a case added here is automatically covered on both sides:

```json
{
  "cases": [
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 30000, "width": 1080, "height": 1920}, "expect": []},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 3000, "width": 1080, "height": 1920}, "expect": []},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 90000, "width": 1080, "height": 1920}, "expect": []},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 2999, "width": 1080, "height": 1920}, "expect": ["too_short"]},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 90001, "width": 1080, "height": 1920}, "expect": ["too_long"]},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 30000, "width": 1920, "height": 1080}, "expect": []},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 30000, "width": 2520, "height": 1080}, "expect": ["wrong_aspect"]},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": 30000, "width": 480, "height": 640}, "expect": ["too_small", "wrong_aspect"]},
    {"platform": "facebook", "surface": "reel", "asset": {"media_kind": "video", "duration_ms": null, "width": null, "height": null}, "expect": []},
    {"platform": "facebook", "surface": "feed", "asset": {"media_kind": "video", "duration_ms": 1080000, "width": 1920, "height": 1080}, "expect": []},
    {"platform": "facebook", "surface": "feed", "asset": {"media_kind": "video", "duration_ms": 1200001, "width": 1920, "height": 1080}, "expect": ["too_long"]},
    {"platform": "myspace", "surface": "feed", "asset": {"media_kind": "video", "duration_ms": 30000, "width": 1080, "height": 1920}, "expect": []}
  ]
}
```

- [ ] **Step 2: Write the failing TS tests**

Create `dashboard/lib/media-limits.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsFor, checkMedia } from "./media-limits.ts";
import matrix from "./media-limits-matrix.json" with { type: "json" };

test("facebook reel limits load from the shared file", () => {
  const lim = limitsFor("facebook", "reel", "video");
  assert.equal(lim?.min_duration_ms, 3000);
  assert.equal(lim?.max_duration_ms, 90000);
});

test("an unknown platform has no limits — absent means NOT ENFORCED", () => {
  assert.equal(limitsFor("myspace", "feed", "video"), null);
});

test("unknown metadata never refuses", () => {
  const asset = { media_kind: "video", duration_ms: null, width: null, height: null };
  assert.deepEqual(checkMedia("facebook", "reel", asset), []);
});

// The whole point of the shared file: this matrix is the SAME file the Python side
// reads in test_media_limits_agreement.py. A case added here is covered on both sides.
for (const [i, c] of matrix.cases.entries()) {
  test(`matrix case ${i}: ${c.platform}/${c.surface}`, () => {
    const got = checkMedia(c.platform, c.surface, c.asset).map((v) => v.kind).sort();
    assert.deepEqual(got, [...c.expect].sort());
  });
}
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd dashboard && npm test`
Expected: FAIL — `./media-limits.ts` does not exist.

- [ ] **Step 4: Implement the TS loader**

Create `dashboard/lib/media-limits.ts`:

```ts
/**
 * Per-platform, per-surface media limits — the SAME media-limits.json the Python worker
 * reads (worker/media_limits.py). Not a mirror: one file, two readers. That is the whole
 * point — a hand-maintained copy of ~100 numbers drifts, and a drifted number is silent
 * in the worst way (the composer says fine, the worker refuses).
 *
 * ABSENT MEANS NOT ENFORCED. A limit we cannot verify is omitted, never guessed.
 *
 * Imported rather than read from disk because the composer is a "use client" component
 * and has no filesystem. @shared/ is the only specifier in this app that reaches above
 * dashboard/ (see tsconfig paths and test/hook.mjs).
 */
import raw from "@shared/media-limits.json" with { type: "json" };

export type Violation = {
  kind: "too_short" | "too_long" | "too_small" | "too_large" | "wrong_aspect" | "wrong_format";
  message: string;
  severity: "refuse" | "warn";
};

type Entry = {
  min_duration_ms?: number; max_duration_ms?: number;
  min_width?: number; min_height?: number;
  max_width?: number; max_height?: number;
  min_aspect?: [number, number]; max_aspect?: [number, number];
  max_bytes?: number; formats?: string[];
  note: string; varies?: string;
};

type AssetLike = {
  media_kind?: string | null;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
  byte_size?: number | null;
};

export function limitsFor(platform: string, surface: string, mediaKind: string): Entry | null {
  const p = (raw as any).platforms?.[platform];
  return p?.[surface]?.[mediaKind] ?? null;
}

/** Cross-multiplied so the comparison is exact. A decimal ratio can exclude 16:9 by
 *  rounding, and 16:9 is a value Meta explicitly permits. Bounds are INCLUSIVE. */
function ratioBelow(w: number, h: number, [aw, ah]: [number, number]): boolean {
  return w * ah < aw * h;
}
function ratioAbove(w: number, h: number, [aw, ah]: [number, number]): boolean {
  return w * ah > aw * h;
}

export function checkMedia(platform: string, surface: string, asset: AssetLike): Violation[] {
  const entry = limitsFor(platform, surface, asset.media_kind ?? "");
  if (!entry) return [];
  // A limit that VARIES by account can never be enforced honestly — warn, never refuse.
  const severity: Violation["severity"] = entry.varies ? "warn" : "refuse";
  const out: Violation[] = [];

  // Every check is guarded on the value being KNOWN. Unknown metadata must never refuse:
  // assets predating the video pipeline carry no duration at all.
  const d = asset.duration_ms;
  if (d != null) {
    if (entry.min_duration_ms != null && d < entry.min_duration_ms) {
      out.push({ kind: "too_short", message: `shorter than ${entry.min_duration_ms / 1000}s`, severity });
    }
    if (entry.max_duration_ms != null && d > entry.max_duration_ms) {
      out.push({ kind: "too_long", message: `longer than ${entry.max_duration_ms / 1000}s`, severity });
    }
  }

  const w = asset.width, h = asset.height;
  if (w && h) {
    if ((entry.min_width != null && w < entry.min_width) ||
        (entry.min_height != null && h < entry.min_height)) {
      out.push({ kind: "too_small", message: `smaller than ${entry.min_width ?? "?"}x${entry.min_height ?? "?"}`, severity });
    }
    if ((entry.max_width != null && w > entry.max_width) ||
        (entry.max_height != null && h > entry.max_height)) {
      out.push({ kind: "too_large", message: `larger than ${entry.max_width ?? "?"}x${entry.max_height ?? "?"}`, severity });
    }
    if ((entry.min_aspect && ratioBelow(w, h, entry.min_aspect)) ||
        (entry.max_aspect && ratioAbove(w, h, entry.max_aspect))) {
      out.push({ kind: "wrong_aspect", message: `aspect ratio ${w}x${h}`, severity });
    }
  }

  const b = asset.byte_size;
  if (b != null && entry.max_bytes != null && b > entry.max_bytes) {
    out.push({ kind: "too_large", message: `larger than ${entry.max_bytes} bytes`, severity });
  }

  return out;
}
```

- [ ] **Step 5: Write the Python half of the agreement test**

Create `worker/tests/test_media_limits_agreement.py`:

```python
"""Both languages, one matrix, identical verdicts.

This is the payoff of the shared file. Before it, the composer and the worker could
disagree about whether a send was publishable and nobody found out until it failed.
Here, disagreement is a failing test.
"""

import json
from pathlib import Path

import pytest

from worker import media_limits

MATRIX = Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "media-limits-matrix.json"


def _cases():
    return json.loads(MATRIX.read_text())["cases"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: f"{c['platform']}/{c['surface']}")
def test_python_matches_the_shared_matrix(case):
    got = sorted(v.kind for v in media_limits.check(case["platform"], case["surface"], case["asset"]))
    assert got == sorted(case["expect"])
```

- [ ] **Step 6: Run both suites**

Run: `cd dashboard && npm test` then `.venv/bin/python -m pytest worker/tests/ -q`
Expected: both PASS. The 12 matrix cases run on both sides.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/media-limits.ts dashboard/lib/media-limits.test.ts dashboard/lib/media-limits-matrix.json worker/tests/test_media_limits_agreement.py
git commit -m "feat(limits): TypeScript loader and the cross-language agreement test

One matrix, both languages, identical verdicts. Disagreement between the
composer and the worker is now a failing test rather than a failed post."
```

---

**PHASE 1 CHECKPOINT.** Both loaders read one file and agree. Nothing consumes them yet, so no behaviour has changed. Confirm both suites green before Phase 2.

---

# Phase 2 — Instagram (the reported bug)

## Task 3: Research and record Instagram's limits

**This task is mostly reading, not coding — and the reading is the deliverable.** The owner's actual bug is that an Instagram Story has no duration check. Do not write a number you have not read today from Meta's own documentation.

**Files:**
- Modify: `media-limits.json`
- Modify: `reference.md`

- [ ] **Step 1: Read the live documentation**

Start at Meta's Instagram Platform reference for publishing — the `#reels-specs` section of the IG User Media reference is what `dashboard/lib/video-spec.ts` cites, and that file's header records it was verified 2026-07-28. Find, for each:

- **Reels / feed video:** min and max duration, max file size, aspect-ratio range, max width, frame rate, formats
- **Stories (video):** max duration, file size, resolution
- **Feed images:** max file size, aspect-ratio range, formats

Record the URL and today's date for each number you find.

**Write down what you could NOT find.** That list is as important as the numbers — it decides which fields stay absent.

- [ ] **Step 2: Add Instagram to `media-limits.json`**

Add entries ONLY for what you verified. Every entry needs a `note` naming the source and the date. A limit you could not confirm is OMITTED — not guessed, not copied from `video-spec.ts` without re-reading its source.

Known starting point, to be re-confirmed rather than trusted: `dashboard/lib/video-spec.ts`'s `REEL_SPEC` records 300 MB, 3 s minimum, 15 minutes maximum, 1920 px max width, verified 2026-07-28. Its header explicitly warns that widely-circulated third-party guides claiming a 90-second maximum and a 4 GB cap are WRONG. Do not "correct" it from memory.

- [ ] **Step 3: Add the Instagram cases to the shared matrix**

Add cases to `dashboard/lib/media-limits-matrix.json` for every limit you recorded, including both inclusive boundaries. Follow the existing case shape exactly.

- [ ] **Step 4: Run both suites**

Run: `cd dashboard && npm test` and `.venv/bin/python -m pytest worker/tests/ -q`
Expected: PASS, with the new Instagram matrix cases running on both sides.

- [ ] **Step 5: Record what you found in `reference.md`**

Add an Instagram media-specs section following the convention of the existing "Facebook Pages VIDEO publishing" section: the numbers, the source, the date, and an explicit list of what you could NOT verify.

- [ ] **Step 6: Commit**

```bash
git add media-limits.json dashboard/lib/media-limits-matrix.json reference.md
git commit -m "feat(limits): record Instagram's verified media limits

Every number read from Meta's live docs today, with its source in the
note. What could not be verified is absent rather than guessed."
```

---

## Task 4: Wire Instagram into the composer and the worker

**Files:**
- Modify: `dashboard/components/channel-surface-picker.tsx`
- Modify: `worker/publisher.py` (`_validate`)
- Test: `dashboard/test-ui/channel-surface-picker-ui.test.ts`, `worker/tests/test_publisher_validate.py`

**Interfaces:**
- Consumes: `checkMedia` (Task 2), `media_limits.check` (Task 1).
- Produces: `destinationDisabledReason(platform, surface, asset)` in `dashboard/lib/media-limits.ts`, returning a human string or `null`.

- [ ] **Step 1: Write the failing tests**

```ts
test("an over-long video disables the Instagram Story chip", () => {
  const html = render(<ChannelSurfacePicker
    channels={[{ id: 1, platform: "instagram", account_name: "me" }]}
    hasVideo={true}
    assets={[{ width: 1080, height: 1920, duration_ms: 600_000 }]}
    value={[]} onChange={() => {}} />);
  assert.match(html, /Too long for Stories/);
});

test("an in-spec video leaves both Instagram chips enabled", () => {
  const html = render(<ChannelSurfacePicker
    channels={[{ id: 1, platform: "instagram", account_name: "me" }]}
    hasVideo={true}
    assets={[{ width: 1080, height: 1920, duration_ms: 20_000 }]}
    value={[]} onChange={() => {}} />);
  assert.doesNotMatch(html, /Too long/);
});
```

```python
def test_an_over_long_instagram_story_is_refused_terminally():
    with pytest.raises(_NonRetryable, match="Stor"):
        _validate(
            {"post_type": "video"},
            [{"media_kind": "video", "id": 1, "duration_ms": 600_000,
              "width": 1080, "height": 1920}],
            dry_run=True, asset_base_url=None, platform="instagram", surface="story",
        )
```

- [ ] **Step 2: Run to confirm they fail**

Run: `cd dashboard && npm test` and `.venv/bin/python -m pytest worker/tests/test_publisher_validate.py -q`
Expected: FAIL — no Story duration gating exists.

- [ ] **Step 3: Generalize the composer's reason helper**

`dashboard/lib/facebook-reel-spec.ts`'s `facebookReelDisabledReason()` becomes generic. Add to `dashboard/lib/media-limits.ts`:

```ts
/** The reason this destination cannot take this asset, or null when it can.
 *  Only "refuse" violations disable a chip — a "warn" (a limit that varies by account,
 *  like Discord's) is shown but never blocks the send. */
export function destinationDisabledReason(
  platform: string, surface: string, asset: AssetLike,
): string | null {
  const refusals = checkMedia(platform, surface, asset).filter((v) => v.severity === "refuse");
  if (refusals.length === 0) return null;
  const surfaceLabel = surface === "reel" ? "Reels" : surface === "story" ? "Stories" : "the feed";
  const v = refusals[0];
  const lead = v.kind === "too_long" ? "Too long for"
    : v.kind === "too_short" ? "Too short for"
    : v.kind === "too_small" ? "Too small for"
    : v.kind === "too_large" ? "Too large for"
    : "Wrong shape for";
  return `${lead} ${surfaceLabel} (${v.message})`;
}
```

Replace the picker's Facebook-specific call with this one, applied to EVERY surface chip.

- [ ] **Step 4: Replace the worker's Facebook-Reels block with the generic check**

In `worker/publisher.py`'s `_validate`, replace the `platform == "facebook" and surface == "reel"` block with a call that works for any platform and surface:

```python
    # Media limits, per platform AND surface, from the shared media-limits.json that the
    # dashboard reads too (worker/media_limits.py). Checked here rather than left to the
    # platform: an out-of-spec clip comes back as a generic API error that says nothing
    # about duration, and by then the send has already read "scheduled" to the owner.
    # This is the BACKSTOP — the composer greys the destination out first. It still
    # matters, because it catches post_targets rows the UI cannot reach.
    if assets:
        for violation in media_limits.check(platform, surface, assets[0]):
            if violation.severity == "refuse":
                raise _NonRetryable(
                    f"{platform} {surface} cannot publish this media: {violation.message}"
                )
```

Keep the existing surface/post_type guard (`surface == "reel"` requires `post_type == "video"`) — it is not a media limit and is not covered by this.

- [ ] **Step 5: Run both suites**

Run: `cd dashboard && npm test` and `.venv/bin/python -m pytest worker/tests/ -q`
Expected: PASS. The Facebook Reels tests must STILL pass — they now exercise the generic path.

- [ ] **Step 6: Verify in a real browser**

`renderToStaticMarkup` cannot catch handlers or layout. Start the dashboard on port 3940 (3939 is the owner's live install — do not touch it), attach a long video, and confirm the Instagram Story chip is disabled with its reason while Feed stays available. Report what you observed.

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/channel-surface-picker.tsx dashboard/lib/media-limits.ts worker/publisher.py dashboard/test-ui worker/tests
git commit -m "feat(limits): gate every destination on the shared media limits

Closes the reported bug: an over-long video can no longer be sent to an
Instagram Story. The Facebook Reels gate becomes one case of a general rule."
```

---

**PHASE 2 CHECKPOINT.** The owner's reported bug is closed. Both suites green, browser-verified.

---

# Phase 3 — The remaining platforms

## Task 5: Retire `facebook-reel-spec.ts`

**Files:**
- Delete: `dashboard/lib/facebook-reel-spec.ts`, `dashboard/lib/facebook-reel-spec.test.ts`
- Modify: every importer (grep for `facebookReelDisabledReason` and `facebook-reel-spec`)

- [ ] **Step 1: Find every importer**

Run: `grep -rn "facebook-reel-spec\|facebookReelDisabledReason" dashboard --include=*.ts --include=*.tsx | grep -v node_modules`

- [ ] **Step 2: Point them all at `destinationDisabledReason`**

The numbers already moved into `media-limits.json` in Task 1. This step removes the now-duplicate source.

- [ ] **Step 3: Confirm the boundary coverage survived**

`facebook-reel-spec.test.ts` pins the inclusive boundaries (3000 ms, 90000 ms, 540×960, exactly 16:9). Those cases must exist in `media-limits-matrix.json` before this file is deleted — if any is missing, ADD IT FIRST. Deleting a test that pins a boundary, without replacing it, is how a boundary silently moves.

- [ ] **Step 4: Run both suites, then commit**

```bash
cd dashboard && npm test && npm run lint
git add -A dashboard/lib
git commit -m "refactor(limits): retire facebook-reel-spec in favour of the shared file"
```

---

## Task 6: Research and record the remaining platforms

Same discipline as Task 3: read live docs, record source and date, omit what you cannot verify.

**Files:**
- Modify: `media-limits.json`, `dashboard/lib/media-limits-matrix.json`, `reference.md`

- [ ] **Step 1: TikTok**

Research the Content Posting API's video requirements: max file size, min/max duration, formats, resolution, aspect ratio. Note that `https://developers.tiktok.com/doc/content-posting-api-reference-upload-video` was checked on 2026-08-24 and does NOT carry the specs — look at the content-posting guide and the creator-info endpoint, which returns per-creator limits at runtime.

**If TikTok's limits turn out to be per-creator and fetched at runtime, record NOTHING in the file** and note that in `reference.md`. A runtime-fetched limit is not a static fact, and this project's rule against hardcoding a limit the platform will disagree with applies directly.

- [ ] **Step 2: Telegram**

Confirmed on 2026-08-24 from core.telegram.org: **10 MB for a photo uploaded directly, 50 MB for other files**; via URL it is 5 MB and 20 MB. A local Bot API server raises it to 2000 MB. Re-read to confirm, then record — noting that this install uploads bytes directly (`uploads_media_bytes=True` in `PlatformCaps`), so the direct-upload numbers are the ones that apply.

- [ ] **Step 3: Discord**

Confirmed on 2026-08-24: the default moved 25 MiB → 10 MiB in January 2025 and reads as ~20 MB by August 2026, and it **varies by Nitro tier and server boost level**.

Record it with `"max_bytes": null` and a `varies` note, so it WARNS rather than refuses. This is the case the `varies` field exists for.

- [ ] **Step 4: Threads**

This worker publishes images and text to Threads; video is unimplemented (`video_surfaces` is empty). Record image limits only, if you can verify them. Do not add video entries for a path that does not exist.

- [ ] **Step 5: Add matrix cases for everything recorded, run both suites, commit**

```bash
git add media-limits.json dashboard/lib/media-limits-matrix.json reference.md
git commit -m "feat(limits): record TikTok, Telegram, Discord and Threads limits

Discord's varies by Nitro tier and boost, so it warns rather than refuses."
```

---

# Phase 4 — The upload gate and the conform rule

## Task 7: The upload gate stops imposing Instagram's rules

**Files:**
- Modify: `dashboard/app/api/assets/upload/route.ts`
- Test: `dashboard/test/upload-route.test.ts` (create if absent)

**Interfaces:**
- Consumes: `checkMedia` (Task 2).
- Produces: `anyDestinationAccepts(asset): boolean` in `dashboard/lib/media-limits.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test("an 18-minute video uploads — Facebook's feed can take it", () => {
  // 18 minutes is over Instagram's 15-minute cap but under Facebook's 20.
  const asset = { media_kind: "video", duration_ms: 18 * 60 * 1000, width: 1920, height: 1080 };
  assert.equal(anyDestinationAccepts(asset), true);
});

test("a 30-minute video is refused — nothing can take it", () => {
  const asset = { media_kind: "video", duration_ms: 30 * 60 * 1000, width: 1920, height: 1080 };
  assert.equal(anyDestinationAccepts(asset), false);
});
```

- [ ] **Step 2: Implement the union check**

```ts
/** True when SOME platform and surface could publish this. The upload gate's only job:
 *  refuse what nothing can take. Which destination it actually goes to is the composer's
 *  question, and it is the only place the app knows the answer. */
export function anyDestinationAccepts(asset: AssetLike): boolean {
  for (const [platform, surfaces] of Object.entries((raw as any).platforms ?? {})) {
    for (const surface of Object.keys(surfaces as object)) {
      const refusals = checkMedia(platform, surface, asset).filter((v) => v.severity === "refuse");
      if (refusals.length === 0) return true;
    }
  }
  return false;
}
```

- [ ] **Step 3: Replace the Instagram-specific gate in the upload route**

`classifyReelErrors`'s split between `fatal` (too short/long — trimming is an editorial call this app must never make) and `convertible` (too wide/large/wrong container — a re-encode genuinely fixes these) is KEPT. Only the source of the numbers changes: refuse when `anyDestinationAccepts` is false, rather than when Instagram's spec is violated.

- [ ] **Step 4: Run the suites and commit**

```bash
git add dashboard/app/api/assets/upload/route.ts dashboard/lib/media-limits.ts dashboard/test
git commit -m "fix(upload): refuse only media NO destination could publish

An 18-minute video is valid for a Facebook Page feed. Judging every
upload by Instagram's spec rejected media the app can publish."
```

---

## Task 8: Conform only when a conform-requiring destination could accept the asset

**Files:**
- Modify: `dashboard/app/api/assets/upload/route.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("an 18-minute video gets no conformed derivative", () => {
  // It fails every Reels-shaped surface, so a transcode toward those specs is both
  // pointless and a multi-minute waste. It reaches Facebook's feed as the original.
  const asset = { media_kind: "video", duration_ms: 18 * 60 * 1000, width: 3840, height: 2160 };
  assert.equal(needsConformedDerivative(asset), false);
});

test("a 30-second 4K vertical clip still gets one", () => {
  const asset = { media_kind: "video", duration_ms: 30_000, width: 2160, height: 3840 };
  assert.equal(needsConformedDerivative(asset), true);
});
```

- [ ] **Step 2: Implement**

```ts
/** Whether building the Instagram-shaped derivative is worth it: true only when some
 *  destination that NEEDS conformed media could actually accept this asset. */
export function needsConformedDerivative(asset: AssetLike): boolean {
  const CONFORM_REQUIRING: Array<[string, string]> = [
    ["instagram", "feed"], ["instagram", "story"], ["facebook", "reel"],
  ];
  return CONFORM_REQUIRING.some(([p, s]) =>
    checkMedia(p, s, asset).filter((v) => v.severity === "refuse").length === 0
  );
}
```

Gate the transcode in the upload route on this. An asset with no derivative already falls back to the original at publish time (`_resolve_rel`), so nothing downstream changes.

- [ ] **Step 3: Run the suites, verify an upload in the browser, commit**

Upload a long video through the running dashboard on port 3940 and confirm it completes without a long transcode and without a `publish_path`.

```bash
git add dashboard/app/api/assets/upload/route.ts dashboard/lib/media-limits.ts
git commit -m "perf(upload): skip the conform transcode when no destination needs it"
```

---

## Self-review notes

- **Spec coverage:** shared file → Task 1; loaders → Tasks 1-2; agreement test → Task 2; three checkpoints → Tasks 4 (composer, worker) and 7 (upload); conform rule → Task 8; retiring the old sources → Task 5; per-platform research → Tasks 3 and 6.
- **The riskiest step is Task 1 Step 6**, the cross-boundary JSON import. It is deliberately first, with a documented fallback, because every later task depends on it.
- **Deliberately NOT covered:** caption length, asset counts and text-only rules stay in `PlatformCaps`; Facebook Stories has no adapter yet; Threads video is unimplemented.
- **Known weak point:** `destinationDisabledReason` reports only the FIRST refusal. A clip that is both too long and the wrong shape shows one reason, fixes it, then discovers the other. Acceptable — the alternative is a paragraph in a chip — but worth revisiting if it annoys in practice.
