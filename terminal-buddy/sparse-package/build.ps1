# TerminalBuddy Sparse Package 构建与注册脚本
# 用法:
#   .\build.ps1              - 构建 .msix 并注册
#   .\build.ps1 -Uninstall   - 注销 Sparse Package
#   .\build.ps1 -BuildOnly   - 仅构建 .msix，不注册

param(
    [switch]$Uninstall,
    [switch]$BuildOnly,
    [string]$InstallDir = ""  # TerminalBuddy 安装目录，留空则自动检测
)

$ErrorActionPreference = "Stop"

$PackageName = "TerminalBuddy"
$SparseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MsixOutput = Join-Path $SparseDir "TerminalBuddy.msix"

# ── 查找 Windows SDK 工具 ──────────────────────────────────────────
function Find-SdkTool {
    param([string]$Name)
    $tool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter $Name `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -like "*\x64" } |
        Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
        Select-Object -First 1
    if (-not $tool) {
        Write-Error "$Name not found. Install Windows SDK (10.0.19041+)."
        exit 1
    }
    return $tool.FullName
}

# ── 卸载 ────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Host "Uninstalling Sparse Package..." -ForegroundColor Yellow
    $pkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
    if ($pkg) {
        Remove-AppxPackage -Package $pkg.PackageFullName
        Write-Host "Sparse Package uninstalled." -ForegroundColor Green
    } else {
        Write-Host "Sparse Package not found (already uninstalled)." -ForegroundColor Gray
    }
    exit 0
}

# ── 检测安装目录 ────────────────────────────────────────────────────
if (-not $InstallDir) {
    # 优先从构建输出查找
    $devExe = Join-Path $SparseDir "..\src-tauri\target\release\terminal-buddy.exe"
    if (Test-Path $devExe) {
        $InstallDir = (Resolve-Path (Split-Path $devExe)).Path
        Write-Host "Using dev build: $InstallDir" -ForegroundColor Cyan
    } else {
        # 尝试 NSIS 安装路径
        $nsisPath = "${env:ProgramFiles}\TerminalBuddy"
        if (Test-Path $nsisPath) {
            $InstallDir = $nsisPath
            Write-Host "Using installed path: $InstallDir" -ForegroundColor Cyan
        } else {
            Write-Error "Cannot find TerminalBuddy installation. Use -InstallDir <path>."
            exit 1
        }
    }
}

# ── 创建自签名证书（首次运行）──────────────────────────────────────
$cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq "CN=TerminalBuddy" } |
    Select-Object -First 1

if (-not $cert) {
    Write-Host "Creating self-signed certificate..." -ForegroundColor Yellow
    $cert = New-SelfSignedCertificate `
        -Type Custom `
        -KeyUsage DigitalSignature `
        -Subject "CN=TerminalBuddy" `
        -FriendlyName "TerminalBuddy Dev Certificate" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
    Write-Host "Certificate created: $($cert.Thumbprint)" -ForegroundColor Green
}

# 将公钥导入 TrustedPeople（如果尚未导入）
$trusted = Get-ChildItem Cert:\CurrentUser\TrustedPeople |
    Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
if (-not $trusted) {
    Write-Host "Importing certificate to TrustedPeople store..." -ForegroundColor Yellow
    Export-Certificate -Cert $cert -FilePath (Join-Path $SparseDir "TerminalBuddy.cer") | Out-Null
    Import-Certificate -FilePath (Join-Path $SparseDir "TerminalBuddy.cer") `
        -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null
    Write-Host "Certificate imported." -ForegroundColor Green
}

# ── 导出 PFX（用于签名）───────────────────────────────────────────
$pfxPath = Join-Path $SparseDir "TerminalBuddy.pfx"
$pfxPassword = ConvertTo-SecureString -String "TerminalBuddy" -Force -AsPlainText
if (-not (Test-Path $pfxPath)) {
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pfxPassword | Out-Null
    Write-Host "PFX exported: $pfxPath" -ForegroundColor Green
}

# ── 构建 MSIX ──────────────────────────────────────────────────────
$makeAppx = Find-SdkTool "MakeAppx.exe"
$signtool = Find-SdkTool "SignTool.exe"

Write-Host "`nBuilding Sparse Package..." -ForegroundColor Yellow

# 确保 Public 目录存在
$publicDir = Join-Path $SparseDir "Public"
if (-not (Test-Path $publicDir)) {
    New-Item -ItemType Directory -Path $publicDir | Out-Null
}

# 打包
& $makeAppx pack /o /d $SparseDir /nv /p $MsixOutput
if ($LASTEXITCODE -ne 0) {
    Write-Error "MakeAppx failed with exit code $LASTEXITCODE"
    exit 1
}
Write-Host "MSIX created: $MsixOutput" -ForegroundColor Green

# 签名
& $signtool sign /fd SHA256 /a /f $pfxPath /p "TerminalBuddy" $MsixOutput
if ($LASTEXITCODE -ne 0) {
    Write-Error "SignTool failed with exit code $LASTEXITCODE"
    exit 1
}
Write-Host "MSIX signed." -ForegroundColor Green

if ($BuildOnly) {
    Write-Host "`nBuild complete. MSIX: $MsixOutput" -ForegroundColor Green
    exit 0
}

# ── 注册 Sparse Package ────────────────────────────────────────────
Write-Host "`nRegistering Sparse Package..." -ForegroundColor Yellow

# 先移除旧包（版本更新时需要）
$oldPkg = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if ($oldPkg) {
    Remove-AppxPackage -Package $oldPkg.PackageFullName
    Write-Host "Removed previous package." -ForegroundColor Gray
}

# 注册
Add-AppxPackage -Path $MsixOutput -ExternalLocation $InstallDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "Add-AppxPackage failed. Try running as Administrator or enable Developer Mode."
    exit 1
}

Write-Host "`nSparse Package registered successfully!" -ForegroundColor Green
Write-Host "  Install Dir: $InstallDir" -ForegroundColor Cyan
Write-Host "  Package:     $PackageName" -ForegroundColor Cyan
Write-Host ""
Write-Host "TerminalBuddy should now appear in:" -ForegroundColor White
Write-Host "  Settings > Privacy & Security > Developers > Terminal" -ForegroundColor White
Write-Host ""
Write-Host "To uninstall the sparse package, run:" -ForegroundColor Gray
Write-Host "  .\build.ps1 -Uninstall" -ForegroundColor Gray
