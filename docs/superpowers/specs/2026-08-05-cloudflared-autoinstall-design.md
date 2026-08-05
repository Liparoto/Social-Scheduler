# cloudflared installs itself on first run

**Date:** 2026-08-05
**Status:** implemented

## The problem

A real publish needs a Cloudflare quick tunnel, which needs the `cloudflared` binary.
Getting it was homework the owner of a fresh clone had to do themselves: `brew install
cloudflared` on macOS (which silently assumes Homebrew is installed at all) or a hunt
through Cloudflare's download page on Windows.

Worse, the launchers only *warned* about it, and the warning was gated behind
`DRY_RUN=0`. A fresh clone ships `DRY_RUN=1`, so a new install saw **no warning at all**.
The missing binary surfaced weeks later as a failed publish — at send time, the worst
possible moment to discover a setup problem.

This was reported on Windows and applied equally to macOS.

## Decisions

**Download the official binary into the repo**, rather than shelling out to a package
manager. Homebrew often isn't installed (a whole separate setup problem), `winget` can
prompt for UAC, and both fail in ways that are hard to explain to a non-developer.
A direct download needs no package manager, no admin password, and no PATH assumptions,
and the logic is identical on both platforms.

**Track the latest release** rather than pinning a version with a committed checksum.
The trust model is HTTPS + GitHub — the same one `brew install` relies on. Zero
maintenance, never goes stale. The tradeoff accepted: a corrupt download is caught by
the post-download `--version` check rather than by a hash comparison.

**Install on first run, unconditionally** — not gated on `DRY_RUN=0`. That gate is
exactly what failed. Doing it during the existing first-run block absorbs the download
into a wait the user already expects (npm install, venv creation), and going live later
becomes a pure flag change.

**Store it in `data/bin/`**, which is already gitignored and per-install, like the
database and asset store. It is never committed and never shared between clones.

## How it works

`worker/cloudflared_setup.py` (stdlib, plus one optional `certifi` import):

1. `find_existing()` — returns a *working* cloudflared if one is already here. Checks
   this install's `data/bin` copy first, then the system PATH, and runs `--version` on
   whichever it finds. A present-but-broken binary counts as missing, so a truncated
   download self-heals on the next start.
2. `asset_name()` — pure map from `(platform.system(), platform.machine())` to
   Cloudflare's release asset name. Windows-on-ARM maps to the amd64 build on purpose:
   no windows-arm64 asset exists and x64 runs under emulation.
3. `latest_asset_url()` — reads the GitHub releases API. Takes an injectable `fetch` so
   tests never touch the network.
4. Download to a temp file **next to** the destination, extract (macOS ships a `.tgz`;
   Windows a bare `.exe`), `chmod +x`, run `--version`, and only then move into place.
   A half-finished download can never be mistaken for a working install.

`worker/tunnel.py` gained `resolve_binary()`: configured name on PATH → literal path →
this install's `data/bin` copy. It returns an **absolute** path, which also removes a
long-standing landmine — launchd runs the worker with a minimal PATH that excludes
Homebrew, so a bare `cloudflared` was never resolvable there.

Both launchers call `.venv/bin/python -m worker.cloudflared_setup` in the first-run
block. Failure is non-fatal: composing and dry runs need no tunnel.

## The certificate trap

The first real download attempt failed with `CERTIFICATE_VERIFY_FAILED`. python.org's
macOS build ships **no CA store of its own** — it relies on a separate "Install
Certificates.command" that most people never run — so stdlib `urllib` cannot verify
`github.com` there. The rest of the worker never hit this because `requests` bundles
`certifi`.

Fix: `_ssl_context()` uses certifi's bundle when importable and falls back to the system
store otherwise, and the launchers run the module with the **venv** Python (which has
certifi) rather than the system one. `certifi` is now declared directly in
`requirements.txt` — it already arrived via `requests`, but the direct import should be
intentional rather than an accident of the dependency tree.

Verification is never disabled. This downloads an executable that then gets run; an
unverified connection would be the weakest link in the entire install.

## Verified

- 28 new unit tests; full worker suite 508 passed.
- Real end-to-end download on macOS/arm64: 41.2 MB, extracted, executable, reports
  `cloudflared version 2026.7.3`. Second run re-downloads nothing.
- Real tunnel opened using the vendored binary with **nothing on PATH**, bytes fetched
  back through the public `trycloudflare.com` URL, then torn down cleanly.
- Windows path is code-reviewed but **untested** — no Windows machine available. Same
  caveat that already applies to the rest of `Start-SocialScheduler-Windows.bat`.
