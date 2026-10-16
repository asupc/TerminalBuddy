#!/usr/bin/env bash
# TerminalBuddy · CentOS 目标机部署脚本
#
# 由 deploy-centos.sh 上传到 /tmp 后以 root 执行（CentOS 允许 root 直连，无需 sudo）。
# 职责：
#   1. 校验 Docker / Compose / socket
#   2. 解压源码到 APP_DIR/src
#   3. 校验工作区路径不会覆盖系统目录（在任何 chown 之前）
#   4. 准备数据/用户/工作区目录并授权给容器内 uid 1000
#   5. 生成 compose.centos.yaml
#   6. 载入上传的镜像，或在本机构建（带基础镜像多源兜底 + 源码指纹跳过）
#   7. 用容器内 uid 实测挂载目录可写
#   8. 重建容器、等待健康检查、校验容器内可访问宿主机 Docker socket
#
# 用法：
#   sudo bash deploy-centos-remote.sh APP_DIR DATA_DIR HOME_DIR WORKSPACE_DIR HOST_PORT BIND_ADDRESS CONTAINER IMAGE USERNAME DOCKER_SOCKET
#
# 环境变量（由 deploy-centos.sh 透传）：
#   TB_SKIP_BUILD=1       跳过构建，直接用现有镜像重建容器
#   TB_IMAGE_TARBALL      镜像包路径，默认 /tmp/terminal-buddy-image.tar.gz
#   TB_IMAGE_CURRENT=1    调用方已确认目标机镜像与本次构建结果一致，无需再编译

set -euo pipefail

if [ "$#" -lt 10 ]; then
  echo "用法: sudo bash $0 APP_DIR DATA_DIR HOME_DIR WORKSPACE_DIR HOST_PORT BIND_ADDRESS CONTAINER IMAGE USERNAME DOCKER_SOCKET" >&2
  exit 2
fi

APP_DIR="$1"
DATA_DIR="$2"
HOME_DIR="$3"
WORKSPACE_DIR="$4"
HOST_PORT="$5"
BIND_ADDRESS="$6"
CONTAINER="$7"
IMAGE="$8"
USERNAME="$9"
DOCKER_SOCKET="${10}"

SRC_DIR="${APP_DIR}/src"
TARBALL="/tmp/terminal-buddy-src.tar.gz"
IMAGE_TARBALL="${TB_IMAGE_TARBALL:-/tmp/terminal-buddy-image.tar.gz}"
COMPOSE_FILE="compose.centos.yaml"
BUILD_LOG="/tmp/terminal-buddy-build.log"
STATE_FILE="${APP_DIR}/.deploy-state"
# 容器以 uid 1000 运行（镜像内的 terminalbuddy 用户）。
APP_UID=1000
APP_GID=1000

log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\033[33m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*" >&2; }
fail() { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

# 单引号保护 YAML 标量，双写 $ 防止 Compose 把路径内容当成变量插值。
yaml_value() {
  local value="${1//\'/\'\'}"
  value="${value//\$/\$\$}"
  printf "'%s'" "$value"
}

[ "$(id -u)" -eq 0 ] || fail "需要 root 权限运行"

# ---------- 1. 环境检查 ----------
command -v docker >/dev/null 2>&1 || fail "未检测到 docker，请先安装：yum install -y docker-ce && systemctl enable --now docker"
if ! docker info >/dev/null 2>&1; then
  warn "Docker 守护进程未运行，尝试启动 docker 服务"
  systemctl start docker 2>/dev/null || true
  sleep 3
fi
docker info >/dev/null 2>&1 || fail "Docker 守护进程不可用，请检查：systemctl status docker"
docker compose version >/dev/null 2>&1 || fail "未检测到 docker compose v2，请安装 docker-compose-plugin"
command -v curl >/dev/null 2>&1 || fail "缺少 curl，请先安装：yum install -y curl"
[ -S "${DOCKER_SOCKET}" ] || fail "Docker socket 不存在：${DOCKER_SOCKET}"

SOCKET_GID="$(stat -c '%g' "${DOCKER_SOCKET}")"
case "${SOCKET_GID}" in ''|*[!0-9]*) fail "无法读取 ${DOCKER_SOCKET} 的数字 GID" ;; esac
log "宿主机 ${DOCKER_SOCKET} 的 GID = ${SOCKET_GID}"

# 端口占用检查：放行 docker-proxy（重建流程里旧容器的代理会占着这个端口）。
if command -v ss >/dev/null 2>&1; then
  BUSY="$(ss -lntp 2>/dev/null | awk -v p=":${HOST_PORT}$" '$4 ~ p {print $NF; exit}')"
  if [ -n "${BUSY}" ] && ! printf '%s' "${BUSY}" | grep -q 'docker-proxy'; then
    fail "宿主机端口 ${HOST_PORT} 已被占用：${BUSY}（请先停掉该进程，或改用其他端口）"
  fi
fi

# ---------- 2. 解压源码 ----------
[ -f "${TARBALL}" ] || fail "未找到源码包 ${TARBALL}"
log "解压源码到 ${SRC_DIR}"
rm -rf "${SRC_DIR}"
mkdir -p "${SRC_DIR}"
tar -xzf "${TARBALL}" -C "${SRC_DIR}"

# 打包环境可能是 Windows/Linux 混合，统一规范文本文件换行，避免 CRLF 影响构建。
find "${SRC_DIR}" -type f \
  \( -name '*.sh' -o -name 'Dockerfile' -o -name '*.yml' -o -name '*.yaml' \
     -o -name '*.toml' -o -name '.dockerignore' \) \
  -exec sed -i 's/\r$//' {} + 2>/dev/null || true

[ -f "${SRC_DIR}/Dockerfile" ]         || fail "源码包中缺少 Dockerfile"
[ -f "${SRC_DIR}/compose.yaml" ]       || fail "源码包中缺少 compose.yaml"
[ -d "${SRC_DIR}/terminal-buddy/web" ] || fail "源码包中缺少 terminal-buddy/web，源码不完整"

# ---------- 3. 目录安全校验 ----------
# 必须在任何 chown/mkdir 之前完成：工作区会以同路径挂载并递归 chown 给容器用户，
# 一旦指向 /root、/usr 之类的系统目录，chown -R 会直接破坏目标机。
WORKSPACE_DIR="$(readlink -m -- "${WORKSPACE_DIR}")"
case "${WORKSPACE_DIR}" in
  /|/root|/data|/data/*|/home|/home/terminalbuddy|/home/terminalbuddy/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/usr|/usr/*|/etc|/etc/*|/var|/var/run|/var/run/*|/run|/run/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/opt|/opt/terminal-buddy|/opt/terminal-buddy/*)
    fail "工作区不能覆盖容器的系统或数据目录：${WORKSPACE_DIR}" ;;
esac
for protected_dir in "${DATA_DIR}" "${HOME_DIR}"; do
  protected_dir="$(readlink -m -- "${protected_dir}")"
  case "${protected_dir}/" in
    "${WORKSPACE_DIR}/"*) fail "工作区不能包含应用数据或用户目录：${WORKSPACE_DIR}" ;;
  esac
done

# ---------- 4. 数据目录与属主 ----------
log "准备数据目录并授权（容器内 uid ${APP_UID}）"
mkdir -p "${DATA_DIR}" "${HOME_DIR}" "${WORKSPACE_DIR}"
chown -R "${APP_UID}:${APP_GID}" "${DATA_DIR}" "${HOME_DIR}" "${WORKSPACE_DIR}"
chmod 755 "${DATA_DIR}" "${HOME_DIR}" "${WORKSPACE_DIR}"

# ---------- 5. 生成 compose ----------
cd "${SRC_DIR}"
log "写入 ${COMPOSE_FILE}"
cat > "${COMPOSE_FILE}" <<YAML
services:
  terminal-buddy:
    image: ${IMAGE}
    container_name: ${CONTAINER}
    restart: unless-stopped
    ports:
      - "${BIND_ADDRESS}:${HOST_PORT}:9600"
    environment:
      TERMINAL_BUDDY_USERNAME: $(yaml_value "${USERNAME}")
      TERMINAL_BUDDY_DATA_DIR: /data
      TERMINAL_BUDDY_WEB_DIST: /opt/terminal-buddy/web
      TERMINAL_BUDDY_WORKSPACE_DIR: $(yaml_value "${WORKSPACE_DIR}")
      DOCKER_HOST: unix:///var/run/docker.sock
      TERMINAL_BUDDY_PORT: "9600"
      HOME: /home/terminalbuddy
      LANG: C.UTF-8
      TERM: xterm-256color
    group_add:
      - "${SOCKET_GID}"
    working_dir: $(yaml_value "${WORKSPACE_DIR}")
    volumes:
      - type: bind
        source: $(yaml_value "${DATA_DIR}")
        target: /data
        bind:
          create_host_path: false
      - type: bind
        source: $(yaml_value "${HOME_DIR}")
        target: /home/terminalbuddy
        bind:
          create_host_path: false
      - type: bind
        source: $(yaml_value "${WORKSPACE_DIR}")
        target: /workspace
        bind:
          create_host_path: false
      - type: bind
        source: $(yaml_value "${DOCKER_SOCKET}")
        target: /var/run/docker.sock
        bind:
          create_host_path: false
YAML
if [ "${WORKSPACE_DIR}" != "/workspace" ]; then
  # 保留 /workspace 供已有项目使用，新项目使用与宿主机相同的绝对路径。
  cat >> "${COMPOSE_FILE}" <<YAML
      - type: bind
        source: $(yaml_value "${WORKSPACE_DIR}")
        target: $(yaml_value "${WORKSPACE_DIR}")
        bind:
          create_host_path: false
YAML
fi
printf '    stop_grace_period: 20s\n' >> "${COMPOSE_FILE}"
docker compose -f "${COMPOSE_FILE}" config --quiet

# ---------- 6. 镜像 ----------
have_image() { docker image inspect "$1" >/dev/null 2>&1; }

state_get() {
  if [ -f "${STATE_FILE}" ]; then
    sed -n "s/^$1=//p" "${STATE_FILE}" 2>/dev/null | tail -n 1 || true
  fi
}

if [ "${TB_SKIP_BUILD:-0}" = "1" ] || [ "${TB_IMAGE_CURRENT:-0}" = "1" ]; then
  # --no-build：不重新编译；TB_IMAGE_CURRENT：调用方已确认目标机镜像即所需镜像。
  have_image "${IMAGE}" || fail "目标机上没有 ${IMAGE}，且本次未上传镜像包（去掉 --no-build 重试）"
  log "复用现有镜像 ${IMAGE}（$(docker image inspect "${IMAGE}" --format '{{.Id}}' | cut -c1-20)）"
elif [ -f "${IMAGE_TARBALL}" ]; then
  log "载入上传的镜像包（$(du -h "${IMAGE_TARBALL}" | cut -f1)）"
  if ! gzip -dc "${IMAGE_TARBALL}" | docker load > /tmp/terminal-buddy-load.log 2>&1; then
    tail -n 10 /tmp/terminal-buddy-load.log >&2 || true
    fail "镜像载入失败：${IMAGE_TARBALL}"
  fi
  have_image "${IMAGE}" || fail "镜像载入后仍找不到 ${IMAGE}，请检查构建机的 tag"
  log "  ✓ 镜像已就绪：$(docker image inspect "${IMAGE}" --format '{{.Id}}' | cut -c1-20)"
else
  log "在目标机上构建镜像 ${IMAGE}（Rust release 编译，首次约 5-10 分钟）"

  # 基础镜像兜底：本地命中 → 备用镜像源。CentOS 7 直连 Docker Hub 常常不通。
  BASE_IMAGES=(
    "node:24-bookworm-slim"
    "rust:1-bookworm"
    "debian:bookworm-slim"
    "docker:28-cli"
  )
  if [ -n "${TB_IMAGE_MIRROR:-}" ]; then
    BASE_MIRRORS=("${TB_IMAGE_MIRROR}")
  else
    BASE_MIRRORS=(
      "docker.m.daocloud.io"
      "dockerproxy.net"
      "docker.xuanyuan.me"
      "docker.1ms.run"
    )
  fi

  # 统一拼成 <镜像源>/library/<name>:<tag>。TB_IMAGE_MIRROR 兼容两种写法：
  # 既接受裸镜像源（docker.m.daocloud.io），也接受旧脚本文档里的带后缀写法
  # （docker.m.daocloud.io/library），这里去掉重复的 /library，避免拼出两层。
  pull_base_image() {
    local name="${1%%:*}" tag="${1##*:}" mirror ref
    for mirror in "${BASE_MIRRORS[@]}"; do
      mirror="${mirror%/}"
      mirror="${mirror%/library}"
      ref="${mirror}/library/${name}:${tag}"
      if timeout 900 docker pull "${ref}" >/tmp/terminal-buddy-base-pull.log 2>&1; then
        docker tag "${ref}" "${name}:${tag}"
        docker rmi "${ref}" >/dev/null 2>&1 || true
        return 0
      fi
      log "    ${mirror} 不可用：$(tail -1 /tmp/terminal-buddy-base-pull.log 2>/dev/null | cut -c1-90)"
    done
    return 1
  }

  log "检查公共基础镜像"
  for img in "${BASE_IMAGES[@]}"; do
    if have_image "${img}"; then
      log "  ✓ ${img}（本地缓存命中，不访问网络）"
    else
      log "  拉取：${img}"
      pull_base_image "${img}" || fail "基础镜像 ${img} 不可用：本地无缓存、备用源均失败。可用 TB_IMAGE_MIRROR 换源后重试。"
      log "  ✓ ${img} 就绪"
    fi
  done

  # Docker 的 COPY 缓存按文件内容校验（不看 mtime），源码没变时连 build 都不发起。
  BUILD_INPUTS=(
    Dockerfile .dockerignore compose.yaml
    terminal-buddy/src terminal-buddy/web
    terminal-buddy/package.json terminal-buddy/package-lock.json
    terminal-buddy/src-tauri terminal-buddy/vite.config.ts terminal-buddy/index.html
    terminal-buddy/tsconfig.json terminal-buddy/tsconfig.node.json
  )
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
    if ! docker build -f Dockerfile -t "${IMAGE}" . > "${BUILD_LOG}" 2>&1; then
      tail -n 25 "${BUILD_LOG}" >&2 || true
      fail "Docker 镜像构建失败，完整日志：${BUILD_LOG}（线上容器未被改动）"
    fi
    log "  构建完成，命中缓存分层 $(grep -c 'CACHED' "${BUILD_LOG}" 2>/dev/null || echo 0) 个"
    tail -n 3 "${BUILD_LOG}" || true
  fi
fi

have_image "${IMAGE}" || fail "镜像 ${IMAGE} 不可用"
NEW_IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"

# ---------- 7. 实测挂载目录对容器内 uid 可写 ----------
# 健康检查无法证明挂载目录可写，必须在重建容器前用容器内实际 uid 落一次盘。
# 此时镜像一定存在，直接复用它，不必联网拉 alpine。
probe_write() {
  local dir="$1" label="$2"
  if ! docker run --rm --user "${APP_UID}:${APP_GID}" --entrypoint sh \
    -v "${dir}:/probe" "${IMAGE}" \
    -c 'touch /probe/.tb-write-probe && mkdir -p /probe/.tb-write-probe.d && rm -rf /probe/.tb-write-probe /probe/.tb-write-probe.d' \
    >/dev/null 2>&1; then
    fail "${label} 对容器内 uid ${APP_UID} 不可写：${dir}
       可在目标机上执行：chown -R ${APP_UID}:${APP_GID} ${dir} && chmod 755 ${dir}
       然后重新运行部署脚本。"
  fi
  log "  ✓ ${label} 可写（uid ${APP_UID}）：${dir}"
}
log "校验挂载目录写入权限"
probe_write "${DATA_DIR}" "数据目录"
probe_write "${HOME_DIR}" "用户目录"
probe_write "${WORKSPACE_DIR}" "工作区"

# ---------- 8. 重建容器 ----------
if command -v sha256sum >/dev/null 2>&1; then
  CONFIG_HASH="$(cat "${COMPOSE_FILE}" | sha256sum | cut -d' ' -f1)"
else
  CONFIG_HASH="$(cat "${COMPOSE_FILE}" | shasum -a 256 | cut -d' ' -f1)"
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

# ---------- 9. 等待健康检查 ----------
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

# ---------- 10. 校验容器内可访问宿主机 Docker socket ----------
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
docker exec --user terminalbuddy "${CONTAINER}" docker buildx version >/dev/null 2>&1 \
  || warn "容器内 docker buildx 不可用"
log "容器内 Docker 连接与 Compose 校验通过"

# 收尾：清理上传的临时包，源码目录留在 ${SRC_DIR} 供排障。
rm -f "${TARBALL}" "${IMAGE_TARBALL}" 2>/dev/null || true

docker ps --filter "name=${CONTAINER}" --format '{{.Names}} | {{.Status}} | {{.Ports}}'
exit 0
