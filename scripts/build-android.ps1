[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Serial = $env:ANDROID_SERIAL
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$AppId = 'com.terminalbuddy.android'
$LaunchActivity = "$AppId/.MainActivity"

function Invoke-CheckedCommand {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$FailureMessage
    )

    $output = & $FilePath @ArgumentList 2>&1
    $output | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage（退出码：$LASTEXITCODE），请查看上方工具输出。"
    }
    return $output
}

# Gradle Wrapper 8.13 支持 JDK 17–23：优先 JAVA_HOME，其次 Android Studio 自带 JDK。
function Find-JavaHome {
    $candidates = @(
        $env:JAVA_HOME,
        $env:JDK_HOME,
        "$env:ProgramFiles\Android\Android Studio\jbr",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr"
    )
    $javaCommand = Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($javaCommand) {
        $candidates += Split-Path -Parent (Split-Path -Parent $javaCommand.Source)
    }
    foreach ($pattern in @("$env:ProgramFiles\Java\jdk-*", "$env:ProgramFiles\Eclipse Adoptium\jdk-*", "$env:USERPROFILE\.jdks\*")) {
        $candidates += @(Get-ChildItem -Path $pattern -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
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

function Find-AndroidSdk {
    param([string]$AndroidRoot)

    $localProperties = Join-Path $AndroidRoot 'local.properties'
    if (Test-Path -LiteralPath $localProperties -PathType Leaf) {
        $sdkSetting = [regex]::Match([IO.File]::ReadAllText($localProperties), '(?m)^\s*sdk\.dir\s*=\s*(.*?)\s*$')
        if ($sdkSetting.Success) {
            $sdk = $sdkSetting.Groups[1].Value.Replace('\\', '\').Replace('\:', ':').Replace('\ ', ' ')
            if (!(Test-Path -LiteralPath (Join-Path $sdk 'platform-tools\adb.exe') -PathType Leaf)) {
                throw "local.properties 指定的 SDK 缺少 platform-tools\adb.exe：$sdk。请在 Android Studio 中安装 Android SDK Platform-Tools 或修正 sdk.dir。"
            }
            return $sdk
        }
    }
    $candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk")
    $adbCommand = Get-Command adb.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($adbCommand) {
        $candidates += Split-Path -Parent (Split-Path -Parent $adbCommand.Source)
    }
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'platform-tools\adb.exe') -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).ProviderPath
        }
    }
    throw '没有找到 Android SDK 和 adb。请安装 Android SDK Platform-Tools，并配置 android\local.properties 的 sdk.dir 或 ANDROID_HOME。'
}

function Select-AndroidDevice {
    param([string]$AdbPath, [string]$RequestedSerial)

    $lines = @(Invoke-CheckedCommand -FilePath $AdbPath -ArgumentList @('devices', '-l') -FailureMessage '读取安卓设备失败')
    $devices = @(foreach ($line in $lines) {
        if ($line -match '^List of devices attached' -or $line -match '^\*' -or [string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -match '^(\S+)\s+(\S+)(?:\s+(.*))?$') {
            [pscustomobject]@{
                Serial = $Matches[1]
                State = $Matches[2]
                Details = $Matches[3]
            }
        }
    })
    if ($RequestedSerial) {
        $selected = @($devices | Where-Object { $_.Serial -eq $RequestedSerial -and $_.State -eq 'device' })
        if ($selected.Count -ne 1) {
            throw "指定设备 $RequestedSerial 未连接或尚未授权。请打开 USB 调试、解锁手机并允许此电脑调试后重试。"
        }
        return $selected[0].Serial
    }
    $ready = @($devices | Where-Object { $_.State -eq 'device' })
    if ($ready.Count -eq 0) {
        foreach ($device in $devices) { Write-Host "设备：$($device.Serial)，状态：$($device.State)" }
        throw '没有可安装的安卓设备。请用数据线连接手机，打开开发者选项和 USB 调试，解锁后允许此电脑调试；offline 设备请重新连接。'
    }
    if ($ready.Count -eq 1) { return $ready[0].Serial }

    Write-Host '检测到多个安卓设备，请选择安装目标：'
    for ($i = 0; $i -lt $ready.Count; $i++) {
        Write-Host ("  {0}. {1}  {2}" -f ($i + 1), $ready[$i].Serial, $ready[$i].Details)
    }
    $choice = Read-Host '输入设备序号'
    $index = 0
    if (![int]::TryParse($choice, [ref]$index) -or $index -lt 1 -or $index -gt $ready.Count) {
        throw '设备序号无效，请重新运行脚本并输入列表中的序号。'
    }
    return $ready[$index - 1].Serial
}

function Invoke-AndroidReleaseRun {
    param([string]$ProjectRoot, [string]$RequestedSerial)

    $androidRoot = Join-Path $ProjectRoot 'android'
    $gradlew = Join-Path $androidRoot 'gradlew.bat'
    if (!(Test-Path -LiteralPath $gradlew -PathType Leaf)) {
        throw "没有找到安卓工程的 Gradle Wrapper：$gradlew"
    }

    $signingProperties = Join-Path $androidRoot 'keystore.properties'
    if (!(Test-Path -LiteralPath $signingProperties -PathType Leaf)) {
        throw "缺少 Release 签名配置：$signingProperties。请恢复签名配置后重试，以生成可安装的 APK。"
    }

    Write-Host '[1/4] 检查 JDK 和 Android SDK……'
    $env:JAVA_HOME = Find-JavaHome
    $sdk = Find-AndroidSdk -AndroidRoot $androidRoot
    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk
    $env:PATH = "$env:JAVA_HOME\bin;$sdk\platform-tools;$env:PATH"
    $adb = Join-Path $sdk 'platform-tools\adb.exe'
    Write-Host "JDK：$env:JAVA_HOME"
    Write-Host "Android SDK：$sdk"

    Write-Host '[2/4] 检测手机连接及调试授权……'
    $targetSerial = Select-AndroidDevice -AdbPath $adb -RequestedSerial $RequestedSerial
    Write-Host "安装目标：$targetSerial"

    Write-Host '[3/4] 编译 Release APK（增量构建，首次运行需要下载依赖）……'
    Push-Location -LiteralPath $androidRoot
    try {
        Invoke-CheckedCommand -FilePath $gradlew -ArgumentList @(':app:assembleRelease', '--console=plain') -FailureMessage 'Release 编译打包失败'
    }
    finally { Pop-Location }
    $apk = Join-Path $androidRoot 'app\build\outputs\apk\release\app-release.apk'
    if (!(Test-Path -LiteralPath $apk -PathType Leaf)) {
        throw "未找到 Release APK：$apk。请检查上方构建输出。"
    }
    Write-Host "APK：$apk"

    Write-Host '[4/4] 安装并启动……'
    $installOutput = & $adb -s $targetSerial install -r $apk 2>&1
    $installOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        if (($installOutput | Out-String) -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_INVALID_APK|signatures do not match') {
            throw "安装失败：手机上已安装同包名但签名不同的 $AppId。请备份应用数据后手动卸载旧版再重试，脚本不会自动卸载。"
        }
        throw "APK 安装失败（退出码：$LASTEXITCODE），请查看上方 adb 输出。"
    }
    Invoke-CheckedCommand -FilePath $adb -ArgumentList @('-s', $targetSerial, 'shell', 'am', 'start', '-n', $LaunchActivity) -FailureMessage 'APK 已安装，但启动应用失败'
    Write-Host ''
    Write-Host "[完成] Release APK 已安装并启动：$apk" -ForegroundColor Green
}

try {
    Invoke-AndroidReleaseRun -ProjectRoot (Split-Path -Parent $PSScriptRoot) -RequestedSerial $Serial
    exit 0
}
catch {
    Write-Host ''
    Write-Host ("[失败] " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
