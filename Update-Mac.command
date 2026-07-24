#!/bin/bash
# ============================================================
#  SocialScheduler — Update (macOS)
#  Double-click to get the latest version of the code.
#  Your credentials (.env) and your data (/data) are never touched.
# ============================================================

cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  SocialScheduler — Update"
echo "=========================================="
echo

pause_and_exit() {
  echo
  echo "$1"
  echo "Press any key to close this window..."
  read -r -n 1
  exit 1
}

# 1. This has to be a git checkout to update.
if ! command -v git >/dev/null 2>&1; then
  pause_and_exit "Git isn't installed, so I can't fetch updates. Install it from https://git-scm.com , then try again."
fi
if [ ! -d ".git" ]; then
  pause_and_exit "This folder isn't a git checkout, so there's nothing to update from. (If you downloaded a ZIP, ask for a fresh 'git clone' copy instead.)"
fi

# 2. Don't overwrite local edits to tracked code. .env and /data are gitignored, so they
#    never show up here; untracked stray files are ignored (a fast-forward pull won't touch
#    them, and step 4 still stops safely if one would actually collide).
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "You have local changes to the app's code:"
  echo
  git status --short --untracked-files=no
  echo
  pause_and_exit "I won't overwrite these. If you didn't change the code on purpose, ask for help before updating."
fi

# 3. Reach the code host (needs internet).
echo "Checking for updates..."
if ! git fetch --quiet; then
  pause_and_exit "Couldn't reach the internet or the code host. Check your connection and try again."
fi

# 4. Fast-forward only — never merge or rewrite your history.
if ! git pull --ff-only; then
  pause_and_exit "Your copy and the latest version have diverged and can't be auto-updated. Ask for help — your data is safe."
fi
echo

# 5. Apply any new database changes (additive — your existing data is preserved).
echo "Updating the database..."
python3 migrate.py || pause_and_exit "Database update failed (see the message above)."
echo

# 6. Refresh dependencies in case they changed (these are safe to run every time).
echo "Refreshing dashboard dependencies..."
( cd dashboard && npm install ) || pause_and_exit "Refreshing dashboard dependencies failed (see above)."
echo

if [ ! -d ".venv" ]; then
  python3 -m venv .venv || pause_and_exit "Couldn't create the Python environment."
  .venv/bin/pip install --quiet --upgrade pip
fi
echo "Refreshing worker dependencies..."
.venv/bin/pip install -r requirements.txt || pause_and_exit "Refreshing worker dependencies failed (see above)."
echo

echo "✅ Up to date. Double-click 'Start-SocialScheduler-Mac' to run it."
echo "Press any key to close this window..."
read -r -n 1
