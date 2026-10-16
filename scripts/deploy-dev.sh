#!/usr/bin/env bash
# TerminalBuddy 预览实例：重建镜像并重启（不影响 9610 生产实例）。
#
# 用法：
#   ./scripts/deploy-dev.sh              # 用当前源码重建镜像 + 重启预览容器
#   ./scripts/deploy-dev.sh --no-build   # 跳过构建，仅重启预览容器
#
# 源码目录默认为仓库根目录；预览实例的数据、家目录、工作区落在
# /root/terminal-buddy/dev/ 下，与生产实例完全隔离。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${TB_DEV_IMAGE:-terminal-buddy:dev}"
CONTAINER="${TB_DEV_CONTAINER:-terminal-buddy-dev}"
HOST_PORT="${TB_DEV_HOST_PORT:-9611}"
HOST_ROOT="${TB_DEV_ROOT:-/root/terminal-buddy/dev}"
COMPOSE_FILE="${REPO_DIR}/compose.dev.yaml"
PROJECT="${TB_DEV_PROJECT:-terminal-buddy-dev}"

log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    -h|--help)  sed -n '2,9p' "$0"; exit 0 ;;
    *) fail "未知参数：$arg（可用：--no-build / --help）" ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail "未检测到 docker"
docker info >/dev/null 2>&1 || fail "Docker 守护进程不可用"

# 预览实例与生产实例共用同一份 Dockerfile，保证预览结果可信。
[ -f "${REPO_DIR}/Dockerfile" ] || fail "缺少 ${REPO_DIR}/Dockerfile"
[ -f "${COMPOSE_FILE}" ] || fail "缺少 ${COMPOSE_FILE}"

# 预览实例以 uid 1000 运行，挂载目录必须存在且可写。
# 这些目录在宿主机上，从容器内操作需要经由临时容器完成。
if [ ! -d "${HOST_ROOT}/data" ]; then
  log "初始化预览实例目录 ${HOST_ROOT}"
  docker run --rm -v "${HOST_ROOT%/dev}:/host" alpine sh -c \
    "mkdir -p /host/dev/data /host/dev/home /host/dev/workspace && chown -R 1000:1000 /host/dev && chmod 755 /host/dev /host/dev/data /host/dev/home /host/dev/workspace"
fi

if [ "${DO_BUILD}" = "1" ]; then
  log "构建镜像 ${IMAGE}（Rust release 编译，约 5-10 分钟）"
  docker build -f "${REPO_DIR}/Dockerfile" -t "${IMAGE}" -t "${IMAGE}-$(date +%Y%m%d-%H%M%S)" "${REPO_DIR}"
else
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail "镜像 ${IMAGE} 不存在，无法使用 --no-build"
  log "跳过构建，复用现有镜像 ${IMAGE}"
fi

log "重启预览容器 ${CONTAINER}（生产实例 terminal-buddy 不受影响）"
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" up -d --force-recreate

log "等待健康检查通过"
for _ in $(seq 1 30); do
  HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${CONTAINER}" 2>/dev/null || echo unknown)"
  [ "${HEALTH}" = "healthy" ] && break
  [ "${HEALTH}" = "unhealthy" ] && break
  sleep 2
done

[ "${HEALTH}" = "healthy" ] || { docker logs --tail 40 "${CONTAINER}"; fail "健康检查未通过（当前：${HEALTH}）"; }

echo
log "预览实例已更新"
docker ps --filter "name=terminal-buddy" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
echo
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "  预览地址 : http://${HOST_IP:-<本机IP>}:${HOST_PORT}/"
echo "  数据目录 : ${HOST_ROOT}/data       -> 容器 /data"
echo "  工作区   : ${HOST_ROOT}/workspace  -> 容器 /workspace"
echo "  查看日志 : docker logs -f --tail 100 ${CONTAINER}"
echo "  停止实例 : docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down"
