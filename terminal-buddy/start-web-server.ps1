param(
    [ValidateRange(1, 65535)]
    [int]$Port = 9610,
    [string]$Username = 'admin',
    [string]$Workspace = $PSScriptRoot,
    [string]$DataDirectory = (Join-Path $PSScriptRoot 'server-data'),
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$serverRoot = $PSScriptRoot
$cargoTargetDirectory = Join-Path $serverRoot 'src-tauri\target\server'
$executable = Join-Path $cargoTargetDirectory 'debug\terminal-buddy-server.exe'
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $portProbe.Start() }
catch { throw "端口 $Port 已被占用，请先停止该端口的服务，或通过 -Port 指定其他端口。" }
finally { $portProbe.Stop() }
if ($Rebuild) {
    # 只有显式传入 -Rebuild 才执行编译。
    Push-Location $serverRoot
    try {
        & npm.cmd ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw '网页依赖安装失败' }
        & npm.cmd run build:web:desktop
        if ($LASTEXITCODE -ne 0) { throw '完整网页资源构建失败' }
        $buildLogDirectory = Join-Path $serverRoot 'server-data\logs'
        [IO.Directory]::CreateDirectory($buildLogDirectory) | Out-Null
        $buildLogPath = Join-Path $buildLogDirectory 'server-build.log'
        $previousIncremental = $env:CARGO_INCREMENTAL
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # 独立服务端使用单独的产物目录，避开已有的增量链接产物。
            $env:CARGO_INCREMENTAL = '0'
            # Windows PowerShell 将重定向的原生 stderr 转成 ErrorRecord，先保留输出再检查退出码。
            $ErrorActionPreference = 'Continue'
            & cargo build --manifest-path src-tauri/Cargo.toml --target-dir $cargoTargetDirectory --no-default-features --features server --bin terminal-buddy-server 2>&1 |
                ForEach-Object { $_.ToString() } | Tee-Object -FilePath $buildLogPath -ErrorAction Stop
            $buildExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
            if ($null -eq $previousIncremental) {
                Remove-Item Env:CARGO_INCREMENTAL -ErrorAction SilentlyContinue
            } else {
                $env:CARGO_INCREMENTAL = $previousIncremental
            }
        }
        if ($buildExitCode -ne 0) { throw "独立服务端编译失败，完整日志：$buildLogPath" }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $executable)) {
    throw '尚未生成服务端程序。请从仓库根目录执行 startDockerServer.bat -Rebuild。'
}
if (-not (Test-Path -LiteralPath (Join-Path $serverRoot 'dist-web\index.html'))) {
    throw '尚未生成完整网页资源。请从仓库根目录执行 startDockerServer.bat -Rebuild。'
}
$env:TERMINAL_BUDDY_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory)
$env:TERMINAL_BUDDY_WORKSPACE_DIR = (Resolve-Path -LiteralPath $Workspace).Path
$env:TERMINAL_BUDDY_WEB_DIST = Join-Path $serverRoot 'dist-web'
$env:TERMINAL_BUDDY_LISTEN_ADDRESS = '127.0.0.1'
$env:TERMINAL_BUDDY_USERNAME = $Username
$env:TERMINAL_BUDDY_PORT = "$Port"
Write-Host "真实 Web 服务：http://127.0.0.1:$Port/"
Write-Host '首次启动请在网页创建管理员密码；已有数据会进入登录页面。'
Write-Host '关闭此窗口或按 Ctrl+C 会停止本地服务。'
try { & $executable }
finally { Remove-Item Env:TERMINAL_BUDDY_PASSWORD -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { throw "独立服务端退出，退出码：$LASTEXITCODE" }
