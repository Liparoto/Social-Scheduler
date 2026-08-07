@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   SocialScheduler - Disable worker autostart (Windows)
REM   Undoes the "Go live, always" choice in Start: stops the
REM   worker and removes it from logon, putting you back on the
REM   manual Start/Stop workflow.
REM
REM   WARNING - UNTESTED: written on macOS with no Windows machine
REM   available. Mirrors the tested macOS version
REM   (Disable-Worker-Autostart-Mac.command). Verify before relying on it.
REM ============================================================

cd /d "%~dp0"
set "TASKNAME=SocialSchedulerWorker"
set "RUN_DIR=%~dp0data\run"

echo ==========================================
echo   Disable worker autostart
echo ==========================================
echo.

REM There are TWO ways autostart may have been set up, and which one you got depends on
REM whether your account is an administrator. Start tries a scheduled task first; a standard
REM user cannot register an ONLOGON task at all ("Access is denied"), so it falls back to a
REM shortcut in your Startup folder. Undo whichever is actually present.
set "REMOVED="

schtasks /Query /TN "%TASKNAME%" >NUL 2>&1
if not errorlevel 1 (
  echo Removing the scheduled task...
  schtasks /End /TN "%TASKNAME%" >NUL 2>&1
  schtasks /Delete /TN "%TASKNAME%" /F >NUL 2>&1
  if errorlevel 1 (
    echo [!] Couldn't remove the scheduled task.
    echo     Try running this file as Administrator, or remove
    echo     "%TASKNAME%" by hand in Task Scheduler.
    echo.
    pause
    exit /b 1
  )
  set "REMOVED=1"
)

for /f "usebackq delims=" %%S in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\startup-shortcut.ps1" -Remove`) do (
  echo Removing the Startup shortcut...
  set "REMOVED=1"
)

if not defined REMOVED (
  echo Autostart wasn't enabled - nothing to undo.
  echo.
  pause
  exit /b 0
)

REM Stop whatever is running now. schtasks /End only reaches a task-launched worker, and
REM with the Startup-folder mechanism there is no task at all — but either way the pid we
REM wrote at launch names it.
if exist "%RUN_DIR%\worker.pid" (
  set /p WPID=<"%RUN_DIR%\worker.pid"
  if defined WPID (
    echo Stopping the worker...
    taskkill /PID !WPID! /T /F >NUL 2>&1
  )
  del /q "%RUN_DIR%\worker.pid" >NUL 2>&1
)

del /q "%RUN_DIR%\run-worker-autostart.cmd" >NUL 2>&1

echo.
echo Autostart disabled and the worker stopped.
echo Start-SocialScheduler-Windows.bat will offer to turn it back on.
echo.
pause
