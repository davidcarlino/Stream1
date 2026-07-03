@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: STREAM1 Updater
:: Copies all files from this script's folder into
:: C:\Program Files\STREAM1 (closing + deleting old versions
:: first), then launches the exe files.
:: ============================================================

:: --- Self-elevate to Administrator (needed for Program Files) ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "SRC=%~dp0"
set "DEST=C:\Program Files\STREAM1"

echo.
echo Source:      %SRC%
echo Destination: %DEST%
echo.

:: --- Kill any running apps that match the files being replaced ---
echo Closing running applications...
for %%F in ("%SRC%*.exe") do (
    taskkill /f /im "%%~nxF" >nul 2>&1
    if not errorlevel 1 echo   Closed: %%~nxF
)

:: Give Windows a moment to release file locks
timeout /t 2 /nobreak >nul

:: --- Make sure destination exists ---
if not exist "%DEST%" mkdir "%DEST%"

:: --- Delete old versions in destination (everything except this bat) ---
echo Deleting old files in %DEST%...
for %%F in ("%SRC%*") do (
    if /i not "%%~nxF"=="%~nx0" (
        if exist "%DEST%\%%~nxF" (
            del /f /q "%DEST%\%%~nxF"
            echo   Deleted: %%~nxF
        )
    )
)

:: --- Copy everything from this folder to destination ---
echo Copying new files...
for %%F in ("%SRC%*") do (
    if /i not "%%~nxF"=="%~nx0" (
        copy /y "%%F" "%DEST%\" >nul
        if errorlevel 1 (
            echo   FAILED to copy: %%~nxF
        ) else (
            echo   Copied: %%~nxF
        )
    )
)

:: --- Launch the exe files ---
echo.
echo Launching applications...
for %%F in ("%SRC%*.exe") do (
    start "" "%DEST%\%%~nxF"
    echo   Started: %%~nxF
)

echo.
echo Done.
timeout /t 3 >nul
exit /b
