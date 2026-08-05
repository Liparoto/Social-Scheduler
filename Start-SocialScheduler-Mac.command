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

# ---- The autostart LaunchAgent: the worker runs whenever you are logged in. ----
AGENT="com.socialscheduler.worker"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"

agent_installed() { launchctl print "gui/$UID/$AGENT" >/dev/null 2>&1; }
agent_pid()       { launchctl print "gui/$UID/$AGENT" 2>/dev/null | awk -F'= ' '/^\tpid = /{print $2; exit}'; }

# Install the agent and confirm it actually STARTED. Echoes nothing on success beyond a
# short confirmation; returns non-zero if launchd took the job but never spawned it.
enable_autostart() {
  local repo launchd_log
  repo="$(pwd -P)"
  # launchd gets its OWN stdout file, deliberately not the nohup log this script uses.
  # macOS stamps files created by a Terminal-launched process with a com.apple.provenance
  # xattr that CANNOT be removed (`xattr -d` silently no-ops), and launchd refuses to open
  # such a file for a job -- it then dies with exit 78 EX_CONFIG before the worker ever
  # runs, logging nothing anywhere. Deleting it first guarantees a fresh inode.
  launchd_log="$repo/data/logs/worker-launchd.out"
  mkdir -p "$HOME/Library/LaunchAgents" "$repo/data/logs"
  rm -f "$launchd_log"

  cat > "$AGENT_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$AGENT</string>

  <key>ProgramArguments</key>
  <array>
    <string>$repo/.venv/bin/python</string>
    <string>-m</string>
    <string>worker.run</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$repo</string>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart ONLY on a non-zero exit, i.e. a crash. The worker exits 0 on SIGTERM, so
       Stop-SocialScheduler-Mac.command genuinely stops it instead of fighting launchd. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <!-- launchd's default PATH is /usr/bin:/bin:/usr/sbin:/sbin. The worker shells out to
       cloudflared by bare name for the publish tunnel, so without this a REAL publish
       fails with "not found" -- at send time, the worst moment to find out. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$launchd_log</string>
  <key>StandardErrorPath</key>
  <string>$launchd_log</string>
</dict>
</plist>
PLIST_EOF

  # Retire the hand-started worker and its 12h auto-stop watchdog: a deadline
  # contradicts "always running", and two daemons would just be confusing.
  if [ -f "$RUN_DIR/watchdog.pid" ]; then
    kill "$(cat "$RUN_DIR/watchdog.pid" 2>/dev/null)" 2>/dev/null
    rm -f "$RUN_DIR/watchdog.pid" "$RUN_DIR/worker.deadline"
  fi
  if [ -f "$RUN_DIR/worker.pid" ]; then
    kill "$(cat "$RUN_DIR/worker.pid" 2>/dev/null)" 2>/dev/null
    rm -f "$RUN_DIR/worker.pid"
  fi

  launchctl bootout "gui/$UID/$AGENT" 2>/dev/null
  sleep 1
  launchctl bootstrap "gui/$UID" "$AGENT_PLIST" 2>/dev/null || launchctl load -w "$AGENT_PLIST" 2>/dev/null

  # A REGISTERED job is not a RUNNING job -- launchd will accept a plist and then fail to
  # spawn it forever. Wait for a real pid before claiming this worked.
  local i=0
  while [ $i -lt 20 ]; do
    [ -n "$(agent_pid)" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
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

# ---- 5c. Make sure cloudflared is here (it delivers your media to Meta). ----
#
# Deliberately unconditional, not gated on DRY_RUN=0. The old gate meant a fresh clone —
# which ships DRY_RUN=1 — was never even warned, and only found out it was missing when
# its first REAL publish failed. Getting it now, while we are already installing things,
# means going live later is just a flag change. It is a no-op once installed, and a
# failure here is never fatal: composing and dry runs need no tunnel.
#
# Run with the venv's Python, not the system one, because it needs certifi: python.org's
# macOS build trusts no certificates until you run its separate Install Certificates
# step, and without that the download fails TLS verification against GitHub.
.venv/bin/python -m worker.cloudflared_setup

# ---- 5b. Already running? Then just bring the browser back and get out of the way. ----
PORT=3939
RUN_DIR="data/run"
LOG_DIR="data/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

# -sTCP:LISTEN matters: without it lsof also returns every CLIENT connected to the port
# — a browser tab left open on the dashboard is enough — and Start would refuse to do
# anything, insisting SocialScheduler was already running when nothing was serving.
if [ -n "$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "SocialScheduler is already running."
  echo "Opening http://localhost:$PORT"
  echo
  echo "To stop it, double-click Stop-SocialScheduler-Mac.command"
  open "http://localhost:$PORT"
  echo
  close_my_window
  exit 0
fi

# ---- 6. The worker. It just runs. ----
#
# There is no menu. Starting SocialScheduler means the whole thing is on: the dashboard to
# compose in, and the worker to publish what has been scheduled. The old compose-vs-live
# choice was a distinction without a difference — an idle worker does nothing at all until
# a send is actually due, and whether anything can post for real is decided by DRY_RUN in
# .env, not by a question asked at launch.
#
# The worker is registered with launchd so it also comes back on its own after a restart,
# which is the one thing Start/Stop cannot do: after a reboot nobody is there to click
# anything. Stop halts it until the next login; KILL_SWITCH=1 in .env stops it for good
# without uninstalling; Disable-Worker-Autostart-Mac.command removes it entirely.
DRY_RUN="$(env_value DRY_RUN)"
KILL_SWITCH="$(env_value KILL_SWITCH)"

if [ "$DRY_RUN" = "0" ] && ! command -v cloudflared >/dev/null 2>&1 \
   && [ ! -x "data/bin/cloudflared" ]; then
  echo "⚠️  cloudflared isn't available — it's needed to deliver your media to Meta for REAL posts."
  echo "    The step above tried to install it and couldn't; check your internet connection"
  echo "    and run this again, or install it with:  brew install cloudflared"
  echo
fi

if [ "$DRY_RUN" != "0" ]; then
  echo "Worker: DRY-RUN is on in .env — it will show what it WOULD post and publish nothing."
elif [ "$KILL_SWITCH" = "1" ]; then
  echo "Worker: KILL_SWITCH is on in .env — it will run but publish nothing."
else
  echo "Worker: publishing for real (DRY_RUN=0 in .env)."
fi

MANUAL_WORKER=0
if agent_installed; then
  if [ -z "$(agent_pid)" ]; then
    # Registered but not running — a previous Stop halted it. Bring it back.
    launchctl kickstart "gui/$UID/$AGENT" 2>/dev/null
    sleep 2
  fi
  echo "        Running (pid $(agent_pid)) — starts on its own every time you log in."
elif enable_autostart; then
  echo "        Running (pid $(agent_pid)) — and will now start on its own every time you log in."
else
  # launchd took the job but never spawned it. Don't leave a broken agent registered;
  # fall back to a worker for this session so the install still works.
  echo "        (Could not register autostart — running it just for this session.)"
  launchctl bootout "gui/$UID/$AGENT" 2>/dev/null
  rm -f "$AGENT_PLIST"
  MANUAL_WORKER=1
fi
echo

# ---- 7. Fallback: a session-only worker, used only if autostart could not be set up. ----
if [ "$MANUAL_WORKER" = "1" ]; then

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

  # An ABSOLUTE wake time, not a countdown. `sleep` is naive about the wall clock and
  # macOS suspends it while the Mac is asleep, so `sleep $AUTO_SECS` silently stretches:
  # the worker kept running hours past the time this very file advertised. Storing the
  # epoch and polling the clock keeps worker.deadline honest to within WATCH_POLL
  # seconds, across any number of sleep/wake cycles. The displayed string is derived
  # FROM the epoch so the two can never disagree.
  DEADLINE_EPOCH="$(python3 -c "import time; print(int(time.time()) + $AUTO_SECS)")"
  DEADLINE="$(python3 -c "import datetime; print(datetime.datetime.fromtimestamp($DEADLINE_EPOCH).strftime('%Y-%m-%d %H:%M'))")"
  echo "$DEADLINE" > "$RUN_DIR/worker.deadline"
  WATCH_POLL=30

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
    while [ "$(date +%s)" -lt "$DEADLINE_EPOCH" ]; do sleep "$WATCH_POLL"; done
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
