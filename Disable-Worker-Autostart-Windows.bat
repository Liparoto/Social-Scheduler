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

schtasks /Query /TN "%TASKNAME%" >NUL 2>&1
if errorlevel 1 (
  echo Autostart wasn't enabled - nothing to undo.
  echo.
  pause
  exit /b 0
)

echo Stopping the worker...
schtasks /End /TN "%TASKNAME%" >NUL 2>&1

echo Removing it from logon...
schtasks /Delete /TN "%TASKNAME%" /F >NUL 2>&1
if errorlevel 1 (
  echo [!] Couldn't remove the scheduled task.
  echo     Try running this file as Administrator, or remove
  echo     "%TASKNAME%" by hand in Task Scheduler.
  echo.
  pause
  exit /b 1
)

del /q "%RUN_DIR%\run-worker-autostart.cmd" >NUL 2>&1

echo.
echo Autostart disabled and the worker stopped.
echo Start-SocialScheduler-Windows.bat will offer to turn it back on.
echo.
pause
