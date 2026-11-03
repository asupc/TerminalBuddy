#!/usr/bin/env bash
# TerminalBuddy Android APK 一键构建脚本（Linux 本机构建，无需 Docker）
#
# 依赖缺失时自动补齐：JDK 17 尝试 sudo 自动安装（无免密 sudo 时会打印命令，
# 先执行再重跑），Android SDK 首次自动下载到 ~/.android-sdk。
#
# 用法：
#   ./xcj/build-android.sh               产出 Release APK
#   ./xcj/build-android.sh --clean-cache 清空 Gradle 项目构建缓存
#
# 产物：dist/TerminalBuddy_<版本>_android.apk 及同名 .sha256（仓库内
# release.keystore 自动完成 Release 签名，并用 apksigner 校验）。
# Windows 上带 adb 直装的版本见 scripts/build-android.bat 与 scripts/build-android.ps1。
#
# 每次构建自动把版本号自增一：versionName 末段 +1（如 1.0.0 → 1.0.1）、
# versionCode 同步 +1，直接写入 android/app/build.gradle.kts（记得随
# 代码提交）；构建失败自动回退，不消耗版本号。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$REPO_ROOT/android"
OUTPUT_DIR="$REPO_ROOT/dist"
ANDROID_HOME="${ANDROID_HOME:-$HOME/.android-sdk}"
CMDLINE_TOOLS_VERSION=13114758
CLEAN_CACHE=0

usage() {
    cat <<'EOF'
用法：./xcj/build-android.sh [--clean-cache]

  --clean-cache  清空项目内 Gradle 构建缓存（android/.gradle 与 app/build）
  -h, --help     显示本帮助

说明：每次构建自动 versionName 末段 +1 / versionCode +1，
      成功后写入 android/app/build.gradle.kts（构建失败自动回退）。

环境变量：
  ANDROID_HOME  Android SDK 目录，默认 ~/.android-sdk
EOF
}

for arg in "$@"; do
    case "$arg" in
        --clean-cache) CLEAN_CACHE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数：$arg" >&2; usage >&2; exit 1 ;;
    esac
done

# ---------- 环境自动补齐 ----------

# 检测并自动安装系统包；无免密 sudo 时打印命令让用户先执行
need_apt() {
    local missing=() pkg
    for pkg in "$@"; do dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg"); done
    [ ${#missing[@]} -eq 0 ] && return 0
    echo "==> 缺少系统包：${missing[*]}，尝试自动安装（需要 sudo）"
    if sudo -n apt-get install -y --no-install-recommends "${missing[@]}"; then
        return 0
    fi
    echo "错误：无法自动安装（sudo 需要密码）。请先执行：" >&2
    echo "  sudo apt-get install -y --no-install-recommends ${missing[*]}" >&2
    exit 1
}

if [ ! -f "$ANDROID_DIR/app/build.gradle.kts" ]; then
    echo "错误：未找到 $ANDROID_DIR/app/build.gradle.kts，请在仓库根目录运行本脚本。" >&2
    exit 1
fi

# JDK 17+
if command -v java >/dev/null 2>&1; then
    JAVA_MAJOR="$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | head -1 | tr -d '"')"
    if [ -z "$JAVA_MAJOR" ] || [ "$JAVA_MAJOR" -lt 17 ]; then
        echo "错误：当前 java（$(java -version 2>&1 | head -1)）低于 17，请安装 openjdk-17-jdk-headless 并设为默认。" >&2
        exit 1
    fi
else
    need_apt openjdk-17-jdk-headless
fi

# Android SDK（用户级 → ~/.android-sdk，无需 sudo）：cmdline-tools + SDK 36 + build-tools 35.0.0
export ANDROID_HOME
if [ ! -d "$ANDROID_HOME/platforms/android-36" ] || [ ! -d "$ANDROID_HOME/build-tools/35.0.0" ]; then
    echo "==> 首次配置 Android SDK → $ANDROID_HOME（下载约 1-2 GB）"
    need_apt ca-certificates curl unzip
    TMP_DIR="$(mktemp -d)"
    curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
        -o "$TMP_DIR/cmdline-tools.zip"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    unzip -q -o "$TMP_DIR/cmdline-tools.zip" -d "$ANDROID_HOME/cmdline-tools"
    rm -rf "$ANDROID_HOME/cmdline-tools/latest"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm -rf "$TMP_DIR"
    SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
    yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
    "$SDKMANAGER" "platform-tools" "platforms;android-36" "build-tools;35.0.0"
fi
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# ---------- 版本号自增（构建失败自动回退） ----------

GRADLE_FILE="$ANDROID_DIR/app/build.gradle.kts"
CURRENT_VERSION="$(grep -m1 -oE 'versionName *= *"[^"]+"' "$GRADLE_FILE" | sed -E 's/.*"([^"]+)"/\1/')"
CURRENT_CODE="$(grep -m1 -oE 'versionCode *= *[0-9]+' "$GRADLE_FILE" | grep -oE '[0-9]+$')"
if ! [[ "$CURRENT_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "错误：versionName 不是三段式数字版本号（当前：$CURRENT_VERSION），无法自动自增。" >&2
    exit 1
fi
if [ -z "$CURRENT_CODE" ]; then
    echo "错误：未能从 $GRADLE_FILE 解析出 versionCode。" >&2
    exit 1
fi
NEW_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
NEW_CODE="$((CURRENT_CODE + 1))"
echo "==> 版本号自增：versionName $CURRENT_VERSION → $NEW_VERSION，versionCode $CURRENT_CODE → $NEW_CODE"

BAK="$GRADLE_FILE.tb-build-bak"
PROP_FILE="$ANDROID_DIR/local.properties"
PROP_BAK=""
restore_and_exit() {
    local status=$?
    if [ "$status" -ne 0 ]; then
        if [ -f "$BAK" ]; then
            mv -f "$BAK" "$GRADLE_FILE"
            echo "==> 构建失败，已回退版本号修改" >&2
        fi
        if [ -n "$PROP_BAK" ] && [ -f "$PROP_BAK" ]; then
            mv -f "$PROP_BAK" "$PROP_FILE"
        fi
    fi
    exit "$status"
}
trap restore_and_exit EXIT

# 新版本直接写入构建文件，失败时由上面的 trap 回退
cp -f "$GRADLE_FILE" "$BAK"
sed -i -E "s/versionName *= *\"[^\"]+\"/versionName = \"$NEW_VERSION\"/" "$GRADLE_FILE"
sed -i -E "s/versionCode *= *[0-9]+/versionCode = $NEW_CODE/" "$GRADLE_FILE"

# local.properties 的 sdk.dir 若指向不存在的目录（比如从 Windows 机器带过来的），
# 构建期间临时替换为本机 SDK，结束后随 trap 一起恢复
if [ -f "$PROP_FILE" ]; then
    SDKDIR="$(grep -E '^sdk\.dir *=' "$PROP_FILE" | head -1 | cut -d= -f2- || true)"
    if [ -n "$SDKDIR" ] && [ ! -d "$SDKDIR" ]; then
        PROP_BAK="$PROP_FILE.tb-build-bak"
        cp -f "$PROP_FILE" "$PROP_BAK"
        sed -i -E "s|^sdk\.dir *=.*|sdk.dir=$ANDROID_HOME|" "$PROP_FILE"
        echo "==> local.properties 的 sdk.dir 无效，构建期间临时指向 $ANDROID_HOME"
    fi
fi

if [ "$CLEAN_CACHE" -eq 1 ]; then
    echo "==> 清理 Gradle 项目缓存：android/.gradle 与 android/app/build"
    rm -rf "$ANDROID_DIR/.gradle" "$ANDROID_DIR/app/build"
fi

# ---------- 构建 ----------

cd "$ANDROID_DIR"
chmod +x gradlew

echo "==> [1/3] 编译 Release APK（首次会下载 Gradle 8.13 与依赖）"
./gradlew :app:assembleRelease --console=plain

APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK" ]; then
    echo "错误：构建结束但未找到产物 $APK" >&2
    exit 1
fi

echo "==> [2/3] 校验 Release 签名"
APKSIGNER="$(ls -1 "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -n1)"
"$APKSIGNER" verify --print-certs "$APK"

echo "==> [3/3] 收集产物"
mkdir -p "$OUTPUT_DIR"
TARGET="$OUTPUT_DIR/TerminalBuddy_${NEW_VERSION}_android.apk"
cp -f "$APK" "$TARGET"
HASH="$(sha256sum "$APK" | cut -d' ' -f1)"
printf '%s  %s\n' "$HASH" "$(basename "$TARGET")" > "$TARGET.sha256"
rm -f "$BAK"
if [ -n "$PROP_BAK" ]; then
    rm -f "$PROP_BAK"
fi
ls -lh "$TARGET"
echo "==> 构建完成，已写入版本号 versionName $NEW_VERSION / versionCode $NEW_CODE（记得随代码提交）"
