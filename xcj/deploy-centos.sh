#!/usr/bin/env bash
# TerminalBuddy 一键部署到 CentOS 服务器
#
# 本脚本是「发起端」，可以在任意装了 ssh / scp / tar / curl 的 Linux 机器上执行，
# 把本机工作区的源码推到 CentOS 目标机，在目标机上构建镜像并重建容器。
# 本机不需要安装 docker / Node.js / Rust。
#
# 默认流程：
#   1. 拉取本机最新代码（git pull --ff-only，可用 --no-pull 跳过）
#   2. 打包本机源码（约 16MB，排除 .git / node_modules / target / 构建产物）
#   3. scp 源码包与 scripts/deploy-centos-remote.sh 上传到目标机 /tmp
#   4. 目标机解压 → 生成 compose.centos.yaml → 构建镜像 → 重建容器 → 健康检查
#   5. 本机做 HTTP 自检并打印访问信息
#
# 用法：
#   ./xcj/deploy-centos.sh                    # 全流程（在目标机上构建镜像）
#   ./xcj/deploy-centos.sh --no-build         # 跳过构建，用目标机现有镜像重建容器
#   ./xcj/deploy-centos.sh --no-pull          # 不拉取本机代码，直接用当前工作区
#   ./xcj/deploy-centos.sh --build-local      # 改在本机构建镜像后上传（需本机 docker 且同架构）
#   ./xcj/deploy-centos.sh --host 192.168.3.202 --ssh-port 22
#
# 免密登录：首次运行会生成部署密钥并自动装到目标机（需要一次密码认证），之后全程免密。
# 密码来源（按优先级）：
#   1. 环境变量 TB_CENTOS_PASSWORD
#   2. 凭据文件（--config，默认 ~/.codex/private/centos-server/config.json，需含 host/username/password）
#   3. 已有的 esxi-server 密码文件 ~/.claude/skills/esxi-server/.pass
#   4. 交互式输入（隐藏回显）
# 密码只交给 ssh 的 SSH_ASKPASS，不写入命令行参数或日志。

set -euo pipefail

# ==================== 可覆盖配置 ====================
CENTOS_HOST="${TB_CENTOS_HOST:-192.168.3.202}"
CENTOS_USER="${TB_CENTOS_USER:-root}"
CENTOS_PORT="${TB_CENTOS_SSH_PORT:-22}"
APP_DIR="${TB_CENTOS_APP_DIR:-/root/terminal-buddy}"
HOST_PORT="${TB_CENTOS_PORT:-9610}"
BIND_ADDRESS="${TB_CENTOS_BIND_ADDRESS:-0.0.0.0}"
CONTAINER="${TB_CENTOS_CONTAINER:-terminal-buddy}"
IMAGE="${TB_CENTOS_IMAGE:-terminal-buddy:server}"
USERNAME="${TB_CENTOS_USERNAME:-admin}"
DOCKER_SOCKET="${TB_CENTOS_DOCKER_SOCKET:-/var/run/docker.sock}"
CONFIG_FILE="${TB_CENTOS_CONFIG:-$HOME/.codex/private/centos-server/config.json}"
SSH_KEY="${TB_CENTOS_SSH_KEY:-$HOME/.ssh/terminal_buddy_centos_deploy}"
PULL_LATEST="${TB_CENTOS_PULL:-1}"
# =====================================================

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="${APP_DIR}/src"
DATA_DIR="${APP_DIR}/data"
HOME_DIR="${APP_DIR}/home"
WORKSPACE_DIR="${APP_DIR}/workspace"

SRC_TARBALL="/tmp/terminal-buddy-src.tar.gz"
IMAGE_TARBALL="/tmp/terminal-buddy-image.tar.gz"
REMOTE_SH="/tmp/terminal-buddy-centos-deploy.sh"
KNOWN_HOSTS="/tmp/terminal_buddy_centos_known_hosts"
ASKPASS_HELPER=""
STAGE_DIR=""

log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\033[33m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*" >&2; }
fail() { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  # 密码辅助脚本与镜像暂存目录不入库、不残留。
  [ -n "${ASKPASS_HELPER}" ] && rm -f "${ASKPASS_HELPER}" 2>/dev/null || true
  [ -n "${STAGE_DIR}" ] && rm -rf "${STAGE_DIR}" 2>/dev/null || true
  return 0
}
trap cleanup EXIT

DO_BUILD=1
BUILD_LOCAL=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build)     DO_BUILD=0 ;;
    --no-pull)      PULL_LATEST=0 ;;
    --pull)         PULL_LATEST=1 ;;
    --build-local)  BUILD_LOCAL=1 ;;
    --host)         CENTOS_HOST="${2:?--host 需要一个地址}"; shift ;;
    --ssh-port)     CENTOS_PORT="${2:?--ssh-port 需要一个端口}"; shift ;;
    --app-dir)      APP_DIR="${2:?--app-dir 需要一个路径}"; shift ;;
    --config)       CONFIG_FILE="${2:?--config 需要一个文件路径}"; shift ;;
    -h|--help)      sed -n '2,28p' "$0"; exit 0 ;;
    *) fail "未知参数：$1（可用：--no-build / --no-pull / --build-local / --host / --ssh-port / --app-dir / --config / --help）" ;;
  esac
  shift
done

# --app-dir 会改变派生路径，解析完参数后统一重算。
SRC_DIR="${APP_DIR}/src"
DATA_DIR="${APP_DIR}/data"
HOME_DIR="${APP_DIR}/home"
WORKSPACE_DIR="${APP_DIR}/workspace"

# ---------- 0. 本机依赖检查 ----------
# 默认在目标机上构建，本机只负责打包与上传，因此不要求本机装 docker。
if [ "${BUILD_LOCAL}" = "1" ]; then
  command -v docker >/dev/null 2>&1 || fail "--build-local 需要本机 docker，但未检测到；去掉该参数即在目标机上构建"
fi
command -v ssh  >/dev/null 2>&1 || fail "未检测到 ssh"
command -v scp  >/dev/null 2>&1 || fail "未检测到 scp"
command -v tar  >/dev/null 2>&1 || fail "未检测到 tar"
command -v curl >/dev/null 2>&1 || fail "未检测到 curl"
command -v ssh-keygen >/dev/null 2>&1 || fail "未检测到 ssh-keygen（openssh-client）"
[ -f "${REPO_DIR}/Dockerfile" ] || fail "缺少 ${REPO_DIR}/Dockerfile，请在项目根目录执行本脚本"
[ -f "${REPO_DIR}/scripts/deploy-centos-remote.sh" ] || fail "缺少 scripts/deploy-centos-remote.sh，源码不完整"
[ -d "${REPO_DIR}/terminal-buddy/src-tauri" ] || fail "缺少 terminal-buddy/src-tauri，源码不完整"

# ---------- 1. 拉取本机最新代码 ----------
if [ "${PULL_LATEST}" = "1" ]; then
  if [ -d "${REPO_DIR}/.git" ]; then
    log "拉取本机最新代码：git pull --ff-only"
    if ! git -C "${REPO_DIR}" pull --ff-only; then
      fail "拉取失败（本机可能有未提交改动与远端冲突）。处理后再试，或用 --no-pull 直接用当前工作区。"
    fi
  else
    warn "${REPO_DIR} 不是 git 仓库，跳过拉取"
  fi
else
  log "已跳过代码拉取（--no-pull）"
fi

# ---------- 2. 免密登录：需要时安装公钥 ----------
ssh_probe() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile="${KNOWN_HOSTS}" -o ConnectTimeout=8 \
      -p "${CENTOS_PORT}" "${CENTOS_USER}@${CENTOS_HOST}" 'echo ok' >/dev/null 2>&1
}

read_password() {
  if [ -n "${TB_CENTOS_PASSWORD:-}" ]; then
    printf '%s' "${TB_CENTOS_PASSWORD}"; return 0
  fi
  # 凭据文件是扁平的 {"host":..,"username":..,"password":..}，不依赖 jq。
  if [ -f "${CONFIG_FILE}" ]; then
    local pw host user
    pw="$(sed -n 's/.*"password"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${CONFIG_FILE}" | head -n 1)"
    host="$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${CONFIG_FILE}" | head -n 1)"
    user="$(sed -n 's/.*"\(username\|user\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' "${CONFIG_FILE}" | head -n 1)"
    if [ -n "${pw}" ] && { [ -z "${host}" ] || [ "${host}" = "${CENTOS_HOST}" ]; } \
       && { [ -z "${user}" ] || [ "${user}" = "${CENTOS_USER}" ]; }; then
      printf '%s' "${pw}"; return 0
    fi
  fi
  # 复用 esxi-server skill 已保存的密码（纯文本单行）
  local pass_file="$HOME/.claude/skills/esxi-server/.pass"
  if [ -f "${pass_file}" ]; then
    local pw
    pw="$(head -n 1 "${pass_file}" | tr -d '\r\n')"
    [ -n "${pw}" ] && { printf '%s' "${pw}"; return 0; }
  fi
  local pw
  read -r -s -p "请输入 ${CENTOS_USER}@${CENTOS_HOST} 的 SSH 密码（仅本次使用，不保存）：" pw </dev/tty
  echo >/dev/tty
  printf '%s' "${pw}"
}

install_public_key() {
  local password pubkey
  password="$(read_password)"
  [ -n "${password}" ] || fail "未取得 SSH 密码，无法安装公钥"

  if [ ! -f "${SSH_KEY}" ]; then
    log "生成本机部署密钥 ${SSH_KEY}"
    mkdir -p "$(dirname "${SSH_KEY}")"
    ssh-keygen -t ed25519 -N '' -C terminal-buddy-centos-deploy -f "${SSH_KEY}" >/dev/null
    chmod 600 "${SSH_KEY}"
  fi
  pubkey="$(cat "${SSH_KEY}.pub")"

  # ssh 不会从非终端读取密码，用 SSH_ASKPASS 交给它。辅助脚本只在部署期间存在。
  ASKPASS_HELPER="$(mktemp /tmp/tb-centos-askpass.XXXXXX)"
  printf '#!/bin/sh\nprintf "%%s\\n" %q\n' "${password}" > "${ASKPASS_HELPER}"
  chmod 700 "${ASKPASS_HELPER}"

  log "安装公钥到 ${CENTOS_USER}@${CENTOS_HOST} 的 ~/.ssh/authorized_keys（需要认证一次）"
  local quoted
  printf -v quoted '%q' "${pubkey}"
  if ! SSH_ASKPASS="${ASKPASS_HELPER}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
       ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile="${KNOWN_HOSTS}" \
           -o ConnectTimeout=15 -o PreferredAuthentications=password -o PubkeyAuthentication=no \
           -o NumberOfPasswordPrompts=1 -p "${CENTOS_PORT}" "${CENTOS_USER}@${CENTOS_HOST}" \
           "umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; grep -qF -- ${quoted} ~/.ssh/authorized_keys || printf '%s\n' ${quoted} >> ~/.ssh/authorized_keys" \
       >/dev/null 2>&1; then
    rm -f "${ASKPASS_HELPER}"; ASKPASS_HELPER=""
    fail "安装公钥失败：请确认 ${CENTOS_USER}@${CENTOS_HOST} 的密码正确、且该账号允许密码登录
       （CentOS 若禁止 root 登录，可用 --host/--ssh-port 之外的 TB_CENTOS_USER 换普通账号）"
  fi
  rm -f "${ASKPASS_HELPER}"; ASKPASS_HELPER=""
  ssh_probe || fail "公钥安装后仍无法免密登录，请检查目标机 ~/.ssh 权限与 sshd 的 PubkeyAuthentication"
  log "  ✓ 免密登录已就绪"
}

if [ ! -f "${SSH_KEY}" ] || ! ssh_probe; then
  install_public_key
else
  log "免密认证通过（${CENTOS_USER}@${CENTOS_HOST}）"
fi

# ---------- 3. 可选：本机构建镜像 ----------
if [ "${DO_BUILD}" = "0" ]; then
  log "跳过构建，复用目标机上的现有镜像 ${IMAGE}"
elif [ "${BUILD_LOCAL}" = "1" ]; then
  log "本机构建镜像 ${IMAGE}（复用 Docker 层缓存，源码未变时几乎瞬时完成）"
  BEFORE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null || true)"
  if ! docker build -f "${REPO_DIR}/Dockerfile" -t "${IMAGE}" "${REPO_DIR}" 2>&1 | tail -n 15; then
    fail "本机构建失败。可去掉 --build-local 改为在目标机上构建，或用 --no-build 复用现有镜像"
  fi
  AFTER_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
  if [ -n "${BEFORE_ID}" ] && [ "${BEFORE_ID}" = "${AFTER_ID}" ]; then
    log "  镜像未变化（全部命中缓存）：${AFTER_ID:7:12}"
  else
    log "  镜像已更新：${AFTER_ID:7:12}"
  fi
else
  log "跳过本机构建：镜像将在目标机上编译（首次约 5-10 分钟，之后按源码指纹跳过）"
fi

# ---------- 4. 打包源码 ----------
log "打包源码（排除 .git / node_modules / target / 构建产物）"
rm -f "${SRC_TARBALL}"
tar -czf "${SRC_TARBALL}" \
  --exclude='./.git' --exclude='./.codegraph' --exclude='./.claude' \
  --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='./target' --exclude='*/target' \
  --exclude='./dist' --exclude='*/dist' --exclude='./dist-web' --exclude='*/dist-web' \
  --exclude='./terminal-buddy/web' \
  --exclude='./server-data' --exclude='*/server-data' \
  --exclude='./workspace' --exclude='./docs' --exclude='./design' \
  --exclude='./terminal-buddy/src-tauri/resources' \
  --exclude='./terminal-buddy/plugins' \
  -C "${REPO_DIR}" .
log "  源码包：$(du -h "${SRC_TARBALL}" | cut -f1)"

# ---------- 5. 可选：导出镜像 ----------
UPLOAD_IMAGE=0
if [ "${BUILD_LOCAL}" = "1" ] && [ "${DO_BUILD}" = "1" ]; then
  LOCAL_IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
  REMOTE_IMAGE_ID="$(ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o UserKnownHostsFile="${KNOWN_HOSTS}" \
      -o LogLevel=ERROR -p "${CENTOS_PORT}" "${CENTOS_USER}@${CENTOS_HOST}" \
      "docker image inspect '${IMAGE}' --format '{{.Id}}' 2>/dev/null || true")"
  if [ -n "${REMOTE_IMAGE_ID}" ] && [ "${REMOTE_IMAGE_ID}" = "${LOCAL_IMAGE_ID}" ]; then
    log "目标机上已有相同镜像（${LOCAL_IMAGE_ID:7:12}），跳过导出与上传（约省 158MB 传输）"
  else
    UPLOAD_IMAGE=1
    STAGE_DIR="$(mktemp -d /tmp/tb-centos-image.XXXXXX)"
    log "导出镜像（docker save | gzip，约 1 分钟）"
    docker save "${IMAGE}" | gzip -1 > "${STAGE_DIR}/image.tar.gz"
    IMAGE_TARBALL="${STAGE_DIR}/image.tar.gz"
    log "  镜像包：$(du -h "${IMAGE_TARBALL}" | cut -f1)"
  fi
fi

# ---------- 6. 上传到目标机 ----------
SCP_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=no -o UserKnownHostsFile="${KNOWN_HOSTS}"
          -o LogLevel=ERROR -P "${CENTOS_PORT}")

log "上传源码包与远端脚本到 ${CENTOS_HOST}:/tmp"
scp "${SCP_OPTS[@]}" "${SRC_TARBALL}" "${CENTOS_USER}@${CENTOS_HOST}:/tmp/terminal-buddy-src.tar.gz" \
  || fail "上传失败，请检查网络与目标机磁盘空间"
scp "${SCP_OPTS[@]}" "${REPO_DIR}/scripts/deploy-centos-remote.sh" \
  "${CENTOS_USER}@${CENTOS_HOST}:${REMOTE_SH}" || fail "上传远端脚本失败"

if [ "${UPLOAD_IMAGE}" = "1" ]; then
  log "上传镜像包（$(du -h "${IMAGE_TARBALL}" | cut -f1)）"
  scp "${SCP_OPTS[@]}" "${IMAGE_TARBALL}" "${CENTOS_USER}@${CENTOS_HOST}:/tmp/terminal-buddy-image.tar.gz" \
    || fail "镜像上传失败，请检查网络与目标机磁盘空间"
fi

# ---------- 7. 目标机执行 ----------
REMOTE_ARGS="${APP_DIR} ${DATA_DIR} ${HOME_DIR} ${WORKSPACE_DIR} ${HOST_PORT} ${BIND_ADDRESS} ${CONTAINER} ${IMAGE} ${USERNAME} ${DOCKER_SOCKET}"

# 目标机是否跳过构建：
#   --no-build     -> 跳过，直接用目标机现有镜像
#   --build-local  -> 本机已构建并上传镜像包，目标机只需载入
#   默认           -> 目标机需要编译
if [ "${DO_BUILD}" = "0" ] || [ "${BUILD_LOCAL}" = "1" ]; then
  REMOTE_SKIP_BUILD=1
else
  REMOTE_SKIP_BUILD=0
fi

# 目标机可复用现有镜像的条件：本次确实上传/确认了镜像。
if [ "${BUILD_LOCAL}" = "1" ] && [ "${DO_BUILD}" = "1" ]; then
  REMOTE_IMAGE_CURRENT=1
else
  REMOTE_IMAGE_CURRENT=0
fi

# 远端脚本按「镜像包文件是否存在」决定是否 docker load，因此这里必须显式给出路径：
# 只有本次真的上传了镜像包才指向它，否则指向一个不存在的路径，避免 /tmp 里上次
# 残留的旧镜像包被误当成新镜像载入（默认在目标机构建时尤其致命）。
if [ "${UPLOAD_IMAGE:-0}" = "1" ]; then
  REMOTE_IMAGE_TARBALL="/tmp/terminal-buddy-image.tar.gz"
else
  REMOTE_IMAGE_TARBALL="/tmp/terminal-buddy-image.absent"
fi

REMOTE_CMD="sed -i 's/\r\$//' ${REMOTE_SH}; \
TB_SKIP_BUILD=${REMOTE_SKIP_BUILD} TB_IMAGE_CURRENT=${REMOTE_IMAGE_CURRENT} \
TB_IMAGE_TARBALL=${REMOTE_IMAGE_TARBALL} \
bash ${REMOTE_SH} ${REMOTE_ARGS}"

log "在 ${CENTOS_HOST} 上执行远端部署脚本"
if ! ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no \
     -o UserKnownHostsFile="${KNOWN_HOSTS}" -o LogLevel=ERROR -p "${CENTOS_PORT}" \
     -o ServerAliveInterval=30 -o ServerAliveCountMax=20 \
     "${CENTOS_USER}@${CENTOS_HOST}" "${REMOTE_CMD}"; then
  fail "远端部署失败，详见上方输出。排查：ssh ${CENTOS_USER}@${CENTOS_HOST} 'docker logs --tail 100 ${CONTAINER}'"
fi

# ---------- 8. 部署后自检 ----------
BASE_URL="http://${CENTOS_HOST}:${HOST_PORT}"
log "部署后自检 ${BASE_URL}"

HEALTH="$(curl -s -m 8 "${BASE_URL}/api/health" || true)"
[ "${HEALTH}" = "正常" ] || fail "健康检查返回异常：${HEALTH:-（无响应）}"
log "  ✓ /api/health -> ${HEALTH}"

AUTH_STATUS="$(curl -s -m 8 "${BASE_URL}/api/auth/status" || true)"
log "  ✓ /api/auth/status -> ${AUTH_STATUS}"
case "${AUTH_STATUS}" in
  *'"setupRequired":true'*) log "  · 尚未初始化，首次打开网页时创建管理员密码" ;;
esac

RUNTIME="$(curl -s -m 8 "${BASE_URL}/api/runtime" || true)"
log "  ✓ /api/runtime -> ${RUNTIME}"

CODE="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/terminals" || echo 000)"
[ "${CODE}" = "401" ] || warn "未带 token 访问 /api/terminals 返回 ${CODE}（预期 401，鉴权可能未生效）"

ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o UserKnownHostsFile="${KNOWN_HOSTS}" \
    -o LogLevel=ERROR -p "${CENTOS_PORT}" "${CENTOS_USER}@${CENTOS_HOST}" \
    "docker ps --filter name=${CONTAINER} --format '{{.Names}} | {{.Status}} | {{.Ports}}'"

echo
log "部署完成"
echo "  访问地址 : ${BASE_URL}/"
echo "  登录账号 : ${USERNAME}（首次打开网页时设置密码，至少 8 位）"
echo "  源码目录 : ${SRC_DIR}"
echo "  数据目录 : ${DATA_DIR}      -> 容器 /data（含 jwt.key / server.key，备份必须包含）"
echo "  用户目录 : ${HOME_DIR}      -> 容器 /home/terminalbuddy（Claude CLI 装在这里）"
echo "  工作区   : ${WORKSPACE_DIR} -> 容器内同路径"
echo "  查看日志 : ssh ${CENTOS_USER}@${CENTOS_HOST} 'docker logs -f --tail 100 ${CONTAINER}'"
echo "  重新部署 : ./xcj/deploy-centos.sh --no-build     # 跳过构建，仅重建容器"
