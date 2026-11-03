#!/usr/bin/env bash
# TerminalBuddy Android APK 一键构建脚本(Linux 上通过 Docker 容器构建)
#
# 源码以只读方式挂载进容器,编译在容器内部完成;宿主机不安装任何工具链。
# Gradle 缓存保存在 Docker 命名卷中,宿主机只接收最终产物。
#
# 用法:
#   ./scripts/build-android.sh               首次自动构建工具链镜像,然后产出 Release APK
#   ./scripts/build-android.sh --rebuild     强制重建工具链镜像
#   ./scripts/build-android.sh --clean-cache 清空 Gradle 构建缓存
#
# 产物:dist/TerminalBuddy_<版本>_android.apk 及同名 .sha256(仓库内
# release.keystore 自动完成 Release 签名,并在容器内用 apksigner 校验)。
# Windows 上带 adb 直装的版本见 scripts/build-android.bat 与 scripts/build-android.ps1。
#
# 每次构建自动把版本号自增一:versionName 末段 +1(如 1.0.0 → 1.0.1)、
# versionCode 同步 +1,构建成功后回写 android/app/build.gradle.kts(记得随
# 代码提交);构建失败则不回写,不消耗版本号。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$REPO_ROOT/scripts/android-build/Dockerfile"
IMAGE="${TERMINAL_BUDDY_ANDROID_IMAGE:-terminal-buddy-android-builder:latest}"
CACHE_VOLUME="${TERMINAL_BUDDY_ANDROID_CACHE_VOLUME:-terminal-buddy-android-cache}"
OUTPUT_DIR="$REPO_ROOT/dist"
REBUILD=0
CLEAN_CACHE=0

usage() {
    cat <<'EOF'
用法:./scripts/build-android.sh [--rebuild] [--clean-cache]

  --rebuild      强制重建构建工具链镜像(--no-cache)
  --clean-cache  删除 Docker 命名卷中的 Gradle 缓存后重新构建
  -h, --help     显示本帮助

说明:每次构建自动 versionName 末段 +1 / versionCode +1,
      构建成功后回写 android/app/build.gradle.kts。

环境变量:
  TERMINAL_BUDDY_ANDROID_IMAGE         自定义工具链镜像名,默认 terminal-buddy-android-builder:latest
  TERMINAL_BUDDY_ANDROID_CACHE_VOLUME  自定义缓存卷名,默认 terminal-buddy-android-cache
EOF
}

for arg in "$@"; do
    case "$arg" in
        --rebuild) REBUILD=1 ;;
        --clean-cache) CLEAN_CACHE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数:$arg" >&2; usage >&2; exit 1 ;;
    esac
done

if ! command -v docker >/dev/null 2>&1; then
    echo "错误:未找到 docker,请先安装并启动 Docker。" >&2
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo "错误:无法连接 Docker 守护进程,请确认当前用户有权限访问 Docker。" >&2
    exit 1
fi
if [ ! -f "$REPO_ROOT/android/build.gradle.kts" ] || [ ! -f "$DOCKERFILE" ]; then
    echo "错误:项目结构不完整,请在仓库根目录运行本脚本。" >&2
    exit 1
fi

# 版本号自增:versionName 末段 +1、versionCode +1;新版本注入容器内副本构建,
# 成功后才回写仓库文件,失败不消耗版本号
GRADLE_FILE="$REPO_ROOT/android/app/build.gradle.kts"
CURRENT_VERSION="$(grep -m1 -oE 'versionName *= *"[^"]+"' "$GRADLE_FILE" | sed -E 's/.*"([^"]+)"/\1/')"
CURRENT_CODE="$(grep -m1 -oE 'versionCode *= *[0-9]+' "$GRADLE_FILE" | grep -oE '[0-9]+$')"
if ! [[ "$CURRENT_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "错误:versionName 不是三段式数字版本号(当前:$CURRENT_VERSION),无法自动自增。" >&2
    exit 1
fi
if [ -z "$CURRENT_CODE" ]; then
    echo "错误:未能从 $GRADLE_FILE 解析出 versionCode。" >&2
    exit 1
fi
NEW_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
NEW_CODE="$((CURRENT_CODE + 1))"
echo "==> 版本号自增:versionName $CURRENT_VERSION → $NEW_VERSION,versionCode $CURRENT_CODE → $NEW_CODE"

echo "==> [1/3] 准备构建镜像:$IMAGE"
if [ "$REBUILD" -eq 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "    首次构建需要下载 Android SDK(约 1-2 GB),耗时较长。"
    if [ "$REBUILD" -eq 1 ]; then
        docker build --no-cache -t "$IMAGE" -f "$DOCKERFILE" "$REPO_ROOT/scripts/android-build"
    else
        docker build -t "$IMAGE" -f "$DOCKERFILE" "$REPO_ROOT/scripts/android-build"
    fi
else
    echo "    镜像已存在,跳过构建(需要重建时加 --rebuild)。"
fi

if [ "$CLEAN_CACHE" -eq 1 ]; then
    echo "    清理构建缓存卷:$CACHE_VOLUME"
    docker volume rm "$CACHE_VOLUME" >/dev/null 2>&1 || true
fi
docker volume create "$CACHE_VOLUME" >/dev/null
mkdir -p "$OUTPUT_DIR"

echo "==> [2/3] 在一次性容器中构建 Release APK(首次会下载 Gradle 8.13 与依赖)"
# 容器用完即删;trap 兜底处理 Ctrl+C / 构建失败,避免留下运行中的构建容器
BUILD_CONTAINER="terminal-buddy-android-build-$$"
cleanup() {
    docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1 || true

docker run --rm -i --name "$BUILD_CONTAINER" \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    -e NEW_VERSION="$NEW_VERSION" \
    -e NEW_CODE="$NEW_CODE" \
    -e HOME=/cache/home \
    -e GRADLE_USER_HOME=/cache/gradle \
    -v "$REPO_ROOT:/src:ro" \
    -v "$CACHE_VOLUME:/cache" \
    -v "$OUTPUT_DIR:/out" \
    "$IMAGE" bash -s <<'CONTAINER_SCRIPT'
set -euo pipefail

echo "    [1/5] 复制源码到容器内工作目录"
rm -rf /build/android
mkdir -p /build
(
    cd /src
    tar -cf - \
        --exclude='android/app/build' \
        --exclude='android/.gradle' \
        --exclude='android/local.properties' \
        android
) | tar -xf - -C /build --no-same-permissions --no-same-owner
# NAS 挂载上的文件权限呈现为 000,tar 会把 0 带进容器,这里统一改成可读写
chmod -R u+rwX,go+rX /build/android
chmod +x /build/android/gradlew

cd /build/android

echo "    [2/5] 注入自增版本号(versionName $NEW_VERSION / versionCode $NEW_CODE)"
sed -i -E "s/versionName *= *\"[^\"]+\"/versionName = \"$NEW_VERSION\"/" app/build.gradle.kts
sed -i -E "s/versionCode *= *[0-9]+/versionCode = $NEW_CODE/" app/build.gradle.kts

echo "    [3/5] 编译 Release APK"
./gradlew :app:assembleRelease --console=plain

APK="app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK" ]; then
    echo "错误:构建结束但未找到产物 $APK" >&2
    exit 1
fi

echo "    [4/5] 校验 Release 签名"
APKSIGNER="$(ls -1 "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -n1)"
"$APKSIGNER" verify --print-certs "$APK"

echo "    [5/5] 收集产物"
TARGET="/out/TerminalBuddy_${NEW_VERSION}_android.apk"
cp -f "$APK" "$TARGET"
HASH="$(sha256sum "$APK" | cut -d' ' -f1)"
printf '%s  %s\n' "$HASH" "$(basename "$TARGET")" > "/out/$(basename "$TARGET").sha256"
ls -lh "$TARGET"
CONTAINER_SCRIPT

# 构建成功,把自增后的版本号回写进仓库,下次构建在此基础上继续自增
sed -i -E "s/versionName *= *\"[^\"]+\"/versionName = \"$NEW_VERSION\"/" "$GRADLE_FILE"
sed -i -E "s/versionCode *= *[0-9]+/versionCode = $NEW_CODE/" "$GRADLE_FILE"

echo "==> [3/3] 构建完成,已回写版本号 versionName $NEW_VERSION / versionCode $NEW_CODE(记得随代码提交)"
ls -lh "$OUTPUT_DIR"/*_android.apk "$OUTPUT_DIR"/*_android.apk.sha256 2>/dev/null | tail -n 2 || true
