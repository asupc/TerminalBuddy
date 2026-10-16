#!/usr/bin/env bash
# TerminalBuddy：CentOS 7 / Docker 一键部署脚本（在项目根目录执行）
#
# 用法：
#   ./deploy-centos.sh              # 构建镜像 + 启动容器
#   ./deploy-centos.sh --no-build   # 跳过构建，用现有镜像重建容器
#   ./deploy-centos.sh --pull       # 构建前先 git pull 拉取最新代码
#
# 可选环境变量：
#   TB_HOST_PORT=9610         宿主机映射端口
#   TB_DATA_DIR=/root/terminal-buddy/data
#   TB_HOME_DIR=/root/terminal-buddy/home
#   TB_WORKSPACE=/root/terminal-buddy/workspace
#   TB_USERNAME=admin
#   TB_DOCKER_SOCKET=/var/run/docker.sock
#   TB_IMAGE_MIRROR=docker.m.daocloud.io/library   基础镜像加速源
set -euo pipefail

cd "$(dirname "$0")"

log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\033[33m[WARN] %s\033[0m\n' "$*"; }
fail() { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

# 单引号保护 YAML 标量，双写 $ 防止 Compose 把路径内容当成变量插值。
yaml_value() {
  local value="${1//\'/\'\'}"
  value="${value//\$/\$\$}"
  printf "'%s'" "$value"
}

DO_BUILD=1
DO_PULL=0
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --pull)     DO_PULL=1 ;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
    *) fail "未知参数：$arg（可用：--no-build / --pull / --help）" ;;
  esac
done

# ---------- 运行环境检查 ----------
command -v docker >/dev/null 2>&1 || fail "未检测到 docker，请先安装：yum install -y docker-ce && systemctl enable --now docker"
docker info >/dev/null 2>&1 || fail "Docker 守护进程未运行：systemctl start docker"
docker compose version >/dev/null 2>&1 || fail "未检测到 docker compose v2，请安装 docker-compose-plugin"
command -v curl >/dev/null 2>&1 || fail "缺少 curl，请先安装：yum install -y curl"

[ -f Dockerfile ] || fail "当前目录没有 Dockerfile，请把脚本放在项目根目录"
[ -d terminal-buddy/src-tauri ] || fail "缺少 terminal-buddy/src-tauri，源码不完整"

# ---------- 基础镜像兜底（CentOS 7 直连 Docker Hub 常不通） ----------
MIRROR="${TB_IMAGE_MIRROR:-docker.m.daocloud.io/library}"
ensure_base_image() {
  local repo="$1" tag="$2" ref="$1:$2"
  if docker image inspect "$ref" >/dev/null 2>&1; then
    log "基础镜像已就绪：$ref"
    return 0
  fi
  log "拉取基础镜像：$MIRROR/$repo:$tag"
  docker pull "$MIRROR/$repo:$tag" || fail "拉取 $MIRROR/$repo:$tag 失败，可用 TB_IMAGE_MIRROR 换源后重试"
  docker tag "$MIRROR/$repo:$tag" "$ref"
}
ensure_base_image node 24-bookworm-slim
ensure_base_image rust 1-bookworm
ensure_base_image debian bookworm-slim
ensure_base_image docker 28-cli

# ---------- 可选：拉取最新代码 ----------
if [ "$DO_PULL" = "1" ]; then
  if [ -d .git ]; then
    log "拉取最新代码：git pull --ff-only"
    git pull --ff-only
  else
    warn "当前目录不是 git 仓库，跳过 --pull"
  fi
fi

# ---------- 变量 ----------
HOST_PORT="${TB_HOST_PORT:-9610}"
CONTAINER_PORT=9600
IMAGE="${TB_IMAGE:-terminal-buddy:server}"
CONTAINER="${TB_CONTAINER:-terminal-buddy}"
USERNAME="${TB_USERNAME:-admin}"
BIND_ADDRESS="${TB_BIND_ADDRESS:-0.0.0.0}"
DATA_DIR="${TB_DATA_DIR:-/root/terminal-buddy/data}"
HOME_DIR="${TB_HOME_DIR:-/root/terminal-buddy/home}"
WORKSPACE_DIR="${TB_WORKSPACE:-/root/terminal-buddy/workspace}"
DOCKER_SOCKET="${TB_DOCKER_SOCKET:-/var/run/docker.sock}"
COMPOSE_FILE="compose.centos.yaml"
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

# Docker 客户端连接的必须是当前宿主机；远端 context 的路径无法在本机挂载。
if [ -n "${DOCKER_CONTEXT:-}" ]; then
  DOCKER_ENDPOINT="$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')"
else
  DOCKER_ENDPOINT="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}"
fi
[ "$DOCKER_ENDPOINT" = "unix://$DOCKER_SOCKET" ] || fail "当前 Docker 连接为 ${DOCKER_ENDPOINT}，请使用本机 socket，或用 TB_DOCKER_SOCKET 指定对应路径"
[ -S "$DOCKER_SOCKET" ] || fail "Docker socket 不存在：${DOCKER_SOCKET}"
DOCKER_GID="$(stat -c '%g' "$DOCKER_SOCKET")"
case "$DOCKER_GID" in ''|*[!0-9]*) fail "无法读取 Docker socket 的数字 GID" ;; esac
WORKSPACE_DIR="$(readlink -m -- "$WORKSPACE_DIR")"
# 工作区会以同路径挂载，不能覆盖镜像的用户、系统目录或应用数据。
case "$WORKSPACE_DIR" in
  /|/root|/data|/data/*|/home|/home/terminalbuddy|/home/terminalbuddy/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/usr|/usr/*|/etc|/etc/*|/var|/var/run|/var/run/*|/run|/run/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/opt|/opt/terminal-buddy|/opt/terminal-buddy/*)
    fail "工作区不能覆盖容器的系统或数据目录：${WORKSPACE_DIR}" ;;
esac
for protected_dir in "$DATA_DIR" "$HOME_DIR"; do
  protected_dir="$(readlink -m -- "$protected_dir")"
  case "$protected_dir/" in
    "$WORKSPACE_DIR/"*) fail "工作区不能包含应用数据或用户目录：${WORKSPACE_DIR}" ;;
  esac
done

# 端口占用检查（放行 docker-proxy 自己）
if command -v ss >/dev/null 2>&1; then
  BUSY="$(ss -lntp 2>/dev/null | awk -v p=":${HOST_PORT}$" '$4 ~ p {print $NF; exit}')"
  if [ -n "$BUSY" ] && ! printf '%s' "$BUSY" | grep -q 'docker-proxy'; then
    fail "宿主机端口 ${HOST_PORT} 已被占用：${BUSY}（可用 TB_HOST_PORT 换端口）"
  fi
fi

# 容器内以 uid 1000 运行，挂载目录必须可写
log "准备数据目录并授权（容器内 uid 1000）"
mkdir -p "$DATA_DIR" "$HOME_DIR" "$WORKSPACE_DIR"
chown -R 1000:1000 "$DATA_DIR" "$HOME_DIR" "$WORKSPACE_DIR"
chmod 755 "$DATA_DIR" "$HOME_DIR" "$WORKSPACE_DIR"

# ---------- 生成 compose ----------
log "写入 $COMPOSE_FILE"
cat > "$COMPOSE_FILE" <<EOF
services:
  terminal-buddy:
    image: ${IMAGE}
    container_name: ${CONTAINER}
    restart: unless-stopped
    ports:
      - "${BIND_ADDRESS}:${HOST_PORT}:${CONTAINER_PORT}"
    environment:
      TERMINAL_BUDDY_USERNAME: $(yaml_value "$USERNAME")
      TERMINAL_BUDDY_DATA_DIR: /data
      TERMINAL_BUDDY_WEB_DIST: /opt/terminal-buddy/web
      TERMINAL_BUDDY_WORKSPACE_DIR: $(yaml_value "$WORKSPACE_DIR")
      DOCKER_HOST: unix:///var/run/docker.sock
      TERMINAL_BUDDY_PORT: "${CONTAINER_PORT}"
      HOME: /home/terminalbuddy
      LANG: C.UTF-8
      TERM: xterm-256color
    group_add:
      - "${DOCKER_GID}"
    working_dir: $(yaml_value "$WORKSPACE_DIR")
    volumes:
      - type: bind
        source: $(yaml_value "$DATA_DIR")
        target: /data
        bind:
          create_host_path: false
      - type: bind
        source: $(yaml_value "$HOME_DIR")
        target: /home/terminalbuddy
        bind:
          create_host_path: false
      - type: bind
        source: $(yaml_value "$WORKSPACE_DIR")
        target: /workspace
        bind:
          create_host_path: false
      - type: bind
        source: $(yaml_value "$DOCKER_SOCKET")
        target: /var/run/docker.sock
        bind:
          create_host_path: false
EOF
if [ "$WORKSPACE_DIR" != "/workspace" ]; then
  # 保留 /workspace 供已有项目使用，新项目使用与宿主机相同的绝对路径。
  cat >> "$COMPOSE_FILE" <<EOF
      - type: bind
        source: $(yaml_value "$WORKSPACE_DIR")
        target: $(yaml_value "$WORKSPACE_DIR")
        bind:
          create_host_path: false
EOF
fi
printf '    stop_grace_period: 20s\n' >> "$COMPOSE_FILE"
docker compose -f "$COMPOSE_FILE" config --quiet

# ---------- 构建镜像 ----------
if [ "$DO_BUILD" = "1" ]; then
  log "构建镜像 ${IMAGE}（Rust release 编译，首次约 5-10 分钟）"
  docker build -f Dockerfile -t "$IMAGE" . 2>&1 | tail -n 20
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "镜像 ${IMAGE} 不存在，无法使用 --no-build"
  log "跳过构建，复用现有镜像 ${IMAGE}"
fi

# ---------- 校验镜像运行依赖 ----------
log "校验镜像中的进程查询命令（Codex 后台服务依赖）"
docker run --rm --user terminalbuddy --entrypoint /bin/sh "$IMAGE" \
  -c 'command -v ps && ps -p "$$" -o pid=,ppid=,args=' \
  || fail "镜像中的 ps 不可用，Codex 后台服务无法启动。请更新源码并完整构建镜像，不要使用 --no-build"

# ---------- 启动容器 ----------
log "启动容器 ${CONTAINER}"
docker compose -f "$COMPOSE_FILE" up -d --force-recreate

CID="$(docker compose -f "$COMPOSE_FILE" ps -q terminal-buddy)"
[ -n "$CID" ] || { docker compose -f "$COMPOSE_FILE" logs --tail 40; fail "容器未创建成功"; }

log "等待健康检查通过"
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CID" 2>/dev/null || echo unknown)"
  [ "$HEALTH" = "healthy" ] && break
  [ "$HEALTH" = "unhealthy" ] && break
  sleep 2
done

if [ "$HEALTH" != "healthy" ]; then
  docker compose -f "$COMPOSE_FILE" logs --tail 40
  fail "健康检查未通过（当前：${HEALTH}）。排查：docker logs --tail 100 ${CONTAINER}"
fi

log "校验容器内 Docker 客户端与宿主机连接（uid 1000）"
docker exec --user terminalbuddy "$CID" docker version || fail "容器内无法连接宿主机 Docker，请检查 socket 挂载、GID 和镜像版本"
docker exec --user terminalbuddy "$CID" docker compose version || fail "镜像缺少 Docker Compose，请完整构建镜像，不要使用 --no-build"
docker exec --user terminalbuddy "$CID" docker buildx version || fail "镜像缺少 Docker Buildx，请完整构建镜像"
HOST_DOCKER_ID="$(docker info --format '{{.ID}}')"
CONTAINER_DOCKER_ID="$(docker exec --user terminalbuddy "$CID" docker info --format '{{.ID}}')"
[ -n "$HOST_DOCKER_ID" ] && [ "$HOST_DOCKER_ID" = "$CONTAINER_DOCKER_ID" ] || fail "容器与宿主机没有连接同一个 Docker Engine"

# ---------- 外部可达性验证 ----------
CODE_LAN="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://${HOST_IP}:${HOST_PORT}/api/auth/status" || true)"
CODE_LOOP="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/api/auth/status" || true)"

echo
log "部署完成"
docker ps --filter "name=${CONTAINER}" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
echo
echo "  容器名   : ${CONTAINER}"
echo "  镜像     : ${IMAGE}"
echo "  数据目录 : ${DATA_DIR}       -> 容器 /data"
echo "  用户目录 : ${HOME_DIR}       -> 容器 /home/terminalbuddy"
echo "  工作区   : ${WORKSPACE_DIR}  -> 容器同路径（兼容 /workspace）"
echo "  Docker   : ${DOCKER_SOCKET} -> 容器 /var/run/docker.sock（GID ${DOCKER_GID}）"
echo "  访问地址 : http://${HOST_IP}:${HOST_PORT}/"
echo "  登录账号 : ${USERNAME}"
echo "  登录密码 : 首次访问网页时设置（至少 8 位）"
echo
echo "  查看日志 : docker logs -f --tail 100 ${CONTAINER}"
echo "  重启服务 : docker restart ${CONTAINER}"
echo "  停止服务 : docker compose -f $(pwd)/${COMPOSE_FILE} down"
echo

[ "$CODE_LAN" = "200" ] && log "局域网自检 http://${HOST_IP}:${HOST_PORT}/ -> 200" || warn "局域网自检返回 ${CODE_LAN}，请检查绑定地址与防火墙"
if [ "$CODE_LOOP" = "000" ] && [ "$BIND_ADDRESS" != "0.0.0.0" ]; then
  warn "127.0.0.1 不通属正常：端口绑定在 ${BIND_ADDRESS}"
fi
