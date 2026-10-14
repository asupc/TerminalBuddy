param(
    [int]$Port = 9600,
    [string]$Username = 'admin',
    [string]$Workspace = (Get-Location).Path,
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$serverRoot = $PSScriptRoot
$executable = Join-Path $serverRoot 'src-tauri\target\debug\terminal-buddy-server.exe'
if ($Rebuild) {
    # 只有显式传入 -Rebuild 才执行编译。
    Push-Location $serverRoot
    try {
        & cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --features server --bin terminal-buddy-server
        if ($LASTEXITCODE -ne 0) { throw '独立服务端编译失败' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $executable)) {
    throw '尚未生成服务端程序。需要编译时请显式执行 .\start-web-server.ps1 -Rebuild。'
}
$env:TERMINAL_BUDDY_DATA_DIR = Join-Path $serverRoot 'server-data'
$env:TERMINAL_BUDDY_WORKSPACE_DIR = (Resolve-Path -LiteralPath $Workspace).Path
$env:TERMINAL_BUDDY_USERNAME = $Username
$env:TERMINAL_BUDDY_PORT = "$Port"
$settingsPath = Join-Path $env:TERMINAL_BUDDY_DATA_DIR 'settings.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
    $securePassword = Read-Host '首次启动，请设置网页登录密码' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $env:TERMINAL_BUDDY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
}
Write-Host "真实 Web 服务：http://127.0.0.1:$Port/"
Write-Host '完整界面开发预览请另开终端执行 npm run dev:web，再打开 http://127.0.0.1:1450/。'
try { & $executable }
finally { Remove-Item Env:TERMINAL_BUDDY_PASSWORD -ErrorAction SilentlyContinue }
