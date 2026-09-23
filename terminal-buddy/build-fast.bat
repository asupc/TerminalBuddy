@echo off
echo === Fast build (exe only) ===
cd /d "%~dp0"
tasklist /FI "IMAGENAME eq terminal-buddy.exe" /NH | find /I "terminal-buddy.exe" >nul
if not errorlevel 1 (
    echo Closing running TerminalBuddy...
    taskkill /F /IM terminal-buddy.exe >nul 2>&1
    if errorlevel 1 (
        echo Failed to close TerminalBuddy. Please close it manually and try again.
        pause
        exit /b 1
    )
)
echo Building web frontend...
cd web
call npm run build
if errorlevel 1 (
    echo.
    echo Web build failed!
    cd ..
    pause
    exit /b 1
)
cd ..
echo Building Tauri app...
call npx tauri build --no-bundle
if errorlevel 1 (
    echo.
    echo Tauri build failed!
    pause
    exit /b 1
)
echo.
echo Build succeeded!
pause
