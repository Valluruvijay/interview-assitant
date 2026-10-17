@echo off
setlocal
title InterviewAI Pro

cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" (
    start "" "%~dp0node_modules\electron\dist\electron.exe" .
    exit /b 0
)

if exist "dist\win-unpacked\AMD Audio Service.exe" (
    start "" "%~dp0dist\win-unpacked\AMD Audio Service.exe"
    exit /b 0
)

echo ==========================================
echo  InterviewAI Pro
echo ==========================================
echo.
echo Installing dependencies now...
echo.

call npm.cmd install
if errorlevel 1 (
    echo.
    echo Install failed.
    pause
    exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" (
    start "" "%~dp0node_modules\electron\dist\electron.exe" .
    exit /b 0
)

pause
exit /b 1
