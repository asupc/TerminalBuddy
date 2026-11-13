#!/usr/bin/env bash
# TerminalBuddy Windows exe 构建入口（兼容旧 scripts/ 路径）。
#
# 新实现位于 xcj/build-windows-exe.sh：Linux 本机 cargo-xwin 交叉编译，
# 不再要求 Docker。--clean-cache 原样转发；--rebuild 仅用于兼容旧命令，
# 会提示 Docker 工具链已退役后继续正常构建，不会清空本机缓存。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${TERMINAL_BUDDY_LEGACY_DOCKER_BUILD:-0}" = 1 ]; then
  echo "错误：旧 Docker 构建实现已退役；请使用 xcj/build-windows-exe.sh。" >&2
  exit 2
fi
args=()
for arg in "$@"; do
  case "$arg" in
    --rebuild)
      echo "提示：Docker 工具链已退役，--rebuild 不再重建镜像；本次直接执行本机构建。" >&2 ;;
    --clean-cache) args+=(--clean-cache) ;;
    -h|--help)
      cat <<'HELP'
用法：./scripts/build-windows-exe.sh [--clean-cache] [--rebuild]
兼容旧路径；实际调用 xcj/build-windows-exe.sh。
  --clean-cache  清空 xwin SDK 与 Windows 目标缓存后重新构建
  --rebuild      兼容旧参数：提示 Docker 已退役，本次正常构建
HELP
      exit 0 ;;
    *) echo "错误：未知参数：$arg" >&2; exit 2 ;;
  esac
done
exec bash "$ROOT/xcj/build-windows-exe.sh" ${args[@]+"${args[@]}"}
