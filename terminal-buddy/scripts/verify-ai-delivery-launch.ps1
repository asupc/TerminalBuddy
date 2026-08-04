param(
    [string]$Exe = "D:\gitee\terminal-buddy\terminal-buddy\src-tauri\target\debug\terminal-buddy.exe",
    [string]$LogDir = "D:\TerminalBuddy"
)

# 命令行验收辅助：启动 TerminalBuddy（真实 Web API 驱动，不操作 UI）。
# 说明：GUI 应用的 stdout/stderr 重定向在部分环境下会导致进程启动失败，
# 因此这里不重定向；应用自身的启动与 AI 交付日志分别写入 data 目录的
# debug.log 与 eprintln 输出（D:\TerminalBuddy 下），供验收后排查。
$process = Start-Process -FilePath $Exe -WindowStyle Hidden -PassThru
Write-Output "STARTED PID=$($process.Id)"

# 等待 Web API 就绪
$deadline = (Get-Date).AddSeconds(30)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:9600/api/auth/status" -TimeoutSec 3
        Write-Output ("WEB_API_READY " + ($status | ConvertTo-Json -Compress))
        $ready = $true
        break
    } catch {
        Start-Sleep -Milliseconds 800
    }
}
if (-not $ready) {
    Write-Output "WEB_API_NOT_READY"
    exit 1
}
