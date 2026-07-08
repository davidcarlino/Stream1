@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: STREAM1 Open
:: Starts Server + App from C:\Program Files\STREAM1
:: - Server: skip start if already running (no second instance)
:: - App:    focus existing window, or start if not running
:: ============================================================

set "DEFAULT_INSTALL=C:\Program Files\STREAM1"
set "ALT_INSTALL=C:\Program Files\Stream1"
set "PORT=15000"
set "INSTALL_DIR=%DEFAULT_INSTALL%\"
set "SERVER_EXE="
set "APP_EXE="
set "SERVER_RUNNING=0"
set "APP_RUNNING=0"
set "EXIT_CODE=0"

:: --- Resolve Server exe (Program Files first) ---
if exist "%DEFAULT_INSTALL%\STREAM1 Server.exe" (
    set "SERVER_EXE=%DEFAULT_INSTALL%\STREAM1 Server.exe"
    set "INSTALL_DIR=%DEFAULT_INSTALL%\"
) else if exist "%DEFAULT_INSTALL%\STREAM1.Server.exe" (
    set "SERVER_EXE=%DEFAULT_INSTALL%\STREAM1.Server.exe"
    set "INSTALL_DIR=%DEFAULT_INSTALL%\"
) else if exist "%ALT_INSTALL%\STREAM1 Server.exe" (
    set "SERVER_EXE=%ALT_INSTALL%\STREAM1 Server.exe"
    set "INSTALL_DIR=%ALT_INSTALL%\"
) else if exist "%ALT_INSTALL%\STREAM1.Server.exe" (
    set "SERVER_EXE=%ALT_INSTALL%\STREAM1.Server.exe"
    set "INSTALL_DIR=%ALT_INSTALL%\"
) else if exist "%~dp0STREAM1 Server.exe" (
    set "INSTALL_DIR=%~dp0"
    set "SERVER_EXE=%~dp0STREAM1 Server.exe"
) else if exist "%~dp0STREAM1.Server.exe" (
    set "INSTALL_DIR=%~dp0"
    set "SERVER_EXE=%~dp0STREAM1.Server.exe"
)

:: --- Resolve App exe (Program Files first) ---
if exist "%DEFAULT_INSTALL%\STREAM1 App.exe" (
    set "APP_EXE=%DEFAULT_INSTALL%\STREAM1 App.exe"
) else if exist "%DEFAULT_INSTALL%\STREAM1.App.exe" (
    set "APP_EXE=%DEFAULT_INSTALL%\STREAM1.App.exe"
) else if exist "%ALT_INSTALL%\STREAM1 App.exe" (
    set "APP_EXE=%ALT_INSTALL%\STREAM1 App.exe"
) else if exist "%ALT_INSTALL%\STREAM1.App.exe" (
    set "APP_EXE=%ALT_INSTALL%\STREAM1.App.exe"
) else if exist "%~dp0STREAM1 App.exe" (
    set "APP_EXE=%~dp0STREAM1 App.exe"
) else if exist "%~dp0STREAM1.App.exe" (
    set "APP_EXE=%~dp0STREAM1.App.exe"
)

if not defined SERVER_EXE (
    echo [ERROR] Could not find STREAM1 Server.exe in:
    echo         %DEFAULT_INSTALL%
    echo         %ALT_INSTALL%
    echo         %~dp0
    set "EXIT_CODE=1"
    goto :finish
)

if not defined APP_EXE (
    echo [ERROR] Could not find STREAM1 App.exe in:
    echo         %DEFAULT_INSTALL%
    echo         %ALT_INSTALL%
    echo         %~dp0
    set "EXIT_CODE=1"
    goto :finish
)

echo.
echo Install folder: %INSTALL_DIR%
echo Server:         %SERVER_EXE%
echo App:            %APP_EXE%
echo.

:: --- Detect running processes ---
call :IsImageRunning "STREAM1 Server.exe" SERVER_RUNNING
if "!SERVER_RUNNING!"=="0" call :IsImageRunning "STREAM1.Server.exe" SERVER_RUNNING

call :IsImageRunning "STREAM1 App.exe" APP_RUNNING
if "!APP_RUNNING!"=="0" call :IsImageRunning "STREAM1.App.exe" APP_RUNNING

:: --- Server ---
if "!SERVER_RUNNING!"=="1" (
    echo [OK] STREAM1 Server is already running — not starting another instance.
) else (
    echo Starting STREAM1 Server...
    start "" /D "%INSTALL_DIR%" "%SERVER_EXE%"
    if errorlevel 1 (
        echo [ERROR] Failed to start STREAM1 Server.
        set "EXIT_CODE=2"
        goto :finish
    )

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
        echo [WARN] Server started but is not responding yet on port %PORT%.
        echo        Check the STREAM1 Server window if the App cannot connect.
    ) else (
        echo [OK] STREAM1 Server is ready.
    )
)

:: --- App ---
if "!APP_RUNNING!"=="1" (
    echo [OK] STREAM1 App is already running — bringing window to front...
    call :FocusStream1App
    if errorlevel 1 (
        echo [WARN] Could not focus the App window ^(it may be in the system tray only^).
        echo        Use the tray icon or taskbar to show STREAM1 App.
    ) else (
        echo [OK] STREAM1 App window focused.
    )
) else (
    echo Starting STREAM1 App...
    start "" /D "%INSTALL_DIR%" "%APP_EXE%"
    if errorlevel 1 (
        echo [ERROR] Failed to start STREAM1 App.
        set "EXIT_CODE=3"
        goto :finish
    )
    echo [OK] STREAM1 App started.
)

:finish
echo.
if "!EXIT_CODE!"=="0" (
    echo Done.
) else (
    echo Finished with errors ^(exit code !EXIT_CODE!^).
)
timeout /t 2 >nul
exit /b !EXIT_CODE!

:: --- Returns ERRORLEVEL 0 if image is running, 1 if not ---
:: Usage: call :IsImageRunning "STREAM1 Server.exe" VAR_NAME
:IsImageRunning
set "%~2=0"
tasklist /fi "imagename eq %~1" /fo csv /nh 2>nul | find /i "%~1" >nul 2>&1
if not errorlevel 1 set "%~2=1"
exit /b 0

:: --- Bring STREAM1 App main window to front (ERRORLEVEL 0 = success) ---
:FocusStream1App
powershell -NoProfile -Command ^
  "Add-Type 'using System; using System.Runtime.InteropServices; public class S1W { [DllImport(""user32.dll"")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(""user32.dll"")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(""user32.dll"")] public static extern bool IsIconic(IntPtr h); }'; " ^
  "$found = $false; " ^
  "foreach ($name in @('STREAM1 App','STREAM1.App')) { " ^
  "  Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { " ^
  "    if ($_.MainWindowHandle -ne [IntPtr]::Zero) { " ^
  "      if ([S1W]::IsIconic($_.MainWindowHandle)) { [S1W]::ShowWindow($_.MainWindowHandle, 9) | Out-Null } " ^
  "      else { [S1W]::ShowWindow($_.MainWindowHandle, 5) | Out-Null }; " ^
  "      [S1W]::SetForegroundWindow($_.MainWindowHandle) | Out-Null; " ^
  "      $found = $true " ^
  "    } " ^
  "  } " ^
  "}; if ($found) { exit 0 } else { exit 1 }"
exit /b %ERRORLEVEL%
