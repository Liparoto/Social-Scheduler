#!/bin/bash
# ============================================================
#   SocialScheduler - Disable worker autostart (macOS)
#   Undoes Enable-Worker-Autostart-Mac.command: stops the
#   worker and removes it from login, leaving you back on the
#   manual Start/Stop workflow.
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1
LABEL="com.socialscheduler.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "=========================================="
echo "  Disable worker autostart"
echo "=========================================="
echo

if [ ! -f "$PLIST" ] && ! launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  echo "Autostart wasn't enabled — nothing to undo."
  echo
  exit 0
fi

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null
rm -f "$PLIST"
sleep 1

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  echo "❌ launchd still reports the job. Try again, or: launchctl bootout gui/$UID/$LABEL"
  echo
  exit 1
fi

echo "✅ Autostart disabled and the worker stopped."
echo "   Start it by hand again with Start-SocialScheduler-Mac.command."
echo
