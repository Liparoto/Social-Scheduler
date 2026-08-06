#!/bin/bash
# ============================================================
#  SocialScheduler — Stop (macOS)
#  Double-click this file in Finder to stop SocialScheduler.
#  This window closes itself when it's done.
# ============================================================

cd "$(dirname "$0")" || exit 1

RUN_DIR="data/run"
PORT=3939
# Absolute, symlink-resolved, so it can be compared against a process's own cwd.
INSTALL_DIR="$(pwd -P)"

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

# Every running worker belonging to THIS install, found by looking at the process table
# rather than by trusting a pid file.
#
# This exists because a pid file is not the truth. The worker can be running with no
# worker.pid at all — launchd owns its own copy, and a nohup worker whose pid file was
# deleted (a stray `rm`, a half-finished Stop, an interrupted Start) becomes invisible to
# every check above. That worker keeps publishing while this script reports success, and
# the next Start adds a SECOND one: there is no single-instance guard and no row claiming,
# so two daemons will happily publish the same due row twice, to a real account.
#
# Scoped by working directory, NOT by process name: another clone of this repo is a
# separate install with its own database and its own queue, and stopping someone else's
# worker would be its own kind of damage. lsof reads the cwd of each candidate; only pids
# whose cwd is this exact directory are ours.
install_worker_pids() {
  local pids pid cwd
  pids="$(pgrep -f 'worker\.run' 2>/dev/null)" || return 0
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ "$cwd" = "$INSTALL_DIR" ] && echo "$pid"
  done
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

# The autostart LaunchAgent, when it is installed. launchd owns that process, so there is
# no worker.pid for it and the block above cannot see it — without this, Stop would report
# success while the worker kept running and publishing.
#
# SIGTERM, deliberately, not `bootout`: the worker exits 0 on SIGTERM and the agent's
# KeepAlive rule only restarts on a NON-zero exit, so this really stops it while leaving
# the agent registered to come back at the next login. `bootout` would also work but would
# quietly disable autostart, which is not what "Stop" should mean.
AGENT="com.socialscheduler.worker"
if launchctl print "gui/$UID/$AGENT" >/dev/null 2>&1; then
  AGENT_PID="$(launchctl print "gui/$UID/$AGENT" 2>/dev/null | awk -F'= ' '/^\tpid = /{print $2; exit}')"
  if [ -n "$AGENT_PID" ]; then
    echo "Stopping the worker (autostart agent, pid $AGENT_PID)..."
    launchctl kill TERM "gui/$UID/$AGENT" 2>/dev/null
    STOPPED_ANY=1
  fi
fi

# ---- 2c. Confirm the worker is really gone; sweep anything the pid file missed. ----
#
# Everything above ASKED processes to stop. Nothing so far has checked whether any of them
# did. This is the only part that looks at reality, and it matters more here than anywhere
# else in this script: the cost of wrongly reporting "stopped" is a second daemon
# publishing to a live account on the next Start.
#
# It also catches the worker no pid file knows about (see install_worker_pids), which is
# why the sweep runs even when the blocks above found nothing to stop.
WORKER_SURVIVORS="$(install_worker_pids)"
if [ -n "$WORKER_SURVIVORS" ]; then
  # An untracked worker gets its own line: it means a pid file was lost, which is worth
  # knowing about rather than silently cleaning up.
  if [ -z "$WORKER_PID" ] && [ -z "$AGENT_PID" ]; then
    echo "Found a worker running that no pid file tracked (pid $(echo $WORKER_SURVIVORS | tr '\n' ' '))."
    echo "Stopping it..."
    STOPPED_ANY=1
  fi
  # SIGTERM first — the worker exits 0 on TERM, which finishes the current cycle cleanly
  # and, for the launchd agent, avoids tripping its restart-on-crash rule.
  for pid in $WORKER_SURVIVORS; do kill "$pid" 2>/dev/null; done

  # Give it a few seconds. A cycle mid-publish can take a moment to unwind, and killing
  # it harder than necessary is how a half-written publication happens.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    WORKER_SURVIVORS="$(install_worker_pids)"
    [ -z "$WORKER_SURVIVORS" ] && break
    sleep 1
  done

  # Still there: escalate, then check ONE more time so the final message reflects the
  # outcome rather than the attempt.
  if [ -n "$WORKER_SURVIVORS" ]; then
    echo "The worker did not stop on request — forcing it."
    for pid in $WORKER_SURVIVORS; do kill -9 "$pid" 2>/dev/null; done
    sleep 1
    WORKER_SURVIVORS="$(install_worker_pids)"
  fi
fi

# ---- 3. The dashboard. ----
# Kill the npm wrapper we recorded, then sweep the port. The sweep is not a
# fallback, it's required: `npm run dev` spawns the actual Next.js server as a
# child, and killing npm can leave that child holding the port.
DASH_PID="$(live_pid "$RUN_DIR/dashboard.pid")"
# -sTCP:LISTEN matters: without it lsof also returns every CLIENT connected to the
# port — a browser tab with the dashboard open, for instance — and the kill/kill -9
# below would take those down too. Only the process actually LISTENING is ours.
PORT_PIDS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)"

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
  [ -z "$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)" ] && break
  sleep 1
done
PORT_PIDS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -n "$PORT_PIDS" ]; then
  # shellcheck disable=SC2086
  kill -9 $PORT_PIDS 2>/dev/null
  sleep 1
fi

# ---- 5. Clean up the bookkeeping files. ----
#
# Only remove worker.pid once the worker is actually gone. Deleting it while a worker is
# still alive is what CREATES an untracked worker: the next Start would see no pid file,
# assume nothing is running, and launch a second daemon alongside the first.
rm -f "$RUN_DIR/dashboard.pid" "$RUN_DIR/watchdog.pid" "$RUN_DIR/worker.deadline"
if [ -z "$WORKER_SURVIVORS" ]; then
  rm -f "$RUN_DIR/worker.pid"
fi

# ---- 6. Report what is actually true. ----
DASH_LEFT="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)"

echo
if [ -n "$WORKER_SURVIVORS" ] || [ -n "$DASH_LEFT" ]; then
  # Never claim success while something survives. A false "Nothing is running" is worse
  # than no message at all: it is the message that makes someone press Start again.
  echo "⚠️  Something is STILL running — do not press Start."
  echo
  if [ -n "$WORKER_SURVIVORS" ]; then
    echo "   The worker survived, even after being forced:"
    for pid in $WORKER_SURVIVORS; do
      echo "     pid $pid   ->   kill -9 $pid"
    done
    echo
    echo "   Starting again now would run TWO workers against one queue, and a due post"
    echo "   would publish twice. Stop this one by hand first."
    echo
    echo "   To halt publishing immediately without stopping anything, set"
    echo "   KILL_SWITCH=1 in .env — the worker checks it every cycle."
  fi
  if [ -n "$DASH_LEFT" ]; then
    echo "   The dashboard is still holding port $PORT (pid $(echo $DASH_LEFT | tr '\n' ' '))."
  fi
elif [ "$STOPPED_ANY" = "1" ]; then
  echo "✅ Stopped. Nothing is running."
else
  echo "Nothing was running."
fi
echo

close_my_window
exit 0
