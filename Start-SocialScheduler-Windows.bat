@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   SocialScheduler - Start (Windows)
REM   Double-click this file to run SocialScheduler.
REM
REM   It sets everything up, then asks whether you want to just
REM   compose, or go live (compose + actually publish).
REM ============================================================

REM Work from the folder this script lives in (the repo root).
cd /d "%~dp0"

echo ==========================================
echo   SocialScheduler
echo ==========================================
echo.

REM ---- 1. Preflight: the two things that must be installed. ----
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Get it from https://nodejs.org ^(choose LTS^), then run this again.
  echo.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 isn't installed. Get it from https://www.python.org/downloads/ , then run this again.
  echo.
  pause
  exit /b 1
)

REM ---- 2. First-run config: create .env from the template if it's missing. ----
if not exist ".env" if exist ".env.example" (
  copy ".env.example" ".env" >nul
  echo Created .env from the template. Add your Meta credentials there when you're ready.
  echo.
)

REM ---- 3. Make sure the database exists / is up to date (safe to run every time). ----
echo Preparing the database...
python migrate.py
if errorlevel 1 (
  echo Database setup failed ^(see the message above^).
  echo.
  pause
  exit /b 1
)
echo.

REM ---- 4. Install the dashboard's dependencies on first run. ----
if not exist "dashboard\node_modules" (
  echo First run - installing dashboard dependencies ^(this can take a minute^)...
  pushd dashboard
  call npm install
  if errorlevel 1 (
    popd
    echo Installing dashboard dependencies failed ^(see above^).
    echo.
    pause
    exit /b 1
  )
  popd
  echo.
)

REM ---- 5. Set up the worker's Python environment on first run. ----
if not exist ".venv" (
  echo First run - setting up the worker ^(this can take a minute^)...
  python -m venv .venv
  if errorlevel 1 (
    echo Couldn't create the Python environment.
    echo.
    pause
    exit /b 1
  )
  ".venv\Scripts\python" -m pip install --quiet --upgrade pip
  ".venv\Scripts\pip" install -r requirements.txt
  if errorlevel 1 (
    echo Installing worker dependencies failed ^(see above^).
    echo.
    pause
    exit /b 1
  )
  echo.
)

REM ---- 6. Ask what to do. ----
echo What would you like to do?
echo   1^) Compose only  - open the dashboard; nothing will be posted ^(safe^)
echo   2^) Go live       - open the dashboard AND run the worker that publishes
echo.
set "choice="
set /p "choice=Enter 1 or 2 [1]: "
if "%choice%"=="" set "choice=1"
echo.

set "MODE=compose"
if "%choice%"=="2" set "MODE=live"

REM ---- 7. If going live, respect the safety switches before starting the worker. ----
if "%MODE%"=="live" (
  call :env_value DRY_RUN DRY_RUN
  call :env_value KILL_SWITCH KILL_SWITCH

  if "!DRY_RUN!"=="0" (
    where cloudflared >nul 2>nul
    if errorlevel 1 (
      echo [!] cloudflared isn't installed - it's needed to deliver your images to Meta for REAL posts.
      echo     Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
      echo     ^(You don't need it while DRY_RUN=1 - dry-run posts nothing.^)
      echo.
    )
    echo [!] DRY_RUN is OFF in your .env. Going live will POST to Instagram/Facebook FOR REAL.
    set "confirm="
    set /p "confirm=Type YES (all caps) to post for real, or just press Enter to compose safely: "
    echo.
    if not "!confirm!"=="YES" (
      echo Okay - starting in Compose only mode. Nothing will be posted.
      echo.
      set "MODE=compose"
    )
  )
)

if "%MODE%"=="live" (
  call :env_value DRY_RUN DRY_RUN
  call :env_value KILL_SWITCH KILL_SWITCH
  if not "!DRY_RUN!"=="0" (
    echo DRY-RUN is on: the worker will show what it WOULD post but publish nothing.
    echo When you're ready to go live for real, set DRY_RUN=0 in your .env file.
    echo.
  )
  if "!KILL_SWITCH!"=="1" (
    echo Note: KILL_SWITCH is ON - the worker will run but publish nothing until you set KILL_SWITCH=0 in .env.
    echo.
  )
  echo Starting the worker in its own window...
  start "SocialScheduler Worker" cmd /c ""%~dp0.venv\Scripts\python" -m worker.run"
  echo Worker running in the "SocialScheduler Worker" window (logs are in data\logs\).
  echo.
)

REM ---- 8. Start the dashboard (foreground). Closing it stops the dashboard. ----
set PORT=3939
echo Starting the dashboard. A browser tab will open at http://localhost:%PORT%
echo If it doesn't, open that address yourself. Close this window to stop the dashboard.
echo.
start "" "http://localhost:%PORT%"
pushd dashboard
call npm run dev
popd

REM When the dashboard stops, stop the worker window too (best-effort parity with the Mac trap).
if "%MODE%"=="live" (
  taskkill /FI "WINDOWTITLE eq SocialScheduler Worker*" /T /F >nul 2>nul
)
echo.
echo Stopped. You can close this window.
pause
exit /b 0

REM ---- helper: read KEY (%1) from .env into variable named %2 (last match wins) ----
:env_value
set "%2="
if not exist ".env" goto :eof
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  set "k=%%A"
  set "k=!k: =!"
  if /i "!k!"=="%1" (
    set "v=%%B"
    set "v=!v: =!"
    set "%2=!v!"
  )
)
goto :eof
