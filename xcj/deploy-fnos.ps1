#requires -version 5.1
<#
.SYNOPSIS
    TerminalBuddy 一键部署到飞牛 fnOS（Windows 本机版）。

.DESCRIPTION
    与 xcj/deploy-fnos.sh 对应，流程保持一致：
      git pull → 本机 docker build（BuildKit 层缓存）→ 与远端镜像 ID 比对，
      一致则跳过传输 → docker save 压缩为本机回滚 tar → scp 推送飞牛 →
      远端 docker load → docker compose up -d → 远端健康检查 → 两端清理。

    飞牛侧的 docker-compose.yml 是权威（挂载 / 网络 / 端口 / 资源限制都在那边维护），
    本脚本不生成、不修改它；镜像 tag 固定 terminal-buddy:server，load 覆盖后
    compose 检测到镜像 ID 变化自动重建容器。

    SSH 走 ~/.ssh/config 别名（默认 fnos），BatchMode 非交互；未配置免密会在
    预检阶段失败并给出指引。Windows 优先使用系统自带 OpenSSH。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File xcj\deploy-fnos.ps1
    powershell -ExecutionPolicy Bypass -File xcj\deploy-fnos.ps1 --no-build
    powershell -ExecutionPolicy Bypass -File xcj\deploy-fnos.ps1 --load .runtime-data\fnos-tars\terminal-buddy_20261121-0930.tar.gz
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# ==================== 可覆盖配置 ====================
$SshTarget = if ($env:TB_FNOS_SSH) { $env:TB_FNOS_SSH } else { 'fnos' }
$Image = if ($env:TB_FNOS_IMAGE) { $env:TB_FNOS_IMAGE } else { 'terminal-buddy:server' }
$Container = if ($env:TB_FNOS_CONTAINER) { $env:TB_FNOS_CONTAINER } else { 'terminal-buddy' }
$AppDir = if ($env:TB_FNOS_APP_DIR) { $env:TB_FNOS_APP_DIR } else { '/vol2/1000/docker/terminal-buddy' }
$RemoteComposeFile = if ($env:TB_FNOS_COMPOSE_FILE) { $env:TB_FNOS_COMPOSE_FILE } else { "$AppDir/docker-compose.yml" }
$HostPort = if ($env:TB_FNOS_PORT) { $env:TB_FNOS_PORT } else { '9600' }
$PullLatest = !($env:TB_FNOS_PULL -eq '0')
$KeepTar = 3
$RemoteTarball = '/tmp/terminal-buddy-image.tar.gz'
# =====================================================

$RepoDir = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
$Tardir = if ($env:TB_FNOS_TARDIR) {
    [IO.Path]::GetFullPath($env:TB_FNOS_TARDIR)
}
else {
    Join-Path $RepoDir '.runtime-data\fnos-tars'
}

function Write-Log {
    param([string]$Message)
    Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) -ForegroundColor Cyan
}

function Write-WarnNote {
    param([string]$Message)
    Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

function Show-Usage {
    Write-Host @'
用法：xcj\deploy-fnos.ps1 [选项]（可在任意目录执行）

  --no-pull           跳过开头的 git pull --ff-only，直接使用当前工作区
  --no-build          跳过本机构建，用飞牛上的现有镜像重建容器
  --load <tar包>      从既有 tar 包部署（回滚 / 免构建），不构建、不清理 tar
  -h, --help          显示帮助

环境变量：TB_FNOS_SSH（SSH 别名，默认 fnos）/ TB_FNOS_APP_DIR / TB_FNOS_COMPOSE_FILE /
TB_FNOS_PORT（健康检查端口）/ TB_FNOS_IMAGE / TB_FNOS_CONTAINER / TB_FNOS_TARDIR /
TB_FNOS_PULL。

SSH 免密：本脚本走 ~/.ssh/config 别名 fnos（BatchMode 非交互）。首次配置：
  ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
  ssh-copy-id <user>@<host>
（或直接编辑 %USERPROFILE%\.ssh\config 添加 Host fnos 条目）
'@
}

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------

$Mode = 'build'
$DoBuild = $true
$LoadTarInput = $null
$index = 0
while ($index -lt $args.Count) {
    $arg = [string]$args[$index]
    switch ($arg) {
        '--no-pull' { $PullLatest = $false }
        '--no-build' { $DoBuild = $false }
        '--load' {
            if ($index + 1 -ge $args.Count) {
                Write-Fail '--load 需要一个 tar 包路径'
            }
            $Mode = 'load'
            $LoadTarInput = [string]$args[$index + 1]
            $index++
        }
        '-h' { Show-Usage; exit 0 }
        '--help' { Show-Usage; exit 0 }
        default {
            Write-Host "错误：未知参数：$arg（可用：--no-build / --no-pull / --load <tar包> / --help）" -ForegroundColor Red
            exit 1
        }
    }
    $index++
}

$LoadTar = $null
if ($Mode -eq 'load') {
    $LoadTar = if ([IO.Path]::IsPathRooted($LoadTarInput)) {
        $LoadTarInput
    }
    else {
        [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LoadTarInput))
    }
    if (!(Test-Path -LiteralPath $LoadTar -PathType Leaf)) {
        Write-Fail "tar 包不存在或不可读：$LoadTar"
    }
}

# ---------------------------------------------------------------------------
# 工具定位
# ---------------------------------------------------------------------------

function Resolve-Tool {
    param(
        [string]$Name,
        [string[]]$Preferred = @()
    )
    foreach ($candidate in $Preferred) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

$openSshDir = Join-Path $env:SystemRoot 'System32\OpenSSH'
$Ssh = Resolve-Tool 'ssh.exe' @((Join-Path $openSshDir 'ssh.exe'))
$Scp = Resolve-Tool 'scp.exe' @((Join-Path $openSshDir 'scp.exe'))
$Docker = Resolve-Tool 'docker.exe' @()
if (!$Ssh) { Write-Fail '未找到 ssh.exe，请启用「Windows 可选功能 → OpenSSH 客户端」。' }
if (!$Scp) { Write-Fail '未找到 scp.exe，请启用「Windows 可选功能 → OpenSSH 客户端」。' }
if (!$Docker) { Write-Fail '未找到 docker CLI，请安装并启动 Docker Desktop。' }

# gzip 只用于 docker save 的压缩；优先 Git for Windows 自带的 gzip
$gzipCandidates = New-Object System.Collections.Generic.List[string]
$gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($gitCommand) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
    $gzipCandidates.Add((Join-Path $gitRoot 'usr\bin\gzip.exe'))
}
if ($env:ProgramFiles) {
    $gzipCandidates.Add((Join-Path $env:ProgramFiles 'Git\usr\bin\gzip.exe'))
}
$programFilesX86 = ${env:ProgramFiles(x86)}
if ($programFilesX86) {
    $gzipCandidates.Add((Join-Path $programFilesX86 'Git\usr\bin\gzip.exe'))
}
$Gzip = Resolve-Tool 'gzip.exe' $gzipCandidates.ToArray()

$SshOptions = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10')
$FnosIp = ''

# ---------------------------------------------------------------------------
# SSH / 远端脚本
# ---------------------------------------------------------------------------

function Format-RemoteArgument {
    param([string]$Value)
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function Quote-ProcessArgument {
    param([string]$Value)
    if (!$Value) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') {
            $backslashes++
            continue
        }
        if ($ch -eq '"') {
            [void]$builder.Append('\' * (($backslashes * 2) + 1))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append('\' * $backslashes)
            $backslashes = 0
        }
        [void]$builder.Append($ch)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append('\' * ($backslashes * 2))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

# PowerShell 5.1 的「字符串 | 原生程序」和 .NET Process 的 StandardInput StreamWriter
# 都会在开头写入 UTF-8 BOM，远端 bash 会把它当成命令的一部分而报
# “﻿printf: command not found”。这里把脚本先写成无 BOM 的临时文件，再交给 cmd
# 的文件重定向（< file）送入 stdin，字节原样送达。
function Invoke-SshScript {
    param(
        [string]$ScriptText,
        [string[]]$RemoteArguments = @(),
        [switch]$Capture
    )
    $argumentText = ''
    if ($RemoteArguments.Count -gt 0) {
        $argumentText = ' ' + (($RemoteArguments | ForEach-Object { Format-RemoteArgument $_ }) -join ' ')
    }
    $remoteCommand = 'bash -s --' + $argumentText
    $payload = ($ScriptText -replace "`r`n", "`n").TrimEnd() + "`n"

    $allArguments = @($SshOptions) + @($SshTarget, $remoteCommand)
    $arguments = (($allArguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('tb-ssh-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $scriptFile = Join-Path $tempRoot 'remote.sh'
    $runnerFile = Join-Path $tempRoot 'run.cmd'
    [IO.File]::WriteAllText($scriptFile, $payload, (New-Object System.Text.UTF8Encoding($false)))
    # 批处理文件按控制台 OEM 代码页写入，避免非 ASCII 临时路径在 cmd 中乱码
    try {
        $batchEncoding = [System.Text.Encoding]::GetEncoding(
            [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
        )
    }
    catch {
        $batchEncoding = [System.Text.Encoding]::Default
    }

    try {
        # 不用 Start-Process：Windows PowerShell 5.1 在进程环境同时存在
        # Path / PATH 大小写变体时会抛“字典中的关键字 Path 所添加的关键字 PATH”。
        # 临时 .cmd + 文件重定向由 cmd 直接完成，不经过 Start-Process 的环境字典。
        if ($Capture) {
            $outFile = Join-Path $tempRoot 'stdout.txt'
            $errFile = Join-Path $tempRoot 'stderr.txt'
            $commandLine = '"{0}" {1} < "{2}" > "{3}" 2> "{4}"' -f $Ssh, $arguments, $scriptFile, $outFile, $errFile
            $batch = "@echo off`r`n$commandLine`r`nexit /b %ERRORLEVEL%`r`n"
            [IO.File]::WriteAllText($runnerFile, $batch, $batchEncoding)
            & $runnerFile | Out-Null
            $exitCode = $LASTEXITCODE
            $stdout = if (Test-Path -LiteralPath $outFile) { [IO.File]::ReadAllText($outFile) } else { '' }
            $stderr = if (Test-Path -LiteralPath $errFile) { [IO.File]::ReadAllText($errFile) } else { '' }
            $combined = (@($stdout, $stderr) -join "`n").Trim()
            return [pscustomobject]@{ Output = $combined; ExitCode = $exitCode }
        }

        $commandLine = '"{0}" {1} < "{2}"' -f $Ssh, $arguments, $scriptFile
        $batch = "@echo off`r`n$commandLine`r`nexit /b %ERRORLEVEL%`r`n"
        [IO.File]::WriteAllText($runnerFile, $batch, $batchEncoding)
        & $runnerFile | Out-Host
        return $LASTEXITCODE
    }
    finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Remote {
    param(
        [string]$ScriptText,
        [string[]]$RemoteArguments = @()
    )
    return Invoke-SshScript -ScriptText $ScriptText -RemoteArguments $RemoteArguments
}

function Invoke-RemoteCapture {
    param(
        [string]$ScriptText,
        [string[]]$RemoteArguments = @()
    )
    return Invoke-SshScript -ScriptText $ScriptText -RemoteArguments $RemoteArguments -Capture
}

function ConvertTo-Text {
    param($Items)
    if ($null -eq $Items) { return '' }
    return (($Items | ForEach-Object { "$_" }) -join "`n").Trim()
}

$composeUpScript = @'
set -eu
cd "$1"
docker compose -f "$2" up -d --remove-orphans 2>&1 | tail -n 5
running="$(docker inspect "$3" --format '{{.State.Running}}' 2>/dev/null || true)"
[ "${running}" = "true" ] || { echo "!! 容器 $3 未在运行" >&2; exit 1; }
img="$(docker inspect "$3" --format '{{.Image}}')"
want="$(docker image inspect "$4" --format '{{.Id}}')"
[ "${img}" = "${want}" ] || { echo "!! 容器实际镜像与 $4 不一致" >&2; exit 1; }
'@

$healthCheckScript = @'
set -u
code=""
for _ in $(seq 1 30); do
  sleep 3
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$1/api/health" 2>/dev/null || true)
  [ "$code" = "200" ] && break
done
if [ "$code" != "200" ]; then
  echo "!! 健康检查失败（HTTP ${code:-无响应}），最近日志：" >&2
  docker logs "$2" --tail 20 >&2 || true
  exit 1
fi
echo "    ✓ /api/health -> 200"
'@

$loadScript = @'
set -e
gzip -t "$1"
out=$(docker load -i "$1"); echo "$out" >&2
img=$(echo "$out" | tr -d '\r' | sed -n 's/^Loaded image: //p' | tail -n1)
[ -n "$img" ] || { echo "!! tar 包内未解析出镜像名（是否为本脚本导出的包？）" >&2; exit 1; }
if [ "$img" != "$2" ]; then
  echo "!! tar 包里是 $img，不是 $2，拒绝部署" >&2; exit 1
fi
rm -f "$1"
'@

$precheckScript = @'
set -e
[ -f "$1" ] || { echo "!! 远端缺 compose 文件: $1（首次部署见 DEPLOY_README.md）" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "!! 远端 docker compose 子命令不可用" >&2; exit 1; }
echo "    飞牛侧当前容器状态："
docker ps -a --filter "name=^/$2\$" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
'@

$prevIdScript = @'
docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || true
'@

# ---------------------------------------------------------------------------
# 本机 docker 辅助
# ---------------------------------------------------------------------------

function Test-LocalDocker {
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & $Docker info *> $null
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $oldErrorAction
    }
    return ($code -eq 0)
}

function Get-LocalImageId {
    param([string]$Name)
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $output = @(& $Docker image inspect $Name --format '{{.Id}}' 2>$null)
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $oldErrorAction
    }
    if ($code -ne 0 -or $output.Count -eq 0) { return $null }
    return ([string]$output[0]).Trim()
}

function Get-ShortImageId {
    param([string]$ImageId)
    if (!$ImageId) { return '' }
    $start = if ($ImageId.StartsWith('sha256:')) { 7 } else { 0 }
    $length = [Math]::Min(12, $ImageId.Length - $start)
    if ($length -le 0) { return '' }
    return $ImageId.Substring($start, $length)
}

function Invoke-ComposeUp {
    $code = Invoke-Remote -ScriptText $composeUpScript -RemoteArguments @($AppDir, $RemoteComposeFile, $Container, $Image)
    if ($code -ne 0) {
        Write-Fail "远端 compose up 失败（退出码 $code）"
    }
}

function Invoke-HealthCheck {
    param([int]$Step, [int]$Steps)
    Write-Host "==> [$Step/$Steps] 健康检查（远端 127.0.0.1:$HostPort）"
    $code = Invoke-Remote -ScriptText $healthCheckScript -RemoteArguments @($HostPort, $Container)
    if ($code -ne 0) {
        Write-Fail '健康检查失败，请查看上方远端日志。'
    }
}

function Show-Finish {
    param(
        [string]$Text,
        [string]$TarPath
    )
    Write-Host ''
    Write-Log "部署完成：$Text"
    if ($FnosIp) {
        Write-Host "  访问地址 : http://${FnosIp}:${HostPort}/"
    }
    Write-Host "  应用目录 : $AppDir（compose 为权威：$RemoteComposeFile）"
    if ($TarPath) {
        Write-Host "  本机 tar : $TarPath"
    }
    Write-Host "  回到旧版 : powershell -ExecutionPolicy Bypass -File xcj\deploy-fnos.ps1 --load $Tardir\terminal-buddy_<旧时间戳>.tar.gz"
    Write-Host "  查看日志 : ssh $SshTarget 'docker logs -f --tail 100 $Container'"
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

function Invoke-Main {
    $steps = if ($Mode -eq 'load') { 4 } else { 6 }
    $pushStep = if ($Mode -eq 'load') { 2 } else { 4 }
    $composeStep = if ($Mode -eq 'load') { 3 } else { 5 }
    $healthStep = if ($Mode -eq 'load') { 4 } else { 6 }

    # ---------- 0. 预检 ----------
    Write-Host "==> [0/$steps] 预检：本机 docker / SSH 免密 / 远端 compose 与容器状态"

    if ($DoBuild -and $Mode -eq 'build') {
        if (!(Test-LocalDocker)) {
            Write-Fail @"
本机 docker 不可用。请确认 Docker Desktop 已启动，并检查：
  docker info
"@
        }
    }

    $sshCheck = Invoke-RemoteCapture -ScriptText 'docker info >/dev/null 2>&1'
    if ($sshCheck.ExitCode -ne 0) {
        $detail = ConvertTo-Text $sshCheck.Output
        Write-Fail @"
SSH 免密登录 $SshTarget 失败或远端 docker 不可用：$detail
   首次配置：ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 && ssh-copy-id <user>@<host>
   （或编辑 %USERPROFILE%\.ssh\config 添加 Host $SshTarget 条目）
"@
    }

    $precheck = Invoke-RemoteCapture -ScriptText $precheckScript -RemoteArguments @($RemoteComposeFile, $Container)
    if ($precheck.ExitCode -ne 0) {
        Write-Fail (ConvertTo-Text $precheck.Output)
    }
    Write-Host (ConvertTo-Text $precheck.Output)

    $prevIdResult = Invoke-RemoteCapture -ScriptText $prevIdScript -RemoteArguments @($Image)
    $prevId = ConvertTo-Text $prevIdResult.Output
    if ($prevId) {
        Write-Log ("当前远端镜像：{0} {1}" -f $Image, (Get-ShortImageId $prevId))
    }
    else {
        Write-Log "远端还没有镜像 $Image（首次部署或镜像被清理）"
    }

    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $sshGraph = @(& $Ssh -G $SshTarget 2>$null)
    }
    finally {
        $ErrorActionPreference = $oldErrorAction
    }
    foreach ($line in $sshGraph) {
        if ($line -match '^hostname\s+(\S+)') {
            $script:FnosIp = $Matches[1]
            break
        }
    }

    # ---------- 1. 拉取本机最新代码 ----------
    if ($Mode -eq 'build') {
        if ($PullLatest) {
            if (Test-Path -LiteralPath (Join-Path $RepoDir '.git') -PathType Container) {
                $git = Resolve-Tool 'git.exe' @()
                if (!$git) {
                    Write-Fail '未检测到 git，无法拉取代码；或用 --no-pull 跳过'
                }
                Write-Log '拉取本机最新代码：git pull --ff-only'
                & $git -C $RepoDir pull --ff-only
                if ($LASTEXITCODE -ne 0) {
                    Write-Fail '拉取失败（本机可能有未提交改动与远端冲突）。处理后再试，或用 --no-pull 直接用当前工作区。'
                }
            }
            else {
                Write-WarnNote "$RepoDir 不是 git 仓库，跳过拉取"
            }
        }
        else {
            Write-Log '已跳过代码拉取（--no-pull）'
        }

        $gitForDiff = Resolve-Tool 'git.exe' @()
        if ($gitForDiff) {
            $oldErrorAction = $ErrorActionPreference
            $ErrorActionPreference = 'SilentlyContinue'
            try {
                & $gitForDiff -C $RepoDir diff --quiet 2>$null
                $diffCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $oldErrorAction
            }
            if ($diffCode -ne 0) {
                Write-Host '    注意：工作区有未提交改动，将一并构建进本次镜像（工作区全量构建）'
            }
        }
    }

    $tag = Get-Date -Format 'yyyyMMdd-HHmm'
    $tar = $null

    # ---------- 2. 本机构建镜像 ----------
    if ($Mode -eq 'build' -and $DoBuild) {
        Write-Host "==> [2/$steps] 本机构建镜像 $Image（工作区全量构建，复用层缓存）"
        New-Item -ItemType Directory -Path $Tardir -Force | Out-Null
        $buildLog = Join-Path $Tardir "build-$tag.log"
        Write-Host '    构建中：缓存全命中约 1 分钟，Rust 层失效则需 10-20 分钟，请勿关闭终端'
        Write-Host "    完整构建日志：$buildLog"

        $beforeId = Get-LocalImageId -Name $Image
        $dockerfile = Join-Path $RepoDir 'Dockerfile'

        # 实时显示并留档：docker build 的进度主要走 stderr。PowerShell 5.1 的
        # `2>&1` 会把每行 stderr 包成 ErrorRecord（直接 Tee 进日志会带一大段
        # PowerShell 错误头），这里取出原始文本再输出到控制台与日志。
        $logWriter = New-Object System.IO.StreamWriter($buildLog, $false, (New-Object System.Text.UTF8Encoding($false)))
        $logWriter.AutoFlush = $true
        $oldErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $Docker build --progress=plain -f $dockerfile -t $Image $RepoDir 2>&1 | ForEach-Object {
                $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                    $_.Exception.Message.TrimEnd()
                }
                else {
                    "$_".TrimEnd()
                }
                Write-Host $line
                $logWriter.WriteLine($line)
            }
            $buildCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $oldErrorAction
            $logWriter.Dispose()
        }
        if ($buildCode -ne 0) {
            Write-Fail "本机构建失败（完整日志 $buildLog）。可用 --no-build 复用现有镜像，或排查 Dockerfile / 源码错误。"
        }

        $localId = Get-LocalImageId -Name $Image
        if (!$localId) {
            Write-Fail '构建结束但无法读取本机镜像 ID，请检查 docker build 输出。'
        }
        if ($beforeId -and $beforeId -eq $localId) {
            Write-Log ("  本机镜像未变化（全部命中缓存）：{0}" -f (Get-ShortImageId $localId))
        }
        else {
            Write-Log ("  本机镜像已更新：{0}" -f (Get-ShortImageId $localId))
        }

        if ($prevId -and $prevId -eq $localId) {
            Write-Host "==> [3/$steps] 飞牛上已是相同镜像，跳过导出与上传"
            Invoke-ComposeUp
            Invoke-HealthCheck -Step 6 -Steps $steps
            Show-Finish -Text ("镜像未变化（$Image {0}），容器已按 compose 对齐" -f (Get-ShortImageId $localId)) -TarPath ''
            return
        }
    }
    elseif ($Mode -eq 'build') {
        Write-Log "跳过本机构建（--no-build），使用本机现有镜像 $Image"
        $localId = Get-LocalImageId -Name $Image
        if (!$localId) {
            Write-Fail "本机也没有镜像 $Image：先去掉 --no-build 构建一次。"
        }
    }

    # ---------- 3. 导出回滚 tar ----------
    if ($Mode -eq 'build') {
        Write-Host "==> [3/$steps] 导出镜像 tar 到本机 $Tardir（回滚留档）"
        New-Item -ItemType Directory -Path $Tardir -Force | Out-Null
        $tar = Join-Path $Tardir "terminal-buddy_$tag.tar.gz"
        $tempTar = Join-Path $Tardir "terminal-buddy_$tag.tar"

        & $Docker save -o $tempTar $Image
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $tempTar -Force -ErrorAction SilentlyContinue
            Write-Fail 'docker save 失败，未能生成本机回滚包。'
        }

        try {
            if (!$Gzip) {
                Write-Fail '未找到 gzip.exe（通常随 Git for Windows 安装），无法压缩镜像包。'
            }
            # 就地压缩：gzip -1 -f 会把 terminal-buddy_<tag>.tar 变成同名 .tar.gz，
            # 避免 PowerShell 管道 / 重定向把二进制镜像数据当文本处理。
            & $Gzip -1 -f $tempTar
            if ($LASTEXITCODE -ne 0) {
                Write-Fail "镜像包压缩失败（gzip 退出码 $LASTEXITCODE）：$tar"
            }
            if (!(Test-Path -LiteralPath $tar -PathType Leaf)) {
                Write-Fail "压缩结束但未找到镜像包：$tar"
            }
            & $Gzip -t $tar
            if ($LASTEXITCODE -ne 0) {
                Write-Fail "镜像包校验失败（磁盘写满或压缩中断）：$tar"
            }
        }
        finally {
            Remove-Item -LiteralPath $tempTar -Force -ErrorAction SilentlyContinue
        }

        $sizeMb = [Math]::Round((Get-Item -LiteralPath $tar).Length / 1MB, 1)
        Write-Host ("    镜像包：{0} MB  ->  {1}" -f $sizeMb, $tar)
    }
    else {
        $tar = $LoadTar
        Write-Host "==> [1/$steps] 使用既有 tar 包：$tar"
    }

    # ---------- 4. 推送飞牛并 docker load ----------
    Write-Host "==> [$pushStep/$steps] 推送飞牛并 docker load"
    $tarDirectory = Split-Path -Parent $tar
    $tarName = Split-Path -Leaf $tar
    Push-Location -LiteralPath $tarDirectory
    try {
        & $Scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 $tarName "${SshTarget}:${RemoteTarball}"
        $scpCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($scpCode -ne 0) {
        Write-Fail '镜像上传失败，请检查网络与飞牛磁盘空间。'
    }

    $loadResult = Invoke-Remote -ScriptText $loadScript -RemoteArguments @($RemoteTarball, $Image)
    if ($loadResult -ne 0) {
        Write-Fail '远端 docker load 失败。'
    }

    # ---------- 5. 重建容器（远端 compose 为权威） ----------
    Write-Host "==> [$composeStep/$steps] 重建容器（远端 compose）"
    Invoke-ComposeUp

    # ---------- 6. 健康检查 + 清理 ----------
    Invoke-HealthCheck -Step $healthStep -Steps $steps

    if ($Mode -eq 'build') {
        Write-Host "==> [6/$steps] 清理旧 tar（本机保留最近 $KeepTar 个）"
        try {
            Get-ChildItem -LiteralPath $Tardir -Filter 'terminal-buddy_*.tar.gz' -File -ErrorAction Stop |
                Sort-Object LastWriteTime -Descending |
                Select-Object -Skip $KeepTar |
                Remove-Item -Force -ErrorAction Stop
        }
        catch {
            Write-WarnNote "本机旧 tar 包清理失败（不影响本次部署）：$($_.Exception.Message)"
        }
    }

    $previousShort = '无'
    if ($prevId) {
        $previousShort = Get-ShortImageId $prevId
    }
    Show-Finish -Text "$Image 已上线（原镜像 $previousShort）" -TarPath $tar
}

try {
    Invoke-Main
    exit 0
}
catch {
    Write-Host ''
    Write-Host ('[失败] ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
