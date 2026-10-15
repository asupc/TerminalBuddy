#!/usr/bin/env bash
# TerminalBuddy 远端部署包装脚本（由 deploy.bat 上传后调用）
# 参数全部来自环境变量，避免 Windows 批处理里的引号嵌套问题。
set -euo pipefail

REMOTE_DIR="${TB_REMOTE_DIR:?缺 TB_REMOTE_DIR}"
SRC_TARBALL="${TB_TARBALL:-/tmp/terminal-buddy-src.tar.gz}"

log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 1. 解压源码 ----------
log "解压源码到 ${REMOTE_DIR}"
rm -rf "${REMOTE_DIR}"
mkdir -p "${REMOTE_DIR}"
tar -xzf "${SRC_TARBALL}" -C "${REMOTE_DIR}"
rm -f "${SRC_TARBALL}"

# Windows 打包带来的 CRLF 会破坏 shell 脚本，统一转成 LF
find "${REMOTE_DIR}" -type f \( -name '*.sh' -o -name 'Dockerfile*' -o -name '*.yml' -o -name '*.yaml' \) \
  -exec sed -i 's/\r$//' {} +
chmod +x "${REMOTE_DIR}/deploy-centos.sh" 2>/dev/null || true

log "解压完成：$(find "${REMOTE_DIR}" -type f | wc -l) 个文件"

# ---------- 2. 调用项目内一键部署脚本 ----------
cd "${REMOTE_DIR}"
if [ "${TB_SKIP_BUILD:-0}" = "1" ]; then
  log "执行 deploy-centos.sh --no-build"
  exec ./deploy-centos.sh --no-build
else
  log "执行 deploy-centos.sh"
  exec ./deploy-centos.sh
fi