#requires -version 5.1
<#
.SYNOPSIS
    TerminalBuddy Android Release APK 一键构建（Windows 本机版）。

.DESCRIPTION
    与 xcj/build-android.sh 对应，流程保持一致：
      检测 JDK 17+ → 解析/自动补齐 Android SDK（默认 %USERPROFILE%\.android-sdk）
      → versionName 末段 +1、versionCode +1（失败自动回退）
      → gradlew :app:assembleRelease → apksigner 校验
      → dist\ 归档并生成 .sha256 → 移动到部署目录（默认 \\192.168.1.71\code）
      → 清理 Gradle / Kotlin JVM。

    与 Linux 版的差异：Windows 没有 apt，Android SDK 缺失时自动下载 cmdline-tools
    到用户目录（约 1-2 GB）。构建成功后默认把 APK 与 .sha256 移动到共享目录
    \\192.168.1.71\code（对应 Linux 版的 /mnt/fnos/code）；该目录不可达时降级为
    保留在 dist\ 并给出警告。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File xcj\build-android.ps1 --clean-cache

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File xcj\build-android.ps1 --deploy-dir D:\apk
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AndroidDir = Join-Path $RepoRoot 'android'
$OutputDir = Join-Path $RepoRoot 'dist'
$CmdlineToolsVersion = 13114758
$CompileSdk = 36
$BuildTools = '35.0.0'
$CleanCache = $false
# 构建成功后产物移动的目标目录：命令行 --deploy-dir > 环境变量 DEPLOY_DIR > 默认共享目录
$DefaultDeployDir = '\\192.168.1.71\code'
$DeployDir = if ($env:DEPLOY_DIR) { $env:DEPLOY_DIR } else { $DefaultDeployDir }
$NoDeploy = $false

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-WarnNote {
    param([string]$Message)
    Write-Host "警告：$Message" -ForegroundColor Yellow
}

function Show-Usage {
    Write-Host @'
用法：xcj\build-android.ps1 [--clean-cache] [--deploy-dir <目录>] [--no-deploy]

  --clean-cache       清空项目内 Gradle 构建缓存（android\.gradle 与 android\app\build）
  --deploy-dir <目录> 构建成功后把 APK 与 .sha256 移动到该目录（也支持 --deploy-dir=<目录>）
  --no-deploy         不移动产物，保留在 dist\
  -h, --help          显示本帮助

说明：每次构建自动 versionName 末段 +1 / versionCode +1，
      成功后写入 android\app\build.gradle.kts（构建失败自动回退）。

环境变量：
  ANDROID_HOME / ANDROID_SDK_ROOT  Android SDK 目录，默认 %USERPROFILE%\.android-sdk
  DEPLOY_DIR                       构建产物移动目标目录；默认 \\192.168.1.71\code
                                   （命令行 --deploy-dir 优先于此变量）

产物默认移动到共享目录 \\192.168.1.71\code；该目录不可达或写入失败时，
产物保留在 dist\ 并给出警告，不影响构建结果。
'@
}

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -eq '--clean-cache') { $CleanCache = $true; continue }
    if ($arg -eq '-h' -or $arg -eq '--help') { Show-Usage; exit 0 }
    if ($arg -eq '--no-deploy') { $NoDeploy = $true; continue }
    if ($arg -eq '--deploy-dir') {
        if ($i + 1 -ge $args.Count) {
            Write-Host '错误：--deploy-dir 缺少目录参数' -ForegroundColor Red
            Show-Usage
            exit 1
        }
        $i++
        $DeployDir = [string]$args[$i]
        continue
    }
    if ($arg -like '--deploy-dir=*') {
        $DeployDir = $arg.Substring('--deploy-dir='.Length)
        continue
    }
    Write-Host "错误：未知参数：$arg" -ForegroundColor Red
    Show-Usage
    exit 1
}

# ---------------------------------------------------------------------------
# JDK
# ---------------------------------------------------------------------------

# Gradle Wrapper 8.13 支持 JDK 17-23：优先 JAVA_HOME，其次 Android Studio 自带 JDK。
function Find-JavaHome {
    $candidates = @(
        $env:JAVA_HOME,
        $env:JDK_HOME,
        (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr')
    )
    $javaCommand = Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($javaCommand) {
        $candidates += Split-Path -Parent (Split-Path -Parent $javaCommand.Source)
    }
    $patterns = @(
        (Join-Path $env:ProgramFiles 'Java\jdk-*'),
        (Join-Path $env:ProgramFiles 'Eclipse Adoptium\jdk-*'),
        (Join-Path $env:USERPROFILE '.jdks\*')
    )
    foreach ($pattern in $patterns) {
        $candidates += @(Get-ChildItem -Path $pattern -Directory -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName)
    }

    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $releaseFile = Join-Path $candidate 'release'
        if (!(Test-Path -LiteralPath $releaseFile -PathType Leaf)) { continue }
        if (!(Test-Path -LiteralPath (Join-Path $candidate 'bin\java.exe') -PathType Leaf)) { continue }
        if (!(Test-Path -LiteralPath (Join-Path $candidate 'bin\javac.exe') -PathType Leaf)) { continue }
        $version = [regex]::Match([IO.File]::ReadAllText($releaseFile), '(?m)^JAVA_VERSION="(\d+)')
        if ($version.Success) {
            $major = [int]$version.Groups[1].Value
            if ($major -ge 17 -and $major -le 23) {
                return (Resolve-Path -LiteralPath $candidate).ProviderPath
            }
        }
    }
    throw '没有找到适用的 JDK。请安装 JDK 17 或 21 并设置 JAVA_HOME，也可安装 Android Studio 使用其自带 JDK。'
}

# ---------------------------------------------------------------------------
# Android SDK
# ---------------------------------------------------------------------------

function Get-LocalPropertiesSdk {
    $propFile = Join-Path $AndroidDir 'local.properties'
    if (!(Test-Path -LiteralPath $propFile -PathType Leaf)) { return $null }
    $match = [regex]::Match([IO.File]::ReadAllText($propFile), '(?m)^\s*sdk\.dir\s*=\s*(.*?)\s*$')
    if (!$match.Success) { return $null }
    $sdk = $match.Groups[1].Value.Replace('\\', '\').Replace('\:', ':').Replace('\ ', ' ')
    if ($sdk -and (Test-Path -LiteralPath $sdk -PathType Container)) {
        return (Resolve-Path -LiteralPath $sdk).ProviderPath
    }
    return $null
}

function Resolve-SdkRoot {
    $localSdk = Get-LocalPropertiesSdk
    if ($localSdk) { return $localSdk }
    foreach ($candidate in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:USERPROFILE '.android-sdk'))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Resolve-Path -LiteralPath $candidate).ProviderPath
        }
    }
    return (Join-Path $env:USERPROFILE '.android-sdk')
}

function Find-SdkManager {
    param([string]$SdkRoot)
    $latest = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
    if (Test-Path -LiteralPath $latest -PathType Leaf) { return $latest }
    $base = Join-Path $SdkRoot 'cmdline-tools'
    if (Test-Path -LiteralPath $base -PathType Container) {
        $found = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin\sdkmanager.bat' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
        if ($found.Count -gt 0) { return $found[0] }
    }
    return $null
}

function Install-CmdlineTools {
    param([string]$SdkRoot)

    $url = "https://dl.google.com/android/repository/commandlinetools-win-${CmdlineToolsVersion}_latest.zip"
    Write-Step "下载 Android cmdline-tools → $SdkRoot（约 140 MB）"
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("tb-cmdline-tools-" + [guid]::NewGuid().ToString('N'))
    $zip = Join-Path $tempRoot 'cmdline-tools.zip'
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($curl) {
            & $curl.Source -fL --retry 3 --connect-timeout 20 -o $zip $url
            if ($LASTEXITCODE -ne 0) {
                throw "下载 cmdline-tools 失败（curl 退出码 $LASTEXITCODE）：$url"
            }
        }
        else {
            $oldProgress = $ProgressPreference
            $ProgressPreference = 'SilentlyContinue'
            try {
                Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
            }
            finally {
                $ProgressPreference = $oldProgress
            }
        }

        $toolsDir = Join-Path $SdkRoot 'cmdline-tools'
        New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $toolsDir -Force

        $extracted = Join-Path $toolsDir 'cmdline-tools'
        $latest = Join-Path $toolsDir 'latest'
        if (Test-Path -LiteralPath $latest) {
            Remove-Item -LiteralPath $latest -Recurse -Force
        }
        if (Test-Path -LiteralPath $extracted -PathType Container) {
            Move-Item -LiteralPath $extracted -Destination $latest
        }
        elseif (Test-Path -LiteralPath (Join-Path $toolsDir 'bin\sdkmanager.bat') -PathType Leaf) {
            # 少数 zip 版本解压后直接就是 bin\，包一层成 latest
            $wrapper = Join-Path $toolsDir 'latest'
            New-Item -ItemType Directory -Path $wrapper -Force | Out-Null
            foreach ($entry in @(Get-ChildItem -LiteralPath $toolsDir -Force)) {
                if ($entry.Name -in @('latest', 'cmdline-tools')) { continue }
                Move-Item -LiteralPath $entry.FullName -Destination (Join-Path $wrapper $entry.Name) -Force
            }
        }
        else {
            throw "cmdline-tools 解压后未找到 sdkmanager.bat：$toolsDir"
        }
    }
    finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-AndroidSdk {
    param([string]$SdkRoot)

    $needPlatformTools = !(Test-Path -LiteralPath (Join-Path $SdkRoot 'platform-tools\adb.exe') -PathType Leaf)
    $needPlatform = !(Test-Path -LiteralPath (Join-Path $SdkRoot "platforms\android-$CompileSdk") -PathType Container)
    $needBuildTools = !(Test-Path -LiteralPath (Join-Path $SdkRoot "build-tools\$BuildTools") -PathType Container)
    if (!$needPlatformTools -and !$needPlatform -and !$needBuildTools) { return }

    $sdkManager = Find-SdkManager -SdkRoot $SdkRoot
    if (!$sdkManager) {
        Install-CmdlineTools -SdkRoot $SdkRoot
        $sdkManager = Find-SdkManager -SdkRoot $SdkRoot
    }
    if (!$sdkManager) {
        throw "未能找到 sdkmanager.bat（$SdkRoot\cmdline-tools）。请安装 Android SDK Command-line Tools 后重试。"
    }

    Write-Step '接受 Android SDK 许可协议'
    # 不能把 'y' 通过 PowerShell 管道喂给 sdkmanager：Windows PowerShell 5.1
    # 会给原生进程 stdin 写入 UTF-8 BOM 和 CRLF，sdkmanager 会把首行认成乱码。
    # 改为写入临时文件，由 cmd 做文件重定向；同时不用 Start-Process，避免它在
    # 进程环境存在 Path/PATH 大小写变体时抛“字典中的关键字 Path 已添加”。
    $licenseFile = Join-Path ([IO.Path]::GetTempPath()) ('tb-sdk-licenses-' + [guid]::NewGuid().ToString('N') + '.txt')
    $licenseRunner = Join-Path ([IO.Path]::GetTempPath()) ('tb-sdk-licenses-' + [guid]::NewGuid().ToString('N') + '.cmd')
    [IO.File]::WriteAllText(
        $licenseFile,
        ((1..40 | ForEach-Object { 'y' }) -join "`r`n") + "`r`n",
        (New-Object System.Text.ASCIIEncoding)
    )
    try {
        try {
            $batchEncoding = [System.Text.Encoding]::GetEncoding(
                [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
            )
        }
        catch {
            $batchEncoding = [System.Text.Encoding]::Default
        }
        $licenseCommand = '"{0}" --licenses --sdk_root="{1}" < "{2}"' -f $sdkManager, $SdkRoot, $licenseFile
        $licenseBatch = "@echo off`r`n$licenseCommand`r`nexit /b %ERRORLEVEL%`r`n"
        [IO.File]::WriteAllText($licenseRunner, $licenseBatch, $batchEncoding)
        & $licenseRunner | Out-Host
        $licenseExit = $LASTEXITCODE
        if ($licenseExit -ne 0) {
            # 与 Linux 版一致：许可交互偶尔以非 0 退出，后续安装仍会验证实际结果
            Write-WarnNote "sdkmanager --licenses 退出码 $licenseExit，继续尝试安装组件"
        }
    }
    finally {
        Remove-Item -LiteralPath $licenseFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $licenseRunner -Force -ErrorAction SilentlyContinue
    }

    $packages = @()
    if ($needPlatformTools) { $packages += 'platform-tools' }
    if ($needPlatform) { $packages += "platforms;android-$CompileSdk" }
    if ($needBuildTools) { $packages += "build-tools;$BuildTools" }
    if ($packages.Count -gt 0) {
        Write-Step ("安装 Android SDK 组件：" + ($packages -join ' '))
        & $sdkManager @packages "--sdk_root=$SdkRoot"
        if ($LASTEXITCODE -ne 0) {
            throw "安装 Android SDK 组件失败（sdkmanager 退出码 $LASTEXITCODE）"
        }
    }

    if (!(Test-Path -LiteralPath (Join-Path $SdkRoot "platforms\android-$CompileSdk") -PathType Container) -or
        !(Test-Path -LiteralPath (Join-Path $SdkRoot "build-tools\$BuildTools") -PathType Container)) {
        throw "Android SDK 组件仍不完整（platforms;android-$CompileSdk / build-tools;$BuildTools）：$SdkRoot"
    }
}

# ---------------------------------------------------------------------------
# JVM 清理
# ---------------------------------------------------------------------------

# 停掉 Gradle/Kotlin 守护进程，并清理本机残留的 daemon java 进程。只匹配守护进程
# 命令行特征，避免误杀用户自己开着的 java 程序（与 Linux 版口径一致）。
function Stop-JavaProcesses {
    Push-Location -LiteralPath $AndroidDir
    try {
        $oldErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        try {
            & (Join-Path $AndroidDir 'gradlew.bat') --stop *> $null
        }
        finally {
            $ErrorActionPreference = $oldErrorAction
        }
    }
    catch {
        # --stop 失败不影响后续清理
    }
    finally {
        Pop-Location
    }

    Start-Sleep -Seconds 1

    $processes = @()
    try {
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction Stop)
    }
    catch {
        try {
            $processes = @(Get-WmiObject Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue)
        }
        catch {
            $processes = @()
        }
    }

    $pattern = 'org\.gradle\.launcher\.daemon\.GradleDaemon|org\.jetbrains\.kotlin\.daemon\.KotlinCompileDaemon|kotlin-compiler-embeddable'
    $targets = @($processes | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })
    if ($targets.Count -eq 0) { return }

    $ids = ($targets | ForEach-Object { $_.ProcessId }) -join ', '
    Write-Step "结束残留 java 进程：$ids"
    foreach ($process in $targets) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    # 最多宽限 5 秒，仍存活的进程强制结束
    for ($i = 0; $i -lt 5; $i++) {
        Start-Sleep -Seconds 1
        $alive = @($targets | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
        if ($alive.Count -eq 0) { return }
    }
    foreach ($process in $targets) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

function Invoke-Main {
    $gradleFile = Join-Path $AndroidDir 'app\build.gradle.kts'
    if (!(Test-Path -LiteralPath $gradleFile -PathType Leaf)) {
        throw "未找到 $gradleFile，请确认在完整仓库中运行本脚本。"
    }

    Write-Step '[1/6] 检查 JDK 与 Android SDK'
    $javaHome = Find-JavaHome
    # 用 .NET 设置进程环境变量：Windows 上大小写不敏感，不会像 $env:XXX = ...
    # 那样可能与已有的 JavaHome / AndroidHome 变体并存，留下重复键。
    [Environment]::SetEnvironmentVariable('JAVA_HOME', $javaHome, 'Process')
    $sdkRoot = Resolve-SdkRoot
    Ensure-AndroidSdk -SdkRoot $sdkRoot
    [Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdkRoot, 'Process')
    [Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdkRoot, 'Process')
    Write-Note "JDK：$javaHome"
    Write-Note "Android SDK：$sdkRoot"

    Write-Step '[2/6] 版本号自增'
    $gradleText = [IO.File]::ReadAllText($gradleFile)
    $nameMatch = [regex]::Match($gradleText, 'versionName\s*=\s*"([^"]+)"')
    $codeMatch = [regex]::Match($gradleText, 'versionCode\s*=\s*(\d+)')
    if (!$nameMatch.Success) {
        throw "未能从 $gradleFile 解析出 versionName。"
    }
    if (!$codeMatch.Success) {
        throw "未能从 $gradleFile 解析出 versionCode。"
    }
    $currentVersion = $nameMatch.Groups[1].Value
    $currentCode = [int]$codeMatch.Groups[1].Value
    $parts = $currentVersion.Split('.')
    if ($parts.Count -ne 3 -or ($parts | Where-Object { $_ -notmatch '^\d+$' })) {
        throw "versionName 不是三段式数字版本号（当前：$currentVersion），无法自动自增。"
    }
    $newVersion = '{0}.{1}.{2}' -f $parts[0], $parts[1], ([int]$parts[2] + 1)
    $newCode = $currentCode + 1
    Write-Note "versionName $currentVersion → $newVersion，versionCode $currentCode → $newCode"

    $backupFile = $gradleFile + '.tb-build-bak'
    $propFile = Join-Path $AndroidDir 'local.properties'
    $propBackup = $null
    $succeeded = $false
    $finalTarget = $null

    Copy-Item -LiteralPath $gradleFile -Destination $backupFile -Force

    try {
        $nameRegex = [regex]'versionName\s*=\s*"[^"]+"'
        $codeRegex = [regex]'versionCode\s*=\s*\d+'
        $updatedText = $nameRegex.Replace($gradleText, "versionName = `"$newVersion`"", 1)
        $updatedText = $codeRegex.Replace($updatedText, "versionCode = $newCode", 1)
        [IO.File]::WriteAllText($gradleFile, $updatedText, (New-Object System.Text.UTF8Encoding($false)))

        # local.properties 的 sdk.dir 若指向不存在的目录（例如从 Linux 机器带过来的），
        # 构建期间临时替换为本机 SDK，结束后随 finally 一起恢复。
        if (Test-Path -LiteralPath $propFile -PathType Leaf) {
            $propText = [IO.File]::ReadAllText($propFile)
            $sdkMatch = [regex]::Match($propText, '(?m)^\s*sdk\.dir\s*=\s*(.*?)\s*$')
            if ($sdkMatch.Success) {
                $configuredSdk = $sdkMatch.Groups[1].Value.Replace('\\', '\').Replace('\:', ':').Replace('\ ', ' ')
                if (!(Test-Path -LiteralPath $configuredSdk -PathType Container)) {
                    $propBackup = $propFile + '.tb-build-bak'
                    Copy-Item -LiteralPath $propFile -Destination $propBackup -Force
                    $sdkLine = 'sdk.dir=' + $sdkRoot.Replace('\', '/')
                    $propText = ([regex]'(?m)^\s*sdk\.dir\s*=.*$').Replace($propText, $sdkLine, 1)
                    [IO.File]::WriteAllText($propFile, $propText, (New-Object System.Text.UTF8Encoding($false)))
                    Write-Note "local.properties 的 sdk.dir 无效，构建期间临时指向 $sdkRoot"
                }
            }
        }

        if ($CleanCache) {
            Write-Step '清理 Gradle 项目缓存：android\.gradle 与 android\app\build'
            Remove-Item -LiteralPath (Join-Path $AndroidDir '.gradle') -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath (Join-Path $AndroidDir 'app\build') -Recurse -Force -ErrorAction SilentlyContinue
        }

        Write-Step '[3/6] 编译 Release APK（首次会下载 Gradle wrapper 与依赖）'
        Push-Location -LiteralPath $AndroidDir
        try {
            & (Join-Path $AndroidDir 'gradlew.bat') ':app:assembleRelease' '--console=plain' '--no-daemon'
            $buildCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        if ($buildCode -ne 0) {
            throw "Release 编译失败（gradlew 退出码 $buildCode），请查看上方构建输出。"
        }

        $apk = Join-Path $AndroidDir 'app\build\outputs\apk\release\app-release.apk'
        if (!(Test-Path -LiteralPath $apk -PathType Leaf)) {
            throw "构建结束但未找到产物：$apk"
        }

        Write-Step '[4/6] 校验 Release 签名'
        $apkSigner = Join-Path $sdkRoot "build-tools\$BuildTools\apksigner.bat"
        if (!(Test-Path -LiteralPath $apkSigner -PathType Leaf)) {
            throw "未找到 apksigner：$apkSigner"
        }
        & $apkSigner verify --print-certs $apk
        if ($LASTEXITCODE -ne 0) {
            throw "APK 签名校验失败（apksigner 退出码 $LASTEXITCODE）"
        }

        Write-Step '[5/6] 收集产物'
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
        $targetName = "TerminalBuddy_${newVersion}_android.apk"
        $target = Join-Path $OutputDir $targetName
        Copy-Item -LiteralPath $apk -Destination $target -Force
        $finalTarget = $target
        $hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText(
            "$target.sha256",
            "$hash  $targetName`n",
            (New-Object System.Text.UTF8Encoding($false))
        )
        $succeeded = $true
    }
    finally {
        if ($succeeded) {
            Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
            if ($propBackup) {
                Remove-Item -LiteralPath $propBackup -Force -ErrorAction SilentlyContinue
            }
        }
        else {
            if (Test-Path -LiteralPath $backupFile -PathType Leaf) {
                Copy-Item -LiteralPath $backupFile -Destination $gradleFile -Force
                Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
                Write-WarnNote '构建失败，已回退版本号修改'
            }
            if ($propBackup -and (Test-Path -LiteralPath $propBackup -PathType Leaf)) {
                Copy-Item -LiteralPath $propBackup -Destination $propFile -Force
                Remove-Item -LiteralPath $propBackup -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Step '[6/6] 清理 Gradle / Kotlin JVM'
        try {
            Stop-JavaProcesses
        }
        catch {
            Write-WarnNote "JVM 清理失败：$($_.Exception.Message)"
        }
    }

    # 构建成功后默认移动产物到共享目录（Linux 版对应 /mnt/fnos/code）。
    # 目标不可达或写入失败时只警告，产物保留在 dist\，不影响构建结果。
    if ($NoDeploy) {
        Write-Note "已指定 --no-deploy，产物保留在 $OutputDir"
    }
    elseif ($DeployDir) {
        $deployDir = $DeployDir.Trim()
        if ($deployDir -match '^[A-Za-z]:' -or $deployDir -match '^\\\\') {
            $deployDir = [IO.Path]::GetFullPath($deployDir)
        }
        $moved = $false
        try {
            if (!(Test-Path -LiteralPath $deployDir -PathType Container)) {
                New-Item -ItemType Directory -Path $deployDir -Force -ErrorAction Stop | Out-Null
            }
            foreach ($item in @($target, "$target.sha256")) {
                Move-Item -LiteralPath $item -Destination $deployDir -Force -ErrorAction Stop
            }
            $finalTarget = Join-Path $deployDir $targetName
            $moved = $true
            Write-Step "已移动产物到 $deployDir"
        }
        catch {
            Write-WarnNote "移动到 $deployDir 失败（$($_.Exception.Message)），产物保留在 $OutputDir"
        }
        if (!$moved -and !(Test-Path -LiteralPath $target -PathType Leaf)) {
            # 极少数情况下 APK 已过去、.sha256 失败，避免最后一行报出无效路径
            Write-WarnNote "本地产物 $target 已不在 $OutputDir，请确认上述目标目录内容是否完整"
        }
    }
    else {
        Write-Note "未指定部署目录，产物保留在 $OutputDir"
    }

    Write-Note "产物：$finalTarget"
    Write-Note "已写入版本号 versionName $newVersion / versionCode $newCode（记得随代码提交）"
}

try {
    Invoke-Main
    Write-Host ''
    Write-Host '[完成] Android Release APK 构建完成' -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ''
    Write-Host ('[失败] ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
