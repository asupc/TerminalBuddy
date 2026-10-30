@echo off
cd /d "%~dp0..\terminal-buddy"

:: 启动 Tauri 开发模式
start "" npm run tauri dev
