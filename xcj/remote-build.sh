#!/usr/bin/env bash
# Terminal Buddy 远程构建脚本：把 NAS 上的源码同步到构建主机（debian99），
# 在构建主机上直接使用本机工具链构建，产物自动回传到本仓库 dist/ 目录。
#
# 重负载（交叉编译、SDK 下载、增量编译）全部落在构建主机上：
#   - NAS 不执行 Docker build/run，也不承载 Rust / Node / Gradle 编译负载；
#   - Windows 复用 cargo-xwin 与 ~/.cache/terminal-buddy/xwin；
#     Android 复用 JDK、~/.android-sdk 与 Gradle 用户缓存；
#   - 源码同步用 tar-over-ssh（NAS 宿主无 rsync），排除大目录后仅几 MB。
#
# 依赖：
#   - ~/.ssh/config 中的 debian99 别名（IdentityFile 指向部署密钥）
#   - 构建主机安装本机工具链；xcj/build-*.sh 会按需补齐（详见
#     xcj/README-remote-build.md）
#
# 用法：
#   ./xcj/remote-build.sh win              远程构建 Windows 单文件 exe
#   ./xcj/remote-build.sh android          远程构建 Android Release APK
#   ./xcj/remote-build.sh win --clean-cache  其余参数透传给远端构建脚本
#   ./xcj/remote-build.sh sync             只同步源码，不构建
#
# 环境变量：
#   TERMINAL_BUDDY_REMOTE_HOST  远程主机 SSH 别名，默认 debian99
#   TERMINAL_BUDDY_REMOTE_DIR   远程源码目录，默认 ~/tb-build

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${TERMINAL_BUDDY_REMOTE_HOST:-debian99}"
REMOTE_DIR="${TERMINAL_BUDDY_REMOTE_DIR:-~/tb-build}"

usage() {
    cat <<'EOF'
用法：./xcj/remote-build.sh <win|android|sync> [透传参数]

  win        远程构建 Windows 单文件 exe（产物回传 dist/）
  android    远程构建 Android Release APK（产物回传 dist/）
  sync       只同步源码到构建主机，不构建
  -h, --help 显示本帮助

示例：
  ./xcj/remote-build.sh win
  ./xcj/remote-build.sh win --clean-cache
  ./xcj/remote-build.sh android

环境变量：
  TERMINAL_BUDDY_REMOTE_HOST  远程主机 SSH 别名，默认 debian99
EOF
}

# ---------- 参数解析 ----------

TARGET="${1:-}"
[ $# -gt 0 ] && shift || true
case "$TARGET" in
    win|android|sync) ;;
    -h|--help|"") usage; [ -n "$TARGET" ] && exit 0 || exit 1 ;;
    *) echo "未知目标：$TARGET" >&2; usage >&2; exit 1 ;;
esac
if [ "$TARGET" = "win" ] || [ "$TARGET" = "android" ]; then
    if [ "${1:-}" = "--rebuild" ]; then
        echo "提示：Docker 工具链已退役，--rebuild 不再重建镜像；本次直接执行本机构建。" >&2
        shift
    fi
fi

if [ ! -f "$REPO_ROOT/terminal-buddy/package.json" ]; then
    echo "错误：项目结构不完整，请在仓库根目录运行本脚本。" >&2
    exit 1
fi
# 远程命令统一通过 $REMOTE_HOST 别名执行；先做一次连通性检查，给出可操作的报错
ssh_remote() {
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE_HOST" "$@"
}
if ! ssh_remote 'true' 2>/dev/null; then
    echo "错误：无法免密 SSH 到 $REMOTE_HOST。" >&2
    echo "请确认 ~/.ssh/config 存在该别名且 IdentityFile 指向有效密钥。" >&2
    exit 1
fi

# ---------- [1/3] 同步源码（tar-over-ssh，全量覆盖远程目录） ----------

echo "==> [1/3] 同步源码到 $REMOTE_HOST:$REMOTE_DIR"
ssh_remote "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
# 排除表与 xcj/build-windows-exe.sh 保持一致（大目录与退役目录不上传）
tar -C "$REPO_ROOT" -cf - \
    --exclude='terminal-buddy/node_modules' \
    --exclude='terminal-buddy/web' \
    --exclude='terminal-buddy/src-tauri/target' \
    --exclude='terminal-buddy/.winbuild-cache' \
    --exclude='terminal-buddy/release' \
    --exclude='terminal-buddy/dist' \
    --exclude='terminal-buddy/dist-web' \
    --exclude='terminal-buddy/src-tauri/resources/vscode-terminal' \
    --exclude='terminal-buddy/server-data' \
    --exclude='.git' \
    --exclude='.codegraph' \
    --exclude='.claude' \
    --exclude='dist' \
    . | ssh_remote "tar -xf - -C $REMOTE_DIR --no-same-permissions --no-same-owner"
# NAS 挂载上的文件权限呈现为 000，tar 会把 0 带过去，统一改成可读写
ssh_remote "chmod -R u+rwX,go+rX $REMOTE_DIR"
echo "    同步完成"

if [ "$TARGET" = "sync" ]; then
    echo "==> 完成（仅同步）"
    exit 0
fi

# ---------- [2/3] 远程构建 ----------

case "$TARGET" in
    win)     BUILD_SCRIPT="xcj/build-windows-exe.sh" ;;
    android) BUILD_SCRIPT="xcj/build-android.sh" ;;
esac

echo "==> [2/3] 在 $REMOTE_HOST 上执行 $BUILD_SCRIPT（复用构建主机本机缓存）"
# DEPLOY_DIR 置空：远端构建产物必须留在远端 dist/ 供下一阶段回传，
# 不要在构建主机上执行「移动到 /mnt/fnos/code」的归档步骤
ssh_remote "cd $REMOTE_DIR && DEPLOY_DIR= bash $BUILD_SCRIPT $*"

# ---------- [3/3] 回传产物 ----------

echo "==> [3/3] 回传产物到 $REPO_ROOT/dist/"
mkdir -p "$REPO_ROOT/dist"
ssh_remote "tar -C $REMOTE_DIR -cf - dist" | tar -C "$REPO_ROOT" -xf -
ls -lh "$REPO_ROOT"/dist/* 2>/dev/null | tail -n 8 || true
echo "==> 远程构建完成"
