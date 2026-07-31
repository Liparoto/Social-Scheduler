@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   SocialScheduler - Stop (Windows)
REM   Double-click this file to stop SocialScheduler.
REM   This window closes itself when it's done.
REM ============================================================

cd /d "%~dp0"

set PORT=3939
set "RUN_DIR=%~dp0data\run"
set "STOPPED_ANY="

echo ==========================================
echo   SocialScheduler - Stopping
echo ==========================================
echo.

REM ---- 1. The auto-stop timer, first, so it can't fire at a recycled PID later. ----
if exist "%RUN_DIR%\watchdog.pid" (
  set "WATCHDOG_PID="
  set /p WATCHDOG_PID=<"%RUN_DIR%\watchdog.pid"
  if defined WATCHDOG_PID (
    taskkill /PID !WATCHDOG_PID! /T /F >NUL 2>&1
    if not errorlevel 1 set "STOPPED_ANY=1"
  )
)

REM ---- 2. The worker. ----
if exist "%RUN_DIR%\worker.deadline" (
  set "DEADLINE="
  set /p DEADLINE=<"%RUN_DIR%\worker.deadline"
  if defined DEADLINE echo The worker was set to stop on its own at !DEADLINE!.
)
if exist "%RUN_DIR%\worker.pid" (
  set "WORKER_PID="
  set /p WORKER_PID=<"%RUN_DIR%\worker.pid"
  if defined WORKER_PID (
    echo Stopping the worker...
    taskkill /PID !WORKER_PID! /T /F >NUL 2>&1
    if not errorlevel 1 set "STOPPED_ANY=1"
  )
)

REM ---- 3. The dashboard. Kill the recorded process, then sweep the port. The
REM sweep is not a fallback, it's required: npm spawns the actual Next.js server
REM as a child, so killing the npm wrapper alone can leave that child holding
REM the port. ----
set "DASH_PID="
if exist "%RUN_DIR%\dashboard.pid" set /p DASH_PID=<"%RUN_DIR%\dashboard.pid"

set "FOUND_PORT="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do set "FOUND_PORT=1"

REM Say it once, up front, if either path found something. Killing the wrapper
REM often frees the port before the sweep runs, so keying the message off the
REM sweep alone would report a stopped dashboard as nothing at all.
if defined DASH_PID (
  echo Stopping the dashboard...
  set "STOPPED_ANY=1"
) else (
  if defined FOUND_PORT (
    echo Stopping the dashboard...
    set "STOPPED_ANY=1"
  )
)

if defined DASH_PID taskkill /PID !DASH_PID! /T /F >NUL 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do taskkill /PID %%a /T /F >NUL 2>&1

REM ---- 4. Clean up the bookkeeping files. ----
del /q "%RUN_DIR%\dashboard.pid" "%RUN_DIR%\worker.pid" "%RUN_DIR%\watchdog.pid" "%RUN_DIR%\worker.deadline" >NUL 2>&1
del /q "%RUN_DIR%\run-dashboard.cmd" "%RUN_DIR%\run-worker.cmd" "%RUN_DIR%\run-watchdog.cmd" >NUL 2>&1

echo.
if defined STOPPED_ANY (
  echo [OK] Stopped. Nothing is running.
) else (
  echo Nothing was running.
)
echo.
exit /b 0
