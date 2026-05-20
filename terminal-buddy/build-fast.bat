@echo off
echo === Fast build (exe only) ===
cd /d "%~dp0"
echo Building web frontend...
cd web && call npm run build && cd ..
if errorlevel 1 (echo Web build failed! && pause && exit /b 1)
npx tauri build --no-bundle
pause
