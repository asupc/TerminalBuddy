@echo off
chcp 65001 >nul
REM 构建已签名的 Release APK，安装到手机并启动应用。
REM 用法：build-android.bat [设备序列号]
REM 设置 TERMINAL_BUDDY_NO_PAUSE=1 可跳过结束时的等待按键。
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
echo 按任意键关闭此窗口...
pause >nul

:Done
exit /b %EXIT_CODE%
