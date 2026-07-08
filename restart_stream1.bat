@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: STREAM1 Restart
:: Kills STREAM1 App + Server (and child processes), then
:: starts Server, waits until it responds, then starts App.
:: ============================================================

set "DEFAULT_INSTALL=C:\Program Files\STREAM1"
set "ALT_INSTALL=C:\Program Files\Stream1"
set "PORT=15000"
set "INSTALL_DIR="
set "SERVER_EXE="
set "APP_EXE="

:: Prefer the folder this script lives in if it contains the exes.
if exist "%~dp0STREAM1 Server.exe" (
    set "INSTALL_DIR=%~dp0"
    set "SERVER_EXE=%~dp0STREAM1 Server.exe"
) else if exist "%~dp0STREAM1.Server.exe" (
    set "INSTALL_DIR=%~dp0"
    set "SERVER_EXE=%~dp0STREAM1.Server.exe"
)

if exist "%~dp0STREAM1 App.exe" (
    if not defined INSTALL_DIR set "INSTALL_DIR=%~dp0"
    set "APP_EXE=%~dp0STREAM1 App.exe"
) else if exist "%~dp0STREAM1.App.exe" (
    if not defined INSTALL_DIR set "INSTALL_DIR=%~dp0"
    set "APP_EXE=%~dp0STREAM1.App.exe"
)

:: Fallback to standard install locations.
if not defined SERVER_EXE if exist "%DEFAULT_INSTALL%\STREAM1 Server.exe" (
    set "INSTALL_DIR=%DEFAULT_INSTALL%\"
    set "SERVER_EXE=%DEFAULT_INSTALL%\STREAM1 Server.exe"
) else if not defined SERVER_EXE if exist "%DEFAULT_INSTALL%\STREAM1.Server.exe" (
    set "INSTALL_DIR=%DEFAULT_INSTALL%\"
    set "SERVER_EXE=%DEFAULT_INSTALL%\STREAM1.Server.exe"
) else if not defined SERVER_EXE if exist "%ALT_INSTALL%\STREAM1 Server.exe" (
    set "INSTALL_DIR=%ALT_INSTALL%\"
    set "SERVER_EXE=%ALT_INSTALL%\STREAM1 Server.exe"
) else if not defined SERVER_EXE if exist "%ALT_INSTALL%\STREAM1.Server.exe" (
    set "INSTALL_DIR=%ALT_INSTALL%\"
    set "SERVER_EXE=%ALT_INSTALL%\STREAM1.Server.exe"
)

if not defined APP_EXE if exist "%DEFAULT_INSTALL%\STREAM1 App.exe" (
    if not defined INSTALL_DIR set "INSTALL_DIR=%DEFAULT_INSTALL%\"
    set "APP_EXE=%DEFAULT_INSTALL%\STREAM1 App.exe"
) else if not defined APP_EXE if exist "%DEFAULT_INSTALL%\STREAM1.App.exe" (
    if not defined INSTALL_DIR set "INSTALL_DIR=%DEFAULT_INSTALL%\"
    set "APP_EXE=%DEFAULT_INSTALL%\STREAM1.App.exe"
) else if not defined APP_EXE if exist "%ALT_INSTALL%\STREAM1 App.exe" (
    if not defined INSTALL_DIR set "INSTALL_DIR=%ALT_INSTALL%\"
    set "APP_EXE=%ALT_INSTALL%\STREAM1 App.exe"
) else if not defined APP_EXE if exist "%ALT_INSTALL%\STREAM1.App.exe" (
    if not defined INSTALL_DIR set "INSTALL_DIR=%ALT_INSTALL%\"
    set "APP_EXE=%ALT_INSTALL%\STREAM1.App.exe"
)

if not defined SERVER_EXE (
    echo Could not find STREAM1 Server.exe in:
    echo   %~dp0
    echo   %DEFAULT_INSTALL%
    echo   %ALT_INSTALL%
    pause
    exit /b 1
)

if not defined APP_EXE (
    echo Could not find STREAM1 App.exe in:
    echo   %~dp0
    echo   %DEFAULT_INSTALL%
    echo   %ALT_INSTALL%
    pause
    exit /b 1
)

echo.
echo Install folder: %INSTALL_DIR%
echo Server:         %SERVER_EXE%
echo App:            %APP_EXE%
echo.

:: --- Close STREAM1 processes ( /T = child processes e.g. mongod ) ---
echo Closing STREAM1 processes...

for %%I in (
    "STREAM1 App.exe"
    "STREAM1.App.exe"
    "STREAM1 Server.exe"
    "STREAM1.Server.exe"
    "stream1-app.exe"
    "stream1-server.exe"
) do (
    taskkill /f /im %%~I /t >nul 2>&1
    if not errorlevel 1 echo   Closed: %%~I
)

:: Wait until both image names are gone (up to ~15 seconds).
set /a TRIES=0
:wait_exit
set "STILL_RUNNING=0"
for %%I in ("STREAM1 App.exe" "STREAM1.App.exe" "STREAM1 Server.exe" "STREAM1.Server.exe") do (
    tasklist /fi "imagename eq %%~I" /fo csv /nh 2>nul | find /i "%%~I" >nul 2>&1
    if not errorlevel 1 set "STILL_RUNNING=1"
)
if "!STILL_RUNNING!"=="1" (
    set /a TRIES+=1
    if !TRIES! lss 30 (
        timeout /t 1 /nobreak >nul
        goto wait_exit
    )
)

echo Waiting for file locks to clear...
timeout /t 2 /nobreak >nul

:: --- Start Server first ---
echo.
echo Starting STREAM1 Server...
start "" /D "%INSTALL_DIR%" "%SERVER_EXE%"
if errorlevel 1 (
    echo Failed to start STREAM1 Server.
    pause
    exit /b 1
)

:: --- Wait for HTTP ping ---
echo Waiting for server on port %PORT%...
powershell -NoProfile -Command ^
  "$deadline = (Get-Date).AddSeconds(120); " ^
  "while ((Get-Date) -lt $deadline) { " ^
  "  try { " ^
  "    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/ping' -UseBasicParsing -TimeoutSec 2; " ^
  "    if ($r.StatusCode -eq 200) { exit 0 } " ^
  "  } catch {} " ^
  "  Start-Sleep -Milliseconds 700 " ^
  "}; exit 1"

if errorlevel 1 (
    echo STREAM1 Server did not respond in time. Check the server window for errors.
    pause
    exit /b 2
)

echo Server is ready.

:: --- Start App ---
echo Starting STREAM1 App...
start "" /D "%INSTALL_DIR%" "%APP_EXE%"
if errorlevel 1 (
    echo Failed to start STREAM1 App.
    pause
    exit /b 3
)

echo.
echo Done — STREAM1 Server and App were restarted.
timeout /t 3 >nul
exit /b 0
