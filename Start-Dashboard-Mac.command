#!/bin/bash
# ============================================================
#  SocialScheduler — Start Dashboard (macOS)
#  Double-click this file in Finder to launch the dashboard.
#  (First time only: if macOS blocks it, right-click → Open.)
# ============================================================

# Always work from the folder this script lives in (the repo root).
cd "$(dirname "$0")" || exit 1

echo "======================================"
echo "  SocialScheduler — starting dashboard"
echo "======================================"
echo

pause_and_exit() {
  echo
  echo "$1"
  echo "Press any key to close this window..."
  read -r -n 1
  exit 1
}

# 1. Node.js must be installed.
if ! command -v node >/dev/null 2>&1; then
  pause_and_exit "Node.js isn't installed. Get it from https://nodejs.org (LTS), then double-click this again."
fi

# 2. First-run config: create .env from the template if it's missing.
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp ".env.example" ".env"
  echo "Created .env from the template. Add your Meta credentials there later."
  echo
fi

# 3. Make sure the database exists / is up to date.
if command -v python3 >/dev/null 2>&1; then
  echo "Preparing the database..."
  python3 migrate.py || pause_and_exit "Database setup failed (see the message above)."
  echo
else
  echo "Note: python3 not found — skipping database setup."
  echo "If the dashboard shows errors, install Python 3 and run: python3 migrate.py"
  echo
fi

# 4. Install dashboard dependencies on first run.
cd dashboard || pause_and_exit "Couldn't find the 'dashboard' folder."
if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies (this can take a minute)..."
  npm install || pause_and_exit "Installing dependencies failed (see above)."
  echo
fi

# 5. Open the browser shortly after the server starts, then run the dashboard.
#    A distinctive port avoids clashing with other dev servers (which commonly use 3000),
#    so the address we open matches the one the server actually uses.
export PORT=3939
echo "Starting the dashboard. A browser tab will open at http://localhost:$PORT"
echo "If it doesn't, open that address. Close this window to stop."
echo
( sleep 4 && open "http://localhost:$PORT" ) &
npm run dev
