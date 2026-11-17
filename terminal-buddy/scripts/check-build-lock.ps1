<#
.SYNOPSIS
  构建前的 exe 占用检查。

.DESCRIPTION
  只有「目标产物 exe 本身被占用」才会让构建失败。
  因此这里不再无条件关闭所有 terminal-buddy.exe：
    1. 目标产物没被占用 → 直接放行（从桌面/安装目录跑着的实例不受影响，也不会被杀）。
    2. 占用者不是当前脚本的祖先进程 → 关闭占用者后重试。
    3. 占用者就是当前脚本的祖先（脚本跑在这个实例内部）→ 退出码 2，
       让调用方提示用户换一个控制台执行，避免把宿主连同脚本一起杀掉。

  退出码：0 = 可以构建；2 = 运行中的实例就是构建产物，无法自行关闭；
          1 = 其他失败（无法枚举 / 关闭后仍被占用）。
#>
param(
    [Parameter(Mandatory = $true)][string]$TargetExe
)

$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($TargetExe)
$exeName = [System.IO.Path]::GetFileName($target)

function Get-AncestorIds {
    $ids = @()
    $id = $PID
    while ($id -gt 0) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if (-not $p) { break }
        $ids += [int]$p.ProcessId
        $parent = [int]$p.ParentProcessId
        if ($parent -eq [int]$p.ProcessId) { break }
        $id = $parent
    }
    return $ids
}

function Test-TargetLocked {
    if (-not (Test-Path -LiteralPath $target)) { return $false }
    try {
        $fs = [System.IO.File]::Open($target, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $fs.Close()
        return $false
    } catch [System.IO.IOException] {
        return $true
    } catch [System.UnauthorizedAccessException] {
        # 权限不足时视为「可能被占用」，交给下面的进程枚举判断
        return $true
    }
}

if (-not (Test-TargetLocked)) {
    Write-Host 'Build output is not locked.'
    exit 0
}

$ancestors = Get-AncestorIds
try {
    $procs = @(Get-CimInstance Win32_Process -Filter ("Name='" + $exeName.Replace("'", "''") + "'"))
} catch {
    Write-Host "Could not enumerate $exeName processes: $($_.Exception.Message)"
    exit 1
}

$holders = @()
$unknown = @()
foreach ($p in $procs) {
    $path = $p.ExecutablePath
    if (-not $path) { $unknown += $p; continue }
    try {
        if ([System.IO.Path]::GetFullPath($path) -ieq $target) { $holders += $p }
    } catch {
        $unknown += $p
    }
}

foreach ($p in $procs) {
    if (-not $p.ExecutablePath) { continue }
    if ($holders -contains $p) { continue }
    Write-Host ("Leaving other TerminalBuddy instance running: PID=" + $p.ProcessId + " " + $p.ExecutablePath)
}

$selfHolders = @($holders | Where-Object { $ancestors -contains [int]$_.ProcessId })
if ($selfHolders.Count -gt 0) {
    Write-Host ("The running instance IS the build output: PID=" +
        (($selfHolders | ForEach-Object { $_.ProcessId }) -join ',') + " " + $target)
    exit 2
}

if ($holders.Count -eq 0) {
    $hint = ''
    if ($unknown.Count -gt 0) {
        $hint = ' Possibly held by an elevated/unknown process: PID=' +
            (($unknown | ForEach-Object { $_.ProcessId }) -join ',') + ' - close it manually.'
    }
    Write-Host ('Build output is locked, but no matching process was found.' + $hint)
    exit 1
}

foreach ($p in $holders) {
    Write-Host ("Closing PID=" + $p.ProcessId + " " + $p.ExecutablePath)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 100
    if (-not (Test-TargetLocked)) {
        Write-Host 'Build output released.'
        exit 0
    }
}

Write-Host 'Build output is still locked after closing the holder.'
exit 1
