#!/usr/bin/env bash
# TerminalBuddy 部署后校验（由 deploy.bat 在服务器上调用，避免 Windows 批处理引号嵌套）
set -uo pipefail

CONTAINER="${TB_CONTAINER:-terminal-buddy}"
IMAGE="${TB_IMAGE:-terminal-buddy:server}"
HOST_PORT="${TB_HOST_PORT:-9610}"
CONTAINER_PORT="${TB_CONTAINER_PORT:-9600}"
STATUS=0

echo "==== 容器状态 ===="
docker ps --filter "name=${CONTAINER}" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || STATUS=1

echo
echo "==== 健康与重启策略 ===="
INSPECT="$(docker inspect -f 'health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} status={{.State.Status}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}' "${CONTAINER}" 2>/dev/null)"
echo "${INSPECT}"
case "${INSPECT}" in
  *"health=healthy"*) ;;
  *) echo "[警告] 健康状态异常"; STATUS=1 ;;
esac

echo
echo "==== HTTP 自检 ===="
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
CODE_LAN="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://${HOST_IP}:${HOST_PORT}/api/auth/status" || echo 000)"
echo "局域网 http://${HOST_IP}:${HOST_PORT}/api/auth/status -> ${CODE_LAN}"
[ "${CODE_LAN}" = "200" ] || STATUS=1

STATUS_JSON="$(curl -s -m 8 "http://${HOST_IP}:${HOST_PORT}/api/auth/status" || true)"
echo "认证状态: ${STATUS_JSON}"

echo
echo "==== 端口监听 ===="
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep -E ":${HOST_PORT}\b" || { echo "[警告] 未监听 ${HOST_PORT}"; STATUS=1; }
else
  netstat -lntp 2>/dev/null | grep -E ":${HOST_PORT}\b" || true
fi

echo
echo "==== 数据卷 ===="
docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "${CONTAINER}" 2>/dev/null

echo
echo "==== 容器进程查询（Codex 后台服务依赖） ===="
docker exec --user terminalbuddy "${CONTAINER}" sh -c 'command -v ps && ps -p "$$" -o pid=,ppid=,args=' || STATUS=1

echo
echo "==== 容器内访问宿主机 Docker（应用用户） ===="
docker exec --user terminalbuddy "${CONTAINER}" docker version || STATUS=1
docker exec --user terminalbuddy "${CONTAINER}" docker compose version || STATUS=1
docker exec --user terminalbuddy "${CONTAINER}" docker buildx version || STATUS=1
HOST_DOCKER_ID="$(docker info --format '{{.ID}}' 2>/dev/null)"
CONTAINER_DOCKER_ID="$(docker exec --user terminalbuddy "${CONTAINER}" docker info --format '{{.ID}}' 2>/dev/null)"
if [ -n "$HOST_DOCKER_ID" ] && [ "$HOST_DOCKER_ID" = "$CONTAINER_DOCKER_ID" ]; then
  echo "[OK] 容器与宿主机连接同一个 Docker Engine"
else
  echo "[FAIL] 容器未能连接宿主机 Docker Engine"
  STATUS=1
fi

if [ "${STATUS}" = "0" ]; then
  echo
  echo "[OK] 校验全部通过"
else
  echo
  echo "[FAIL] 存在异常项，请查看上面输出"
fi
exit "${STATUS}"
