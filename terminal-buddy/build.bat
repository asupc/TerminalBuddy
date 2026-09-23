@echo off
echo === Full build (exe + NSIS installer) ===
cd /d "%~dp0"
echo Building web frontend...
cd web && call npm run build && cd ..
if errorlevel 1 (echo Web build failed! && pause && exit /b 1)
npx tauri build
pause
