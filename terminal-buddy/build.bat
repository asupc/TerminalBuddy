@echo off
echo === Full build (exe + NSIS installer) ===
cd /d "%~dp0"
npx tauri build
pause
