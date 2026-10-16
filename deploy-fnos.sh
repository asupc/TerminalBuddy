#!/usr/bin/env bash
# TerminalBuddy 一键部署到飞牛 fnOS
#
# 飞牛默认禁止 root 登录（PermitRootLogin no），因此使用普通管理员账号 + sudo 部署。
# 默认流程：打包源码 → scp 上传 → 远端 sudo 执行 scripts/deploy-fnos-remote.sh
# （在飞牛上构建镜像 + 重建容器 + 健康检查）。本机不需要安装 docker。
#
# 之所以默认在飞牛上编译：部署机不必装 docker / Node / Rust，任意能 ssh 的机器都能发包；
# 源码包约 16MB，比搬运 158MB 镜像包更省事。i3-N305（8 核）首次构建约 20-40 分钟，
# 之后源码未变时按指纹跳过构建，直接复用镜像。基础镜像走「本地命中 → 离线备份 →
# 备用镜像源」三级兜底，构建所需的 npm / crates 源在飞牛上实测可达。
# 需要在本机构建并上传镜像时用 --build-local（要求本机有 docker）。
#
# 用法：
#   ./deploy-fnos.sh                       # 全流程（拉代码 → 在飞牛上构建镜像）
#   ./deploy-fnos.sh --no-build            # 跳过构建，用飞牛上现有镜像重建容器
#   ./deploy-fnos.sh --no-pull             # 不拉取本机代码，直接用当前工作区
#   ./deploy-fnos.sh --build-local         # 改在本机构建镜像后上传（需本机 docker）
#   ./deploy-fnos.sh --host 192.168.3.77 --listen-port 9600
#
# sudo 密码来源（按优先级）：
#   1. 环境变量 TB_FNOS_PASSWORD
#   2. 凭据文件（--config，默认 ~/.codex/private/fnos/config.json，需含 host/username/password）
#   3. 交互式输入（隐藏回显）
# 密码只经 stdin 交给远端 sudo -S，不写入命令行参数或日志。

set -euo pipefail

# ==================== 可覆盖配置 ====================
FNOS_HOST="${TB_FNOS_HOST:-192.168.3.77}"
FNOS_USER="${TB_FNOS_USER:-397383523}"
FNOS_PORT="${TB_FNOS_SSH_PORT:-22}"
APP_DIR="${TB_FNOS_APP_DIR:-/vol1/1000/docker/terminal-buddy}"
HOST_PORT="${TB_FNOS_PORT:-9600}"
CONTAINER="${TB_FNOS_CONTAINER:-terminal-buddy}"
IMAGE="${TB_FNOS_IMAGE:-terminal-buddy:server}"
CONFIG_FILE="${TB_FNOS_CONFIG:-$HOME/.codex/private/fnos/config.json}"
SSH_KEY="${TB_FNOS_SSH_KEY:-$HOME/.ssh/terminal_buddy_fnos_deploy}"
PULL_LATEST="${TB_FNOS_PULL:-1}"
# =====================================================

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${APP_DIR}/data"
HOME_DIR="${APP_DIR}/home"
WORKSPACE_DIR="${APP_DIR}/workspace"

SRC_TARBALL="/tmp/terminal-buddy-src.tar.gz"
IMAGE_TARBALL="/tmp/terminal-buddy-image.tar.gz"
REMOTE_SH="/tmp/terminal-buddy-fnos-deploy.sh"
KNOWN_HOSTS="/tmp/terminal_buddy_fnos_known_hosts"
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
NO_BASE_IMAGE_BACKUP=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build)         DO_BUILD=0 ;;
    --no-pull)          PULL_LATEST=0 ;;
    --pull)             PULL_LATEST=1 ;;
    --build-local)      BUILD_LOCAL=1 ;;
    --build-on-nas)     warn "--build-on-nas 已无必要：现在默认就在飞牛上构建，按默认流程继续" ;;
    --no-base-image-backup) NO_BASE_IMAGE_BACKUP=1 ;;
    --host)             FNOS_HOST="${2:?--host 需要一个地址}"; shift ;;
    --listen-port)      HOST_PORT="${2:?--listen-port 需要一个端口}"; shift ;;
    --config)           CONFIG_FILE="${2:?--config 需要一个文件路径}"; shift ;;
    -h|--help)          sed -n '2,30p' "$0"; exit 0 ;;
    *) fail "未知参数：$1（可用：--no-build / --no-pull / --build-local / --no-base-image-backup / --host / --listen-port / --config / --help）" ;;
  esac
  shift
done

# ---------- 0. 本机依赖检查 ----------
# 默认在飞牛上构建，本机只负责打包与上传，因此不要求本机装 docker。
if [ "${BUILD_LOCAL}" = "1" ]; then
  command -v docker >/dev/null 2>&1 || fail "--build-local 需要本机 docker，但未检测到；去掉该参数即在飞牛上构建"
fi
command -v ssh    >/dev/null 2>&1 || fail "未检测到 ssh"
command -v scp    >/dev/null 2>&1 || fail "未检测到 scp"
command -v tar    >/dev/null 2>&1 || fail "未检测到 tar"
command -v curl   >/dev/null 2>&1 || fail "未检测到 curl"
[ -f "${REPO_DIR}/Dockerfile" ] || fail "缺少 ${REPO_DIR}/Dockerfile"
[ -f "${REPO_DIR}/scripts/deploy-fnos-remote.sh" ] || fail "缺少 scripts/deploy-fnos-remote.sh"
[ -d "${REPO_DIR}/terminal-buddy/src-tauri" ] || fail "缺少 terminal-buddy/src-tauri，源码不完整"

# ---------- 1. 拉取本机最新代码 ----------
if [ "${PULL_LATEST}" = "1" ]; then
  if [ -d "${REPO_DIR}/.git" ]; then
    command -v git >/dev/null 2>&1 || fail "未检测到 git，无法拉取代码；或用 --no-pull 跳过"
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
      -p "${FNOS_PORT}" "${FNOS_USER}@${FNOS_HOST}" 'echo ok' >/dev/null 2>&1
}

read_password() {
  if [ -n "${TB_FNOS_PASSWORD:-}" ]; then
    printf '%s' "${TB_FNOS_PASSWORD}"; return 0
  fi
  if [ -f "${CONFIG_FILE}" ]; then
    # 不依赖 jq：凭据文件是扁平的 {"host":..,"username":..,"password":..}。
    local pw host user
    pw="$(sed -n 's/.*"password"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${CONFIG_FILE}" | head -n 1)"
    host="$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${CONFIG_FILE}" | head -n 1)"
    user="$(sed -n 's/.*"\(username\|user\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' "${CONFIG_FILE}" | head -n 1)"
    if [ -n "${pw}" ] && { [ -z "${host}" ] || [ "${host}" = "${FNOS_HOST}" ]; } \
       && { [ -z "${user}" ] || [ "${user}" = "${FNOS_USER}" ]; }; then
      printf '%s' "${pw}"; return 0
    fi
  fi
  local pw
  read -r -s -p "请输入 ${FNOS_USER}@${FNOS_HOST} 的 SSH 密码（仅本次使用，不保存）：" pw </dev/tty
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
    ssh-keygen -t ed25519 -N '' -C terminal-buddy-fnos-deploy -f "${SSH_KEY}" >/dev/null
    chmod 600 "${SSH_KEY}"
  fi
  pubkey="$(cat "${SSH_KEY}.pub")"

  # ssh 不会从非终端读取密码，用 SSH_ASKPASS 交给它。辅助脚本只在部署期间存在。
  ASKPASS_HELPER="$(mktemp /tmp/tb-fnos-askpass.XXXXXX)"
  chmod 700 "${ASKPASS_HELPER}"
  printf '#!/bin/sh\nprintf "%%s\\n" %q\n' "${password}" > "${ASKPASS_HELPER}"
  chmod 700 "${ASKPASS_HELPER}"

  log "安装公钥到 ${FNOS_USER}@${FNOS_HOST} 的 ~/.ssh/authorized_keys（需要认证一次）"
  local quoted
  printf -v quoted '%q' "${pubkey}"
  if ! SSH_ASKPASS="${ASKPASS_HELPER}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
       ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile="${KNOWN_HOSTS}" \
           -o ConnectTimeout=15 -o PreferredAuthentications=password -o PubkeyAuthentication=no \
           -o NumberOfPasswordPrompts=1 -p "${FNOS_PORT}" "${FNOS_USER}@${FNOS_HOST}" \
           "umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; grep -qF -- ${quoted} ~/.ssh/authorized_keys || printf '%s\n' ${quoted} >> ~/.ssh/authorized_keys" \
       >/dev/null 2>&1; then
    rm -f "${ASKPASS_HELPER}"; ASKPASS_HELPER=""
    fail "安装公钥失败：请确认 ${FNOS_USER}@${FNOS_HOST} 的密码正确、且该账号可用密码登录"
  fi
  rm -f "${ASKPASS_HELPER}"; ASKPASS_HELPER=""
  ssh_probe || fail "公钥安装后仍无法免密登录，请检查远端 ~/.ssh 权限"
  log "  ✓ 免密登录已就绪"
}

if [ ! -f "${SSH_KEY}" ] || ! ssh_probe; then
  install_public_key
else
  log "免密认证通过（${FNOS_USER}@${FNOS_HOST}）"
fi

# ---------- 3. 构建镜像 ----------
if [ "${DO_BUILD}" = "0" ]; then
  log "跳过构建，复用飞牛上的现有镜像 ${IMAGE}"
elif [ "${BUILD_LOCAL}" = "1" ]; then
  log "本机构建镜像 ${IMAGE}（复用 Docker 层缓存，源码未变时几乎瞬时完成）"
  BEFORE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null || true)"
  if ! docker build -f "${REPO_DIR}/Dockerfile" -t "${IMAGE}" "${REPO_DIR}" 2>&1 | tail -n 15; then
    fail "本机构建失败。可去掉 --build-local 改为在飞牛上构建，或用 --no-build 复用现有镜像"
  fi
  AFTER_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
  if [ -n "${BEFORE_ID}" ] && [ "${BEFORE_ID}" = "${AFTER_ID}" ]; then
    log "  镜像未变化（全部命中缓存）：${AFTER_ID:7:12}"
  else
    log "  镜像已更新：${AFTER_ID:7:12}"
  fi
else
  log "跳过本机构建：镜像将在飞牛上编译（首次约 20-40 分钟，之后按源码指纹跳过）"
fi

# ---------- 4. 打包源码与镜像 ----------
log "打包源码（排除 .git / node_modules / target / 构建产物）"
rm -f "${SRC_TARBALL}"
tar -czf "${SRC_TARBALL}" \
  --exclude='./.git' --exclude='./.codegraph' --exclude='./.claude' \
  --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='./target' --exclude='*/target' \
  --exclude='./dist' --exclude='*/dist' --exclude='./dist-web' --exclude='*/dist-web' \
  --exclude='./server-data' --exclude='*/server-data' \
  --exclude='./workspace' --exclude='./docs' --exclude='./design' \
  --exclude='./terminal-buddy/src-tauri/resources' \
  --exclude='./terminal-buddy/plugins' \
  -C "${REPO_DIR}" .
log "  源码包：$(du -h "${SRC_TARBALL}" | cut -f1)"

UPLOAD_IMAGE=0
if [ "${BUILD_LOCAL}" = "1" ] && [ "${DO_BUILD}" = "1" ]; then
  LOCAL_IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
  REMOTE_IMAGE_ID="$(ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o UserKnownHostsFile="${KNOWN_HOSTS}" \
      -o LogLevel=ERROR -p "${FNOS_PORT}" "${FNOS_USER}@${FNOS_HOST}" \
      "docker image inspect '${IMAGE}' --format '{{.Id}}' 2>/dev/null || true")"
  if [ -n "${REMOTE_IMAGE_ID}" ] && [ "${REMOTE_IMAGE_ID}" = "${LOCAL_IMAGE_ID}" ]; then
    log "飞牛上已有相同镜像（${LOCAL_IMAGE_ID:7:12}），跳过导出与上传（约省 158MB 传输）"
  else
    UPLOAD_IMAGE=1
    STAGE_DIR="$(mktemp -d /tmp/tb-fnos-image.XXXXXX)"
    log "导出镜像（docker save | gzip，约 1 分钟）"
    docker save "${IMAGE}" | gzip -1 > "${STAGE_DIR}/image.tar.gz"
    IMAGE_TARBALL="${STAGE_DIR}/image.tar.gz"
    log "  镜像包：$(du -h "${IMAGE_TARBALL}" | cut -f1)"
  fi
fi

# ---------- 5. 上传到飞牛 ----------
SCP_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=no -o UserKnownHostsFile="${KNOWN_HOSTS}"
          -o LogLevel=ERROR -P "${FNOS_PORT}")

log "上传源码包与远端脚本到 ${FNOS_HOST}:/tmp"
scp "${SCP_OPTS[@]}" "${SRC_TARBALL}" "${FNOS_USER}@${FNOS_HOST}:/tmp/terminal-buddy-src.tar.gz" \
  || fail "上传失败，请检查网络与磁盘空间"
scp "${SCP_OPTS[@]}" "${REPO_DIR}/scripts/deploy-fnos-remote.sh" \
  "${FNOS_USER}@${FNOS_HOST}:${REMOTE_SH}" || fail "上传远端脚本失败"

if [ "${UPLOAD_IMAGE}" = "1" ]; then
  log "上传镜像包（$(du -h "${IMAGE_TARBALL}" | cut -f1)）"
  scp "${SCP_OPTS[@]}" "${IMAGE_TARBALL}" "${FNOS_USER}@${FNOS_HOST}:/tmp/terminal-buddy-image.tar.gz" \
    || fail "镜像上传失败，请检查网络与磁盘空间"
fi

# ---------- 6. 远端 sudo 执行 ----------
SUDO_PASSWORD="$(read_password)"
[ -n "${SUDO_PASSWORD}" ] || fail "未取得 sudo 密码"

REMOTE_ARGS="${APP_DIR} ${DATA_DIR} ${HOME_DIR} ${WORKSPACE_DIR} ${HOST_PORT} ${CONTAINER} ${IMAGE} ${FNOS_USER}"
REMOTE_FLAGS=""
# 默认（BUILD_LOCAL=0）：让远端真正编译，传 --build-on-nas 走「在飞牛上本地构建」分支
# （远端那个标志名保持不变，语义即「在飞牛上构建」）。
[ "${BUILD_LOCAL}" = "0" ] && [ "${DO_BUILD}" = "1" ] && REMOTE_FLAGS="${REMOTE_FLAGS} --build-on-nas"
[ "${NO_BASE_IMAGE_BACKUP}" = "1" ] && REMOTE_FLAGS="${REMOTE_FLAGS} --no-base-image-backup"
# 是否要求远端跳过构建：
#   --no-build     -> 跳过，直接用远端现有镜像
#   --build-local  -> 本机已构建并上传镜像包，远端只需载入
#   默认           -> 远端需要编译
if [ "${DO_BUILD}" = "0" ] || [ "${BUILD_LOCAL}" = "1" ]; then
  REMOTE_SKIP_BUILD=1
else
  REMOTE_SKIP_BUILD=0
fi
# 远端可复用的条件：本次确实上传/确认了镜像。
#   --build-local  -> 本机已构建，远端镜像即所需镜像，无需再编译
#   默认在飞牛构建 -> 远端必须真正编译，不能标记为 current
if [ "${BUILD_LOCAL}" = "1" ] && [ "${DO_BUILD}" = "1" ]; then
  REMOTE_IMAGE_CURRENT=1
else
  REMOTE_IMAGE_CURRENT=0
fi

# 远端脚本按「镜像包文件是否存在」决定是否 docker load，因此这里必须显式给出路径：
# 只有本次真的上传了镜像包才指向它，否则指向一个不存在的路径，避免 /tmp 里上次
# 残留的旧镜像包被误当成新镜像载入（默认在飞牛构建时尤其致命）。
if [ "${UPLOAD_IMAGE:-0}" = "1" ]; then
  REMOTE_IMAGE_TARBALL="/tmp/terminal-buddy-image.tar.gz"
else
  REMOTE_IMAGE_TARBALL="/tmp/terminal-buddy-image.absent"
fi

REMOTE_CMD="sed -i 's/\r\$//' ${REMOTE_SH}; \
TB_SKIP_BUILD=${REMOTE_SKIP_BUILD} TB_IMAGE_CURRENT=${REMOTE_IMAGE_CURRENT} \
TB_IMAGE_TARBALL=${REMOTE_IMAGE_TARBALL} \
sudo -E -S -p '' bash ${REMOTE_SH} ${REMOTE_ARGS}${REMOTE_FLAGS}"

log "在飞牛上执行远端部署脚本"
if ! printf '%s\n' "${SUDO_PASSWORD}" | ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no \
     -o UserKnownHostsFile="${KNOWN_HOSTS}" -o LogLevel=ERROR -p "${FNOS_PORT}" \
     "${FNOS_USER}@${FNOS_HOST}" "${REMOTE_CMD}"; then
  fail "远端部署失败，详见上方输出。排查：ssh ${FNOS_USER}@${FNOS_HOST} 'docker logs --tail 100 ${CONTAINER}'"
fi

# ---------- 7. 部署后自检 ----------
BASE_URL="http://${FNOS_HOST}:${HOST_PORT}"
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
    -o LogLevel=ERROR -p "${FNOS_PORT}" "${FNOS_USER}@${FNOS_HOST}" \
    "docker ps --filter name=${CONTAINER} --format '{{.Names}} | {{.Status}} | {{.Ports}}'"

echo
log "部署完成"
echo "  访问地址 : ${BASE_URL}/"
echo "  登录账号 : admin（首次打开网页时设置密码，至少 8 位）"
echo "  应用目录 : ${APP_DIR}"
echo "  数据目录 : ${DATA_DIR}      -> 容器 /data（含 jwt.key / server.key，备份必须包含）"
echo "  用户目录 : ${HOME_DIR}      -> 容器 /home/terminalbuddy（Claude CLI 装在这里）"
echo "  工作区   : ${WORKSPACE_DIR} -> 容器内同路径"
echo "  查看日志 : ssh ${FNOS_USER}@${FNOS_HOST} 'docker logs -f --tail 100 ${CONTAINER}'"
echo "  重新部署 : ./deploy-fnos.sh --no-build     # 跳过构建，仅重建容器"