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

REM ---- 5c. Make sure cloudflared is here (it delivers your media to Meta). ----
REM
REM Deliberately unconditional, not gated on DRY_RUN=0. The old gate meant a fresh clone -
REM which ships DRY_RUN=1 - was never even warned, and only found out it was missing when
REM its first REAL publish failed. Getting it now, while we are already installing things,
REM means going live later is just a flag change. It is a no-op once installed, and a
REM failure here is never fatal: composing and dry runs need no tunnel.
REM
REM Run with the venv's Python, not the system one, because it needs certifi for TLS
REM verification against GitHub (see the note in worker/cloudflared_setup.py).
".venv\Scripts\python" -m worker.cloudflared_setup

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

REM ---- 6. The worker. It just runs. ----
REM
REM There is no menu. Starting SocialScheduler means the whole thing is on: the dashboard
REM to compose in, and the worker to publish what has been scheduled. The old
REM compose-vs-live choice was a distinction without a difference - an idle worker does
REM nothing until a send is actually due, and whether anything can post for real is decided
REM by DRY_RUN in .env, not by a question asked at launch.
REM
REM The worker is registered as an at-logon Scheduled Task so it also comes back on its own
REM after a restart, which is the one thing Start/Stop cannot do: after a reboot nobody is
REM there to click anything. Stop halts it until the next logon; KILL_SWITCH=1 in .env stops
REM it for good without uninstalling; Disable-Worker-Autostart-Windows.bat removes it.
REM
REM WARNING - UNTESTED: written on macOS with no Windows machine available. Mirrors the
REM tested Start-SocialScheduler-Mac.command. Verify on Windows before relying on it.
set "TASKNAME=SocialSchedulerWorker"
call :env_value DRY_RUN DRY_RUN
call :env_value KILL_SWITCH KILL_SWITCH

if "!DRY_RUN!"=="0" (
  where cloudflared >nul 2>nul
  if errorlevel 1 if not exist "data\bin\cloudflared.exe" (
    REM [^!] not [!] — with delayed expansion on, a lone ! is swallowed and prints as [].
    echo [^!] cloudflared isn't available - it's needed to deliver your media to Meta for REAL posts.
    echo     The step above tried to install it and couldn't; check your internet connection
    echo     and run this again, or get it from https://github.com/cloudflare/cloudflared/releases/latest
    echo.
  )
)

if not "!DRY_RUN!"=="0" (
  echo Worker: DRY-RUN is on in .env - it will show what it WOULD post and publish nothing.
) else (
  if "!KILL_SWITCH!"=="1" (
    echo Worker: KILL_SWITCH is on in .env - it will run but publish nothing.
  ) else (
    echo Worker: publishing for real ^(DRY_RUN=0 in .env^).
  )
)

set "MANUAL_WORKER=0"
schtasks /Query /TN "%TASKNAME%" >NUL 2>&1
if not errorlevel 1 (
  REM Registered already. Make sure an instance is actually up - a previous Stop may have
  REM ended it - then leave it alone.
  schtasks /Run /TN "%TASKNAME%" >NUL 2>&1
  echo         Running - starts on its own every time you log in.
) else (
  echo         Setting it up to start on its own every time you log in...

  > "!RUN_DIR!\run-worker-autostart.cmd" echo @echo off
  >>"!RUN_DIR!\run-worker-autostart.cmd" echo cd /d "%~dp0"
  >>"!RUN_DIR!\run-worker-autostart.cmd" echo ".venv\Scripts\python" -m worker.run ^>^> "!LOG_DIR!\worker-autostart.out" 2^>^&1

  REM Retire any 12h auto-stop watchdog: a deadline contradicts "always running".
  if exist "!RUN_DIR!\watchdog.pid" (
    set /p WD_PID=<"!RUN_DIR!\watchdog.pid"
    taskkill /PID !WD_PID! /T /F >NUL 2>&1
    del /q "!RUN_DIR!\watchdog.pid" "!RUN_DIR!\worker.deadline" >NUL 2>&1
  )

  schtasks /Create /F /SC ONLOGON /TN "%TASKNAME%" /TR "wscript //nologo \"%~dp0scripts\run-hidden.vbs\" \"!RUN_DIR!\run-worker-autostart.cmd\"" >NUL 2>&1
  if errorlevel 1 (
    echo         ^(Could not register autostart - running it just for this session.^)
    set "MANUAL_WORKER=1"
  ) else (
    schtasks /Run /TN "%TASKNAME%" >NUL 2>&1
    echo         Running - and will now start on its own every time you log in.
  )
)
echo.

REM ---- 7. Fallback: a session-only worker, used only if autostart could not be set up. ----
if "!MANUAL_WORKER!"=="1" (
  echo Starting the worker in the background...

  > "!RUN_DIR!\run-worker.cmd" echo @echo off
  >>"!RUN_DIR!\run-worker.cmd" echo cd /d "%~dp0"
  >>"!RUN_DIR!\run-worker.cmd" echo ".venv\Scripts\python" -m worker.run ^>^> "!LOG_DIR!\worker-daemon.out" 2^>^&1

  set "WORKER_PID="
  for /f %%p in ('cscript //nologo "%~dp0scripts\run-hidden.vbs" "!RUN_DIR!\run-worker.cmd"') do set "WORKER_PID=%%p"
  if defined WORKER_PID >"!RUN_DIR!\worker.pid" echo !WORKER_PID!
  echo Worker running in the background ^(logs are in data\logs\^).
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
  echo [^!] The dashboard didn't start within 90 seconds.
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
