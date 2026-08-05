#!/bin/bash
# ============================================================
#  SocialScheduler — Start (macOS)
#  Double-click this file in Finder to run SocialScheduler.
#  (First time only: if macOS blocks it, right-click → Open.)
#
#  It sets everything up, then asks whether you want to just
#  compose, or go live (compose + actually publish).
# ============================================================

# Always work from the folder this script lives in (the repo root).
cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  SocialScheduler"
echo "=========================================="
echo

pause_and_exit() {
  echo
  echo "$1"
  echo "Press any key to close this window..."
  read -r -n 1
  exit 1
}

# Read a value for KEY from .env (last match wins), with spaces stripped. Empty if absent.
env_value() {
  [ -f ".env" ] || return 0
  grep -E "^[[:space:]]*$1=" ".env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]'
}

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

# ---- 1. Preflight: the two things that must be installed. ----
if ! command -v node >/dev/null 2>&1; then
  pause_and_exit "Node.js isn't installed. Get it from https://nodejs.org (choose LTS), then double-click this again."
fi
if ! command -v python3 >/dev/null 2>&1; then
  pause_and_exit "Python 3 isn't installed. Get it from https://www.python.org/downloads/ , then double-click this again."
fi

# ---- 2. First-run config: create .env from the template if it's missing. ----
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp ".env.example" ".env"
  echo "Created .env from the template. Add your Meta credentials there when you're ready."
  echo
fi

# ---- 3. Make sure the database exists / is up to date (safe to run every time). ----
echo "Preparing the database..."
python3 migrate.py || pause_and_exit "Database setup failed (see the message above)."
echo

# ---- 4. Install the dashboard's dependencies on first run. ----
if [ ! -d "dashboard/node_modules" ]; then
  echo "First run — installing dashboard dependencies (this can take a minute)..."
  ( cd dashboard && npm install ) || pause_and_exit "Installing dashboard dependencies failed (see above)."
  echo
fi

# ---- 5. Set up the worker's Python environment on first run. ----
if [ ! -d ".venv" ]; then
  echo "First run — setting up the worker (this can take a minute)..."
  python3 -m venv .venv || pause_and_exit "Couldn't create the Python environment."
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install -r requirements.txt || pause_and_exit "Installing worker dependencies failed (see above)."
  echo
fi

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

# ---- 6. Ask what to do. ----
echo "What would you like to do?"
echo "  1) Compose only  — open the dashboard; nothing will be posted (safe)"
echo "  2) Go live       — open the dashboard AND run the worker that publishes"
echo
read -r -p "Enter 1 or 2 [1]: " choice
choice="${choice:-1}"
echo

MODE="compose"
if [ "$choice" = "2" ]; then
  MODE="live"
fi

# ---- 7. If going live, respect the safety switches before starting the worker. ----
if [ "$MODE" = "live" ]; then
  DRY_RUN="$(env_value DRY_RUN)"
  KILL_SWITCH="$(env_value KILL_SWITCH)"

  if [ "$DRY_RUN" = "0" ]; then
    # Real posting. Make sure she means it, and warn if the delivery tool is missing.
    if ! command -v cloudflared >/dev/null 2>&1; then
      echo "⚠️  cloudflared isn't installed — it's needed to deliver your images to Meta for REAL posts."
      echo "    Install it once with:  brew install cloudflared"
      echo "    (You don't need it while DRY_RUN=1 — dry-run posts nothing.)"
      echo
    fi
    echo "⚠️  DRY_RUN is OFF in your .env. Going live will POST to Instagram/Facebook FOR REAL."
    read -r -p "Type YES (all caps) to post for real, or just press Enter to compose safely: " confirm
    echo
    if [ "$confirm" != "YES" ]; then
      echo "Okay — starting in Compose only mode. Nothing will be posted."
      echo
      MODE="compose"
    fi
  fi
fi

if [ "$MODE" = "live" ]; then
  DRY_RUN="$(env_value DRY_RUN)"
  KILL_SWITCH="$(env_value KILL_SWITCH)"
  if [ "$DRY_RUN" != "0" ]; then
    echo "DRY-RUN is on: the worker will show what it WOULD post but publish nothing."
    echo "When you're ready to go live for real, set DRY_RUN=0 in your .env file."
    echo
  fi
  if [ "$KILL_SWITCH" = "1" ]; then
    echo "Note: KILL_SWITCH is ON — the worker will run but publish nothing until you set KILL_SWITCH=0 in .env."
    echo
  fi
  echo "Starting the worker in the background..."
  nohup .venv/bin/python -m worker.run >> "$LOG_DIR/worker-daemon.out" 2>&1 &
  WORKER_PID=$!
  disown
  echo "$WORKER_PID" > "$RUN_DIR/worker.pid"

  # How long before the worker stops itself. Anything unparseable falls back to 12.
  # This exists because the worker publishes for real and now runs with no visible
  # window — without a deadline, a forgotten worker posts unattended for days.
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
  #
  # It must only ever act on ITS OWN worker. `sleep` is naive about wall clock — macOS
  # suspends it while the Mac is asleep — so a watchdog routinely wakes LONG after the
  # deadline recorded in worker.deadline, by which time the owner may have stopped and
  # restarted everything. Acting unconditionally at that point does real damage: it
  # deletes the CURRENT worker's pid files, leaving a worker that publishes for real
  # while Stop can no longer find it (it reports success and kills nothing), and it
  # signals a 12-hour-old PID number that may since have been recycled onto an
  # unrelated process.
  #
  # Guard: worker.pid must still name this watchdog's own worker. If it names anything
  # else — or is gone — another launch has taken over and this watchdog is obsolete, so
  # it exits quietly and touches nothing.
  (
    sleep "$AUTO_SECS"
    still_ours="$(cat "$RUN_DIR/worker.pid" 2>/dev/null | tr -d '[:space:]')"
    if [ "$still_ours" = "$WORKER_PID" ]; then
      # The files are ours, so clean them up either way. Only SIGNAL the PID if it is
      # still actually a worker — across a long sleep the number can belong to someone
      # else, and killing a stranger's process is worse than leaving ours running.
      if ps -p "$WORKER_PID" -o command= 2>/dev/null | grep -q "worker\.run"; then
        kill "$WORKER_PID" 2>/dev/null
      fi
      rm -f "$RUN_DIR/worker.pid" "$RUN_DIR/watchdog.pid" "$RUN_DIR/worker.deadline"
    fi
  ) >/dev/null 2>&1 &
  WATCHDOG_PID=$!
  disown
  echo "$WATCHDOG_PID" > "$RUN_DIR/watchdog.pid"

  echo "Worker running in the background (logs are in data/logs/)."
  echo "It will stop on its own at $DEADLINE, or whenever you double-click Stop."
  echo
fi

# ---- 8. Start the dashboard in the background. ----
echo "Starting the dashboard..."
nohup env PORT="$PORT" npm --prefix dashboard run dev > "$LOG_DIR/dashboard.log" 2>&1 &
DASH_PID=$!
disown
echo "$DASH_PID" > "$RUN_DIR/dashboard.pid"

# Wait until the dashboard actually answers before opening the browser. A fixed sleep
# guessed wrong on a cold start — Next.js compiles on first run, so the tab opened on a
# dead port, showed a connection error, and you had to type the address in yourself.
# Polls for up to 90s.
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
