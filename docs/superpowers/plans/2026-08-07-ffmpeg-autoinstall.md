# ffmpeg Auto-Install (Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows install converts iPhone video out of the box, with no manual setup, and every "no converter" message tells the user something true on their platform.

**Architecture:** Follows the cloudflared auto-install precedent — a binary lands in gitignored `data/bin/`, put there by a setup module both launchers run unconditionally, non-fatal on failure. It departs from that precedent on sourcing only: the binary comes from the `imageio-ffmpeg` PyPI wheel (31 MB, rides the existing `pip install`) rather than a 170 MB GitHub download. On the dashboard side, `findConverter()` gains vendored-binary and `.exe` awareness and starts returning a resolved absolute path instead of a bare command name.

**Tech Stack:** Python 3 stdlib + `imageio-ffmpeg` (worker), TypeScript + `node:test` (dashboard), batch/shell launchers.

**Spec:** [`docs/superpowers/specs/2026-08-07-ffmpeg-autoinstall-design.md`](../specs/2026-08-07-ffmpeg-autoinstall-design.md)

## Global Constraints

- **macOS behaviour must not change.** `avconvert` stays the auto-selected converter on
  darwin. It is proven in the owner's live install. No Mac clone downloads ffmpeg.
- **`data/` is gitignored and per-install.** No binary is ever committed.
- **Setup failure is never fatal.** Images, carousels, composing, and dry runs must work
  with no converter present.
- **Dependency line, exactly:** `imageio-ffmpeg>=0.6; sys_platform == "win32"`
- **`video-convert.ts` stays free of database and HTTP concerns** — its module header
  promises this. Do not import `config` into it; inject paths instead.
- **The setup module is stdlib-only** apart from importing `imageio_ffmpeg` itself. No
  `requests`, no network code.
- **Never say `brew` on Windows.** Remedy text is chosen from `process.platform`.
- Worker tests: `.venv/bin/python -m pytest worker/tests -q`
- Dashboard tests: `npm test` (from `dashboard/`), plus
  `node --experimental-strip-types scripts/test-video-convert.mjs`
- Dashboard lint is at **0 errors** and must stay there: `npm run lint`

---

### Task 1: Resolve converters to a real path, and see `ffmpeg.exe`

This is the task that fixes the reported bug's deepest layer: today an ffmpeg that IS
installed on Windows is invisible, because the probe looks for a file named `ffmpeg` and
Windows names it `ffmpeg.exe`.

`Converter` is currently the bare string union `"avconvert" | "ffmpeg"`, and
`convertVideo()` re-derives the executable from it (`bin = converter === "avconvert" ?
"/usr/bin/avconvert" : "ffmpeg"`). That type cannot express "ffmpeg, at this specific
path," which is exactly what a vendored binary needs. Splitting it into `{ kind, bin }`
is the whole change; `buildArgs()` keeps switching on `kind` and its logic is untouched.

**Files:**
- Modify: `dashboard/lib/video-convert.ts:16-66` (types, probe, `findConverter`)
- Modify: `dashboard/lib/video-convert.ts:135-145` (`convertVideo` binary selection)
- Modify: `dashboard/scripts/test-video-convert.mjs:12,19,47,51,123,127`
- Create: `dashboard/lib/video-convert.test.ts`

**Interfaces:**
- Produces:
  - `type ConverterKind = "avconvert" | "ffmpeg"`
  - `interface ResolvedConverter { kind: ConverterKind; bin: string }`
  - `findConverter(override?: string, vendorDir?: string): ResolvedConverter | null`
  - `buildArgs(kind: ConverterKind, input: string, output: string): string[]` — signature
    unchanged, now explicitly typed to the kind
  - `convertVideo(input, output, { converter: ResolvedConverter, timeoutMs: number })`
  - `vendoredFfmpegPath(vendorDir: string): string | null`

**Deliberate semantic change:** an explicit override now still requires the binary to
exist. `findConverter("ffmpeg")` returns `null` when no ffmpeg can be found, where it
previously returned the string `"ffmpeg"` unconditionally. This is what makes
`VIDEO_CONVERTER=ffmpeg` produce an honest 422 instead of a confusing exec failure — and
it repairs `test-video-convert.mjs:123`, whose `hasFfmpeg` check is currently always true
and therefore never actually guarding anything. Overrides still bypass the cache.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/lib/video-convert.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findConverter, buildArgs, vendoredFfmpegPath } from "./video-convert.ts";

function tmpVendorDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ss-vendor-"));
}

test("off disables conversion whatever is installed", () => {
  assert.equal(findConverter("off"), null);
});

test("a vendored ffmpeg is found and returned as an absolute path", () => {
  const dir = tmpVendorDir();
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "#!/bin/sh\n");
  fs.chmodSync(binPath, 0o755);

  const found = vendoredFfmpegPath(dir);
  assert.equal(found, binPath);
  assert.ok(path.isAbsolute(found), "must be absolute — background launchers have a minimal PATH");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("an empty vendor dir yields no vendored ffmpeg", () => {
  const dir = tmpVendorDir();
  assert.equal(vendoredFfmpegPath(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forcing ffmpeg prefers the vendored copy over anything on PATH", () => {
  const dir = tmpVendorDir();
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "#!/bin/sh\n");
  fs.chmodSync(binPath, 0o755);

  const c = findConverter("ffmpeg", dir);
  assert.equal(c?.kind, "ffmpeg");
  assert.equal(c?.bin, binPath);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("forcing a converter that does not exist returns null, not a bare name", () => {
  // The old behaviour returned the string "ffmpeg" unconditionally, so an install with no
  // ffmpeg got a spawn failure mid-upload instead of the actionable 422.
  const dir = tmpVendorDir();
  const saved = process.env.PATH;
  process.env.PATH = dir; // empty of binaries
  try {
    assert.equal(findConverter("ffmpeg", dir), null);
  } finally {
    process.env.PATH = saved;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildArgs still switches on kind and keeps the Instagram-critical flags", () => {
  const args = buildArgs("ffmpeg", "in.mov", "out.mp4");
  const mv = args.indexOf("-movflags");
  assert.ok(mv !== -1 && args[mv + 1] === "+faststart", "moov must move to the front");
  assert.deepEqual(buildArgs("avconvert", "in.mov", "out.mp4"),
    ["-s", "in.mov", "-p", "Preset1920x1080", "-o", "out.mp4", "--replace"]);
});

if (process.platform === "darwin") {
  test("macOS still auto-selects avconvert, at its absolute path", () => {
    const c = findConverter();
    assert.equal(c?.kind, "avconvert");
    assert.equal(c?.bin, "/usr/bin/avconvert");
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `dashboard/`:
```bash
npm test
```
Expected: FAIL — `vendoredFfmpegPath` is not exported, and `findConverter` returns strings
rather than objects.

- [ ] **Step 3: Implement the resolution layer**

In `dashboard/lib/video-convert.ts`, replace the type and probe block (lines 16–66):

```ts
import path from "node:path";

export class ConvertError extends Error {}

export type ConverterKind = "avconvert" | "ffmpeg";

/** A converter that is known to exist, and where it is. */
export interface ResolvedConverter {
  kind: ConverterKind;
  /** Absolute path wherever we resolved one ourselves. */
  bin: string;
}

const AVCONVERT_BIN = "/usr/bin/avconvert";

/**
 * Where this install keeps binaries it fetched for itself — the same gitignored,
 * per-install folder cloudflared already uses.
 *
 * Computed here rather than imported from `config` on purpose: this module's header
 * promises it stays free of database/HTTP concerns, and every caller can inject a
 * different directory for tests.
 */
export function defaultVendorDir(): string {
  return path.resolve(process.cwd(), "..", "data", "bin");
}

/** Candidate filenames for an executable, newest-first. Windows needs the .exe. */
function executableNames(base: string): string[] {
  return process.platform === "win32" ? [`${base}.exe`, base] : [base];
}

/**
 * This install's own ffmpeg, or null.
 *
 * Returns an ABSOLUTE path. That matters beyond tidiness: the worker and dashboard are
 * started by background launchers (launchd, a Scheduled Task, a Startup shortcut) whose
 * PATH is minimal, so a bare command name can be unresolvable there even when the same
 * name works in a terminal.
 */
export function vendoredFfmpegPath(vendorDir: string): string | null {
  for (const name of executableNames("ffmpeg")) {
    const candidate = path.join(vendorDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Look up an executable on PATH by hand.
 *
 * Windows is why this exists at all: the previous version probed only for a file named
 * exactly `ffmpeg`, but Windows names it `ffmpeg.exe` and `fs.existsSync` does not apply
 * PATHEXT. Anyone who had installed ffmpeg themselves was invisible to this app.
 */
function findOnPath(base: string): string | null {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH || "").split(sep)) {
    if (!dir) continue;
    for (const name of executableNames(base)) {
      try {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore unreadable PATH entries
      }
    }
  }
  return null;
}

function resolveAvconvert(): ResolvedConverter | null {
  return fs.existsSync(AVCONVERT_BIN) ? { kind: "avconvert", bin: AVCONVERT_BIN } : null;
}

function resolveFfmpeg(vendorDir: string): ResolvedConverter | null {
  const bin = vendoredFfmpegPath(vendorDir) ?? findOnPath("ffmpeg");
  return bin ? { kind: "ffmpeg", bin } : null;
}

// Cached across calls — findConverter() runs on every video upload, and re-probing the
// filesystem each time would be wasteful. An explicit override always bypasses the cache
// so tests (and callers who know better) aren't stuck with whatever the first call
// happened to detect.
let cachedAuto: ResolvedConverter | null | undefined;

/**
 * Resolve which converter to use, in order: `avconvert` (macOS, always present,
 * preferred) -> this install's vendored ffmpeg -> ffmpeg on PATH -> `null`.
 *
 * `override`:
 * - `"off"` always returns `null`, regardless of what's installed.
 * - `"avconvert"` / `"ffmpeg"` force that KIND, but still require it to exist — forcing a
 *   converter that isn't installed returns `null` so the caller can render the real
 *   "nothing available" message instead of failing later at spawn time.
 * - omitted: probe once and cache the result for subsequent no-override calls.
 */
export function findConverter(
  override?: string,
  vendorDir: string = defaultVendorDir()
): ResolvedConverter | null {
  if (override === "off") return null;
  if (override === "avconvert") return resolveAvconvert();
  if (override === "ffmpeg") return resolveFfmpeg(vendorDir);

  if (cachedAuto === undefined) {
    cachedAuto = resolveAvconvert() ?? resolveFfmpeg(vendorDir);
  }
  return cachedAuto;
}
```

Then update `buildArgs`'s signature and `convertVideo`'s binary selection:

```ts
export function buildArgs(converter: ConverterKind, input: string, output: string): string[] {
```

```ts
interface ConvertOpts {
  converter: ResolvedConverter;
  timeoutMs: number;
}
```

```ts
  const { converter, timeoutMs } = opts;
  const bin = converter.bin;
  const args = buildArgs(converter.kind, inputPath, outputPath);
```

In the error strings inside `convertVideo`, replace the two bare `${converter}`
interpolations with `${converter.kind}` — otherwise they stringify as `[object Object]`.

- [ ] **Step 4: Update the existing script test to the new shape**

In `dashboard/scripts/test-video-convert.mjs`:
- line 19: `buildArgs("ffmpeg", ...)` — unchanged, still takes a kind.
- line 47: `assert.equal(findConverter()?.kind, "avconvert", "macOS must find avconvert");`
- line 51 onward: `conv` is now a `ResolvedConverter`; it is passed straight through to
  `convertVideo` as `{ converter: conv, ... }`, which still works.
- line 106: `${conv}` → `${conv.kind}` in the pgrep assertion message.
- line 123: `const ffmpegConv = findConverter("ffmpeg");` then
  `const hasFfmpeg = ffmpegConv !== null;`
- line 127: `convertVideo(REAL, dst, { converter: ffmpegConv, timeoutMs: 300_000 })`

- [ ] **Step 5: Run both suites**

From `dashboard/`:
```bash
npm test && npm run lint && node --experimental-strip-types scripts/test-video-convert.mjs
```
Expected: all PASS, lint 0 errors. On this Mac `findConverter()` resolves avconvert and
`findConverter("ffmpeg")` resolves `/usr/local/bin/ffmpeg`.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/video-convert.ts dashboard/lib/video-convert.test.ts dashboard/scripts/test-video-convert.mjs
git commit -m "fix(video): find ffmpeg.exe on Windows, and resolve converters to a path"
```

---

### Task 2: Stop telling Windows users to run `brew`

**Files:**
- Modify: `dashboard/app/api/assets/upload/route.ts:118-128`
- Create: `dashboard/lib/converter-advice.ts`
- Create: `dashboard/lib/converter-advice.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (pure string logic — keep it that way so it is trivially
  testable on any platform)
- Produces: `converterAdvice(platform: NodeJS.Platform): string`

**Why a separate module:** the advice needs testing on all three platforms from one
machine, which means it must take the platform as an argument. Inlining it in the route
handler would make it reachable only through an HTTP request.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/converter-advice.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { converterAdvice } from "./converter-advice.ts";

test("Windows is never told to use Homebrew", () => {
  const advice = converterAdvice("win32");
  assert.ok(!/brew/i.test(advice), `must not mention brew on Windows: ${advice}`);
  assert.ok(/Start-SocialScheduler-Windows\.bat/.test(advice),
    "should point at the launcher, which now installs it automatically");
});

test("macOS keeps the Homebrew hint", () => {
  assert.ok(/brew install ffmpeg/.test(converterAdvice("darwin")));
});

test("other platforms get something generic but still actionable", () => {
  const advice = converterAdvice("linux");
  assert.ok(/ffmpeg/.test(advice));
  assert.ok(!/brew/i.test(advice));
});
```

- [ ] **Step 2: Run it to verify it fails**

From `dashboard/`: `npm test`
Expected: FAIL — `Cannot find module './converter-advice.ts'`.

- [ ] **Step 3: Implement it**

Create `dashboard/lib/converter-advice.ts`:

```ts
/**
 * What to tell someone whose upload needs converting when no converter is available.
 *
 * Split out of the upload route so every platform's wording can be asserted from one
 * machine. The bug this fixes was reported from Windows, where the message hardcoded
 * `brew install ffmpeg` — a command that does not exist there, sending the one person who
 * hit it down a dead end.
 *
 * Takes the platform rather than reading process.platform so it stays a pure function.
 */
export function converterAdvice(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return (
      "This install has no video converter yet. Close SocialScheduler and double-click " +
      "Start-SocialScheduler-Windows.bat — it installs one automatically, then upload " +
      "this video again."
    );
  }
  if (platform === "darwin") {
    return (
      "This Mac has no video converter available, which is unusual — macOS normally " +
      "provides one. Installing ffmpeg (`brew install ffmpeg`) would let this app " +
      "convert and publish it automatically."
    );
  }
  return (
    "This install has no video converter. Installing ffmpeg and making sure it is on " +
    "your PATH would let this app convert and publish this automatically."
  );
}
```

- [ ] **Step 4: Wire it into the route**

In `dashboard/app/api/assets/upload/route.ts`, add the import beside the existing
`video-convert` import, then replace the 422 body (lines 120–127):

```ts
    if (!converter) {
      return NextResponse.json(
        { error: `${check.convertible.join(" ")} ${converterAdvice(process.platform)}` },
        { status: 422 }
      );
    }
```

- [ ] **Step 5: Run the tests and lint**

From `dashboard/`:
```bash
npm test && npm run lint
```
Expected: PASS, 0 lint errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/converter-advice.ts dashboard/lib/converter-advice.test.ts dashboard/app/api/assets/upload/route.ts
git commit -m "fix(video): give platform-correct advice when no converter is available"
```

---

### Task 3: `worker/ffmpeg_setup.py`

**Files:**
- Create: `worker/ffmpeg_setup.py`
- Create: `worker/tests/test_ffmpeg_setup.py`
- Modify: `requirements.txt`

**Interfaces:**
- Consumes: `data/bin/` layout established by `worker/cloudflared_setup.py`
- Produces:
  - `repo_root() -> Path`
  - `vendored_path(root: Path) -> Path`
  - `verify(path: Path | str) -> str` — monkeypatched by the tests
  - `find_existing(root: Path) -> Path | None`
  - `bundled_binary() -> Path` — monkeypatched by the tests
  - `install(root: Path | None = None, log=print) -> Path | None` — `None` means "no
    converter needed on this platform", which is the normal macOS outcome
  - `main(argv: list[str] | None = None) -> int`
  - `class SetupError(RuntimeError)`

Mirror `cloudflared_setup.py`'s shape closely — same function names, same
find-then-verify-then-atomic-move discipline. A reader who knows one should recognise the
other.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_ffmpeg_setup.py`:

```python
"""Tests for the automatic ffmpeg install (worker/ffmpeg_setup.py).

Nothing here touches the network or runs a real ffmpeg: `verify` is monkeypatched, and
the "binary" is a text file. The point is the decision logic, not the codec.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from worker import ffmpeg_setup as fs


def _fake_binary(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not really ffmpeg")
    return path


def test_vendored_path_uses_exe_on_windows(monkeypatch):
    # Construct the Path BEFORE patching os.name. pathlib picks WindowsPath vs PosixPath
    # from os.name at instantiation, and Python 3.11 refuses to instantiate WindowsPath on
    # a POSIX host — patching first makes this line raise, which aborts the whole suite.
    root = Path("/repo")
    monkeypatch.setattr(fs.os, "name", "nt")
    assert fs.vendored_path(root).name == "ffmpeg.exe"


def test_vendored_path_is_bare_elsewhere(monkeypatch):
    monkeypatch.setattr(fs.os, "name", "posix")
    assert fs.vendored_path(Path("/repo")).name == "ffmpeg"


def test_find_existing_returns_the_vendored_copy(tmp_path, monkeypatch):
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    dest = _fake_binary(fs.vendored_path(tmp_path))
    assert fs.find_existing(tmp_path) == dest


def test_a_broken_vendored_copy_counts_as_missing(tmp_path, monkeypatch):
    """A truncated copy must self-heal on the next start, not be trusted forever."""
    def boom(path):
        raise fs.SetupError("exited 1")
    monkeypatch.setattr(fs, "verify", boom)
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    _fake_binary(fs.vendored_path(tmp_path))
    assert fs.find_existing(tmp_path) is None


def test_find_existing_falls_back_to_path(tmp_path, monkeypatch):
    """Someone who installed ffmpeg themselves keeps using theirs and downloads nothing."""
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    monkeypatch.setattr(fs.shutil, "which", lambda name: "/usr/local/bin/ffmpeg")
    assert fs.find_existing(tmp_path) == Path("/usr/local/bin/ffmpeg")


def test_install_is_a_no_op_off_windows(tmp_path, monkeypatch):
    """macOS has avconvert; nothing should be copied there."""
    monkeypatch.setattr(fs.sys, "platform", "darwin")
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    assert fs.install(tmp_path, log=lambda *a: None) is None
    assert not fs.vendored_path(tmp_path).exists()


def test_install_copies_the_bundled_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(fs.sys, "platform", "win32")
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "verify", lambda p: "ffmpeg version 7.1")
    source = _fake_binary(tmp_path / "site-packages" / "ffmpeg-win-x86_64-v7.1.exe")
    monkeypatch.setattr(fs, "bundled_binary", lambda: source)

    dest = fs.install(tmp_path, log=lambda *a: None)
    assert dest == fs.vendored_path(tmp_path)
    assert dest.exists()
    assert dest.read_text() == "not really ffmpeg"


def test_install_leaves_nothing_behind_when_the_copy_is_unusable(tmp_path, monkeypatch):
    """A binary that will not run must never be left where the next start trusts it."""
    monkeypatch.setattr(fs.sys, "platform", "win32")
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "verify", lambda p: (_ for _ in ()).throw(fs.SetupError("bad")))
    monkeypatch.setattr(fs, "bundled_binary",
                        lambda: _fake_binary(tmp_path / "src" / "ffmpeg.exe"))

    with pytest.raises(fs.SetupError):
        fs.install(tmp_path, log=lambda *a: None)
    assert not fs.vendored_path(tmp_path).exists()
    assert list(fs.vendored_path(tmp_path).parent.glob("tmp*")) == []


def test_main_never_raises_when_the_package_is_missing(tmp_path, monkeypatch, capsys):
    """Windows-on-ARM has no wheel. That must be a sentence, never a traceback."""
    monkeypatch.setattr(fs.sys, "platform", "win32")
    monkeypatch.setattr(fs, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(fs.shutil, "which", lambda name: None)
    monkeypatch.setattr(fs, "bundled_binary",
                        lambda: (_ for _ in ()).throw(ImportError("no imageio_ffmpeg")))

    assert fs.main([]) == 1
    err = capsys.readouterr().err
    assert "Traceback" not in err
    assert "ffmpeg" in err
```

- [ ] **Step 2: Run them to verify they fail**

```bash
.venv/bin/python -m pytest worker/tests/test_ffmpeg_setup.py -q
```
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.ffmpeg_setup'`.

- [ ] **Step 3: Implement the module**

Create `worker/ffmpeg_setup.py`:

```python
"""One-time setup: put a working `ffmpeg` on this install (Windows only).

Instagram refuses two things an iPhone produces by default — a `moov` atom at the end of
the file, and HEVC video — and both are fixed by re-encoding. macOS has always been fine
here: `avconvert` ships with every Mac. Windows has no equivalent, so a Windows install
could not convert at all, and the error it raised told the user to run `brew install
ffmpeg`, which does not exist there.

Unlike cloudflared_setup.py, this downloads nothing itself. `imageio-ffmpeg` is declared
in requirements.txt for Windows only, and pip has already put a suitable binary inside the
venv by the time this runs; the job here is to copy it to the one predictable place the
dashboard looks — `data/bin/`, gitignored and per-install, next to cloudflared.

That binary was checked before being adopted: it reports `--enable-gpl --enable-libx264`
and carries an HEVC decoder, which is exactly the pair of problems above.

Run it directly:  .venv/Scripts/python -m worker.ffmpeg_setup
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_VERSION_TIMEOUT = 30


class SetupError(RuntimeError):
    """ffmpeg could not be installed (no wheel for this platform, or a bad copy)."""


# ---------------------------------------------------------------- paths


def repo_root() -> Path:
    """The repo root, derived from this file's location — not the cwd."""
    return Path(__file__).resolve().parent.parent


def vendored_path(root: Path) -> Path:
    """Where this install keeps its own copy of ffmpeg."""
    name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    return root / "data" / "bin" / name


# ---------------------------------------------------------------- discovery


def verify(path: Path | str) -> str:
    """Run `-version` and return its first line, or raise SetupError.

    A present-but-broken binary must count as missing so a truncated copy self-heals on
    the next start instead of being trusted forever.
    """
    try:
        proc = subprocess.run(
            [str(path), "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=_VERSION_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        # TimeoutExpired is a SubprocessError, NOT an OSError — catching only OSError
        # would let a hung binary escape as a traceback (the same trap cloudflared_setup
        # documents).
        raise SetupError(f"{path} could not be run ({exc})") from exc
    if proc.returncode != 0:
        raise SetupError(f"{path} exited {proc.returncode} when asked for its version")
    lines = (proc.stdout or proc.stderr or "").strip().splitlines()
    return lines[0] if lines else "unknown"


def find_existing(root: Path) -> Path | None:
    """An ffmpeg that is already here and actually works, or None.

    Checks this install's own copy first, then the system PATH — someone who already
    installed ffmpeg themselves keeps using theirs and we copy nothing.
    """
    local = vendored_path(root)
    if local.exists():
        try:
            verify(local)
            return local
        except SetupError:
            return None  # present but broken — caller re-copies over it
    found = shutil.which("ffmpeg")
    if found:
        try:
            verify(found)
            return Path(found)
        except SetupError:
            return None
    return None


def bundled_binary() -> Path:
    """The ffmpeg that pip put inside this venv, via imageio-ffmpeg.

    Uses the package's own resolver rather than reconstructing its version-stamped
    filename, so its layout stays its own concern.
    """
    import imageio_ffmpeg

    return Path(imageio_ffmpeg.get_ffmpeg_exe())


# ---------------------------------------------------------------- install


def install(root: Path | None = None, log=print) -> Path | None:
    """Ensure a working ffmpeg exists for this install; return its path, or None if
    none is needed on this platform.

    Idempotent and safe to run on every start.
    """
    root = root or repo_root()

    existing = find_existing(root)
    if existing is not None:
        return existing

    if sys.platform != "win32":
        # macOS has /usr/bin/avconvert, which the dashboard prefers anyway. Nothing to do.
        return None

    source = bundled_binary()
    dest = vendored_path(root)
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Sweep any staging file orphaned by an earlier run that was killed mid-copy. Each
    # orphan is ~76 MB, and NamedTemporaryFile does not clean up after a SIGKILL.
    for orphan in dest.parent.glob("tmp*"):
        if orphan.is_file():
            orphan.unlink(missing_ok=True)

    log("First run — setting up ffmpeg (needed to convert iPhone video for Instagram)...")

    # Stage beside the destination and move into place only after the copy has proven it
    # runs, so a half-written file can never be mistaken for a working install.
    #
    # Close mkstemp's file descriptor immediately. It hands back an OPEN fd, and on Windows
    # an open handle blocks the .replace() below — the staged copy would be verified, then
    # fail to move, on the one platform this whole module exists for.
    fd, staged_name = tempfile.mkstemp(dir=str(dest.parent), prefix="tmp")
    os.close(fd)
    staged = Path(staged_name)
    try:
        shutil.copyfile(source, staged)
        staged.chmod(0o755)
        version = verify(staged)
        staged.replace(dest)
    except BaseException:
        staged.unlink(missing_ok=True)
        raise

    log(f"          Installed {version} into {dest.parent}")
    return dest


def main(argv: list[str] | None = None) -> int:
    """Launcher entry point. Never raises — prints plainly and returns an exit code."""
    root = repo_root()
    try:
        install(root)
        return 0
    except Exception as exc:  # noqa: BLE001
        # Deliberately broad, for the same reason cloudflared_setup is: the whole point of
        # this module is that a non-developer never has to think about ffmpeg, so ANY
        # failure must arrive as the sentences below rather than a traceback mid-startup.
        print(f"[!] Couldn't set up ffmpeg automatically: {exc}", file=sys.stderr)
        print(
            "    Without it, iPhone video (HEVC, or with its index at the end of the "
            "file) can't be\n"
            "    converted for Instagram. Photos and carousels are unaffected.\n"
            "    You can install ffmpeg yourself from https://ffmpeg.org/download.html "
            "and make sure\n"
            "    it is on your PATH, then run Start again.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Add the dependency**

Append to `requirements.txt`, matching the commented style of its neighbours:

```
# Bundles an ffmpeg binary (~31 MB wheel) so a Windows install can convert iPhone video
# without the owner hunting one down. Windows only: macOS ships /usr/bin/avconvert, which
# the dashboard prefers, so a Mac clone downloads nothing. Copied into data/bin by
# worker/ffmpeg_setup.py.
imageio-ffmpeg>=0.6; sys_platform == "win32"
```

- [ ] **Step 5: Run the tests**

```bash
.venv/bin/python -m pytest worker/tests/test_ffmpeg_setup.py -q && .venv/bin/python -m pytest worker/tests -q
```
Expected: the new file PASSes, and the full worker suite still passes with no regressions.

- [ ] **Step 6: Commit**

```bash
git add worker/ffmpeg_setup.py worker/tests/test_ffmpeg_setup.py requirements.txt
git commit -m "feat(video): install ffmpeg automatically on Windows"
```

---

### Task 4: Run it from both launchers

**Files:**
- Modify: `Start-SocialScheduler-Mac.command:212` (add one line after the cloudflared call)
- Modify: `Start-SocialScheduler-Windows.bat:100` (add one line after the cloudflared call)
- Modify: `readme.md`

**Interfaces:**
- Consumes: `worker.ffmpeg_setup.main()` from Task 3

The macOS launcher gets the call even though it is a guaranteed no-op, so the two scripts
stay diffable against each other. A divergence between them should show up as a diff, not
be hidden by an intentional omission.

- [ ] **Step 1: Add the call to the Windows launcher**

In `Start-SocialScheduler-Windows.bat`, immediately after line 100
(`".venv\Scripts\python" -m worker.cloudflared_setup`):

```bat
REM ---- 5d. Make sure ffmpeg is here (it converts iPhone video for Instagram). ----
REM
REM Unconditional, exactly like cloudflared above and for a sharper reason: the install
REM that reported this could not convert at all, and it ALREADY EXISTS. A first-run guard
REM would skip it there forever. It is a no-op once installed, and failure is never fatal -
REM photos and carousels need no converter.
".venv\Scripts\python" -m worker.ffmpeg_setup
```

- [ ] **Step 2: Add the matching call to the Mac launcher**

In `Start-SocialScheduler-Mac.command`, immediately after line 212
(`.venv/bin/python -m worker.cloudflared_setup`):

```sh
# macOS already has /usr/bin/avconvert, so this exits immediately and downloads nothing.
# Kept here anyway so this script stays line-for-line comparable with the Windows one.
.venv/bin/python -m worker.ffmpeg_setup
```

- [ ] **Step 3: Verify the Mac launcher's new line is genuinely a no-op**

```bash
.venv/bin/python -m worker.ffmpeg_setup; echo "exit=$?"; ls data/bin/
```
Expected: `exit=0`, no output, and `data/bin/` contains cloudflared but **no ffmpeg**.

- [ ] **Step 4: Document it**

In `readme.md`, locate the setup/first-run section that mentions cloudflared
(`grep -n cloudflared readme.md`) and add this alongside it, matching the surrounding
voice and heading level:

> **Video conversion.** iPhone video is usually HEVC, and stores its index at the end of
> the file — Instagram accepts neither. Start sets up a converter for you the first time
> it runs. On a Mac this uses `avconvert`, which macOS already provides, so nothing is
> downloaded; on Windows a converter is installed automatically. Photos and carousels
> never need it.

- [ ] **Step 5: Commit**

```bash
git add Start-SocialScheduler-Mac.command Start-SocialScheduler-Windows.bat readme.md
git commit -m "feat(launcher): set up ffmpeg during first run"
```

---

### Task 5: Prove it end to end on a real HEVC file

Every earlier task tested decisions. This one tests the actual claim made to the person
who reported the bug: **that a video like hers now converts and uploads.**

**Files:**
- Create: `dashboard/scripts/make-hevc-fixture.mjs`
- Modify: `docs/tasks.md` (record results)

The existing script test depends on `~/Downloads/IMG_3707.MOV`, which is **not present on
this machine** — so its real-conversion branch silently skips. Generating the fixture
removes that dependency and, unlike IMG_3707, reproduces *both* reported problems.

- [ ] **Step 1: Write the fixture generator**

Create `dashboard/scripts/make-hevc-fixture.mjs`:

```js
/**
 * Build a video that reproduces the originally reported upload failure: HEVC-encoded,
 * with its `moov` atom at the END of the file. Both are iPhone camera defaults, and both
 * are what classifyReelErrors() flags as convertible.
 *
 * Usage: node scripts/make-hevc-fixture.mjs <ffmpeg-bin> <output.mov>
 */
import { execFileSync } from "node:child_process";

const [bin, out] = process.argv.slice(2);
if (!bin || !out) {
  console.error("usage: make-hevc-fixture.mjs <ffmpeg-bin> <output.mov>");
  process.exit(2);
}

execFileSync(bin, [
  "-y", "-nostdin", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=4",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
  "-c:v", "libx265", "-tag:v", "hvc1",
  "-c:a", "aac",
  // No +faststart on purpose: that leaves moov at the end, which is half the bug.
  out,
]);
console.log(`wrote ${out}`);
```

- [ ] **Step 2: Generate the fixture and confirm it reproduces both problems**

```bash
cd dashboard && node scripts/make-hevc-fixture.mjs /usr/local/bin/ffmpeg /tmp/hevc-trailing.mov && node --experimental-strip-types -e "import('./lib/video-meta.ts').then(async m => { const fs = await import('node:fs'); const meta = m.readVideoMeta(fs.readFileSync('/tmp/hevc-trailing.mov')); console.log({ is_hevc: meta.is_hevc, moov_before_mdat: meta.moov_before_mdat, w: meta.width, h: meta.height }); })"
```
Expected: `is_hevc: true, moov_before_mdat: false` — i.e. the fixture genuinely reproduces
the reported condition. If either is wrong, the rest of this task proves nothing; fix the
fixture first.

- [ ] **Step 3: Convert it with the exact binary Windows will get**

Use the `imageio-ffmpeg` binary rather than the system one, so this exercises the build
that actually ships to her machine:

```bash
cd dashboard && export FF=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())") && node --experimental-strip-types -e "
import('./lib/video-convert.ts').then(async vc => {
  const fs = await import('node:fs');
  const meta = await import('./lib/video-meta.ts');
  await vc.convertVideo('/tmp/hevc-trailing.mov', '/tmp/hevc-fixed.mp4', {
    converter: { kind: 'ffmpeg', bin: process.env.FF }, timeoutMs: 300000,
  });
  const m = meta.readVideoMeta(fs.readFileSync('/tmp/hevc-fixed.mp4'));
  console.log({ is_hevc: m.is_hevc, moov_before_mdat: m.moov_before_mdat, w: m.width, h: m.height });
});"
```
Expected: `is_hevc: false, moov_before_mdat: true` — both reported problems resolved. If
`imageio-ffmpeg` is not installed on this Mac (the marker excludes it), install it into
the venv temporarily for this check and note that it was temporary.

- [ ] **Step 4: Upload it through the running dashboard**

Start the dashboard, then upload `/tmp/hevc-trailing.mov` through the real Library UI —
not curl. This is the only step that exercises the route, the 422 path, the conform
decision, and the preview together.

Confirm: the upload is **accepted**, the resulting asset **previews** in the browser
(which HEVC would not), and the **cover picker** renders frames.

- [ ] **Step 5: Confirm the failure path still reads correctly**

With the dashboard running, set `VIDEO_CONVERTER=off` in `.env`, restart it, and upload the
fixture again. Confirm the 422 shown in the UI is the platform-correct message from Task 2
and mentions no `brew` on Windows wording. Then restore `.env`.

- [ ] **Step 6: Run everything**

```bash
.venv/bin/python -m pytest worker/tests -q
cd dashboard && npm test && npm run lint && node --experimental-strip-types scripts/test-video-convert.mjs
```
Expected: worker suite passes, dashboard suite passes, lint 0 errors.

- [ ] **Step 7: Record results and commit**

Append to `docs/tasks.md`, following the existing checkbox-with-counts style. Fill in the
real numbers — do not copy these:

```markdown
## ffmpeg auto-install (Windows) — 2026-08-07

- [x] `.venv/bin/python -m pytest worker/tests -q` — NNN passed (was NNN before).
- [x] `npm test` — NN passed. `npm run lint` — 0 errors.
- [x] `scripts/test-video-convert.mjs` — passes; the ffmpeg branch now actually guards
      on availability instead of being always-true.
- [x] Generated HEVC + trailing-moov fixture reproduces both reported problems
      (`is_hevc: true, moov_before_mdat: false`).
- [x] Converted with the imageio-ffmpeg binary → `is_hevc: false, moov_before_mdat: true`.
- [x] Uploaded through the real Library UI: accepted, previews render, cover picker works.
- [x] `VIDEO_CONVERTER=off` → platform-correct 422, no `brew` text on Windows.
- [ ] **NOT VERIFIED — Windows.** The `.exe` filename handling, the copy into `data/bin`,
      and the launcher line are code-reviewed only; no Windows machine is available here.
      Same caveat that already applies to the rest of `Start-SocialScheduler-Windows.bat`.
      Closes only when the reporting install runs Update then Start and uploads its video.
```

```bash
git add dashboard/scripts/make-hevc-fixture.mjs docs/tasks.md
git commit -m "test(video): prove HEVC + trailing-moov conversion end to end"
```

---

## Still open after this plan

**The Windows path is unverified.** Nothing in Task 5 runs on Windows, because no Windows
machine is available here. What Task 5 does prove is that the conversion works with the
exact binary the wheel ships. What it cannot prove is the `.exe` filename handling, the
copy into `data/bin`, and the launcher line — those are code-reviewed only.

The report closes when the install that raised it runs `Update-Windows.bat`, then `Start`,
and uploads the original video successfully. Until that happens this is fixed in
principle, not in fact, and should be described that way.
