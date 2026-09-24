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

REM 7. Restart SocialScheduler if it's running, so the new code is the code that runs.
REM
REM    A running worker keeps the code it started with - pulling new files changes nothing
REM    in it - and Start can't help on its own, because it only says "already running".
REM    Stop then Start is the same restart a person would do by hand, using the same two
REM    launchers, so there is no second way of stopping the worker to get wrong.
REM
REM    NOTE: every new line in this file lives AFTER the git pull above, on purpose. cmd
REM    reads a batch file as it runs it, and that pull can replace this very file: an older
REM    copy of Update continues into the newer one at the same byte offset. Keeping
REM    everything up to the pull byte-identical is what makes that handover land cleanly.
REM
REM    WARNING - UNTESTED on Windows: written on macOS.
set "WAS_RUNNING="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3939" ^| findstr LISTENING') do set "WAS_RUNNING=1"
REM The worker writes its pid into its lock file; only trust it if that pid is Python now.
set "LOCK_PID="
if exist "data\run\worker.lock" (
  for /f "usebackq tokens=1" %%p in ("data\run\worker.lock") do set "LOCK_PID=%%p"
)
if defined LOCK_PID (
  tasklist /FI "PID eq !LOCK_PID!" /NH 2>NUL | findstr /I /B /C:"python" >NUL
  if not errorlevel 1 set "WAS_RUNNING=1"
)

if not defined WAS_RUNNING (
  echo Up to date. Double-click "Start-SocialScheduler-Windows" to run it.
  echo.
  pause
  exit /b 0
)

echo Restarting SocialScheduler so it runs the new version...
echo.
call "%~dp0Stop-SocialScheduler-Windows.bat"
call "%~dp0Start-SocialScheduler-Windows.bat"
echo.
echo Up to date. SocialScheduler has been restarted on the new version.
echo.
pause
exit /b 0
