@echo off
echo === Fast build (exe only) ===
cd /d "%~dp0"
npx tauri build --no-bundle
pause
