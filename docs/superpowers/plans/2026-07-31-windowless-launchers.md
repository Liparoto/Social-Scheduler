# Windowless Start/Stop Launchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Start and Stop double-clickable files that leave no console window behind, so the dashboard survives closing whatever launched it.

**Architecture:** The Start scripts keep their existing preflight and safety prompts but launch the dashboard and worker as detached background processes, record their PIDs under `data/run/`, then close their own window. A paired Stop script reads those PIDs and terminates everything, with a port sweep as a backstop. A detached watchdog stops the worker after `WORKER_AUTO_STOP_HOURS` (default 12) so a windowless real-posting worker cannot run unattended forever.

**Tech Stack:** Bash + AppleScript (macOS), batch + VBScript/WMI (Windows). No new dependencies.

**Spec:** [docs/design-launcher-windowless.md](../../design-launcher-windowless.md)

## Global Constraints

- Port is `3939` everywhere. It is set via `PORT=3939` and `npm run dev` reads it.
- Runtime state lives in `data/run/`: `dashboard.pid`, `worker.pid`, `watchdog.pid`, `worker.deadline`. `data/` is already gitignored — never commit anything from it.
- Logs go to `data/logs/`: `dashboard.log` (overwrite each start), `worker-daemon.out` (append).
- Worker entry point is `.venv/bin/python -m worker.run` (Mac) / `.venv\Scripts\python -m worker.run` (Windows).
- Start steps 1–7 of the existing scripts are preserved verbatim: Node/Python preflight, `.env` creation from `.env.example`, `migrate.py`, first-run `npm install`, first-run venv + `pip install -r requirements.txt`, the "Compose only vs Go live" question, and the `DRY_RUN=0` → "type YES" guard including the `cloudflared` warning.
- `WORKER_AUTO_STOP_HOURS` default is `12`. It applies in dry-run too.
- Scripts must never leave the user unable to stop things. Every kill path has a port-sweep fallback.
- Every script writes messages a non-technical person can act on. No stack traces, no jargon.

## File Structure

| File | Responsibility |
|---|---|
| `Stop-SocialScheduler-Mac.command` | **New.** Kill recorded PIDs, sweep port 3939, clean `data/run/`, report, close window. |
| `Start-SocialScheduler-Mac.command` | **Rewrite of step 8 only.** Detached launch, PID recording, watchdog, close window. |
| `scripts/run-hidden.vbs` | **New.** Windows-only. Spawns a command with no console window and prints its PID. |
| `Start-SocialScheduler-Windows.bat` | **Rewrite of step 8 only.** Windows mirror of the Mac Start. |
| `Stop-SocialScheduler-Windows.bat` | **New.** Windows mirror of the Mac Stop. |
| `.env.example` | **Edit.** Document `WORKER_AUTO_STOP_HOURS`. |
| `readme.md` | **Edit.** Replace "close the window to stop" with the Stop file. |

Stop is built first (Task 1) because it is the only task that can be verified against the dashboard already running right now, and because Tasks 2's verification needs a working Stop to reset between runs.

**A note on testing:** these are shell scripts with no unit-test harness in this repo, and adding one for four launcher scripts is not worth it. The test cycle for each macOS task is running the script and observing process/port state — the commands are given verbatim in each step. **The Windows tasks (3 and 4) have no verification step available**; there is no Windows machine in this setup and no reliable batch linter. They ship unverified and must be labeled as such.

---

### Task 1: macOS Stop script

**Files:**
- Create: `Stop-SocialScheduler-Mac.command`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the `data/run/` PID-file contract that Task 2 writes to — `dashboard.pid`, `worker.pid`, `watchdog.pid`, `worker.deadline`, each a plain text file containing one integer PID (or, for `worker.deadline`, a `YYYY-MM-DD HH:MM` local timestamp). Also produces `close_my_window()`, reused verbatim in Task 2.

- [ ] **Step 1: Write the script**

Create `Stop-SocialScheduler-Mac.command`:

```bash
#!/bin/bash
# ============================================================
#  SocialScheduler — Stop (macOS)
#  Double-click this file in Finder to stop SocialScheduler.
#  This window closes itself when it's done.
# ============================================================

cd "$(dirname "$0")" || exit 1

RUN_DIR="data/run"
PORT=3939

echo "=========================================="
echo "  SocialScheduler — Stopping"
echo "=========================================="
echo

# Close the Terminal window this script is running in. Fired in the background
# after a short delay so the shell exits first — Terminal then closes the window
# cleanly instead of asking "terminate running process?". Matching on tty means
# we can only ever close our own window, never one the user opened themselves.
# If this fails for any reason the window just stays open showing the messages
# above, which is the old behavior — never a broken run.
close_my_window() {
  local my_tty
  my_tty="$(tty 2>/dev/null)" || return 0
  case "$my_tty" in /dev/ttys*) ;; *) return 0 ;; esac
  (
    sleep 1
    osascript \
      -e 'tell application "Terminal"' \
      -e '  repeat with w in windows' \
      -e '    repeat with t in tabs of w' \
      -e '      try' \
      -e "        if tty of t is \"$my_tty\" then close w" \
      -e '      end try' \
      -e '    end repeat' \
      -e '  end repeat' \
      -e 'end tell'
  ) >/dev/null 2>&1 &
  disown 2>/dev/null
}

# Echo the PID held in file $1 only if that process is actually alive.
live_pid() {
  local p
  [ -f "$1" ] || return 1
  p="$(cat "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  echo "$p"
}

STOPPED_ANY=0

# ---- 1. The auto-stop timer, first, so it can't fire at a recycled PID later. ----
WATCHDOG_PID="$(live_pid "$RUN_DIR/watchdog.pid")"
if [ -n "$WATCHDOG_PID" ]; then
  kill "$WATCHDOG_PID" 2>/dev/null
  STOPPED_ANY=1
fi

# ---- 2. The worker. ----
if [ -f "$RUN_DIR/worker.deadline" ]; then
  echo "The worker was set to stop on its own at $(cat "$RUN_DIR/worker.deadline")."
fi
WORKER_PID="$(live_pid "$RUN_DIR/worker.pid")"
if [ -n "$WORKER_PID" ]; then
  echo "Stopping the worker..."
  kill "$WORKER_PID" 2>/dev/null
  STOPPED_ANY=1
fi

# ---- 3. The dashboard. ----
# Kill the npm wrapper we recorded, then sweep the port. The sweep is not a
# fallback, it's required: `npm run dev` spawns the actual Next.js server as a
# child, and killing npm can leave that child holding the port.
DASH_PID="$(live_pid "$RUN_DIR/dashboard.pid")"
if [ -n "$DASH_PID" ]; then
  kill "$DASH_PID" 2>/dev/null
  STOPPED_ANY=1
fi
PORT_PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null)"
if [ -n "$PORT_PIDS" ]; then
  echo "Stopping the dashboard..."
  # shellcheck disable=SC2086
  kill $PORT_PIDS 2>/dev/null
  STOPPED_ANY=1
fi

# ---- 4. Give things a moment, then insist if anything is still holding the port. ----
for _ in 1 2 3 4 5; do
  [ -z "$(lsof -ti "tcp:$PORT" 2>/dev/null)" ] && break
  sleep 1
done
PORT_PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null)"
if [ -n "$PORT_PIDS" ]; then
  # shellcheck disable=SC2086
  kill -9 $PORT_PIDS 2>/dev/null
  sleep 1
fi

# ---- 5. Clean up the bookkeeping files. ----
rm -f "$RUN_DIR/dashboard.pid" "$RUN_DIR/worker.pid" \
      "$RUN_DIR/watchdog.pid" "$RUN_DIR/worker.deadline"

echo
if [ "$STOPPED_ANY" = "1" ]; then
  echo "✅ Stopped. Nothing is running."
else
  echo "Nothing was running."
fi
echo

close_my_window
exit 0
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x Stop-SocialScheduler-Mac.command
```

- [ ] **Step 3: Confirm the dashboard is currently up, so the test means something**

Run:
```bash
lsof -nP -iTCP:3939 -sTCP:LISTEN
```
Expected: one `node` line. If empty, start one first with:
```bash
nohup env PORT=3939 npm --prefix dashboard run dev > data/logs/dashboard.log 2>&1 & disown
```
and re-check until it appears.

- [ ] **Step 4: Run Stop from the terminal and verify the port frees**

Run:
```bash
./Stop-SocialScheduler-Mac.command; echo "--- after ---"; lsof -nP -iTCP:3939 -sTCP:LISTEN || echo "port 3939 is free"
```
Expected: prints "Stopping the dashboard...", then "✅ Stopped. Nothing is running.", then "port 3939 is free". No `node` line.

Note: run from the terminal, not Finder, for this step — `close_my_window` returns early when there is no Terminal tty, so it will not try to close anything.

- [ ] **Step 5: Verify the no-op path**

Run:
```bash
./Stop-SocialScheduler-Mac.command
```
Expected: "Nothing was running." Exit code 0. Running Stop twice must never error.

- [ ] **Step 6: Commit**

```bash
git add Stop-SocialScheduler-Mac.command
git commit -m "feat(launcher): add double-click Stop for macOS"
```

---

### Task 2: macOS Start script — detached launch

**Files:**
- Modify: `Start-SocialScheduler-Mac.command:139-158` (replace section 8; sections 1–7 untouched)
- Modify: `.env.example` (add `WORKER_AUTO_STOP_HOURS`)

**Interfaces:**
- Consumes: `close_my_window()` and the `data/run/` PID-file contract from Task 1; the existing `env_value()` and `pause_and_exit()` helpers already defined at lines 32–44 of the script.
- Produces: `data/run/dashboard.pid`, `data/run/worker.pid`, `data/run/watchdog.pid` (one integer each), `data/run/worker.deadline` (`YYYY-MM-DD HH:MM`). Task 4's Windows Stop mirrors this contract.

- [ ] **Step 1: Add the config key to `.env.example`**

Append to `.env.example`:

```bash
# How long the worker runs before stopping itself, in hours (default 12).
# The worker publishes for real when DRY_RUN=0, and the launcher runs it with no
# visible window — this timer is what stops a forgotten worker from posting
# unattended for days. Double-clicking Stop always ends it immediately.
# Applies in dry-run too, so the behavior is the same every time.
WORKER_AUTO_STOP_HOURS=12
```

- [ ] **Step 2: Add `close_my_window()` to the Start script**

Insert into `Start-SocialScheduler-Mac.command` immediately after the `env_value()` function (after line 44), the exact same function body written in Task 1 Step 1:

```bash
# Close the Terminal window this script is running in. Fired in the background
# after a short delay so the shell exits first — Terminal then closes the window
# cleanly instead of asking "terminate running process?". Matching on tty means
# we can only ever close our own window, never one the user opened themselves.
# If this fails for any reason the window just stays open showing the messages
# above, which is the old behavior — never a broken run.
close_my_window() {
  local my_tty
  my_tty="$(tty 2>/dev/null)" || return 0
  case "$my_tty" in /dev/ttys*) ;; *) return 0 ;; esac
  (
    sleep 1
    osascript \
      -e 'tell application "Terminal"' \
      -e '  repeat with w in windows' \
      -e '    repeat with t in tabs of w' \
      -e '      try' \
      -e "        if tty of t is \"$my_tty\" then close w" \
      -e '      end try' \
      -e '    end repeat' \
      -e '  end repeat' \
      -e 'end tell'
  ) >/dev/null 2>&1 &
  disown 2>/dev/null
}

# Echo the PID held in file $1 only if that process is actually alive.
live_pid() {
  local p
  [ -f "$1" ] || return 1
  p="$(cat "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  echo "$p"
}
```

- [ ] **Step 3: Delete the old worker-and-cleanup machinery**

The worker is no longer a child of this window, so the `trap`-based cleanup is wrong — it would kill the detached worker the moment the window closes, which is the whole thing we are removing.

Delete lines 19–30 (the `WORKER_PID=""` declaration, the `cleanup()` function, and the `trap cleanup EXIT INT TERM HUP` line).

Then delete lines 132–137, the old foreground worker launch:

```bash
  echo "Starting the worker..."
  .venv/bin/python -m worker.run &
  WORKER_PID=$!
  echo "Worker running (logs are in data/logs/). It stops automatically when you close this window."
  echo
```

Leave the surrounding `if [ "$MODE" = "live" ]` block and all the DRY_RUN / KILL_SWITCH messages above it intact.

- [ ] **Step 4: Add the already-running check before the mode question**

Insert immediately before section 6 ("Ask what to do", the `echo "What would you like to do?"` line):

```bash
# ---- 5b. Already running? Then just bring the browser back and get out of the way. ----
PORT=3939
RUN_DIR="data/run"
LOG_DIR="data/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

if [ -n "$(lsof -ti "tcp:$PORT" 2>/dev/null)" ]; then
  echo "SocialScheduler is already running."
  echo "Opening http://localhost:$PORT"
  echo
  echo "To stop it, double-click Stop-SocialScheduler-Mac.command"
  open "http://localhost:$PORT"
  echo
  close_my_window
  exit 0
fi
```

- [ ] **Step 5: Replace section 8 with the detached launch**

Replace everything from line 139 (`# ---- 8. Start the dashboard ...`) to the end of the file with:

```bash
# ---- 8. Start the worker detached, with a timer that stops it on its own. ----
if [ "$MODE" = "live" ]; then
  nohup .venv/bin/python -m worker.run >> "$LOG_DIR/worker-daemon.out" 2>&1 &
  WORKER_PID=$!
  disown
  echo "$WORKER_PID" > "$RUN_DIR/worker.pid"

  # How long before the worker stops itself. Anything unparseable falls back to 12.
  HOURS="$(env_value WORKER_AUTO_STOP_HOURS)"
  case "$HOURS" in
    ''|*[!0-9.]*) HOURS=12 ;;
  esac
  AUTO_SECS="$(python3 -c "print(int(float('$HOURS') * 3600))" 2>/dev/null)"
  case "$AUTO_SECS" in
    ''|0|*[!0-9]*) AUTO_SECS=43200; HOURS=12 ;;
  esac

  DEADLINE="$(python3 -c "import datetime; print((datetime.datetime.now() + datetime.timedelta(seconds=$AUTO_SECS)).strftime('%Y-%m-%d %H:%M'))")"
  echo "$DEADLINE" > "$RUN_DIR/worker.deadline"

  # The watchdog. Sleeps, then stops the worker and clears its bookkeeping.
  (
    sleep "$AUTO_SECS"
    kill "$WORKER_PID" 2>/dev/null
    rm -f "$RUN_DIR/worker.pid" "$RUN_DIR/watchdog.pid" "$RUN_DIR/worker.deadline"
  ) >/dev/null 2>&1 &
  WATCHDOG_PID=$!
  disown
  echo "$WATCHDOG_PID" > "$RUN_DIR/watchdog.pid"

  echo "Worker running in the background (logs are in data/logs/)."
  echo "It will stop on its own at $DEADLINE, or whenever you double-click Stop."
  echo
fi

# ---- 9. Start the dashboard detached. ----
echo "Starting the dashboard..."
nohup env PORT="$PORT" npm --prefix dashboard run dev > "$LOG_DIR/dashboard.log" 2>&1 &
DASH_PID=$!
disown
echo "$DASH_PID" > "$RUN_DIR/dashboard.pid"

# Wait until the dashboard actually answers before opening the browser. A fixed
# sleep guessed wrong on a cold start — Next.js compiles on first run, so the tab
# opened on a dead port and showed a connection error. Polls for up to 90s.
READY=0
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null "http://localhost:$PORT"; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" = "1" ]; then
  open "http://localhost:$PORT"
  echo "✅ Running at http://localhost:$PORT"
else
  echo "⚠️  The dashboard didn't start within 90 seconds."
  echo "    Check data/logs/dashboard.log for the reason."
  echo "    If it starts later, open http://localhost:$PORT yourself."
fi

echo
echo "You can close this window — everything keeps running."
echo "To stop it, double-click Stop-SocialScheduler-Mac.command"
echo

close_my_window
exit 0
```

- [ ] **Step 6: Verify a clean start detaches**

Run:
```bash
./Stop-SocialScheduler-Mac.command >/dev/null 2>&1; printf '1\n' | ./Start-SocialScheduler-Mac.command
```
Expected: preflight output, "Starting the dashboard...", "✅ Running at http://localhost:3939", browser opens.

Then confirm the PID files and the port:
```bash
cat data/run/dashboard.pid; lsof -nP -iTCP:3939 -sTCP:LISTEN
```
Expected: a PID, and one `node` LISTEN line.

- [ ] **Step 7: Verify it survives its parent dying**

This is the actual bug being fixed, so verify it directly. Run:
```bash
bash -c 'printf "1\n" | ./Start-SocialScheduler-Mac.command >/dev/null 2>&1' ; sleep 2; curl -s -o /dev/null -w "still answering: HTTP %{http_code}\n" http://localhost:3939/
```
Expected: `still answering: HTTP 200` — the server outlived the shell that started it.

(The `already running` path will trigger on the second start; that is expected and is itself covered by Step 8.)

- [ ] **Step 8: Verify the already-running path does not double-start**

With the dashboard up, run:
```bash
printf '1\n' | ./Start-SocialScheduler-Mac.command; echo "--- listeners ---"; lsof -nP -iTCP:3939 -sTCP:LISTEN | wc -l
```
Expected: "SocialScheduler is already running." and exactly one listener line (`1`). No second server.

- [ ] **Step 9: Verify the worker path and the deadline**

Run:
```bash
./Stop-SocialScheduler-Mac.command >/dev/null 2>&1
printf '2\nYES\n' | ./Start-SocialScheduler-Mac.command
echo "--- run dir ---"; cat data/run/worker.deadline; ps -p "$(cat data/run/worker.pid)" -o pid=,command= ; ps -p "$(cat data/run/watchdog.pid)" -o pid= 
```
Expected: `worker.deadline` is a timestamp ~12 hours ahead of now; the worker PID is a live `python -m worker.run`; the watchdog PID is live.

**Caution:** this starts the real worker and `.env` has `DRY_RUN=0`. Before running this step, set `KILL_SWITCH=1` in `.env` so nothing publishes during the test, and set it back to `0` afterward. Confirm with `grep KILL_SWITCH .env` before and after.

- [ ] **Step 10: Verify Stop clears everything the worker path created**

Run:
```bash
./Stop-SocialScheduler-Mac.command
echo "--- leftovers ---"; ls data/run/ 2>/dev/null; lsof -ti tcp:3939 || echo "port free"
```
Expected: reports the deadline and stops both, `data/run/` is empty, "port free".

- [ ] **Step 11: Verify the window actually closes from Finder**

This is the one behavior no terminal command can prove. Manual check:

1. Double-click `Start-SocialScheduler-Mac.command` in Finder
2. Choose `1`
3. Expected: the Terminal window closes on its own within ~2 seconds of the browser opening, and no other Terminal window you had open is affected
4. Double-click `Stop-SocialScheduler-Mac.command`
5. Expected: that window also closes on its own

Report the result. If the window does not close, the launch itself still worked — note it as a cosmetic failure rather than blocking the task.

- [ ] **Step 12: Commit**

```bash
git add Start-SocialScheduler-Mac.command .env.example
git commit -m "feat(launcher): macOS Start runs detached and closes its own window"
```

---

### Task 3: Windows hidden-launch helper and Start script

**Files:**
- Create: `scripts/run-hidden.vbs`
- Modify: `Start-SocialScheduler-Windows.bat:146-167` (replace section 8 and the trailing cleanup; sections 1–7 and the `:env_value` helper untouched)

**Interfaces:**
- Consumes: the `data/run/` PID-file contract from Task 2 — same four filenames, same formats.
- Produces: `scripts/run-hidden.vbs`, invoked as `cscript //nologo scripts\run-hidden.vbs "<command line>"`, which spawns the command with no window and prints its PID as a bare integer on stdout. Task 4's Stop reads the PID files this writes.

**No verification is available for this task.** There is no Windows machine in this setup and no reliable batch-syntax linter. Write it carefully against the Task 2 logic and label it unverified in the commit message.

- [ ] **Step 1: Create the hidden-launch helper**

Create `scripts/run-hidden.vbs`:

```vbscript
' ============================================================
'  run-hidden.vbs — launch a command with no console window.
'
'  Usage:  cscript //nologo scripts\run-hidden.vbs "<command line>"
'  Prints: the new process's PID, so the caller can stop it later.
'
'  Why this exists: a .bat cannot start a truly windowless process.
'  `start /b` and `start /min` both still leave a console attached.
'  Win32_Process.Create with ShowWindow=0 does not, and unlike
'  WScript.Shell.Run it hands back a PID.
' ============================================================

If WScript.Arguments.Count < 1 Then
  WScript.StdErr.WriteLine "run-hidden.vbs: no command given"
  WScript.Quit 1
End If

Dim svc, startup, proc, pid, rc
Set svc = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")

Set startup = svc.Get("Win32_ProcessStartup").SpawnInstance_
startup.ShowWindow = 0            ' SW_HIDE

Set proc = svc.Get("Win32_Process")
rc = proc.Create(WScript.Arguments(0), Null, startup, pid)

If rc <> 0 Then
  WScript.StdErr.WriteLine "run-hidden.vbs: could not start (code " & rc & ")"
  WScript.Quit 1
End If

WScript.Echo pid
WScript.Quit 0
```

- [ ] **Step 2: Add the already-running check before section 6**

Insert into `Start-SocialScheduler-Windows.bat` immediately before `REM ---- 6. Ask what to do. ----`:

```bat
REM ---- 5b. Already running? Then just bring the browser back and get out of the way. ----
set PORT=3939
set "RUN_DIR=data\run"
set "LOG_DIR=data\logs"
if not exist "%RUN_DIR%" mkdir "%RUN_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

set "ALREADY="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do set "ALREADY=%%a"
if defined ALREADY (
  echo SocialScheduler is already running.
  echo Opening http://localhost:%PORT%
  echo.
  echo To stop it, double-click Stop-SocialScheduler-Windows.bat
  start "" "http://localhost:%PORT%"
  exit /b 0
)
```

- [ ] **Step 3: Replace the old worker launch**

Delete lines 140–143 of the original:

```bat
  echo Starting the worker in its own window...
  start "SocialScheduler Worker" cmd /c ""%~dp0.venv\Scripts\python" -m worker.run"
  echo Worker running in the "SocialScheduler Worker" window (logs are in data\logs\).
  echo.
```

Replace with the hidden launch plus the auto-stop timer:

```bat
  echo Starting the worker in the background...
  set "WORKER_PID="
  for /f %%p in ('cscript //nologo scripts\run-hidden.vbs "cmd /c """"%~dp0.venv\Scripts\python"""" -m worker.run >> """"%~dp0%LOG_DIR%\worker-daemon.out"""" 2>&1"') do set "WORKER_PID=%%p"
  if defined WORKER_PID >"%RUN_DIR%\worker.pid" echo !WORKER_PID!

  REM How long before the worker stops itself. Anything unparseable falls back to 12.
  call :env_value WORKER_AUTO_STOP_HOURS AUTO_HOURS
  if not defined AUTO_HOURS set "AUTO_HOURS=12"
  set "AUTO_SECS="
  for /f %%s in ('python -c "print(int(float('!AUTO_HOURS!') * 3600))" 2^>NUL') do set "AUTO_SECS=%%s"
  if not defined AUTO_SECS set "AUTO_SECS=43200"

  set "DEADLINE="
  for /f "delims=" %%d in ('python -c "import datetime; print((datetime.datetime.now() + datetime.timedelta(seconds=!AUTO_SECS!)).strftime('%%Y-%%m-%%d %%H:%%M'))" 2^>NUL') do set "DEADLINE=%%d"
  if defined DEADLINE >"%RUN_DIR%\worker.deadline" echo !DEADLINE!

  REM The watchdog: waits, then stops the worker.
  set "WATCHDOG_PID="
  for /f %%p in ('cscript //nologo scripts\run-hidden.vbs "cmd /c timeout /t !AUTO_SECS! /nobreak >NUL & taskkill /PID !WORKER_PID! /T /F >NUL 2>&1"') do set "WATCHDOG_PID=%%p"
  if defined WATCHDOG_PID >"%RUN_DIR%\watchdog.pid" echo !WATCHDOG_PID!

  echo Worker running in the background ^(logs are in data\logs\^).
  echo It will stop on its own at !DEADLINE!, or whenever you double-click Stop.
  echo.
```

- [ ] **Step 4: Replace section 8 with the detached dashboard launch**

Replace everything from `REM ---- 8. Start the dashboard (foreground). ...` (line 146) to the end of the `pause` / `exit /b 0` block (line 167), keeping the `:env_value` helper that follows it:

```bat
REM ---- 8. Start the dashboard in the background. ----
echo Starting the dashboard...
set "DASH_PID="
for /f %%p in ('cscript //nologo scripts\run-hidden.vbs "cmd /c cd /d """"%~dp0dashboard"""" ^&^& npm run dev > """"%~dp0%LOG_DIR%\dashboard.log"""" 2>&1"') do set "DASH_PID=%%p"
if defined DASH_PID >"%RUN_DIR%\dashboard.pid" echo !DASH_PID!

REM Wait until the dashboard actually answers before opening the browser. This used
REM to fire immediately, so the tab always opened on a dead port. Next.js compiles
REM on a cold start, so poll for up to 90 seconds.
set "READY="
for /l %%i in (1,1,90) do (
  if not defined READY (
    curl -sf -o NUL http://localhost:%PORT% && set "READY=1"
    if not defined READY timeout /t 1 /nobreak >NUL
  )
)

if defined READY (
  start "" "http://localhost:%PORT%"
  echo [OK] Running at http://localhost:%PORT%
) else (
  echo [!] The dashboard didn't start within 90 seconds.
  echo     Check data\logs\dashboard.log for the reason.
  echo     If it starts later, open http://localhost:%PORT% yourself.
)

echo.
echo This window will close - everything keeps running.
echo To stop it, double-click Stop-SocialScheduler-Windows.bat
echo.
exit /b 0
```

Note the removed `pause` — that is what lets the console window close on its own when the script ends.

- [ ] **Step 5: Set `PORT` for the dashboard process**

The Mac version passes `PORT=3939` in the launched process's environment. The batch `set PORT=3939` in Step 2 is inherited by the `cscript` child and onward to `npm`, so no extra work is needed — but confirm `set PORT=3939` appears *before* the dashboard launch in the final file, not only inside the already-running block.

- [ ] **Step 6: Commit**

```bash
git add scripts/run-hidden.vbs Start-SocialScheduler-Windows.bat
git commit -m "feat(launcher): Windows Start runs detached with no console window

UNVERIFIED - no Windows machine available to test on. Mirrors the
verified macOS logic in Start-SocialScheduler-Mac.command."
```

---

### Task 4: Windows Stop script

**Files:**
- Create: `Stop-SocialScheduler-Windows.bat`

**Interfaces:**
- Consumes: the `data/run/` PID-file contract written by Task 3, and `scripts/run-hidden.vbs` is *not* used here (Stop is allowed a brief visible window since it exits immediately).
- Produces: nothing consumed by later tasks.

**No verification is available for this task**, for the same reason as Task 3.

- [ ] **Step 1: Write the script**

Create `Stop-SocialScheduler-Windows.bat`:

```bat
@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   SocialScheduler - Stop (Windows)
REM   Double-click this file to stop SocialScheduler.
REM   This window closes itself when it's done.
REM ============================================================

cd /d "%~dp0"

set PORT=3939
set "RUN_DIR=data\run"
set "STOPPED_ANY="

echo ==========================================
echo   SocialScheduler - Stopping
echo ==========================================
echo.

REM ---- 1. The auto-stop timer, first, so it can't fire at a recycled PID later. ----
if exist "%RUN_DIR%\watchdog.pid" (
  set /p WATCHDOG_PID=<"%RUN_DIR%\watchdog.pid"
  if defined WATCHDOG_PID (
    taskkill /PID !WATCHDOG_PID! /T /F >NUL 2>&1
    if not errorlevel 1 set "STOPPED_ANY=1"
  )
)

REM ---- 2. The worker. ----
if exist "%RUN_DIR%\worker.deadline" (
  set /p DEADLINE=<"%RUN_DIR%\worker.deadline"
  echo The worker was set to stop on its own at !DEADLINE!.
)
if exist "%RUN_DIR%\worker.pid" (
  set /p WORKER_PID=<"%RUN_DIR%\worker.pid"
  if defined WORKER_PID (
    echo Stopping the worker...
    taskkill /PID !WORKER_PID! /T /F >NUL 2>&1
    if not errorlevel 1 set "STOPPED_ANY=1"
  )
)

REM ---- 3. The dashboard. Kill the recorded process, then sweep the port. The
REM sweep is not a fallback, it's required: npm spawns the actual Next.js server
REM as a child, and killing npm can leave that child holding the port. ----
if exist "%RUN_DIR%\dashboard.pid" (
  set /p DASH_PID=<"%RUN_DIR%\dashboard.pid"
  if defined DASH_PID (
    taskkill /PID !DASH_PID! /T /F >NUL 2>&1
    if not errorlevel 1 set "STOPPED_ANY=1"
  )
)

set "FOUND_PORT="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do (
  set "FOUND_PORT=1"
  taskkill /PID %%a /T /F >NUL 2>&1
)
if defined FOUND_PORT (
  echo Stopping the dashboard...
  set "STOPPED_ANY=1"
)

REM ---- 4. Clean up the bookkeeping files. ----
del /q "%RUN_DIR%\dashboard.pid" "%RUN_DIR%\worker.pid" "%RUN_DIR%\watchdog.pid" "%RUN_DIR%\worker.deadline" >NUL 2>&1

echo.
if defined STOPPED_ANY (
  echo [OK] Stopped. Nothing is running.
) else (
  echo Nothing was running.
)
echo.
exit /b 0
```

- [ ] **Step 2: Commit**

```bash
git add Stop-SocialScheduler-Windows.bat
git commit -m "feat(launcher): add double-click Stop for Windows

UNVERIFIED - no Windows machine available to test on. Mirrors the
verified macOS logic in Stop-SocialScheduler-Mac.command."
```

---

### Task 5: Update the docs that still say "close the window"

**Files:**
- Modify: `readme.md`
- Modify: `docs/tasks.md`
- Modify: `docs/design-launcher-windowless.md` (flip Status to built)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing.

- [ ] **Step 1: Find every stale instruction**

Run:
```bash
grep -rn -i "close.*window\|close this window\|Start-SocialScheduler" readme.md docs/ --include="*.md"
```

Read each hit. Any text telling the reader to close a window to stop the app is now wrong.

- [ ] **Step 2: Update `readme.md`**

Rewrite the run instructions so they name the four files. The replacement text:

```markdown
### Running it

- **Start** — double-click `Start-SocialScheduler-Mac.command`
  (Windows: `Start-SocialScheduler-Windows.bat`). It asks whether you want to
  compose only or go live, then opens the dashboard at http://localhost:3939 and
  closes its own window. Everything keeps running in the background.
- **Stop** — double-click `Stop-SocialScheduler-Mac.command`
  (Windows: `Stop-SocialScheduler-Windows.bat`).

Double-clicking Start again while it's already running just reopens the browser
tab — it won't start a second copy, so it doubles as an "is it on?" check.

If you chose **Go live**, the worker stops itself after 12 hours so it can't keep
publishing unattended if you forget. Change that with `WORKER_AUTO_STOP_HOURS` in
your `.env`.

Logs live in `data/logs/` — `dashboard.log` and `worker-daemon.out`.
```

- [ ] **Step 3: Update `docs/tasks.md`**

Add a completed phase entry recording this work, matching the file's existing phase format. Include the unverified-on-Windows caveat.

- [ ] **Step 4: Flip the design doc status**

In `docs/design-launcher-windowless.md`, change:

```markdown
**Status:** approved, not yet built
```

to:

```markdown
**Status:** built and verified on macOS; Windows scripts unverified
```

- [ ] **Step 5: Verify no stale instructions remain**

Run:
```bash
grep -rn -i "close this window to stop\|closing the window stops\|stops everything" readme.md docs/*.md
```
Expected: no hits, or only hits inside `docs/design-launcher-windowless.md` describing the *old* behavior in the Problem section, which is correct and should stay.

- [ ] **Step 6: Commit**

```bash
git add readme.md docs/tasks.md docs/design-launcher-windowless.md
git commit -m "docs: launchers run detached; document Stop and the worker auto-stop"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| `Stop-SocialScheduler-Mac.command` | 1 |
| Mac Start detached launch + PID recording | 2 |
| Mac window self-close via tty-matched AppleScript | 1 (function), 2 (reuse) |
| Already-running check doubles as status | 2 Step 4 |
| Worker auto-stop watchdog + `worker.deadline` | 2 Step 5 |
| `WORKER_AUTO_STOP_HOURS` in `.env.example`, default 12, applies in dry-run | 2 Step 1 |
| `scripts/run-hidden.vbs` | 3 |
| Windows Start rewrite, `pause` removed | 3 |
| `Stop-SocialScheduler-Windows.bat` | 4 |
| Port-sweep backstop so Stop can't wedge | 1 Step 1, 4 Step 1 |
| `data/run/` under gitignored `data/` | 2 Step 4 (`mkdir -p`) |
| Steps 1–7 of Start preserved | Global Constraints; 2 and 3 both scope edits to section 8 only |
| Windows ships unverified and is labeled so | 3 and 4 commit messages, 5 Step 4 |

**Two things this plan adds that the spec did not state:**

1. **Deleting the `trap cleanup` block** (Task 2 Step 3). The spec said sections 1–7 are preserved, but the `trap` at line 30 sits above them and would kill the detached worker the instant the window closes — the exact opposite of the goal. It must go.
2. **The port sweep is mandatory, not a fallback.** The spec framed `lsof -ti tcp:3939` as a fallback for stale PID files. It is actually required on every run: `npm run dev` spawns Next.js as a child, and `$!` records the npm wrapper, so killing only the recorded PID can orphan the server. Both Stop scripts now always sweep.

**Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N". Every code step has literal content.

**Type consistency:** the four `data/run/` filenames and their formats are identical across Tasks 1, 2, 3, and 4. `close_my_window()` and `live_pid()` are byte-identical in Tasks 1 and 2. `run-hidden.vbs` is invoked with the same `cscript //nologo` + single-quoted-argument form in both places it appears in Task 3.
