#!/bin/bash
# ============================================================
#   SocialScheduler - Disable autostart (macOS)
#   Stops the worker AND the dashboard and removes both from
#   login (System Settings → Login Items), leaving you on the
#   manual Start/Stop workflow. (File name kept from when only
#   the worker autostarted.)
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1
LABELS="com.socialscheduler.worker com.socialscheduler.dashboard"

echo "=========================================="
echo "  Disable SocialScheduler autostart"
echo "=========================================="
echo

FOUND=0
for LABEL in $LABELS; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ -f "$PLIST" ] || launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    FOUND=1
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null
    rm -f "$PLIST"
  fi
done

if [ "$FOUND" = "0" ]; then
  echo "Autostart wasn't enabled — nothing to undo."
  echo
  exit 0
fi
sleep 1

FAILED=0
for LABEL in $LABELS; do
  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    echo "❌ launchd still reports $LABEL. Try again, or: launchctl bootout gui/$UID/$LABEL"
    FAILED=1
  fi
done
if [ "$FAILED" = "1" ]; then
  echo
  exit 1
fi

echo "✅ Autostart disabled. The worker and the dashboard are stopped and removed from"
echo "   Login Items. Start-SocialScheduler-Mac.command turns them back on."
echo
