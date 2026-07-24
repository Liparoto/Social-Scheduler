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

WORKER_PID=""

# When this window closes (or you press Ctrl-C), stop the worker cleanly if we started one.
cleanup() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    echo
    echo "Stopping the worker..."
    kill "$WORKER_PID" 2>/dev/null
    wait "$WORKER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM HUP

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

# ---- 6. Ask what to do. ----
echo "What would you like to do?"
echo "  1) Compose only  — open the dashboard; nothing will be posted (safe)"
echo "  2) Go live       — open the dashboard AND run the worker that publishes"
echo
read -r -p "Enter 1 or 2 [1]: " choice
choice="${choice:-1}"
echo

MODE="compose"
if [ "$choice" = "2" ]; then
  MODE="live"
fi

# ---- 7. If going live, respect the safety switches before starting the worker. ----
if [ "$MODE" = "live" ]; then
  DRY_RUN="$(env_value DRY_RUN)"
  KILL_SWITCH="$(env_value KILL_SWITCH)"

  if [ "$DRY_RUN" = "0" ]; then
    # Real posting. Make sure she means it, and warn if the delivery tool is missing.
    if ! command -v cloudflared >/dev/null 2>&1; then
      echo "⚠️  cloudflared isn't installed — it's needed to deliver your images to Meta for REAL posts."
      echo "    Install it once with:  brew install cloudflared"
      echo "    (You don't need it while DRY_RUN=1 — dry-run posts nothing.)"
      echo
    fi
    echo "⚠️  DRY_RUN is OFF in your .env. Going live will POST to Instagram/Facebook FOR REAL."
    read -r -p "Type YES (all caps) to post for real, or just press Enter to compose safely: " confirm
    echo
    if [ "$confirm" != "YES" ]; then
      echo "Okay — starting in Compose only mode. Nothing will be posted."
      echo
      MODE="compose"
    fi
  fi
fi

if [ "$MODE" = "live" ]; then
  DRY_RUN="$(env_value DRY_RUN)"
  KILL_SWITCH="$(env_value KILL_SWITCH)"
  if [ "$DRY_RUN" != "0" ]; then
    echo "DRY-RUN is on: the worker will show what it WOULD post but publish nothing."
    echo "When you're ready to go live for real, set DRY_RUN=0 in your .env file."
    echo
  fi
  if [ "$KILL_SWITCH" = "1" ]; then
    echo "Note: KILL_SWITCH is ON — the worker will run but publish nothing until you set KILL_SWITCH=0 in .env."
    echo
  fi
  echo "Starting the worker..."
  .venv/bin/python -m worker.run &
  WORKER_PID=$!
  echo "Worker running (logs are in data/logs/). It stops automatically when you close this window."
  echo
fi

# ---- 8. Start the dashboard (this stays in the foreground; closing the window stops it). ----
export PORT=3939
echo "Starting the dashboard. A browser tab will open at http://localhost:$PORT"
echo "If it doesn't, open that address yourself. Close this window to stop everything."
echo
( sleep 4 && open "http://localhost:$PORT" ) &
cd dashboard || pause_and_exit "Couldn't find the 'dashboard' folder."
npm run dev
