@echo off
echo === Fast build (exe only) ===
cd /d "%~dp0"
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
