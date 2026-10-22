@echo off
REM Quick build + install + launch for the Android app in .\android.
REM Usage: build-android.bat [device-serial]
REM Set TERMINAL_BUDDY_NO_PAUSE=1 for non-interactive use.
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
echo Press any key to close this window...
pause >nul

:Done
exit /b %EXIT_CODE%
