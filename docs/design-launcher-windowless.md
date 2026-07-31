# Design — Windowless Start / Stop launchers

**Status:** built and verified on macOS; Windows scripts unverified
**Date:** 2026-07-31

## Problem

Today the Terminal window *is* the stop button. `Start-SocialScheduler-Mac.command`
runs `npm run dev` in the foreground (line 158) and tells you "Close this window to
stop everything" (line 142). The Windows `.bat` does the same, plus it spawns a second
window for the worker and a third to poll for the browser.

Two consequences:

1. **Clutter.** Running the app means one to three console windows sitting on screen
   for as long as you use it.
2. **Fragility.** Anything that closes the window kills the dashboard — including a
   Claude Code session ending, which is how it "keeps turning off."

## Goal

Double-click Start → things run → the window goes away. Double-click Stop → things
stop. No console windows in between.

## Non-goals

- Auto-start on login. Separate decision, not part of this.
- A menu-bar or tray app. Too much machinery for an internal tool.
- Changing anything about how the dashboard or worker themselves behave.

## Files

| File | Status | Purpose |
|---|---|---|
| `Start-SocialScheduler-Mac.command` | rewrite | Preflight + prompts, launch detached, close own window |
| `Stop-SocialScheduler-Mac.command` | new | Stop dashboard + worker, report, close |
| `Start-SocialScheduler-Windows.bat` | rewrite | Same |
| `Stop-SocialScheduler-Windows.bat` | new | Same |
| `scripts/run-hidden.vbs` | new | Windows-only helper; launches a command with no console window |
| `.env.example` | edit | Document `WORKER_AUTO_STOP_HOURS` |

## What does not change

Start steps 1–7 are kept verbatim:

- Node / Python preflight
- Create `.env` from `.env.example` on first run
- `python3 migrate.py`
- `npm install` on first run
- `venv` + `pip install -r requirements.txt` on first run
- The "Compose only vs Go live" question
- The `DRY_RUN=0` → "type YES to post for real" guard, and the `cloudflared` warning

These are the safety net. The rewrite touches only how processes are launched and how
the window is disposed of.

## How Start launches things

Replacing step 8.

1. **Already-running check.** If `data/run/dashboard.pid` names a live process, skip
   the launch, open the browser, say "already running," exit. Double-clicking Start is
   therefore also the "is it on?" check — no separate Status file to explain.
2. **Launch the dashboard detached.**
   - Mac: `nohup env PORT=3939 npm --prefix dashboard run dev > data/logs/dashboard.log 2>&1 & disown`
   - Windows: via `scripts/run-hidden.vbs`, logging to `data\logs\dashboard.log`
3. **Launch the worker detached** if the user chose Go live.
   - Mac: `nohup .venv/bin/python -m worker.run >> data/logs/worker-daemon.out 2>&1 & disown`
   - Windows: via the same `.vbs` helper, using `.venv\Scripts\python`
4. **Record PIDs** to `data/run/dashboard.pid`, `data/run/worker.pid`, and — when the
   worker is running — `data/run/watchdog.pid` for the auto-stop timer below.
5. **Poll the port** until `http://localhost:3939` answers (up to 90s — Next.js compiles
   on a cold start), then open the browser. This preserves the existing fix that stopped
   the tab from opening on a dead port.
6. **Print the URL** and "double-click Stop when you're done."
7. **Close the window.**

### Closing the window on macOS

A `.command` file leaves its Terminal window open after the script exits; Terminal's
default profile does not close on exit. The script therefore fires a background
AppleScript that closes the window owning the script's own `tty`, then exits
immediately. The one-second delay lets the shell exit first, so Terminal closes the
window cleanly instead of prompting "terminate running process?".

Matching on `tty` rather than window title means it cannot close an unrelated Terminal
window the user has open.

If the AppleScript fails for any reason — permissions, a non-Terminal terminal emulator
— the window simply stays open showing the "Running at … double-click Stop" message.
That is exactly today's behavior, so the failure mode is a cosmetic regression, never a
broken launch.

### Closing the window on Windows

A double-clicked `.bat` closes its console automatically when the script ends. The
rewrite just removes the trailing `pause` and stops running `npm run dev` in the
foreground. No trick needed.

`run-hidden.vbs` exists because `start /b` and `start /min` both still leave a console
window associated with the process. The `.vbs` shim launches a process with window style
0 (hidden) via `Win32_Process.Create`, which — unlike `WScript.Shell.Run` — also hands
back a PID so Stop can find it later.

**Changed during implementation:** the shim takes a **`.cmd` file path**, not a command
line. The commands it launches contain redirects, quotes, and paths with spaces (this
repo lives under `Claude Projects`), and threading those through batch's `for /f` quoting
rules is the single most likely thing to break in a script that cannot be tested here.
Start therefore writes `data/run/run-dashboard.cmd`, `run-worker.cmd`, and
`run-watchdog.cmd`, and passes one quoted path. Stop deletes them along with the PID
files.

## Worker auto-stop

`.env` on this install has `DRY_RUN=0` — the worker publishes for real. A detached
worker with no visible window could keep publishing unattended for days if the user
forgets to stop it.

Start therefore spawns a detached watchdog alongside the worker: it waits
`WORKER_AUTO_STOP_HOURS` (default **12**), then stops the worker by PID.

- Configured in `.env`, documented in `.env.example`.
- Applies in dry-run too. One rule with no exceptions is easier to reason about than a
  rule that behaves differently depending on a second setting.
- The absolute stop time is written to `data/run/worker.deadline` so Stop can report
  "worker was set to stop at 11:40pm."
- The watchdog stops only the worker. The dashboard runs until Stop — it publishes
  nothing, so there is no reason to time it out.

## Stop

1. Read `data/run/dashboard.pid`, `data/run/worker.pid`, and `data/run/watchdog.pid`;
   stop each one that is still live.
2. **Fallback:** if a PID file is missing or stale, kill whatever is listening on port
   3939 (`lsof -ti tcp:3939` / `netstat` + `taskkill`). Stop must never be wedged into a
   state where it cannot stop things.
3. Delete the PID and deadline files.
4. Print what was stopped — naming each one, or "nothing was running."
5. Close the window (same mechanism as Start).

## Storage

New directory `data/run/`, holding `dashboard.pid`, `worker.pid`, `watchdog.pid`, and
`worker.deadline`.

`data/` is already gitignored, so this stays per-install and nothing is committed —
consistent with the project rule that every clone owns its own state.

## Dependencies

None. Bash + AppleScript on macOS, batch + VBScript on Windows, all built in.

## Verification

**macOS — will be tested end to end:**

1. Double-click Start, choose Compose only → window closes, browser opens, dashboard answers
2. Quit Terminal entirely → dashboard still answers (proves detachment)
3. Double-click Start again → reports "already running," opens browser, does not start a second server
4. Double-click Stop → port 3939 free, PID files gone
5. Start with Go live → worker PID recorded, `worker.deadline` written ~12h out
6. Stop → worker gone, watchdog gone

**Windows — ships unverified.** There is no Windows machine available in this setup.
The batch scripts mirror the Mac logic and are written carefully, but they have not
been run. This is a known gap; the first person to run them on Windows should expect to
report bugs.
