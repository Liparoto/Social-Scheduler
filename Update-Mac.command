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

# 7. Restart the worker, so the new code is actually the code that runs.
#
#    A running worker keeps the code it started with — pulling new files changes nothing in
#    it — and Start can't help, because it only says "already running". Before this step,
#    an update to the worker did nothing until someone thought to Stop and Start.
#
#    Only the WORKER is restarted. The dashboard reloads new code by itself.
#
#    NOTE: every new line in this file lives AFTER the `git pull` above, on purpose. bash
#    reads a script as it runs it, and that pull can replace this very file: an older copy
#    of Update continues into the newer one at the same byte offset. Keeping everything up
#    to the pull byte-identical is what makes that handover land on a line boundary.
AGENT="com.socialscheduler.worker"
agent_pid() { launchctl print "gui/$UID/$AGENT" 2>/dev/null | awk -F'= ' '/^\tpid = /{print $2; exit}'; }
INSTALL_DIR="$(pwd -P)"
# Same scoping as Stop: a worker is ours only if its working directory is this install.
install_worker_pids() {
  local pids pid cwd
  pids="$(pgrep -f 'worker\.run' 2>/dev/null)" || return 0
  for pid in $pids; do
    cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ "$cwd" = "$INSTALL_DIR" ] && echo "$pid"
  done
}

OLD_PID="$(agent_pid)"
if [ -n "$OLD_PID" ]; then
  echo "Restarting the worker so it runs the new version..."
  # SIGTERM, then wait: the worker finishes the cycle it is in — possibly a post going out
  # — and exits 0, which the agent's KeepAlive rule does NOT restart. Never forced: killing
  # a worker mid-publish is how a post ends up half-sent.
  launchctl kill TERM "gui/$UID/$AGENT" 2>/dev/null
  WAITED=0
  while [ -n "$(agent_pid)" ] && [ "$WAITED" -lt 300 ]; do
    [ "$WAITED" = "10" ] && echo "   (it's finishing what it was doing — this can take a few minutes)"
    sleep 2
    WAITED=$((WAITED + 2))
  done
  if [ -n "$(agent_pid)" ]; then
    echo "⚠️  The worker is still busy after 5 minutes, so I left it alone — it is still"
    echo "    running the OLD version. Later, double-click Stop-SocialScheduler-Mac and then"
    echo "    Start-SocialScheduler-Mac to finish the update."
  else
    launchctl kickstart "gui/$UID/$AGENT" 2>/dev/null
    sleep 3
    NEW_PID="$(agent_pid)"
    if [ -n "$NEW_PID" ]; then
      echo "   Worker restarted on the new version (pid $NEW_PID)."
    else
      echo "⚠️  The worker stopped but didn't come back. Double-click Start-SocialScheduler-Mac."
    fi
  fi
  echo
elif [ -n "$(install_worker_pids)" ]; then
  # A session-only worker (autostart couldn't be set up). Its restart belongs to Start.
  echo "⚠️  A worker is running outside autostart, still on the OLD version. To finish the"
  echo "    update, double-click Stop-SocialScheduler-Mac and then Start-SocialScheduler-Mac."
  echo
fi

if [ -n "$(lsof -ti tcp:3939 -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "✅ Up to date. SocialScheduler is running the new version."
else
  echo "✅ Up to date. Double-click 'Start-SocialScheduler-Mac' to run it."
fi
echo "Press any key to close this window..."
read -r -n 1
