@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   SocialScheduler - Restore (Windows)
REM   Double-click to put a backup folder back: your posts,
REM   schedule, tags and statistics, plus all of your images.
REM
REM   This REPLACES the data on this computer. It shows you what
REM   it will do first and asks you to confirm. Your current
REM   database is saved aside before anything is overwritten.
REM ============================================================

cd /d "%~dp0"

echo ==========================================
echo   SocialScheduler - Restore
echo ==========================================
echo.

if not exist ".venv" (
  echo The Python environment is missing. Double-click "Update-Windows" first, then try again.
  echo.
  pause
  exit /b 1
)

echo Find the backup folder in File Explorer - it's the dated one Export made,
echo with "socialscheduler.db" and "export.json" inside it.
echo.
echo Drag that folder into this window, then press Enter:
echo.
set "BACKUP="
set /p "BACKUP=  Folder: "

REM Dragging a folder into a console window wraps the path in double quotes when it
REM contains spaces. Strip them; the path is re-quoted where it is used below.
if defined BACKUP set "BACKUP=%BACKUP:"=%"

if not defined BACKUP (
  echo.
  echo No folder given. Nothing was changed.
  echo.
  pause
  exit /b 1
)
if not exist "%BACKUP%\" (
  echo.
  echo That isn't a folder: %BACKUP%
  echo Nothing was changed.
  echo.
  pause
  exit /b 1
)

echo.
echo ------------------------------------------
echo   What restoring would do
echo ------------------------------------------
echo.

REM Dry run first, always. The module writes nothing without --apply, so this is a
REM genuine preview rather than a promise about one.
".venv\Scripts\python" -m worker.restore "%BACKUP%"
if not "%errorlevel%"=="0" (
  echo.
  echo Nothing was changed.
  echo.
  pause
  exit /b 1
)

echo ------------------------------------------
echo.
echo This replaces the posts and images on THIS computer with the ones above.
echo Stop the app first if it is running - the restore will refuse otherwise.
echo.
set "CONFIRM="
set /p "CONFIRM=Type the word  restore  to go ahead (anything else cancels): "

if not "%CONFIRM%"=="restore" (
  echo.
  echo Cancelled. Nothing was changed.
  echo.
  pause
  exit /b 1
)

echo.
".venv\Scripts\python" -m worker.restore "%BACKUP%" --apply
if not "%errorlevel%"=="0" (
  echo.
  echo The restore didn't finish ^(see the message above^).
  echo.
  pause
  exit /b 1
)

echo.
echo Done. Start the app, then reconnect each account under Channels -
echo backups deliberately contain no passwords or access tokens.
echo.
pause
exit /b 0
