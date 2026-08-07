# ffmpeg installs itself on Windows

**Date:** 2026-08-07
**Status:** designed

## The problem

A Windows install cannot convert video at all, and says so in a way that cannot be acted on.

Reported by a second install's owner, uploading an ordinary iPhone recording. The upload
was refused with two *convertible* reasons — a trailing `moov` atom and HEVC encoding —
followed by the advice to run `brew install ffmpeg`. Homebrew does not exist on Windows.

Three separate defects sit behind that one message:

1. **No converter is available on Windows.** `avconvert` ships with every Mac, so macOS has
   never needed anything installed. Windows has no equivalent, and nothing in the setup
   flow provides one.
2. **Installing ffmpeg would not have helped.** `hasFfmpeg()` probes each `PATH` entry for a
   file named exactly `ffmpeg`. On Windows the file is `ffmpeg.exe`, and `fs.existsSync`
   does not apply `PATHEXT`. The probe splits `PATH` on `;` for Windows, so Windows was
   considered — the extension was simply missed. Anyone who installed ffmpeg themselves
   would get the identical error, with no way to tell why.
3. **The remedy is hardcoded to macOS.** The 422 body appends `brew install ffmpeg`
   regardless of platform.

The result is a dead end: correct diagnosis, impossible instructions, and a fix that would
not have worked even if followed.

## Decisions

**Install ffmpeg automatically, as part of setup** — the same conclusion the cloudflared
work reached on 2026-08-05, for the same reason. Hunting down a binary is homework a
non-developer should never be handed, and a dependency discovered at publish time is
discovered at the worst possible moment. This follows that precedent deliberately rather
than inventing a second pattern for the same problem.

**Get the binary from the `imageio-ffmpeg` PyPI wheel**, not a direct download. This is the
one place this design departs from cloudflared, and it is a departure about size:

| Source | Windows download | Notes |
|---|---|---|
| `imageio-ffmpeg` wheel | **31 MB** | rides the existing `pip install` |
| BtbN GPL static | 170 MB | mirrors cloudflared exactly |
| BtbN GPL shared | 77 MB | needs a folder of DLLs kept together |
| `winget install` | n/a | rejected by the cloudflared spec — UAC prompts |

The wheel is a fifth of the static build and needs no GitHub API call, no zip extraction,
and no new download code — `pip install -r requirements.txt` already runs in both
launchers' first-run block. Every step we do not write is a step that cannot break on a
machine we cannot test.

**Verified before adopting, not assumed.** The bundled binary was installed into a scratch
venv and inspected directly. It reports `--enable-gpl --enable-libx264` and carries an HEVC
decoder — decode HEVC, encode H.264, which is exactly the pair of problems that produced
the original report. `-movflags +faststart`, already in `buildArgs()`, relocates `moov`.

**Windows only, via an environment marker.** macOS keeps `avconvert`: it is already present
on every Mac, needs no download, and is proven in the owner's live install. The marker
`sys_platform == "win32"` means Mac clones fetch nothing. This differs from how `tzdata` is
declared — that one is Windows-motivated but installed everywhere — and the difference is
justified by size. 350 KB is not worth a marker; 31 MB is.

**Accept the `--enable-nonfree` build.** The bundled binary is compiled with `--enable-gpl
--enable-nonfree --enable-version3`, which makes it non-redistributable. This project never
redistributes it: pip fetches it onto each machine at setup, exactly as a user installing
ffmpeg by hand would. No binary is committed, and `data/` is gitignored.

**Copy the binary to `data/bin/ffmpeg.exe` rather than pointing at `site-packages`.**
`data/bin/` already holds cloudflared, is gitignored, and is per-install. The dashboard then
has one predictable absolute path instead of globbing a version-stamped filename
(`ffmpeg-win-x86_64-v7.1.exe`) out of a venv whose layout is pip's business, not ours. The
duplicated ~76 MB on disk buys a boundary that does not move when the package updates.

**Run the setup step unconditionally, never gated on first run.** This is the specific
mistake the cloudflared spec called out, and it matters more here than it did there: the
install that reported this bug **already exists**. A first-run guard would skip it forever.
Unconditional means she runs `Update-Windows.bat`, then `Start`, and it is simply there. It
is a no-op once installed.

**Failure is never fatal.** Images, carousels, composing, and dry runs all work without a
converter. A failed setup must leave the app fully usable and degrade to the same 422 — with
correct instructions this time.

## How it works

### `worker/ffmpeg_setup.py` (new)

Mirrors `cloudflared_setup.py`, including its `find_existing()` → verify → atomic-move
shape:

1. **`find_existing(root)`** — returns a *working* ffmpeg if one is already here: this
   install's `data/bin` copy first, then `ffmpeg`/`ffmpeg.exe` on `PATH`, running
   `-version` on whichever it finds. A present-but-broken binary counts as missing, so a
   truncated copy self-heals on the next start.
2. **Non-Windows exits immediately**, reporting success. macOS has `avconvert`.
3. **`import imageio_ffmpeg; get_ffmpeg_exe()`** to locate the bundled binary. Using the
   package's own resolver rather than reconstructing its filename means its layout stays
   its own concern.
4. **Copy to a temp file beside the destination, run `-version`, then move into place.** A
   half-copied file can never be mistaken for a working install.

No network code, no TLS context, no GitHub API — pip already did that work. The certifi trap
documented in the cloudflared spec does not apply here for the same reason.

### `dashboard/lib/video-convert.ts`

- **`hasFfmpeg()`** checks `ffmpeg.exe` as well as `ffmpeg` on Windows — defect 2, and the
  reason anyone who installs ffmpeg by hand is currently invisible to the app.
- **`probe()`** gains a step between `avconvert` and `PATH`: this install's
  `data/bin/ffmpeg(.exe)`, returned as an **absolute path**. Same reasoning as cloudflared's
  `resolve_binary()` — an absolute path is immune to whatever `PATH` a background launcher
  hands the process.
- **`Converter`** becomes a `{ kind, bin }` pair rather than the bare string union
  `"avconvert" | "ffmpeg"`. `convertVideo()` currently derives the executable from the kind
  (`bin = converter === "avconvert" ? "/usr/bin/avconvert" : "ffmpeg"`), which cannot express
  "ffmpeg, at this specific path." `buildArgs()` continues to switch on `kind`, so the
  argument logic is untouched.
- The **cache** keeps its current semantics: an explicit override still bypasses it, so
  `VIDEO_CONVERTER=ffmpeg` remains a working manual escape hatch.

### `dashboard/app/api/assets/upload/route.ts`

The no-converter 422 stops hardcoding Homebrew. On Windows it points at
`Start-SocialScheduler-Windows.bat`, since by then the automatic path is the real remedy and
re-running Start is the whole fix. Wording is per-platform via `process.platform`.

### Launchers

Both gain one line beside the existing cloudflared call, run with the venv's Python:

```
.venv/bin/python -m worker.ffmpeg_setup          # Mac  (no-ops immediately)
".venv\Scripts\python" -m worker.ffmpeg_setup    # Windows
```

The macOS launcher gets the call despite being a guaranteed no-op, so the two scripts stay
diffable against each other — a divergence between them is a defect, and keeping them
line-for-line comparable is how that stays visible.

### `requirements.txt`

```
imageio-ffmpeg>=0.6; sys_platform == "win32"
```

## Risks

**The Windows path cannot be tested here.** No Windows machine is available — the same
caveat already written into `Start-SocialScheduler-Windows.bat`. Mitigated by forcing
`VIDEO_CONVERTER=ffmpeg` on macOS, which drives the identical `buildArgs`/`convertVideo`
path with the identical binary, and by keeping the Windows-specific surface down to a
filename extension and a copy. Final confirmation requires the reporting install to run it.

**Windows on ARM has no wheel.** pip falls back to the 25 KB sdist, which installs cleanly
but bundles no binary, so `pip install` does not fail — the risk is contained to
`get_ffmpeg_exe()`, which on an sdist install either raises or attempts its own download.
Both outcomes are wrapped: any exception, and the subprocess timeout already applied to the
`-version` check, are caught and reported as a non-fatal skip. The 422 then tells the user
to install ffmpeg themselves. Rare, and it fails the same way the app fails today rather
than a new way.

**`imageio-ffmpeg` could stop shipping a GPL build.** Its purpose is writing H.264 MP4s, so
losing libx264 would break the package's own reason to exist. If it happened, `-version`
would still pass while conversion failed at encode time. Accepted: the failure is visible,
per-upload, and never silent.

## Verified

To be completed during implementation. Required before this is called done:

- [ ] Unit tests for `ffmpeg_setup` (already-present, PATH hit, non-Windows skip, missing
      package, broken copy self-heal) with no filesystem or subprocess side effects.
- [ ] `findConverter()` tests covering `.exe` on Windows, `data/bin` precedence over `PATH`,
      and override-bypasses-cache.
- [ ] Full worker suite and `dashboard/scripts/test-video-convert.mjs` green.
- [ ] **Real conversion on macOS with `VIDEO_CONVERTER=ffmpeg`**, using the
      `imageio-ffmpeg` binary, on an actual HEVC iPhone file with a trailing `moov`:
      output plays, is H.264, and has `moov` before `mdat`.
- [ ] Upload the same file through the running dashboard and confirm it is accepted,
      previews render, and the cover picker works.
- [ ] Windows: reporting install runs `Update-Windows.bat` then `Start`, and the original
      video uploads. **This is the only step that closes the original report.**
