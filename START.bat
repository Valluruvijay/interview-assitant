@echo off
setlocal
title InterviewAI Pro
color 0A

cd /d "%~dp0"

if exist "dist\win-unpacked\AMD Audio Service.exe" (
    start "" "%~dp0dist\win-unpacked\AMD Audio Service.exe"
    exit /b 0
)

if exist "dist\win-unpacked\InterviewAI Pro.exe" (
    start "" "%~dp0dist\win-unpacked\InterviewAI Pro.exe"
    exit /b 0
)

if exist "node_modules\electron\dist\electron.exe" (
    start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
    exit /b 0
)

echo.
echo  ==========================================
echo   InterviewAI Pro v2.0
echo  ==========================================
echo.

echo [1] Checking Node.js...
node --version
if errorlevel 1 (
    echo.
    echo PROBLEM: Node.js was not found in PATH.
    echo Fix: install Node.js LTS from https://nodejs.org, restart Windows, then run START.bat again.
    echo.
    pause
    exit /b 1
)

echo.
echo [2] Installing app dependencies...
echo This may take 2-5 minutes on first setup.
echo.
call npm.cmd install
if errorlevel 1 (
    echo.
    echo PROBLEM: npm install failed.
    echo Run DEBUG.bat for detailed logs.
    echo.
    pause
    exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Launching InterviewAI Pro...
    start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
    exit /b 0
)

echo.
echo PROBLEM: Electron was not found after install.
echo Run DEBUG.bat for detailed logs.
echo.
pause
exit /b 1
