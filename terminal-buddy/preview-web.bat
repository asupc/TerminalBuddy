@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
    echo 正在安装网页界面依赖，不执行原生安装脚本...
    call npm ci --ignore-scripts --no-audit --no-fund
    if errorlevel 1 exit /b 1
)
echo 浏览器界面演示：http://127.0.0.1:1450/
echo 此模式使用示例数据，真实终端请使用独立服务端。
call npm run dev:web:demo
