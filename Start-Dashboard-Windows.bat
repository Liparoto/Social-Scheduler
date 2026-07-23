@echo off
REM ============================================================
REM   SocialScheduler - Start Dashboard (Windows)
REM   Double-click this file to launch the dashboard.
REM ============================================================

REM Work from the folder this script lives in (the repo root).
cd /d "%~dp0"

echo ======================================
echo   SocialScheduler - starting dashboard
echo ======================================
echo.

REM 1. Node.js must be installed.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Get it from https://nodejs.org ^(LTS^), then run this again.
  echo.
  pause
  exit /b 1
)

REM 2. First-run config: create .env from the template if it's missing.
if not exist ".env" if exist ".env.example" (
  copy ".env.example" ".env" >nul
  echo Created .env from the template. Add your Meta credentials there later.
  echo.
)

REM 3. Make sure the database exists / is up to date.
where python >nul 2>nul
if errorlevel 1 (
  echo Note: python not found - skipping database setup.
  echo If the dashboard shows errors, install Python 3 and run: python migrate.py
  echo.
) else (
  echo Preparing the database...
  python migrate.py
  if errorlevel 1 (
    echo Database setup failed ^(see the message above^).
    echo.
    pause
    exit /b 1
  )
  echo.
)

REM 4. Install dashboard dependencies on first run.
cd dashboard
if not exist "node_modules" (
  echo First run - installing dependencies ^(this can take a minute^)...
  call npm install
  if errorlevel 1 (
    echo Installing dependencies failed ^(see above^).
    echo.
    pause
    exit /b 1
  )
  echo.
)

REM 5. Open the browser, then run the dashboard.
REM    A distinctive port avoids clashing with other dev servers (often on 3000),
REM    so the address we open matches the one the server actually uses.
set PORT=3939
echo Starting the dashboard. A browser tab will open at http://localhost:%PORT%
echo If it doesn't, open that address. Close this window to stop.
echo.
start "" "http://localhost:%PORT%"
call npm run dev

pause
