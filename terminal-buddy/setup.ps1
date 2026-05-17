# TerminalBuddy 一键构建与注册脚本
# 用法:
#   .\setup.ps1                     - 完整流程：构建 + 打包 + 注册 + 设为默认终端
#   .\setup.ps1 -BuildOnly          - 仅构建 .msix，不注册
#   .\setup.ps1 -SkipTauriBuild     - 跳过 Tauri 构建（已有 release exe 时使用）
#   .\setup.ps1 -Uninstall          - 注销 Sparse Package 并还原默认终端设置
#   .\setup.ps1 -RegisterOnly       - 仅注册已有的 .msix（跳过构建和打包）

param(
    [switch]$Uninstall,
    [switch]$BuildOnly,
    [switch]$SkipTauriBuild,
    [switch]$RegisterOnly,
    [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"

# ── 自动提升为管理员 ──────────────────────────────────────────────────
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $PSBoundParameters.GetEnumerator() | ForEach-Object { `"-$($_.Key)`" }"
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath)
    foreach ($key in $PSBoundParameters.Keys) {
        $val = $PSBoundParameters[$key]
        if ($val -is [System.Management.Automation.SwitchParameter]) {
            if ($val.IsPresent) { $argList += "-$key" }
        } else {
            $argList += "-$key"
            $argList += "$val"
        }
    }
    Start-Process PowerShell -Verb RunAs -ArgumentList $argList
    exit 0
}

$PackageName = "TerminalBuddy"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SparseDir = Join-Path $ProjectDir "sparse-package"
$MsixOutput = Join-Path $SparseDir "TerminalBuddy.msix"
$TauriDir = Join-Path $ProjectDir "src-tauri"
$ReleaseExe = Join-Path $TauriDir "target\release\terminal-buddy.exe"

# ── CLSID 定义（必须与 Rust 代码中一致）──────────────────────────────
$CLSID_DELEGATION_CONSOLE = "{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}"
$CLSID_DELEGATION_TERMINAL = "{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}"

# ── 辅助函数 ─────────────────────────────────────────────────────────

function Write-Step {
    param([string]$Message)
    Write-Host "`n━━━ $Message ━━━" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  ✓ $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  ! $Message" -ForegroundColor Yellow
}

function Find-SdkTool {
    param([string]$Name)
    $tool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter $Name `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -like "*\x64" } |
        Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
        Select-Object -First 1
    if (-not $tool) {
        Write-Error "$Name not found. Install Windows SDK 10.0.19041 or later."
        exit 1
    }
    return $tool.FullName
}

# ── 卸载 ─────────────────────────────────────────────────────────────

if ($Uninstall) {
    Write-Step "卸载 TerminalBuddy 默认终端设置"

    # 还原注册表
    $regKey = "HKCU:\Console\%%Startup"
    if (Test-Path $regKey) {
        $current = Get-ItemProperty -Path $regKey -Name "DelegationTerminal" -ErrorAction SilentlyContinue
        if ($current.DelegationTerminal -eq $CLSID_DELEGATION_TERMINAL) {
            Set-ItemProperty -Path $regKey -Name "DelegationConsole" -Value "{00000000-0000-0000-0000-000000000000}"
            Set-ItemProperty -Path $regKey -Name "DelegationTerminal" -Value "{00000000-0000-0000-0000-000000000000}"
            Write-Ok "已还原默认终端注册表设置"
        } else {
            Write-Warn "当前默认终端不是 TerminalBuddy，跳过注册表还原"
        }
    }

    # 清理 CLSID 注册
    $clsidKey = "HKCU:\Software\Classes\CLSID\$CLSID_DELEGATION_TERMINAL"
    if (Test-Path $clsidKey) {
        Remove-Item -Path $clsidKey -Recurse -Force
        Write-Ok "已清理 CLSID 注册表项"
    }

    # 注销 Sparse Package
    $pkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
    if ($pkg) {
        Remove-AppxPackage -Package $pkg.PackageFullName
        Write-Ok "Sparse Package 已注销"
    } else {
        Write-Warn "Sparse Package 未找到（可能已注销）"
    }

    Write-Host "`n卸载完成。" -ForegroundColor Green
    exit 0
}

# ── 步骤 1：构建 Tauri 应用 ──────────────────────────────────────────

if (-not $SkipTauriBuild -and -not $RegisterOnly) {
    Write-Step "步骤 1/4：构建 Tauri 应用"

    # 检查 node_modules
    if (-not (Test-Path (Join-Path $ProjectDir "node_modules"))) {
        Write-Host "  安装 npm 依赖..." -ForegroundColor Gray
        Push-Location $ProjectDir
        npm install
        Pop-Location
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm install 失败"
            exit 1
        }
    }

    Write-Host "  执行 cargo build --release（首次构建可能需要几分钟）..." -ForegroundColor Gray
    Push-Location $TauriDir
    cargo build --release 2>&1 | ForEach-Object { Write-Host "    $_" }
    Pop-Location

    if (-not (Test-Path $ReleaseExe)) {
        Write-Error "构建失败：找不到 $ReleaseExe"
        exit 1
    }
    Write-Ok "Tauri 应用构建完成"
} else {
    if ($RegisterOnly) {
        Write-Step "跳过构建（仅注册模式）"
    } else {
        Write-Step "跳过构建（使用已有 release exe）"
    }

    if (-not (Test-Path $ReleaseExe)) {
        Write-Error "找不到 release exe: $ReleaseExe`n请先构建或移除 -SkipTauriBuild 参数"
        exit 1
    }
}

# ── 检测安装目录 ─────────────────────────────────────────────────────

if (-not $InstallDir) {
    $InstallDir = (Resolve-Path (Split-Path $ReleaseExe)).Path
    Write-Ok "安装目录: $InstallDir"
}

# ── 步骤 2：创建自签名证书 ──────────────────────────────────────────

if (-not $RegisterOnly) {
    Write-Step "步骤 2/4：准备签名证书"

    $cert = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq "CN=TerminalBuddy" } |
        Select-Object -First 1

    if (-not $cert) {
        Write-Host "  创建自签名证书..." -ForegroundColor Gray
        $cert = New-SelfSignedCertificate `
            -Type Custom `
            -KeyUsage DigitalSignature `
            -Subject "CN=TerminalBuddy" `
            -FriendlyName "TerminalBuddy Dev Certificate" `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
        Write-Ok "证书已创建: $($cert.Thumbprint)"
    } else {
        Write-Ok "证书已存在: $($cert.Thumbprint)"
    }

    # 导出 CER（用于导入到多个存储）
    $cerPath = Join-Path $SparseDir "TerminalBuddy.cer"
    Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

    # 导入到 TrustedPeople（如果尚未导入）
    $trusted = Get-ChildItem Cert:\CurrentUser\TrustedPeople |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if (-not $trusted) {
        Write-Host "  导入证书到 TrustedPeople..." -ForegroundColor Gray
        Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null
        Write-Ok "证书已导入 TrustedPeople"
    } else {
        Write-Ok "证书已在 TrustedPeople 中"
    }

    # 导入到 LocalMachine\Root（MSIX 注册必需，需要管理员权限）
    $rooted = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if (-not $rooted) {
        Write-Host "  导入证书到 LocalMachine\Root..." -ForegroundColor Gray
        Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
        Write-Ok "证书已导入 LocalMachine\Root"
    } else {
        Write-Ok "证书已在 LocalMachine\Root 中"
    }

    # 导出 PFX（用于签名）
    $pfxPath = Join-Path $SparseDir "TerminalBuddy.pfx"
    $pfxPassword = ConvertTo-SecureString -String "TerminalBuddy" -Force -AsPlainText
    if (-not (Test-Path $pfxPath)) {
        Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pfxPassword | Out-Null
        Write-Ok "PFX 已导出"
    } else {
        Write-Ok "PFX 已存在"
    }
}

# ── 步骤 3：构建并签名 MSIX ─────────────────────────────────────────

if (-not $RegisterOnly) {
    Write-Step "步骤 3/4：构建 Sparse Package"

    $makeAppx = Find-SdkTool "MakeAppx.exe"
    $signtool = Find-SdkTool "SignTool.exe"

    # 清理上次构建产物（避免打包进新 MSIX）
    if (Test-Path $MsixOutput) { Remove-Item $MsixOutput -Force }

    # 确保 Public 目录和 Assets 目录存在
    $publicDir = Join-Path $SparseDir "Public"
    if (-not (Test-Path $publicDir)) {
        New-Item -ItemType Directory -Path $publicDir | Out-Null
    }
    $assetsDir = Join-Path $SparseDir "Assets"
    if (-not (Test-Path $assetsDir)) {
        New-Item -ItemType Directory -Path $assetsDir | Out-Null
    }

    # 打包
    Write-Host "  MakeAppx 打包中..." -ForegroundColor Gray
    & $makeAppx pack /o /d $SparseDir /nv /p $MsixOutput
    if ($LASTEXITCODE -ne 0) {
        Write-Error "MakeAppx 失败 (exit code $LASTEXITCODE)"
        exit 1
    }
    Write-Ok "MSIX 已创建"

    # 签名
    Write-Host "  SignTool 签名中..." -ForegroundColor Gray
    & $signtool sign /fd SHA256 /a /f $pfxPath /p "TerminalBuddy" $MsixOutput
    if ($LASTEXITCODE -ne 0) {
        Write-Error "SignTool 失败 (exit code $LASTEXITCODE)"
        exit 1
    }
    Write-Ok "MSIX 已签名"

    if ($BuildOnly) {
        Write-Host "`n构建完成。MSIX: $MsixOutput" -ForegroundColor Green
        exit 0
    }
}

# ── 步骤 4：注册 Sparse Package + 设置默认终端 ──────────────────────

Write-Step "步骤 4/4：注册并设为默认终端"

# 移除旧包（版本更新时需要）
$oldPkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if ($oldPkg) {
    Remove-AppxPackage -Package $oldPkg.PackageFullName
    Write-Ok "已移除旧版 Sparse Package"
}

# 注册
Write-Host "  注册 Sparse Package..." -ForegroundColor Gray
if (-not (Test-Path $MsixOutput)) {
    Write-Error "找不到 MSIX: $MsixOutput`n请先构建或移除 -RegisterOnly 参数"
    exit 1
}

Add-AppxPackage -Path $MsixOutput -ExternalLocation $InstallDir -AllowUnsigned
if ($LASTEXITCODE -ne 0) {
    Write-Error "Add-AppxPackage 失败。请尝试以管理员身份运行或开启开发者模式。"
    exit 1
}
Write-Ok "Sparse Package 注册成功"

# 设置默认终端注册表
Write-Host "  设置默认终端注册表..." -ForegroundColor Gray

$regKey = "HKCU:\Console\%%Startup"
if (-not (Test-Path $regKey)) {
    New-Item -Path $regKey -Force | Out-Null
}

Set-ItemProperty -Path $regKey -Name "DelegationConsole" -Value $CLSID_DELEGATION_CONSOLE -Type String
Set-ItemProperty -Path $regKey -Name "DelegationTerminal" -Value $CLSID_DELEGATION_TERMINAL -Type String
Write-Ok "注册表 DelegationConsole/DelegationTerminal 已设置"

# 注册 CLSID LocalServer32（让 COM 能自动启动 TerminalBuddy）
$clsidKey = "HKCU:\Software\Classes\CLSID\$CLSID_DELEGATION_TERMINAL"
if (-not (Test-Path $clsidKey)) {
    New-Item -Path $clsidKey -Force | Out-Null
}
Set-ItemProperty -Path $clsidKey -Name "(Default)" -Value "TerminalBuddy Terminal Handoff" -Type String

$localServerKey = "$clsidKey\LocalServer32"
if (-not (Test-Path $localServerKey)) {
    New-Item -Path $localServerKey -Force | Out-Null
}
Set-ItemProperty -Path $localServerKey -Name "(Default)" -Value $ReleaseExe -Type String
Write-Ok "CLSID LocalServer32 已注册 -> $ReleaseExe"

# ── 验证 ─────────────────────────────────────────────────────────────

Write-Step "验证"

$pkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if ($pkg) {
    Write-Ok "Sparse Package 已注册: $($pkg.PackageFullName)"
} else {
    Write-Warn "Sparse Package 未检测到"
}

$regValues = Get-ItemProperty -Path $regKey -ErrorAction SilentlyContinue
if ($regValues.DelegationTerminal -eq $CLSID_DELEGATION_TERMINAL) {
    Write-Ok "默认终端注册表正确"
} else {
    Write-Warn "默认终端注册表值不匹配: $($regValues.DelegationTerminal)"
}

if (Test-Path $ReleaseExe) {
    Write-Ok "可执行文件就绪: $ReleaseExe"
} else {
    Write-Warn "可执行文件不存在: $ReleaseExe"
}

# ── 完成 ─────────────────────────────────────────────────────────────

Write-Host @"

═══════════════════════════════════════════════════════════
  TerminalBuddy 已设置为系统默认终端！
═══════════════════════════════════════════════════════════

  安装目录:  $InstallDir
  MSIX:      $MsixOutput
  Package:   $PackageName

  现在可以通过以下方式触发:
    - 在文件资源管理器地址栏输入路径
    - VS2022/VS2026 调试控制台程序
    - Windows Settings > Privacy & Security > Developers > Terminal

  注意:
    1. 首次触发 handoff 时 TerminalBuddy 必须已在运行
       （注册了 LocalServer32 后，未运行时 COM 会自动启动）
    2. 如果 VS 调试未生效，重启 VS 后再试

  卸载命令:
    .\setup.ps1 -Uninstall

"@ -ForegroundColor White
