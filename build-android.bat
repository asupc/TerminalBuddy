@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "PS_SCRIPT=%~dp0scripts\build-android.ps1"

where pwsh.exe >nul 2>nul
if errorlevel 1 goto :UseWindowsPowerShell

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
goto :AfterRun

:UseWindowsPowerShell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*

:AfterRun
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if /i "%TERMINAL_BUDDY_NO_PAUSE%"=="1" goto :Done
pause

:Done
exit /b %EXIT_CODE%
