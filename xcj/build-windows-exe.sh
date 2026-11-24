#!/usr/bin/env bash
# TerminalBuddy Windows exe 一键构建脚本（Linux 本机交叉编译，无需 Docker）
#
# 依赖缺失时自动补齐：rustup / cargo-xwin / Windows SDK 缓存装到用户目录，
# 系统包尝试 sudo 自动安装（无免密 sudo 时会打印需要执行的命令，先执行再重跑）。
#
# 用法：
#   ./xcj/build-windows-exe.sh               产出 Windows 单文件 exe
#   ./xcj/build-windows-exe.sh --clean-cache 清空交叉编译缓存（xwin SDK 与 Windows 目标产物）
#
# 产物：先落到仓库根 dist/，构建成功后自动移动到 /mnt/fnos/code/
#       （TerminalBuddy_<版本>_x64.exe；目标目录不可用时保留在 dist/；不生成 .sha256）
# 说明：只生成单个 exe，不生成 NSIS 安装包；安装包需在 Windows 上执行
#       terminal-buddy/build.bat。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$REPO_ROOT/terminal-buddy"
OUTPUT_DIR="$REPO_ROOT/dist"
DEPLOY_DIR="${DEPLOY_DIR:-/mnt/fnos/code}"
XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$HOME/.cache/terminal-buddy/xwin}"
CLEAN_CACHE=0

usage() {
    cat <<'EOF'
用法：./xcj/build-windows-exe.sh [--clean-cache]

  --clean-cache  清空 xwin SDK 缓存与 Windows 目标构建产物后重新构建
  -h, --help     显示本帮助

环境变量：
  XWIN_CACHE_DIR  Windows SDK 缓存目录，默认 ~/.cache/terminal-buddy/xwin
  DEPLOY_DIR      构建产物移动目标目录，默认 /mnt/fnos/code；设为空字符串时跳过移动
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

if [ ! -f "$WORK_DIR/package.json" ]; then
    echo "错误：未找到 $WORK_DIR/package.json，请在仓库根目录运行本脚本。" >&2
    exit 1
fi

command -v node >/dev/null 2>&1 || { echo "错误：未找到 node，请先安装 Node.js 20+。" >&2; exit 1; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "错误：Node 版本过低（$(node --version)），本项目需要 20+。" >&2
    exit 1
fi

# clang/lld/llvm：cargo-xwin 交叉编译 MSVC 目标所需；cmake/ninja/pkg-config/libssl-dev：
# 部分 C 依赖的构建脚本会用到
need_apt ca-certificates curl git xz-utils build-essential clang lld llvm cmake ninja-build pkg-config libssl-dev

# Rust 工具链（用户级，装到 ~/.cargo，无需 sudo）
if ! command -v cargo >/dev/null 2>&1; then
    echo "==> 安装 Rust 工具链（rustup，用户级 → ~/.cargo）"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
fi
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
echo "==> Rust：$(rustc --version)"

rustup target add x86_64-pc-windows-msvc
rustup component add llvm-tools

if ! command -v cargo-xwin >/dev/null 2>&1; then
    echo "==> 安装 cargo-xwin 0.23.1（需要本地编译，耗时几分钟）"
    cargo install cargo-xwin --version 0.23.1 --locked
fi

# Debian 的 clang 包没有 clang-cl 入口；clang 会按 argv[0] 自动进入 CL 模式，
# 补一个同名软链接供 cargo-xwin 调用（放 ~/.local/bin，无需 sudo）
if ! command -v clang-cl >/dev/null 2>&1; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$(command -v clang)" "$HOME/.local/bin/clang-cl"
fi

export XWIN_CACHE_DIR
export XWIN_ARCH=x86_64
# 前端准备 vscode-terminal 插件资源时按目标平台下载
export TERMINAL_BUDDY_TARGET_PLATFORM=win32

if [ "$CLEAN_CACHE" -eq 1 ]; then
    echo "==> 清理交叉编译缓存：$XWIN_CACHE_DIR 与 src-tauri/target/x86_64-pc-windows-msvc"
    rm -rf "$XWIN_CACHE_DIR" "$WORK_DIR/src-tauri/target/x86_64-pc-windows-msvc"
fi

mkdir -p "$XWIN_CACHE_DIR" "$OUTPUT_DIR"

# ---------- 构建 ----------

cd "$WORK_DIR"

echo "==> [1/4] 安装前端依赖"
npm ci --no-audit --no-fund

echo "==> [2/4] 准备 Windows 终端插件资源"
npm run prepare:vscode-terminal

# Windows SDK 文件名在 Linux 上区分大小写，而 windows crate 以小写以外的
# 写法引用 Restart Manager 库（Rstrtmgr.lib），这里补一个大小写别名。
# 注：XWIN_CACHE_DIR 是 cache root，cargo-xwin 会在其下自建 xwin/ 子目录。
SDK_LIB="$XWIN_CACHE_DIR/xwin/sdk/lib/um/x86_64"
if [ ! -d "$SDK_LIB" ]; then
    echo "    预下载 MSVC CRT 与 Windows SDK（约 1 GB，仅首次）"
    cargo xwin cache xwin
fi
if [ -d "$SDK_LIB" ] && [ ! -e "$SDK_LIB/Rstrtmgr.lib" ]; then
    # find -iname 同时处理大小写差异；-print -quit 避免依赖 ls | grep。
    RESTART_LIB="$(find "$SDK_LIB" -maxdepth 1 -type f -iname 'rstrtmgr.lib' -print -quit)"
    if [ -n "$RESTART_LIB" ]; then
        ln -s "$(basename "$RESTART_LIB")" "$SDK_LIB/Rstrtmgr.lib"
    fi
fi

echo "==> [3/4] 交叉编译 Windows exe"
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle

BUILT="$WORK_DIR/src-tauri/target/x86_64-pc-windows-msvc/release/terminal-buddy.exe"
if [ ! -f "$BUILT" ]; then
    echo "错误：构建结束但未找到产物 $BUILT" >&2
    exit 1
fi

echo "==> [4/4] 收集产物"
VERSION="$(node -p "require('$REPO_ROOT/version.json').version")"
TARGET="$OUTPUT_DIR/TerminalBuddy_${VERSION}_x64.exe"
cp -f "$BUILT" "$TARGET"

# 构建成功后把 exe 移动到 /mnt/fnos/code；
# 目标目录不可用时保留在 dist/，避免构建成果丢失
if [ -z "$DEPLOY_DIR" ]; then
    echo "==> DEPLOY_DIR 为空，跳过移动，产物保留在 $OUTPUT_DIR"
    ls -lh "$TARGET"
elif [ -d "$DEPLOY_DIR" ] || mkdir -p "$DEPLOY_DIR" 2>/dev/null; then
    if mv -f "$TARGET" "$DEPLOY_DIR/"; then
        echo "==> 已移动产物到 $DEPLOY_DIR"
        ls -lh "$DEPLOY_DIR/$(basename "$TARGET")"
    else
        echo "警告：移动到 $DEPLOY_DIR 失败，产物保留在 $OUTPUT_DIR" >&2
        ls -lh "$TARGET"
    fi
else
    echo "警告：目录 $DEPLOY_DIR 不存在且无法创建，产物保留在 $OUTPUT_DIR" >&2
    ls -lh "$TARGET"
fi
echo "==> 构建完成"
