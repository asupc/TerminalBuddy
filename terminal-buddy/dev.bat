@echo off
cd /d "%~dp0terminal-buddy"

:: 编译 web 端远程访问界面
cd web
call npm run build
cd ..

:: 启动 Tauri 开发模式
start "" npm run tauri dev
