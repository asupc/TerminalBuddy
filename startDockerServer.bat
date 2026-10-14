@echo off
chcp 936 >nul
setlocal EnableExtensions
title TerminalBuddy 服务端

cd /d "%~dp0"

rem ============ 解析第一个参数，决定运行模式 ============
set "MODE="
set "FORWARD_ARGS="
if "%~1"=="" goto :mode_auto
if /i "%~1"=="local" goto :mode_local
if /i "%~1"=="docker" goto :mode_docker
if /i "%~1"=="docker-stop" goto :mode_docker_stop
if /i "%~1"=="docker-logs" goto :mode_docker_logs
if /i "%~1"=="help" goto :mode_help
if /i "%~1"=="-Check" goto :mode_check
if /i "%~1"=="-check" goto :mode_check
if /i "%~1"=="-h" goto :mode_help
if /i "%~1"=="--help" goto :mode_help
if /i "%~1"=="-?" goto :mode_help
set "ARG1=%~1"
if "%ARG1:~0,1%"=="-" (
    rem 直接传 -Port / -Rebuild / -Workspace 等参数时，按本机模式处理
    set "MODE=local"
    set "FORWARD_ARGS=%*"
    goto :dispatch
)
echo.
echo [错误] 未知命令：%~1
echo        可用命令：local、docker、docker-stop、docker-logs、help
echo        查看用法：startDockerServer.bat help
goto :fail

:mode_auto
set "MODE=auto"
goto :dispatch

:mode_local
set "MODE=local"
rem 跳过开头的 local，其余参数原样转发给 start-web-server.ps1
:collect_local_args
shift
if "%~1"=="" goto :dispatch
set "FORWARD_ARGS=%FORWARD_ARGS% %1"
goto :collect_local_args

:mode_docker
set "MODE=docker"
goto :dispatch

:mode_docker_stop
set "MODE=docker-stop"
goto :dispatch

:mode_docker_logs
set "MODE=docker-logs"
goto :dispatch

:mode_check
set "MODE=check"
goto :dispatch

:mode_help
set "MODE=help"
goto :dispatch

rem ============ 模式分发 ============
:dispatch
if /i "%MODE%"=="check" goto :check_mode
if /i "%MODE%"=="auto" goto :auto_mode
if /i "%MODE%"=="local" goto :local_mode
if /i "%MODE%"=="docker" goto :docker_mode
if /i "%MODE%"=="docker-stop" goto :docker_stop
if /i "%MODE%"=="docker-logs" goto :docker_logs
goto :show_help

rem ============ 只读自检：不编译、不启动、不修改任何文件 ============
:check_mode
echo.
echo [自检] 正在检查启动环境（不会编译或启动服务）...
echo.
set "CHECK_FAIL="
if not exist "%~dp0compose.yaml" (
    echo   [警告] 缺少 compose.yaml，Docker 模式不可用。
    set "CHECK_FAIL=1"
) else (
    echo   [通过] compose.yaml 存在。
)
if not exist "%~dp0terminal-buddy\start-web-server.ps1" (
    echo   [警告] 缺少 terminal-buddy\start-web-server.ps1，本机模式不可用。
    set "CHECK_FAIL=1"
) else (
    echo   [通过] start-web-server.ps1 存在。
)
if not exist "%~dp0terminal-buddy\src-tauri\target\debug\terminal-buddy-server.exe" (
    echo   [提示] 服务端程序尚未编译，首次启动时会自动编译。
) else (
    echo   [通过] 服务端程序已编译。
)
if not exist "%~dp0terminal-buddy\dist-web\index.html" (
    echo   [提示] 网页资源尚未构建，首次启动时会自动构建。
) else (
    echo   [通过] 网页资源已构建。
)
where docker >nul 2>&1
if errorlevel 1 (
    echo   [提示] 未检测到 Docker，将使用本机模式。
) else (
    docker info >nul 2>&1
    if errorlevel 1 (
        echo   [提示] Docker 未运行，将使用本机模式。
    ) else (
        echo   [通过] Docker 可用，默认将使用容器模式。
    )
)
where cargo >nul 2>&1
if errorlevel 1 ( echo   [提示] 未检测到 cargo，无法自动编译服务端。) else ( echo   [通过] cargo 可用。)
where npm.cmd >nul 2>&1
if errorlevel 1 ( echo   [提示] 未检测到 npm.cmd，无法自动构建网页。) else ( echo   [通过] npm.cmd 可用。)
echo.
echo [自检] 完成，未做任何修改。
goto :done

rem 不传参数时：优先用 Docker 容器运行；Docker 不可用时自动退回本机模式
:auto_mode
where docker >nul 2>&1
if errorlevel 1 (
    echo [提示] 未检测到 Docker，将用本机模式启动独立服务端。
    goto :local_mode
)
docker info >nul 2>&1
if errorlevel 1 (
    echo [提示] Docker 未运行，将用本机模式启动独立服务端。
    goto :local_mode
)
goto :docker_mode

rem ============ 本机模式：在 Windows 上直接运行服务端程序，不需要 Docker ============
:local_mode
if not exist "%~dp0terminal-buddy\start-web-server.ps1" (
    echo [错误] 未找到 terminal-buddy\start-web-server.ps1。
    echo        请确认本脚本位于 TerminalBuddy 仓库根目录，且 terminal-buddy 源码目录完整。
    goto :fail
)
where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Windows PowerShell，无法启动本机服务。
    goto :fail
)

set "NEED_REBUILD="
set "REBUILD_REASON="
if not exist "%~dp0terminal-buddy\src-tauri\target\debug\terminal-buddy-server.exe" (
    set "NEED_REBUILD=1"
    set "REBUILD_REASON=未检测到已编译的服务端程序。"
)
if not exist "%~dp0terminal-buddy\dist-web\index.html" (
    set "NEED_REBUILD=1"
    set "REBUILD_REASON=未检测到已编译的网页资源。"
)
echo(%* | findstr /i /c:"-rebuild" >nul 2>&1
if not errorlevel 1 (
    set "NEED_REBUILD="
) else if defined NEED_REBUILD (
    rem 编译产物缺失，需要重新编译。
) else (
    rem 编译产物存在时，检查源码是否比产物更新。
    set "STALE="
    for /f "usebackq delims=" %%s in (`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$sources = Get-ChildItem -LiteralPath 'terminal-buddy\src','terminal-buddy\src-tauri\src' -Recurse -File; $sources += Get-Item -LiteralPath 'terminal-buddy\package.json','terminal-buddy\vite.config.ts','terminal-buddy\index.html'; $newest = ($sources | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime; $exe = (Get-Item -LiteralPath 'terminal-buddy\src-tauri\target\debug\terminal-buddy-server.exe').LastWriteTime; $web = (Get-Item -LiteralPath 'terminal-buddy\dist-web\index.html').LastWriteTime; if ($newest -gt $exe -or $newest -gt $web) { 'stale' }"`) do set "STALE=%%s"
    if defined STALE (
        set "NEED_REBUILD=1"
        set "REBUILD_REASON=检测到源码比编译产物新。"
    )
)

if not defined NEED_REBUILD goto :local_tools_ok
set "TOOL_MISSING="
where cargo >nul 2>&1
if errorlevel 1 set "TOOL_MISSING=cargo"
where npm.cmd >nul 2>&1
if errorlevel 1 set "TOOL_MISSING=npm.cmd"
if defined TOOL_MISSING (
    echo [错误] 未检测到 %TOOL_MISSING%，无法自动编译服务端程序。
    echo        请先安装 Rust 与 Node.js，或改用 Docker 模式：startDockerServer.bat docker
    goto :fail
)
echo.
echo [提示] %REBUILD_REASON%将先自动编译，首次编译需要数分钟时间，请耐心等待。
set "FORWARD_ARGS=%FORWARD_ARGS% -Rebuild"
:local_tools_ok

set "LOCAL_PORT=9610"
call :parse_port %*
set "POLL_SECONDS=900"

echo.
echo [提示] 正在以本机模式启动独立服务端（与 Docker 镜像运行同一个服务端程序，无需 Docker）。
echo        服务就绪后会自动打开浏览器；未自动打开时请手动访问 http://127.0.0.1:%LOCAL_PORT%/
echo        首次启动请在打开的网页中创建管理员密码（至少 8 个字符）。
echo        关闭本窗口或按 Ctrl+C 可停止服务。
echo.

start "" /min powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "for ($i = 0; $i -lt %POLL_SECONDS%; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%LOCAL_PORT%/api/health' -TimeoutSec 3; if ($r.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:%LOCAL_PORT%/'; break } } catch { } Start-Sleep -Seconds 2 }"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0terminal-buddy\start-web-server.ps1" %FORWARD_ARGS%
set "SERVER_CODE=%ERRORLEVEL%"
if "%SERVER_CODE%"=="0" goto :done
echo.
echo [错误] 服务端已退出，退出码：%SERVER_CODE%
echo        如果刚才是按 Ctrl+C 主动停止，可忽略这条提示。
goto :fail

rem ============ Docker 模式 ============
:docker_mode
if not exist "%~dp0compose.yaml" (
    echo [错误] 未找到 compose.yaml，请确认本脚本位于 TerminalBuddy 仓库根目录。
    goto :fail
)
call :require_docker
if errorlevel 1 goto :fail
call :ensure_env
if errorlevel 1 goto :fail

echo.
echo [提示] 正在构建并启动终端伙伴容器（首次构建需要数分钟，之后会复用缓存）。
docker compose up -d --build
if errorlevel 1 (
    echo.
    echo [错误] Docker 容器启动失败。
    echo        如果提示端口被占用，请修改 .env 中的 TERMINAL_BUDDY_PORT。
    echo        查看详细日志：startDockerServer.bat docker-logs
    goto :fail
)

call :wait_docker_health
if errorlevel 1 goto :fail
call :docker_ready
goto :done

:docker_stop
call :require_docker
if errorlevel 1 goto :fail
docker compose down
if errorlevel 1 (
    echo [错误] 停止 Docker 服务失败。
    goto :fail
)
echo [提示] Docker 服务已停止，数据卷保留，管理员密码与历史数据仍然有效。
goto :done

:docker_logs
call :require_docker
if errorlevel 1 goto :fail
echo [提示] 正在显示容器日志，按 Ctrl+C 退出。
docker compose logs -f --tail 200 terminal-buddy
goto :done

rem ============ 帮助 ============
:show_help
echo.
echo 用法：startDockerServer.bat [命令或参数]
echo.
echo 不传参数（推荐）：
echo   startDockerServer.bat                     Docker 可用时启动容器；否则用本机模式启动
echo.
echo Docker 模式（需要 Docker Desktop 已安装并启动）：
echo   startDockerServer.bat docker              构建并启动容器，就绪后打开浏览器
echo   startDockerServer.bat docker-stop         停止容器（保留数据卷）
echo   startDockerServer.bat docker-logs         查看容器日志
echo.
echo 本机模式（在 Windows 上直接运行服务端程序，不需要 Docker）：
echo   startDockerServer.bat local               启动服务，缺少编译产物时自动编译
echo   startDockerServer.bat -Rebuild            强制重新编译后再启动
echo   startDockerServer.bat -Port 9620          指定端口启动（默认 9610）
echo   startDockerServer.bat -Workspace D:\code  指定工作区目录
echo.
echo 首次启动：在自动打开的网页中创建管理员密码（至少 8 个字符），创建后即可进入完整界面。
goto :done

rem ============ 子过程 ============
:parse_port
if "%~1"=="" exit /b 0
if /i "%~1"=="-Port" (
    if not "%~2"=="" set "LOCAL_PORT=%~2"
    exit /b 0
)
shift
goto :parse_port

:require_docker
where docker >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 docker 命令，请先安装并启动 Docker Desktop。
    echo        只想在本机运行服务时，可执行：startDockerServer.bat local
    exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
    echo [错误] 无法连接 Docker 服务，请确认 Docker Desktop 已启动后重试。
    echo        只想在本机运行服务时，可执行：startDockerServer.bat local
    exit /b 1
)
docker compose version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 docker compose 插件，请升级 Docker Desktop 后重试。
    exit /b 1
)
exit /b 0

:ensure_env
if not exist ".env" (
    echo [提示] 未找到 .env，正在按默认值生成（可在其中修改端口与工作区）。
    (
        echo # TerminalBuddy Docker 本地配置（由 startDockerServer.bat 生成）
        echo TERMINAL_BUDDY_USERNAME=admin
        echo TERMINAL_BUDDY_PORT=9600
        echo TERMINAL_BUDDY_BIND_ADDRESS=127.0.0.1
        echo # 工作区目录：请填写宿主机上已存在的绝对路径，例如 D:/projects
        echo TERMINAL_BUDDY_WORKSPACE=./workspace
    )>".env"
)
set "WS="
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="TERMINAL_BUDDY_WORKSPACE" set "WS=%%b"
if not defined WS set "WS=./workspace"
set "WS=%WS:"=%"
set "WS_COMPOSE=%WS:\=/%"
set "WS_PATH=%WS:/=\%"
if "%WS_PATH:~0,2%"==".\" set "WS_PATH=%WS_PATH:~2%"
if exist "%WS_PATH%" goto :workspace_ready
if /i "%WS_PATH%"=="workspace" (
    mkdir "workspace" >nul 2>&1
    goto :workspace_ready
)
echo [错误] .env 中的工作区目录不存在：%WS%
echo        请把 TERMINAL_BUDDY_WORKSPACE 改为宿主机上已存在的目录，例如 D:/projects。
exit /b 1

:workspace_ready
rem 统一用正斜杠传给 Docker，避免 .env 中反斜杠路径在 compose 里的转义问题
set "TERMINAL_BUDDY_WORKSPACE=%WS_COMPOSE%"
exit /b 0

:wait_docker_health
set "CID="
for /f "usebackq delims=" %%i in (`docker compose ps -q terminal-buddy 2^>nul`) do set "CID=%%i"
if not defined CID (
    echo [错误] 未找到运行中的容器，请执行 startDockerServer.bat docker-logs 查看日志。
    exit /b 1
)
echo [提示] 等待容器健康检查通过...
set /a TRY=0
:docker_wait_loop
set /a TRY+=1
set "HEALTH="
for /f "usebackq delims=" %%s in (`docker inspect --format "{{.State.Health.Status}}" %CID% 2^>nul`) do set "HEALTH=%%s"
if /i "%HEALTH%"=="healthy" exit /b 0
if /i "%HEALTH%"=="unhealthy" (
    echo [错误] 容器健康检查未通过，请执行 startDockerServer.bat docker-logs 查看日志。
    exit /b 1
)
if %TRY% GEQ 45 (
    echo [错误] 等待健康检查超时（约 90 秒），请执行 startDockerServer.bat docker-logs 查看日志。
    exit /b 1
)
timeout /t 2 /nobreak >nul 2>&1
goto :docker_wait_loop

:docker_ready
set "URL="
for /f "usebackq delims=" %%u in (`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { $m = @(docker compose port terminal-buddy 9600)[0] } catch { $m = $null }; if (-not $m) { $m = '127.0.0.1:9600' }; $i = $m.LastIndexOf(':'); $h = $m.Substring(0, $i).Trim('[', ']'); $p = $m.Substring($i + 1); if ($h -eq '0.0.0.0' -or $h -eq '::' -or $h -eq '') { $h = '127.0.0.1' }; 'http://' + $h + ':' + $p + '/'"`) do set "URL=%%u"
if not defined URL set "URL=http://127.0.0.1:9600/"
echo.
echo 服务地址：%URL%
set "SETUP="
for /f "usebackq delims=" %%r in (`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-RestMethod -Uri '%URL%api/auth/status' -TimeoutSec 5).setupRequired } catch { 'unknown' }"`) do set "SETUP=%%r"
if /i "%SETUP%"=="True" echo [提示] 首次启动：请在浏览器中创建管理员密码（至少 8 个字符），创建后即完成初始化。
if /i "%SETUP%"=="False" echo [提示] 服务已初始化，请在浏览器中使用管理员账号登录。
if /i not "%SETUP%"=="True" if /i not "%SETUP%"=="False" echo [提示] 请在浏览器中打开服务地址，按页面提示完成初始化或登录。
start "" "%URL%"
exit /b 0

rem ============ 退出 ============
:fail
echo.
echo 操作未完成，请按上面的提示处理后重试。
pause
exit /b 1

:done
endlocal
exit /b 0