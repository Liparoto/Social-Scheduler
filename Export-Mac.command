#!/bin/bash
# ============================================================
#  SocialScheduler — Export (macOS)
#  Double-click to save a copy of all your posts, images, and
#  stats into a dated folder you can drag into Google Drive.
#  This only READS your data. Nothing is changed or posted.
# ============================================================

cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  SocialScheduler — Export"
echo "=========================================="
echo

pause_and_exit() {
  echo
  echo "$1"
  echo "Press any key to close this window..."
  read -r -n 1
  exit 1
}

# The export runs in the same Python environment as the worker.
if [ ! -d ".venv" ]; then
  pause_and_exit "The Python environment is missing. Double-click 'Update-Mac' first, then try again."
fi

echo "Gathering your posts, images, and stats..."
echo

# The module prints the output folder as its last line so we can reveal it in Finder.
# pipefail makes the pipeline report Python's failure rather than tail's success.
# (PIPESTATUS would NOT work here — command substitution runs in a subshell, so it
# would describe the assignment, not the pipeline inside it.)
set -o pipefail
OUTPUT="$(.venv/bin/python -m worker.export | tee /dev/tty | tail -n 1)"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  pause_and_exit "The export didn't finish (see the message above). Your data is untouched."
fi

echo
if [ -d "$OUTPUT" ]; then
  open "$OUTPUT"
  echo "✅ Done. The folder is open in Finder — drag it into Google Drive to back it up."
else
  echo "✅ Done."
fi
echo "Press any key to close this window..."
read -r -n 1
