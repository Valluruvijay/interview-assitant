@echo off
title InterviewAI Pro - DEBUG
color 0E

if "%1"=="CHILD" goto :main
cmd /k "%~f0" CHILD
exit

:main
echo ==========================================
echo  INTERVIEWAI PRO - DEBUG LOG
echo ==========================================
echo  Time: %date% %time%
echo.

echo --- SYSTEM ---
echo Node.js:
node --version 2>&1
echo npm:
call npm.cmd --version 2>&1
echo.

echo --- FOLDER ---
cd /d "%~dp0"
echo Working dir: %CD%
echo.

echo --- FILES ---
dir /b 2>&1
echo.

echo --- node_modules ---
if exist "node_modules" (
    echo EXISTS
    if exist "node_modules\electron" (
        echo electron folder: EXISTS
    ) else (
        echo electron folder: MISSING
    )
    if exist "node_modules\electron\dist\electron.exe" (
        echo electron.exe: EXISTS - ready to run
    ) else (
        echo electron.exe: MISSING - need to download
    )
) else (
    echo node_modules: DOES NOT EXIST - run npm install
)
echo.

echo --- RUNNING NPM INSTALL ---
call npm.cmd install 2>&1
echo NPM exit code: %errorlevel%
echo.

echo --- CHECKING ELECTRON AFTER INSTALL ---
if exist "node_modules\electron\dist\electron.exe" (
    echo electron.exe found! Launching now...
    echo.
    node_modules\electron\dist\electron.exe .
    echo Electron exit code: %errorlevel%
) else (
    echo electron.exe STILL not found after install.
    echo This usually means the download was blocked.
    echo Try: npm install --verbose to see what failed
    echo.
    call npm.cmd install --verbose 2>&1
)

echo.
echo ==========================================
echo  DEBUG COMPLETE - Press any key to close
echo ==========================================
pause > nul
