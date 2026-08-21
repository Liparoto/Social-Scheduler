#!/bin/bash
# ============================================================
#  SocialScheduler — Restore (macOS)
#  Double-click to put a backup folder back: your posts,
#  schedule, tags and statistics, plus all of your images.
#
#  This REPLACES the data on this computer. It shows you what
#  it will do first and asks you to confirm. Your current
#  database is saved aside before anything is overwritten.
# ============================================================

cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  SocialScheduler — Restore"
echo "=========================================="
echo

pause_and_exit() {
  echo
  echo "$1"
  echo "Press any key to close this window..."
  read -r -n 1
  exit 1
}

if [ ! -d ".venv" ]; then
  pause_and_exit "The Python environment is missing. Double-click 'Update-Mac' first, then try again."
fi

echo "Find the backup folder in Finder — it's the dated one Export made,"
echo "with 'socialscheduler.db' and 'export.json' inside it."
echo
echo "Drag that folder into this window, then press Return:"
echo
printf "  Folder: "
read -r RAW

# Dragging a folder from Finder into Terminal pastes its path with spaces
# backslash-escaped, and sometimes wrapped in quotes. Undo both, rather than
# running the input through eval — eval on a pasted string would execute
# anything the path happened to contain.
BACKUP="${RAW%\"}"; BACKUP="${BACKUP#\"}"
BACKUP="${BACKUP%\'}"; BACKUP="${BACKUP#\'}"
BACKUP="${BACKUP//\\ / }"
# Finder appends a trailing space after a dragged path.
BACKUP="${BACKUP%"${BACKUP##*[![:space:]]}"}"

if [ -z "$BACKUP" ]; then
  pause_and_exit "No folder given. Nothing was changed."
fi
if [ ! -d "$BACKUP" ]; then
  pause_and_exit "That isn't a folder: $BACKUP"$'\n'"Nothing was changed."
fi

echo
echo "------------------------------------------"
echo "  What restoring would do"
echo "------------------------------------------"
echo

# Dry run first, always. The module writes nothing without --apply, so this is a
# genuine preview rather than a promise about one.
.venv/bin/python -m worker.restore "$BACKUP"
if [ $? -ne 0 ]; then
  pause_and_exit "Nothing was changed."
fi

echo "------------------------------------------"
echo
echo "This replaces the posts and images on THIS computer with the ones above."
echo "Stop the app first if it is running — the restore will refuse otherwise."
echo
printf 'Type the word  restore  to go ahead (anything else cancels): '
read -r CONFIRM

if [ "$CONFIRM" != "restore" ]; then
  pause_and_exit "Cancelled. Nothing was changed."
fi

echo
.venv/bin/python -m worker.restore "$BACKUP" --apply
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  pause_and_exit "The restore didn't finish (see the message above)."
fi

echo
echo "✅ Done. Start the app, then reconnect each account under Channels —"
echo "   backups deliberately contain no passwords or access tokens."
echo "Press any key to close this window..."
read -r -n 1
