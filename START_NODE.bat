@echo off
title InterviewAI Pro
if "%1"=="CHILD" goto :main
cmd /k "%~f0" CHILD
exit
:main
cd /d "%~dp0"
echo Running setup via Node.js...
echo.
node SETUP.js
echo.
pause > nul
