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
PORT_PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null)"

# Say it once, up front, if either path found something. Killing the npm wrapper
# often frees the port before the sweep runs, so keying the message off the sweep
# alone meant a stopped dashboard was reported as nothing at all.
if [ -n "$DASH_PID" ] || [ -n "$PORT_PIDS" ]; then
  echo "Stopping the dashboard..."
  STOPPED_ANY=1
fi

if [ -n "$DASH_PID" ]; then
  kill "$DASH_PID" 2>/dev/null
fi
if [ -n "$PORT_PIDS" ]; then
  # shellcheck disable=SC2086
  kill $PORT_PIDS 2>/dev/null
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
