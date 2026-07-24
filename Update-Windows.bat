@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   SocialScheduler - Update (Windows)
REM   Double-click to get the latest version of the code.
REM   Your credentials (.env) and your data (\data) are never touched.
REM ============================================================

cd /d "%~dp0"

echo ==========================================
echo   SocialScheduler - Update
echo ==========================================
echo.

REM 1. This has to be a git checkout to update.
where git >nul 2>nul
if errorlevel 1 (
  echo Git isn't installed, so I can't fetch updates. Install it from https://git-scm.com , then try again.
  echo.
  pause
  exit /b 1
)
if not exist ".git" (
  echo This folder isn't a git checkout, so there's nothing to update from.
  echo ^(If you downloaded a ZIP, ask for a fresh "git clone" copy instead.^)
  echo.
  pause
  exit /b 1
)

REM 2. Don't overwrite local edits to tracked code. .env and \data are gitignored, so they
REM    never show up here; untracked stray files are ignored (a fast-forward pull won't touch
REM    them, and step 4 still stops safely if one would actually collide).
set "DIRTY="
for /f "delims=" %%L in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY (
  echo You have local changes to the app's code:
  echo.
  git status --short --untracked-files=no
  echo.
  echo I won't overwrite these. If you didn't change the code on purpose, ask for help before updating.
  echo.
  pause
  exit /b 1
)

REM 3. Reach the code host (needs internet).
echo Checking for updates...
git fetch --quiet
if errorlevel 1 (
  echo Couldn't reach the internet or the code host. Check your connection and try again.
  echo.
  pause
  exit /b 1
)

REM 4. Fast-forward only - never merge or rewrite your history.
git pull --ff-only
if errorlevel 1 (
  echo Your copy and the latest version have diverged and can't be auto-updated.
  echo Ask for help - your data is safe.
  echo.
  pause
  exit /b 1
)
echo.

REM 5. Apply any new database changes (additive - your existing data is preserved).
echo Updating the database...
python migrate.py
if errorlevel 1 (
  echo Database update failed ^(see the message above^).
  echo.
  pause
  exit /b 1
)
echo.

REM 6. Refresh dependencies in case they changed (safe to run every time).
echo Refreshing dashboard dependencies...
pushd dashboard
call npm install
if errorlevel 1 (
  popd
  echo Refreshing dashboard dependencies failed ^(see above^).
  echo.
  pause
  exit /b 1
)
popd
echo.

if not exist ".venv" (
  python -m venv .venv
  ".venv\Scripts\python" -m pip install --quiet --upgrade pip
)
echo Refreshing worker dependencies...
".venv\Scripts\pip" install -r requirements.txt
if errorlevel 1 (
  echo Refreshing worker dependencies failed ^(see above^).
  echo.
  pause
  exit /b 1
)
echo.

echo Up to date. Double-click "Start-SocialScheduler-Windows" to run it.
echo.
pause
exit /b 0
