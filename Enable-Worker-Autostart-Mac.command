#!/bin/bash
# ============================================================
#   SocialScheduler - Enable worker autostart (macOS)
#   Double-click this once. After that the worker starts by
#   itself whenever you log in, and restarts itself if it
#   ever crashes. No prompt, no Terminal window to babysit.
#
#   Undo it any time with Disable-Worker-Autostart-Mac.command
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1
REPO="$(pwd -P)"
LABEL="com.socialscheduler.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUN_DIR="$REPO/data/run"
LOG_DIR="$REPO/data/logs"
# launchd gets its OWN stdout file, deliberately NOT the launcher's worker-daemon.out.
# macOS stamps files created by a Terminal-launched process with a com.apple.provenance
# xattr that CANNOT be removed (`xattr -d` silently no-ops), and launchd refuses to open
# such a file for a job -- the job then dies with exit 78 EX_CONFIG before the worker ever
# starts. Nothing is lost by splitting them: the real rotating log is data/logs/worker.log,
# written by the worker itself; these .out files only catch stray stdout/stderr.
LAUNCHD_LOG="$LOG_DIR/worker-launchd.out"

echo "=========================================="
echo "  Enable worker autostart"
echo "=========================================="
echo

if [ ! -x "$REPO/.venv/bin/python" ]; then
  echo "The worker's Python environment isn't set up yet."
  echo "Double-click Start-SocialScheduler-Mac.command once first, then run this."
  echo
  read -r -n 1 -p "Press any key to close."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$RUN_DIR" "$LOG_DIR"

# What this daemon will do, stated plainly before it is installed.
DRY="$(grep -E "^[[:space:]]*DRY_RUN=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]')"
if [ "$DRY" = "0" ]; then
  echo "NOTE: DRY_RUN=0 in your .env, so this worker PUBLISHES FOR REAL,"
  echo "      unattended, whenever a send comes due."
else
  echo "NOTE: DRY_RUN=$DRY in your .env, so this worker publishes NOTHING."
fi
echo "      KILL_SWITCH=1 in .env still stops it within one poll, without uninstalling."
echo

# PATH matters: launchd hands a process a minimal PATH that does NOT include
# /usr/local/bin or /opt/homebrew/bin. The worker shells out to `cloudflared` for the
# publish tunnel by bare name, so without this a REAL publish fails with
# "'cloudflared' not found" -- and only at send time, which is the worst moment to
# discover it.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$REPO/.venv/bin/python</string>
    <string>-m</string>
    <string>worker.run</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO</string>

  <!-- Start at login. -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Restart ONLY on a non-zero exit, i.e. a crash. The worker exits 0 when it is
       sent SIGTERM, so Stop-SocialScheduler-Mac.command still genuinely stops it
       instead of fighting launchd. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$LAUNCHD_LOG</string>
  <key>StandardErrorPath</key>
  <string>$LAUNCHD_LOG</string>
</dict>
</plist>
PLIST_EOF

echo "Wrote $PLIST"

# Stop anything already running so we don't end up with two daemons.
if [ -f "$RUN_DIR/watchdog.pid" ]; then
  kill "$(cat "$RUN_DIR/watchdog.pid" 2>/dev/null)" 2>/dev/null
  rm -f "$RUN_DIR/watchdog.pid" "$RUN_DIR/worker.deadline"
  echo "Retired the old 12-hour auto-stop watchdog (autostart means always-on)."
fi
if [ -f "$RUN_DIR/worker.pid" ]; then
  kill "$(cat "$RUN_DIR/worker.pid" 2>/dev/null)" 2>/dev/null
  rm -f "$RUN_DIR/worker.pid"
  echo "Stopped the previously hand-started worker."
fi

# Start from a fresh inode so a provenance-stamped leftover cannot block the job.
rm -f "$LAUNCHD_LOG"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
sleep 1
launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null

# A registered job is NOT a running job: launchd will happily accept a plist and then
# fail to spawn it forever. Wait for an actual pid before claiming success.
WORKER_PID=""
for _ in $(seq 1 20); do
  WORKER_PID="$(launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk -F'= ' '/^\tpid = /{print $2; exit}')"
  [ -n "$WORKER_PID" ] && break
  sleep 1
done

echo
if [ -n "$WORKER_PID" ]; then
  echo "✅ Autostart enabled. The worker is running now (pid $WORKER_PID) and starts on every login."
  echo
  echo "   Stop it for now : double-click Stop-SocialScheduler-Mac.command"
  echo "   Start it again  : launchctl kickstart gui/$UID/$LABEL"
  echo "   Turn this off   : double-click Disable-Worker-Autostart-Mac.command"
  echo "   Logs            : data/logs/worker.log (and worker-launchd.out for stray output)"
else
  echo "❌ The job is registered but never started."
  echo "   launchd exit code: $(launchctl print "gui/$UID/$LABEL" 2>/dev/null | grep 'last exit code' | sed 's/.*= //')"
  echo "   78 (EX_CONFIG) usually means launchd could not open $LAUNCHD_LOG."
  echo "   Try: rm -f '$LAUNCHD_LOG' and run this again."
  echo
  read -r -n 1 -p "Press any key to close."
  exit 1
fi
echo
