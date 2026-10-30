#!/usr/bin/env bash
# TerminalBuddy · 飞牛 fnOS 远端部署脚本
#
# 由 scripts/deploy-fnos.sh 上传到 /tmp 后以 root 执行（飞牛默认禁止 root 登录，
# 因此由普通管理员账号通过 sudo 调用）。职责：
#   1. 校验 Docker / Compose / socket
#   2. 准备应用目录与属主，并以容器内 uid 实测写入权限（飞牛 /vol1 走 TrimACL）
#   3. 解压源码、生成 .env 与 compose.fnos.yaml
#   4. 载入本机传来的镜像（默认），或在飞牛上本地构建（--build-on-nas / 无镜像包时）
#   5. 重建容器、等待健康检查、校验容器内可访问宿主机 Docker socket
#
# 用法：
#   sudo bash deploy-fnos-remote.sh APP_DIR DATA_DIR HOME_DIR WORKSPACE_DIR HOST_PORT CONTAINER IMAGE DEPLOY_USER [--build-on-nas] [--no-base-image-backup]
#
# 环境变量（由 sudo 透传，见 scripts/deploy-fnos.sh 的 sudo -E）：
#   TB_SKIP_BUILD=1      跳过构建/载入，直接用现有镜像重建容器
#   TB_IMAGE_TARBALL     镜像包路径，默认 /tmp/terminal-buddy-image.tar.gz

set -euo pipefail

if [ "$#" -lt 8 ]; then
  echo "用法: sudo bash $0 APP_DIR DATA_DIR HOME_DIR WORKSPACE_DIR HOST_PORT CONTAINER IMAGE DEPLOY_USER [--build-on-nas] [--no-base-image-backup]" >&2
  exit 2
fi

APP_DIR="$1"
DATA_DIR="$2"
HOME_DIR="$3"
WORKSPACE_DIR="$4"
HOST_PORT="$5"
CONTAINER="$6"
IMAGE="$7"
DEPLOY_USER="$8"

SRC_DIR="${APP_DIR}/src"
TARBALL="/tmp/terminal-buddy-src.tar.gz"
IMAGE_TARBALL="${TB_IMAGE_TARBALL:-/tmp/terminal-buddy-image.tar.gz}"
BUILD_LOG="/tmp/terminal-buddy-build.log"
COMPOSE_FILE="compose.fnos.yaml"
# 容器以 uid 1000 运行（镜像内的 terminalbuddy 用户）。
APP_UID=1000
APP_GID=1000

log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\033[33m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*" >&2; }
fail() { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

BUILD_ON_NAS=0
BACKUP_BASE_IMAGES=1
for arg in "${@:9}"; do
  case "${arg}" in
    --build-on-nas)          BUILD_ON_NAS=1 ;;
    --no-base-image-backup)  BACKUP_BASE_IMAGES=0 ;;
    --*) fail "未知参数：${arg}" ;;
  esac
done
if [ "${TB_SKIP_BUILD:-0}" = "1" ]; then
  BUILD_ON_NAS=0
fi

[ "$(id -u)" -eq 0 ] || fail "需要 root 权限运行（请通过 sudo 调用）"

# ---------- 1. 环境检查 ----------
command -v docker >/dev/null 2>&1 || fail "未检测到 docker"
docker compose version >/dev/null 2>&1 || fail "未检测到 docker compose v2"

if ! docker info >/dev/null 2>&1; then
  warn "Docker 守护进程未运行，尝试启动 docker 服务"
  systemctl start docker 2>/dev/null || true
  sleep 3
fi
docker info >/dev/null 2>&1 || fail "Docker 守护进程不可用，请检查：systemctl status docker"
[ -S /var/run/docker.sock ] || fail "/var/run/docker.sock 不存在，请确认飞牛 Docker 服务已启动"

SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)"
log "宿主机 /var/run/docker.sock 的 GID = ${SOCKET_GID}"

# ---------- 2. 解压源码 ----------
[ -f "${TARBALL}" ] || fail "未找到源码包 ${TARBALL}"
log "解压源码到 ${SRC_DIR}"
rm -rf "${SRC_DIR}"
mkdir -p "${SRC_DIR}"
tar -xzf "${TARBALL}" -C "${SRC_DIR}"

# 上传自 Windows/Linux 混合环境，统一规范文本文件换行，避免 CRLF 影响构建
find "${SRC_DIR}" -type f \
  \( -name '*.sh' -o -name 'Dockerfile' -o -name '*.yml' -o -name '*.yaml' \
     -o -name '*.toml' -o -name '.dockerignore' \) \
  -exec sed -i 's/\r$//' {} + 2>/dev/null || true

[ -f "${SRC_DIR}/Dockerfile" ]          || fail "源码包中缺少 Dockerfile"
[ -f "${SRC_DIR}/compose.yaml" ]        || fail "源码包中缺少 compose.yaml"

# ---------- 3. 应用目录与属主 ----------
# 飞牛 /vol1 使用自家 TrimACL，POSIX ACL 不参与判定，因此以 chown 为准。
log "准备应用目录 ${APP_DIR}"
mkdir -p "${DATA_DIR}" "${HOME_DIR}" "${WORKSPACE_DIR}"
chown -R "${APP_UID}:${APP_GID}" "${DATA_DIR}" "${HOME_DIR}" "${WORKSPACE_DIR}"
chmod 755 "${APP_DIR}" "${DATA_DIR}" "${HOME_DIR}" "${WORKSPACE_DIR}"
# 源码目录留给部署账号手工维护（排障、看 compose 文件），容器不写它。
chown -R "${DEPLOY_USER}:Users" "${APP_DIR}" 2>/dev/null || true

# API 健康检查无法证明挂载目录可写，必须用容器内实际 uid 落一次盘。
PROBE_IMAGE="alpine:3.21"
have_image() { docker image inspect "$1" >/dev/null 2>&1; }
if ! have_image "${PROBE_IMAGE}"; then
  # 飞牛上已有 alpine 缓存（其它容器装的），缺失时才联网，尽量不影响部署。
  for mirror in dockerproxy.net docker.xuanyuan.me docker.1ms.run docker.m.daocloud.io; do
    if timeout 300 docker pull "${mirror}/library/alpine:3.21" >/dev/null 2>&1; then
      docker tag "${mirror}/library/alpine:3.21" "${PROBE_IMAGE}"
      break
    fi
  done
fi

probe_write() {
  local dir="$1" label="$2"
  if ! docker run --rm -u "${APP_UID}:${APP_GID}" -v "${dir}:/probe" "${PROBE_IMAGE}" \
    sh -c 'touch /probe/.tb-write-probe && mkdir -p /probe/.tb-write-probe.d && rm -rf /probe/.tb-write-probe /probe/.tb-write-probe.d' \
    >/dev/null 2>&1; then
    fail "${label} 对容器内 uid ${APP_UID} 不可写：${dir}
       飞牛 /vol1 以 TrimACL 判定权限，可在飞牛上执行：
         sudo chown -R ${APP_UID}:${APP_GID} ${dir}
         sudo /usr/trim/bin/trimacl -m a:u:${APP_UID}:rwxpdDaAeEc:sfd ${dir}
       然后重新运行部署脚本。"
  fi
  log "  ✓ ${label} 可写（uid ${APP_UID}）：${dir}"
}
probe_write "${DATA_DIR}" "数据目录"
probe_write "${HOME_DIR}" "用户目录"
probe_write "${WORKSPACE_DIR}" "工作区"

# ---------- 4. 生成 .env 与 compose ----------
cd "${SRC_DIR}"

# COMPOSE_PROJECT_NAME 固定：源码位于 src/ 子目录，不指定项目名会变成 src，
# 与既有容器/网络对不上。
cat > "${SRC_DIR}/.env" <<ENV
COMPOSE_PROJECT_NAME=terminal-buddy
ENV
chmod 600 "${SRC_DIR}/.env"

log "写入 ${COMPOSE_FILE}"
cat > "${COMPOSE_FILE}" <<YAML
services:
  terminal-buddy:
    image: ${IMAGE}
    container_name: ${CONTAINER}
    restart: unless-stopped
    ports:
      - "0.0.0.0:${HOST_PORT}:9600"
    environment:
      TERMINAL_BUDDY_USERNAME: admin
      TERMINAL_BUDDY_DATA_DIR: /data
      TERMINAL_BUDDY_WEB_DIST: /opt/terminal-buddy/web
      TERMINAL_BUDDY_WORKSPACE_DIR: ${WORKSPACE_DIR}
      DOCKER_HOST: unix:///var/run/docker.sock
      TERMINAL_BUDDY_PORT: "9600"
      HOME: /home/terminalbuddy
      LANG: C.UTF-8
      TERM: xterm-256color
    group_add:
      - "${SOCKET_GID}"
    working_dir: ${WORKSPACE_DIR}
    volumes:
      - type: bind
        source: ${DATA_DIR}
        target: /data
        bind:
          create_host_path: false
      - type: bind
        source: ${HOME_DIR}
        target: /home/terminalbuddy
        bind:
          create_host_path: false
      - type: bind
        source: ${WORKSPACE_DIR}
        target: ${WORKSPACE_DIR}
        bind:
          create_host_path: false
      - type: bind
        source: /var/run/docker.sock
        target: /var/run/docker.sock
        bind:
          create_host_path: false
    stop_grace_period: 20s
YAML
docker compose -f "${COMPOSE_FILE}" config --quiet

# ---------- 5. 镜像 ----------
have_image() { docker image inspect "$1" >/dev/null 2>&1; }

STATE_FILE="${APP_DIR}/.deploy-state"
state_get() {
  if [ -f "${STATE_FILE}" ]; then
    sed -n "s/^$1=//p" "${STATE_FILE}" 2>/dev/null | tail -n 1 || true
  fi
}

if [ "${BUILD_ON_NAS}" = "0" ] && [ -f "${IMAGE_TARBALL}" ]; then
  # 默认路径：载入本机交叉构建好的镜像，避免在 i3-N305 上跑 Rust release 编译。
  # --no-build 同样走这里：它表示「不在飞牛上重新编译」，而不是「不更新镜像」。
  log "载入本机构建的镜像（$(du -h "${IMAGE_TARBALL}" | cut -f1)）"
  if ! gzip -dc "${IMAGE_TARBALL}" | docker load > /tmp/terminal-buddy-load.log 2>&1; then
    tail -n 10 /tmp/terminal-buddy-load.log >&2 || true
    fail "镜像载入失败：${IMAGE_TARBALL}"
  fi
  have_image "${IMAGE}" || fail "镜像载入后仍找不到 ${IMAGE}，请检查构建机的 tag"
  log "  ✓ 镜像已就绪：$(docker image inspect "${IMAGE}" --format '{{.Id}}' | cut -c1-20)"
elif [ "${TB_SKIP_BUILD:-0}" = "1" ] || [ "${TB_IMAGE_CURRENT:-0}" = "1" ]; then
  # TB_SKIP_BUILD：--no-build（不重新编译）；TB_IMAGE_CURRENT：本机已确认飞牛上的
  # 镜像与本次构建结果一致，因此没有上传镜像包 —— 两者都直接复用现有镜像。
  have_image "${IMAGE}" || fail "飞牛上没有 ${IMAGE}，且本次未上传镜像包"
  log "复用飞牛上的现有镜像 ${IMAGE}（$(docker image inspect "${IMAGE}" --format '{{.Id}}' | cut -c1-20)）"
else
  if [ "${BUILD_ON_NAS}" = "1" ]; then
    log "在飞牛上本地构建镜像（Rust release 编译，i3-N305 约 20-40 分钟，请耐心等待）"
  else
    warn "未找到镜像包 ${IMAGE_TARBALL}，退回在飞牛上本地构建（约 20-40 分钟）"
  fi

  # 基础镜像三级兜底：本地命中 -> 离线备份 -> 备用镜像源。
  # 飞牛的镜像加速源会间歇性返回 401，且会清理未被容器占用的镜像。
  BASE_IMAGES=(
    "node:24-bookworm-slim"
    "rust:1-bookworm"
    "debian:bookworm-slim"
    "docker:28-cli"
  )
  BASE_MIRRORS=(
    "dockerproxy.net"
    "docker.xuanyuan.me"
    "docker.1ms.run"
    "docker.m.daocloud.io"
  )
  BASE_CACHE_DIR="${APP_DIR}/base-images"

  backup_file() { printf '%s/%s.tar.gz' "${BASE_CACHE_DIR}" "$(printf '%s' "$1" | tr '/:' '__')"; }

  pull_base_image() {
    local spec="$1" name="${1%%:*}" tag="${1##*:}" mirror
    for mirror in "${BASE_MIRRORS[@]}"; do
      if timeout 900 docker pull "${mirror}/library/${name}:${tag}" >/tmp/terminal-buddy-base-pull.log 2>&1; then
        docker tag "${mirror}/library/${name}:${tag}" "${name}:${tag}"
        docker rmi "${mirror}/library/${name}:${tag}" >/dev/null 2>&1 || true
        return 0
      fi
      log "    ${mirror} 不可用：$(tail -1 /tmp/terminal-buddy-base-pull.log 2>/dev/null | cut -c1-90)"
    done
    return 1
  }

  log "检查公共基础镜像"
  BASE_MISSING=""
  for img in "${BASE_IMAGES[@]}"; do
    if have_image "$img"; then
      log "  ✓ ${img}（本地缓存命中，不访问网络）"
    else
      BASE_MISSING="${BASE_MISSING} ${img}"
    fi
  done

  for img in ${BASE_MISSING}; do
    backup="$(backup_file "${img}")"
    if [ -f "${backup}" ]; then
      log "  离线备份恢复：${img}"
      if gzip -dc "${backup}" | docker load >/dev/null 2>&1 && have_image "${img}"; then
        log "  ✓ ${img} 已从备份恢复"
        continue
      fi
      warn "  备份不可用，改为联网拉取：${img}"
    fi
    log "  联网拉取：${img}"
    pull_base_image "${img}" || fail "基础镜像 ${img} 不可用：本地无缓存、备用源均失败。可稍后重试，或先在飞牛修复镜像加速源。"
    log "  ✓ ${img} 就绪"
  done

  if [ "${BACKUP_BASE_IMAGES}" = "1" ]; then
    mkdir -p "${BASE_CACHE_DIR}"
    log "导出基础镜像离线备份到 ${BASE_CACHE_DIR}"
    for img in "${BASE_IMAGES[@]}"; do
      backup="$(backup_file "${img}")"
      if [ -f "${backup}" ]; then
        log "  ✓ 已存在，跳过：$(basename "${backup}")"
      else
        docker save "${img}" | gzip -1 > "${backup}.tmp" && mv "${backup}.tmp" "${backup}"
        log "  ✓ 已导出：$(basename "${backup}")"
      fi
    done
  fi

  # Docker 的 COPY 缓存按文件内容校验（不看 mtime），源码没变时连 build 都不发起。
  BUILD_INPUTS=(Dockerfile .dockerignore compose.yaml terminal-buddy/src terminal-buddy/package.json terminal-buddy/package-lock.json terminal-buddy/src-tauri terminal-buddy/vite.config.ts terminal-buddy/index.html terminal-buddy/tsconfig.json terminal-buddy/tsconfig.node.json)
  hash_inputs() {
    local paths=() item
    for item in "${BUILD_INPUTS[@]}"; do
      [ -e "${item}" ] && paths+=("${item}")
    done
    [ "${#paths[@]}" -eq 0 ] && { printf 'no-inputs'; return 0; }
    find "${paths[@]}" -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1
  }
  SOURCE_HASH="$(hash_inputs)"
  PREV_SOURCE_HASH="$(state_get source)"
  IMAGE_EXISTS=0
  have_image "${IMAGE}" && IMAGE_EXISTS=1

  if [ "${IMAGE_EXISTS}" -eq 1 ] && [ -n "${PREV_SOURCE_HASH}" ] && [ "${PREV_SOURCE_HASH}" = "${SOURCE_HASH}" ]; then
    log "源码未变化（指纹 ${SOURCE_HASH:0:12}），跳过构建，复用镜像 ${IMAGE}"
  else
    log "构建镜像 ${IMAGE}（复用已有分层，只重建变动部分）"
    if ! docker build -t "${IMAGE}" . > "${BUILD_LOG}" 2>&1; then
      tail -n 25 "${BUILD_LOG}" >&2 || true
      fail "Docker 镜像构建失败，完整日志：${BUILD_LOG}（线上容器未被改动）"
    fi
    log "  构建完成，命中缓存分层 $(grep -c 'CACHED' "${BUILD_LOG}" 2>/dev/null || echo 0) 个"
    tail -n 3 "${BUILD_LOG}" || true
  fi
fi

NEW_IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"

# ---------- 6. 重建容器 ----------
if command -v sha256sum >/dev/null 2>&1; then
  CONFIG_HASH="$(cat "${COMPOSE_FILE}" .env | sha256sum | cut -d' ' -f1)"
else
  CONFIG_HASH="$(cat "${COMPOSE_FILE}" .env | shasum -a 256 | cut -d' ' -f1)"
fi
CURRENT_IMAGE_ID="$(docker inspect "${CONTAINER}" --format '{{.Image}}' 2>/dev/null || true)"
CURRENT_RUNNING="$(docker inspect "${CONTAINER}" --format '{{.State.Running}}' 2>/dev/null || true)"
PREV_CONFIG_HASH="$(state_get config)"

if [ "${CURRENT_RUNNING}" = "true" ] && [ "${NEW_IMAGE_ID}" = "${CURRENT_IMAGE_ID}" ] && [ "${CONFIG_HASH}" = "${PREV_CONFIG_HASH}" ]; then
  log "镜像与运行配置均未变化，容器保持运行（服务零中断）"
else
  log "重建容器 ${CONTAINER}"
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker compose -f "${COMPOSE_FILE}" up -d --no-build --remove-orphans 2>&1 | tail -n 12
fi

{
  printf 'source=%s\n' "${SOURCE_HASH:-skipped}"
  printf 'image=%s\n' "${NEW_IMAGE_ID}"
  printf 'config=%s\n' "${CONFIG_HASH}"
} > "${STATE_FILE}"
chmod 600 "${STATE_FILE}" 2>/dev/null || true

# ---------- 7. 等待健康检查 ----------
log "等待服务健康检查通过"
HEALTH_OK=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 3
done
if [ "${HEALTH_OK}" != "1" ]; then
  docker logs --tail 40 "${CONTAINER}" >&2 2>&1 || true
  fail "新容器启动后健康检查未通过（http://127.0.0.1:${HOST_PORT}/api/health）"
fi
log "健康检查通过"

# ---------- 8. 校验容器内可访问宿主机 Docker socket ----------
if ! docker exec --user terminalbuddy "${CONTAINER}" docker version >/dev/null 2>&1; then
  docker inspect "${CONTAINER}" --format '{{json .HostConfig.GroupAdd}}' >&2 || true
  fail "容器内无法访问宿主机 Docker（检查 compose 的 group_add=${SOCKET_GID}）"
fi
HOST_DOCKER_ID="$(docker info --format '{{.ID}}')"
CONTAINER_DOCKER_ID="$(docker exec --user terminalbuddy "${CONTAINER}" docker info --format '{{.ID}}')"
[ -n "${HOST_DOCKER_ID}" ] && [ "${HOST_DOCKER_ID}" = "${CONTAINER_DOCKER_ID}" ] \
  || fail "容器与宿主机没有连接同一个 Docker Engine"
docker exec --user terminalbuddy "${CONTAINER}" docker compose version >/dev/null 2>&1 \
  || warn "容器内 docker compose 不可用，网页端 Compose 功能会受限"
log "容器内 Docker 连接与 Compose 校验通过"

# 收尾：清理上传的临时包，源码目录留给部署账号维护。
rm -f "${TARBALL}" "${IMAGE_TARBALL}" 2>/dev/null || true

docker ps --filter "name=${CONTAINER}" --format '{{.Names}} | {{.Status}} | {{.Ports}}'
exit 0
