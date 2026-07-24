@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   SocialScheduler - Export (Windows)
REM   Double-click to save a copy of all your posts, images, and
REM   stats into a dated folder you can drag into Google Drive.
REM   This only READS your data. Nothing is changed or posted.
REM ============================================================

cd /d "%~dp0"

echo ==========================================
echo   SocialScheduler - Export
echo ==========================================
echo.

REM The export runs in the same Python environment as the worker.
if not exist ".venv" (
  echo The Python environment is missing. Double-click "Update-Windows" first, then try again.
  echo.
  pause
  exit /b 1
)

echo Gathering your posts, images, and stats...
echo.

REM Batch has no "tee", so capture the run to a temp file, show it to the user, then
REM read back the last line - the module prints the output folder there so we can open it.
set "LOGFILE=%TEMP%\socialscheduler-export-%RANDOM%.log"
".venv\Scripts\python" -m worker.export > "%LOGFILE%" 2>&1
set "STATUS=%errorlevel%"

type "%LOGFILE%"
echo.

REM The last non-blank line of output is the export folder path. for /f skips blank
REM lines, so the loop variable ends up holding that final line.
set "OUTPUT="
for /f "usebackq delims=" %%L in ("%LOGFILE%") do set "OUTPUT=%%L"
del "%LOGFILE%" >nul 2>nul

if not "%STATUS%"=="0" (
  echo The export didn't finish ^(see the message above^). Your data is untouched.
  echo.
  pause
  exit /b 1
)

if exist "%OUTPUT%\" (
  explorer "%OUTPUT%"
  echo Done. The folder is open in File Explorer - drag it into Google Drive to back it up.
) else (
  echo Done.
)
echo.
pause
exit /b 0
