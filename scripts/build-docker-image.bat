@echo off
chcp 936 >nul
setlocal EnableExtensions DisableDelayedExpansion
title TerminalBuddy 镜像构建与导出

cd /d "%~dp0.."

rem ============ 可调参数 ============
if not defined TB_IMAGE set "TB_IMAGE=terminal-buddy:server"
set "OUTPUT_DIR=%~dp0..\dist"
set "TARBALL=%OUTPUT_DIR%\terminal-buddy-server.tar"

rem ============ 环境检查 ============
where docker >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 docker 命令，请先安装 Docker Desktop 并确保它已加入 PATH。
    goto :fail
)
docker info >nul 2>&1
if errorlevel 1 (
    echo [错误] 无法连接 Docker 引擎，请确认 Docker Desktop 已启动。
    goto :fail
)
if not exist "%~dp0..\Dockerfile" (
    echo [错误] 未找到 Dockerfile，请确认仓库根目录下存在 Dockerfile。
    goto :fail
)
if not exist "%OUTPUT_DIR%" (
    mkdir "%OUTPUT_DIR%"
    if errorlevel 1 (
        echo [错误] 无法创建输出目录：%OUTPUT_DIR%
        goto :fail
    )
)

rem ============ 构建镜像 ============
echo.
echo [1/2] 构建镜像 %TB_IMAGE%
echo       首次构建需下载基础镜像与依赖，耗时较长；改动源码后再次构建会复用缓存。
echo.
docker build -f "%~dp0..\Dockerfile" -t "%TB_IMAGE%" "%~dp0.."
if errorlevel 1 (
    echo.
    echo [错误] 镜像构建失败，请查看上方构建日志。
    goto :fail
)

rem ============ 导出 tar ============
echo.
echo [2/2] 导出镜像到 %TARBALL%
echo       未压缩 tar 体积较大，导出需要一些时间。
echo.
docker save -o "%TARBALL%" "%TB_IMAGE%"
if errorlevel 1 (
    echo.
    echo [错误] 镜像导出失败。
    goto :fail
)

set "IMAGE_ID="
for /f "usebackq delims=" %%i in (`docker image inspect "%TB_IMAGE%" --format "{{.Id}}"`) do set "IMAGE_ID=%%i"
for %%A in ("%TARBALL%") do set "TAR_SIZE=%%~zA"

echo.
echo [完成] 镜像已构建并导出。
echo        镜像标签：%TB_IMAGE%
echo        镜像 ID ：%IMAGE_ID%
echo        导出文件：%TARBALL%
echo        文件大小：%TAR_SIZE% 字节
echo.
echo 在离线机器上导入：
echo        docker load -i terminal-buddy-server.tar
echo 之后按 compose.yaml 或 docker run 启动，镜像名使用 %TB_IMAGE%
goto :done

:fail
echo.
pause
exit /b 1

:done
echo.
pause
exit /b 0
