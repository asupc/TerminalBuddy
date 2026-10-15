@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title TerminalBuddy - 一键部署到 CentOS 服务器

REM ==================== 配置 ====================
set SERVER=192.168.3.202
set SSH_PORT=22
set USER=root
set REMOTE_DIR=/root/terminal-buddy/src
set DATA_DIR=/root/terminal-buddy/data
set HOME_DIR=/root/terminal-buddy/home
set WORKSPACE_DIR=/root/terminal-buddy/workspace
set CONTAINER=terminal-buddy
set IMAGE=terminal-buddy:server
set HOST_PORT=9610
set CONTAINER_PORT=9600
set BIND_ADDRESS=0.0.0.0
set ADMIN_USER=admin
set SSH_RETRY=3
set SSH_WAIT=3
set PULL_LATEST=1
set SKIP_BUILD=0

REM Git 自带的 ssh/scp（本机 Windows 自带 OpenSSH 不可用）
set GIT_USR=C:\Program Files\Git\usr\bin
set SSH_EXE=%GIT_USR%\ssh.exe
set SCP_EXE=%GIT_USR%\scp.exe
set KEYGEN_EXE=%GIT_USR%\ssh-keygen.exe
set SSH_KEY=%USERPROFILE%\.ssh\terminal_buddy_deploy
set KNOWN_HOSTS=%TEMP%\terminal_buddy_known_hosts
set SSH_OPTS=-i "%SSH_KEY%" -o StrictHostKeyChecking=no -o UserKnownHostsFile="%KNOWN_HOSTS%" -o LogLevel=ERROR -p %SSH_PORT%
set SSH_OPTS_B=-i "%SSH_KEY%" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile="%KNOWN_HOSTS%" -o LogLevel=ERROR -p %SSH_PORT%
REM ================================================

cd /d "%~dp0"
set PROJECT_DIR=%CD%
set TARBALL=%TEMP%\terminal-buddy-src.tar.gz
set OUT_LOG=%TEMP%\terminal_buddy_deploy.log

echo ========== TerminalBuddy 一键部署 ==========
echo   目标: %USER%@%SERVER%    端口 %HOST_PORT% -^> 容器 %CONTAINER_PORT%
echo.

REM ---------- 0. 依赖检查 ----------
if not exist "%SSH_EXE%" goto :no_git
if not exist "Dockerfile" goto :wrong_dir
if not exist "deploy-centos.sh" goto :no_script
if not exist "scripts\remote-deploy.sh" goto :no_script
if not exist "scripts\remote-verify.sh" goto :no_script
where tar >nul 2>nul
if errorlevel 1 goto :no_tar

if "%~1"=="--no-build" set SKIP_BUILD=1
if "%~1"=="--no-pull" set PULL_LATEST=0

REM ---------- 1. 拉取最新代码 ----------
if "%PULL_LATEST%"=="1" (
    if exist ".git" (
        echo [1/6] 拉取最新代码...
        git pull --ff-only
        if errorlevel 1 goto :git_pull_fail
    ) else (
        echo [1/6] 非 git 目录，跳过拉取。
    )
) else (
    echo [1/6] 已跳过代码拉取。
)

REM ---------- 2. 免密认证 ----------
if not exist "%SSH_KEY%" goto :setup_key
"%SSH_EXE%" %SSH_OPTS_B% -o ConnectTimeout=8 %USER%@%SERVER% "echo ok" >nul 2>nul
if not errorlevel 1 goto :key_ok
echo [提示] 免密登录失效，重新安装公钥...

:setup_key
echo [2/6] 首次运行：生成部署密钥并安装到服务器...
if not exist "%SSH_KEY%" "%KEYGEN_EXE%" -t ed25519 -N "" -C terminal-buddy-deploy -f "%SSH_KEY%" >nul
where python >nul 2>nul
if errorlevel 1 goto :need_python
python -c "import paramiko" >nul 2>nul
if errorlevel 1 python -m pip install --quiet --disable-pip-version-check paramiko
python "scripts\install-key.py" --host %SERVER% --port %SSH_PORT% --user %USER% --pubkey "%SSH_KEY%.pub"
if errorlevel 1 goto :fail

:key_ok
echo [2/6] 免密认证通过 (%USER%@%SERVER%)
echo.

REM ---------- 3. 打包本机源码 ----------
echo [3/6] 打包源码...
del /q "%TARBALL%" 2>nul
tar -czf "%TARBALL%" --exclude=./.git --exclude=./node_modules --exclude=*/node_modules --exclude=./target --exclude=*/target --exclude=./terminal-buddy/dist --exclude=./terminal-buddy/dist-web --exclude=./terminal-buddy/server-data --exclude=./workspace --exclude=./secrets --exclude=./.claude --exclude=./.codegraph --exclude=./design -C "%PROJECT_DIR%" .
if errorlevel 1 goto :tar_fail
for %%A in ("%TARBALL%") do set TARBYTES=%%~zA
echo       源码包: !TARBYTES! 字节

echo [4/6] 上传到服务器...
set UPLOAD_OK=0
for /L %%i in (1,1,!SSH_RETRY!) do (
    if !UPLOAD_OK!==0 (
        echo   尝试 %%i/!SSH_RETRY! ...
        "%SCP_EXE%" -i "%SSH_KEY%" -o StrictHostKeyChecking=no -o UserKnownHostsFile="%KNOWN_HOSTS%" -o LogLevel=ERROR -P %SSH_PORT% "%TARBALL%" %USER%@%SERVER%:/tmp/terminal-buddy-src.tar.gz
        if not errorlevel 1 ( set UPLOAD_OK=1 ) else ( timeout /t !SSH_WAIT! /nobreak >nul )
    )
)
if !UPLOAD_OK!==0 goto :upload_fail

"%SCP_EXE%" -i "%SSH_KEY%" -o StrictHostKeyChecking=no -o UserKnownHostsFile="%KNOWN_HOSTS%" -o LogLevel=ERROR -P %SSH_PORT% "scripts\remote-deploy.sh" %USER%@%SERVER%:/tmp/terminal-buddy-remote-deploy.sh
if errorlevel 1 goto :upload_fail

REM ---------- 4. 远端构建并启动 ----------
if "%SKIP_BUILD%"=="1" (
    echo [5/6] 远端部署（跳过构建）...
    set REMOTE_ENV=TB_REMOTE_DIR=%REMOTE_DIR% TB_HOST_PORT=%HOST_PORT% TB_DATA_DIR=%DATA_DIR% TB_HOME_DIR=%HOME_DIR% TB_WORKSPACE=%WORKSPACE_DIR% TB_USERNAME=%ADMIN_USER% TB_BIND_ADDRESS=%BIND_ADDRESS%
    "%SSH_EXE%" %SSH_OPTS_B% -o ServerAliveInterval=30 -o ServerAliveCountMax=20 %USER%@%SERVER% "chmod +x /tmp/terminal-buddy-remote-deploy.sh; TB_SKIP_BUILD=1 !REMOTE_ENV! bash /tmp/terminal-buddy-remote-deploy.sh" > "%OUT_LOG%" 2>&1
) else (
    echo [5/6] 远端构建镜像并启动容器（首次约 5-10 分钟）...
    set REMOTE_ENV=TB_REMOTE_DIR=%REMOTE_DIR% TB_HOST_PORT=%HOST_PORT% TB_DATA_DIR=%DATA_DIR% TB_HOME_DIR=%HOME_DIR% TB_WORKSPACE=%WORKSPACE_DIR% TB_USERNAME=%ADMIN_USER% TB_BIND_ADDRESS=%BIND_ADDRESS%
    "%SSH_EXE%" %SSH_OPTS_B% -o ServerAliveInterval=30 -o ServerAliveCountMax=20 %USER%@%SERVER% "chmod +x /tmp/terminal-buddy-remote-deploy.sh; !REMOTE_ENV! bash /tmp/terminal-buddy-remote-deploy.sh" > "%OUT_LOG%" 2>&1
)
set REMOTE_EXIT=%ERRORLEVEL%
findstr /V /C:"Permanently added" /C:"setlocale" "%OUT_LOG%"
if not "%REMOTE_EXIT%"=="0" goto :remote_fail

REM ---------- 5. 最终验证 ----------
echo [6/6] 校验容器与服务状态...
"%SCP_EXE%" -i "%SSH_KEY%" -o StrictHostKeyChecking=no -o UserKnownHostsFile="%KNOWN_HOSTS%" -o LogLevel=ERROR -P %SSH_PORT% "scripts\remote-verify.sh" %USER%@%SERVER%:/tmp/terminal-buddy-remote-verify.sh
if errorlevel 1 goto :verify_fail
"%SSH_EXE%" %SSH_OPTS_B% %USER%@%SERVER% "TB_CONTAINER=%CONTAINER% TB_IMAGE=%IMAGE% TB_HOST_PORT=%HOST_PORT% TB_CONTAINER_PORT=%CONTAINER_PORT% bash /tmp/terminal-buddy-remote-verify.sh; set +e; rc=$?; rm -f /tmp/terminal-buddy-remote-verify.sh /tmp/terminal-buddy-remote-deploy.sh; exit $rc"
if errorlevel 1 goto :verify_fail

echo.
echo ========== 部署完成 ==========
echo   局域网 : http://%SERVER%:%HOST_PORT%/
echo   容器   : %CONTAINER%  镜像 %IMAGE%
echo   数据   : %DATA_DIR%  ^|  %HOME_DIR%  ^|  %WORKSPACE_DIR%
echo   账号   : %ADMIN_USER%  密码在网页首次访问时设置
echo.
echo   查看日志 : "%SSH_EXE%" %SSH_OPTS% %USER%@%SERVER% "docker logs -f --tail 100 %CONTAINER%"
echo   重启服务 : "%SSH_EXE%" %SSH_OPTS% %USER%@%SERVER% "docker restart %CONTAINER%"
echo.
del /q "%TARBALL%" 2>nul
if not "%TB_NO_PAUSE%"=="1" pause
endlocal
exit /b 0

:no_git
echo [错误] 找不到 Git 自带的 ssh: %SSH_EXE%
echo        请先安装 Git for Windows，或修改脚本中的 GIT_USR 路径。
goto :fail

:no_tar
echo [错误] 找不到 tar 命令，无法打包源码。
goto :fail

:wrong_dir
echo [错误] 当前目录没有 Dockerfile，请把 deploy.bat 放在项目根目录。
echo        当前目录: %PROJECT_DIR%
goto :fail

:no_script
echo [错误] 缺少部署脚本（deploy-centos.sh / scripts\remote-deploy.sh），源码不完整。
goto :fail

:need_python
echo [错误] 首次安装公钥需要 Python 3 + paramiko。
echo        或手动把 %SSH_KEY%.pub 内容追加到服务器 /root/.ssh/authorized_keys
goto :fail

:git_pull_fail
echo [错误] 拉取最新代码失败（可用 deploy.bat --no-pull 跳过）。
goto :fail

:tar_fail
echo [错误] 打包源码失败。
goto :fail

:upload_fail
echo [错误] 源码上传失败（%SSH_RETRY% 次重试均失败）。
goto :fail

:remote_fail
echo [错误] 远端部署失败，完整日志：%OUT_LOG%
goto :fail

:verify_fail
echo [错误] 最终校验失败，请登录服务器确认容器状态。
goto :fail

:fail
echo.
echo ---------- 部署失败 ----------
echo.
if not "%TB_NO_PAUSE%"=="1" pause
endlocal
exit /b 1
