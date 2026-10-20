#!/usr/bin/env bash
# TerminalBuddy Windows exe 一键构建脚本（Linux 上通过 Docker 交叉编译）
#
# 源码以只读方式挂载进容器，编译在容器内部完成；宿主机不安装任何工具链。
# 缓存保存在 Docker 命名卷中，宿主机只接收最终产物。
#
# 用法：
#   ./build-windows-exe.sh              首次自动构建工具链镜像，然后产出 exe
#   ./build-windows-exe.sh --rebuild    强制重建工具链镜像
#   ./build-windows-exe.sh --clean-cache 清空构建缓存（cargo / target / xwin / npm）
#
# 产物：dist/TerminalBuddy_<版本>_x64.exe 及同名 .sha256
# 说明：只生成单个 exe，不生成 NSIS 安装包；安装包需在 Windows 上执行
#       terminal-buddy/build.bat。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$REPO_ROOT/terminal-buddy"
DOCKERFILE="$REPO_ROOT/scripts/windows-build/Dockerfile"
IMAGE="${TERMINAL_BUDDY_WIN_IMAGE:-terminal-buddy-windows-builder:latest}"
CACHE_VOLUME="${TERMINAL_BUDDY_WIN_CACHE_VOLUME:-terminal-buddy-win-cache}"
OUTPUT_DIR="$REPO_ROOT/dist"
REBUILD=0
CLEAN_CACHE=0

usage() {
    cat <<'EOF'
用法：./build-windows-exe.sh [--rebuild] [--clean-cache]

  --rebuild      强制重建交叉编译工具链镜像（--no-cache）
  --clean-cache  删除 Docker 命名卷中的构建缓存后重新构建
  -h, --help     显示本帮助

环境变量：
  TERMINAL_BUDDY_WIN_IMAGE        自定义工具链镜像名，默认 terminal-buddy-windows-builder:latest
  TERMINAL_BUDDY_WIN_CACHE_VOLUME 自定义缓存卷名，默认 terminal-buddy-win-cache
EOF
}

for arg in "$@"; do
    case "$arg" in
        --rebuild) REBUILD=1 ;;
        --clean-cache) CLEAN_CACHE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数：$arg" >&2; usage >&2; exit 1 ;;
    esac
done

if ! command -v docker >/dev/null 2>&1; then
    echo "错误：未找到 docker，请先安装并启动 Docker。" >&2
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo "错误：无法连接 Docker 守护进程，请确认当前用户有权限访问 Docker。" >&2
    exit 1
fi
if [ ! -f "$WORK_DIR/package.json" ] || [ ! -f "$DOCKERFILE" ]; then
    echo "错误：项目结构不完整，请在仓库根目录运行本脚本。" >&2
    exit 1
fi

echo "==> [1/3] 准备交叉编译镜像：$IMAGE"
if [ "$REBUILD" -eq 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "    首次构建需要安装 Rust / Node.js / clang / cargo-xwin，耗时较长。"
    if [ "$REBUILD" -eq 1 ]; then
        docker build --no-cache -t "$IMAGE" -f "$DOCKERFILE" "$REPO_ROOT/scripts/windows-build"
    else
        docker build -t "$IMAGE" -f "$DOCKERFILE" "$REPO_ROOT/scripts/windows-build"
    fi
else
    echo "    镜像已存在，跳过构建（需要重建时加 --rebuild）。"
fi

if [ "$CLEAN_CACHE" -eq 1 ]; then
    echo "    清理构建缓存卷：$CACHE_VOLUME"
    docker volume rm "$CACHE_VOLUME" >/dev/null 2>&1 || true
fi
docker volume create "$CACHE_VOLUME" >/dev/null
mkdir -p "$OUTPUT_DIR"

echo "==> [2/3] 在一次性容器中交叉编译（首次会下载 Rust 依赖、MSVC CRT 与 Windows SDK）"
# 容器用完即删；trap 兜底处理 Ctrl+C / 构建失败，避免留下运行中的构建容器
BUILD_CONTAINER="terminal-buddy-win-build-$$"
cleanup() {
    docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1 || true

docker run --rm -i --name "$BUILD_CONTAINER" \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    -e HOME=/cache/home \
    -e CARGO_HOME=/cache/cargo \
    -e CARGO_TARGET_DIR=/cache/target \
    -e RUSTUP_HOME=/usr/local/rustup \
    -e XWIN_CACHE_DIR=/cache/xwin \
    -e XWIN_ARCH=x86_64 \
    -e TERMINAL_BUDDY_TARGET_PLATFORM=win32 \
    -v "$REPO_ROOT:/src:ro" \
    -v "$CACHE_VOLUME:/cache" \
    -v "$OUTPUT_DIR:/out" \
    "$IMAGE" bash -s <<'CONTAINER_SCRIPT'
set -euo pipefail

echo "    [1/5] 复制源码到容器内工作目录"
rm -rf /build/terminal-buddy
mkdir -p /build
(
    cd /src
    tar -cf - \
        --exclude='terminal-buddy/node_modules' \
        --exclude='terminal-buddy/web/node_modules' \
        --exclude='terminal-buddy/src-tauri/target' \
        --exclude='terminal-buddy/.winbuild-cache' \
        --exclude='terminal-buddy/release' \
        --exclude='terminal-buddy/dist' \
        --exclude='terminal-buddy/dist-web' \
        --exclude='terminal-buddy/web/dist' \
        --exclude='terminal-buddy/src-tauri/resources/vscode-terminal' \
        --exclude='terminal-buddy/server-data' \
        --exclude='.git' \
        --exclude='.codegraph' \
        terminal-buddy
) | tar -xf - -C /build --no-same-permissions --no-same-owner
# NAS 挂载上的文件权限呈现为 000，tar 会把 0 带进容器，这里统一改成可读写
chmod -R u+rwX,go+rX /build/terminal-buddy
cat /src/version.json > /build/version.json

cd /build/terminal-buddy

# gosu 在 UID 没有对应 passwd 记录时会把 HOME 重置为 /，这里显式指回缓存卷
export HOME=/cache/home
export npm_config_cache="$HOME/.npm"

echo "    [2/5] 安装前端依赖"
npm ci --no-audit --no-fund
(cd web && npm ci --no-audit --no-fund)

echo "    [3/5] 准备 Windows 终端插件资源"
npm run prepare:vscode-terminal

# Windows SDK 文件名在 Linux 上区分大小写，而 windows crate 以小写以外的
# 写法引用 Restart Manager 库（Rstrtmgr.lib），这里补一个大小写别名。
SDK_LIB=/cache/xwin/xwin/sdk/lib/um/x86_64
if [ ! -d "$SDK_LIB" ]; then
    echo "    预下载 MSVC CRT 与 Windows SDK"
    cargo xwin cache xwin
fi
if [ ! -e "$SDK_LIB/Rstrtmgr.lib" ]; then
    RESTART_LIB="$(ls "$SDK_LIB" | grep -ix 'rstrtmgr\.lib' | head -n1 || true)"
    if [ -n "$RESTART_LIB" ]; then
        ln -s "$RESTART_LIB" "$SDK_LIB/Rstrtmgr.lib"
    fi
fi

echo "    [4/5] 交叉编译 Windows exe"
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle

BUILT="${CARGO_TARGET_DIR}/x86_64-pc-windows-msvc/release/terminal-buddy.exe"
if [ ! -f "$BUILT" ]; then
    echo "错误：构建结束但未找到产物 $BUILT" >&2
    exit 1
fi

echo "    [5/5] 收集产物"
VERSION="$(node -p "require('/build/version.json').version")"
TARGET="/out/TerminalBuddy_${VERSION}_x64.exe"
cp -f "$BUILT" "$TARGET"
HASH="$(sha256sum "$BUILT" | cut -d' ' -f1)"
printf '%s  %s\n' "$HASH" "$(basename "$TARGET")" > "/out/$(basename "$TARGET").sha256"
ls -lh "$TARGET"
CONTAINER_SCRIPT

echo "==> [3/3] 构建完成"
ls -lh "$OUTPUT_DIR"/*.exe "$OUTPUT_DIR"/*.sha256 2>/dev/null | tail -n 2 || true
