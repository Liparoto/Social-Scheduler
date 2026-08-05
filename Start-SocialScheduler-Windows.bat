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

REM ---- 5b. Already running? Then just bring the browser back and get out of the way. ----
set PORT=3939
set "RUN_DIR=%~dp0data\run"
set "LOG_DIR=%~dp0data\logs"
if not exist "%RUN_DIR%" mkdir "%RUN_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

set "ALREADY="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do set "ALREADY=%%a"
if defined ALREADY (
  echo SocialScheduler is already running.
  echo Opening http://localhost:%PORT%
  echo.
  echo To stop it, double-click Stop-SocialScheduler-Windows.bat
  start "" "http://localhost:%PORT%"
  exit /b 0
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
  echo Starting the worker in the background...

  REM Write the worker's command to its own .cmd file rather than threading
  REM redirects and quoted paths through for /f. See scripts\run-hidden.vbs.
  > "!RUN_DIR!\run-worker.cmd" echo @echo off
  >>"!RUN_DIR!\run-worker.cmd" echo cd /d "%~dp0"
  >>"!RUN_DIR!\run-worker.cmd" echo ".venv\Scripts\python" -m worker.run ^>^> "!LOG_DIR!\worker-daemon.out" 2^>^&1

  set "WORKER_PID="
  for /f %%p in ('cscript //nologo "%~dp0scripts\run-hidden.vbs" "!RUN_DIR!\run-worker.cmd"') do set "WORKER_PID=%%p"
  if defined WORKER_PID >"!RUN_DIR!\worker.pid" echo !WORKER_PID!

  REM How long before the worker stops itself. Anything unparseable falls back to 12.
  REM This exists because the worker publishes for real and now runs with no visible
  REM window — without a deadline, a forgotten worker posts unattended for days.
  call :env_value WORKER_AUTO_STOP_HOURS AUTO_HOURS
  if not defined AUTO_HOURS set "AUTO_HOURS=12"
  set "AUTO_SECS="
  for /f %%s in ('python -c "print(int(float('!AUTO_HOURS!') * 3600))" 2^>NUL') do set "AUTO_SECS=%%s"
  if not defined AUTO_SECS set "AUTO_SECS=43200"

  set "DEADLINE="
  for /f "delims=" %%d in ('python -c "import datetime; print((datetime.datetime.now() + datetime.timedelta(seconds=!AUTO_SECS!)).strftime('%%Y-%%m-%%d %%H:%%M'))" 2^>NUL') do set "DEADLINE=%%d"
  if defined DEADLINE >"!RUN_DIR!\worker.deadline" echo !DEADLINE!

  REM The watchdog: waits, then stops the worker and clears its bookkeeping.
  REM
  REM It must only ever act on ITS OWN worker. A watchdog can wake long after the
  REM deadline -- a sleeping machine stretches `timeout` the same way it stretches the
  REM macOS `sleep` -- by which point the owner may have stopped and restarted
  REM everything. Acting unconditionally then deletes the CURRENT worker's pid files:
  REM leaving a worker publishing for real that Stop can no longer find, since Stop
  REM reads worker.pid — and `taskkill /F` would force-kill a stale PID number that
  REM Windows may since have recycled onto an unrelated process.
  REM
  REM Guard: worker.pid must still name this watchdog's own worker, or it exits
  REM quietly. Mirrors the same guard in Start-SocialScheduler-Mac.command, which is
  REM covered by scripts/test-watchdog-guard.sh.
  REM
  REM WARNING - UNTESTED: written on macOS with no Windows machine available. The logic mirrors
  REM the tested shell version, but verify on Windows before relying on it. If the guard
  REM ever fails to match, the watchdog simply never stops the worker — so a broken
  REM guard shows up as "the worker outlived its deadline", not as anything destructive.
  > "!RUN_DIR!\run-watchdog.cmd" echo @echo off
  >>"!RUN_DIR!\run-watchdog.cmd" echo timeout /t !AUTO_SECS! /nobreak ^>NUL
  >>"!RUN_DIR!\run-watchdog.cmd" echo set "STILL_OURS="
  >>"!RUN_DIR!\run-watchdog.cmd" echo if exist "!RUN_DIR!\worker.pid" set /p STILL_OURS=^<"!RUN_DIR!\worker.pid"
  >>"!RUN_DIR!\run-watchdog.cmd" echo if not "%%STILL_OURS%%"=="!WORKER_PID!" exit /b 0
  >>"!RUN_DIR!\run-watchdog.cmd" echo taskkill /PID !WORKER_PID! /T /F ^>NUL 2^>^&1
  >>"!RUN_DIR!\run-watchdog.cmd" echo del /q "!RUN_DIR!\worker.pid" "!RUN_DIR!\watchdog.pid" "!RUN_DIR!\worker.deadline" ^>NUL 2^>^&1

  set "WATCHDOG_PID="
  for /f %%p in ('cscript //nologo "%~dp0scripts\run-hidden.vbs" "!RUN_DIR!\run-watchdog.cmd"') do set "WATCHDOG_PID=%%p"
  if defined WATCHDOG_PID >"!RUN_DIR!\watchdog.pid" echo !WATCHDOG_PID!

  echo Worker running in the background ^(logs are in data\logs\^).
  echo It will stop on its own at !DEADLINE!, or whenever you double-click Stop.
  echo.
)

REM ---- 8. Start the dashboard in the background. ----
echo Starting the dashboard...

> "%RUN_DIR%\run-dashboard.cmd" echo @echo off
>>"%RUN_DIR%\run-dashboard.cmd" echo cd /d "%~dp0dashboard"
>>"%RUN_DIR%\run-dashboard.cmd" echo set PORT=%PORT%
>>"%RUN_DIR%\run-dashboard.cmd" echo npm run dev ^> "%LOG_DIR%\dashboard.log" 2^>^&1

set "DASH_PID="
for /f %%p in ('cscript //nologo "%~dp0scripts\run-hidden.vbs" "%RUN_DIR%\run-dashboard.cmd"') do set "DASH_PID=%%p"
if defined DASH_PID >"%RUN_DIR%\dashboard.pid" echo !DASH_PID!

REM Wait until the dashboard actually answers before opening the browser. This used to
REM fire immediately, one line before the server was even started, so the tab always
REM opened on a dead port and showed a connection error. Next.js compiles on a cold
REM start, so poll for up to 90 seconds.
set "READY="
for /l %%i in (1,1,90) do (
  if not defined READY (
    curl -sf -o NUL http://localhost:%PORT% && set "READY=1"
    if not defined READY timeout /t 1 /nobreak >NUL
  )
)

if defined READY (
  start "" "http://localhost:%PORT%"
  echo [OK] Running at http://localhost:%PORT%
) else (
  echo [!] The dashboard didn't start within 90 seconds.
  echo     Check data\logs\dashboard.log for the reason.
  echo     If it starts later, open http://localhost:%PORT% yourself.
)

echo.
echo This window will close - everything keeps running.
echo To stop it, double-click Stop-SocialScheduler-Windows.bat
echo.
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
