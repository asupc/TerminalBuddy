#!/usr/bin/env bash
# TerminalBuddy 在飞牛 fnOS 上原地更新（也可在自己的网页终端中执行）。
# 使用当前目录的源码构建镜像，不拉代码，不修改原部署的端口、环境变量与挂载。
# 独立更新容器负责切换；失败时恢复 data/home 快照并重新启动原容器。
# 默认更新成功后自动清理旧容器、更新容器和临时镜像标签；--keep-rollback 可保留回退材料。
# 允许用户顺手输入 sh update.sh：尽早切回 Bash，避免 Bash 专用语法在 dash 中报错。
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

CONTAINER="${TB_FNOS_CONTAINER:-terminal-buddy}"
IMAGE="${TB_FNOS_IMAGE:-terminal-buddy:server}"
SOURCE_DIR="${PWD}"
HEALTH_TIMEOUT="${TB_UPDATE_HEALTH_TIMEOUT:-180}"
DETACH=0
KEEP_SHELL=1
KEEP_ROLLBACK="${TB_UPDATE_KEEP_ROLLBACK:-0}"
CLEANUP_DELAY="${TB_UPDATE_CLEANUP_DELAY:-10}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
emit_update_marker() {
  local phase="$1"
  printf '\033]7777;terminal-buddy-update;%s;%s\033\\' "${phase}" "${RUN_ID:-unknown}"
}
fail() {
  emit_update_marker end
  printf '[错误] %s\n' "$*" >&2
  exit 1
}
# 所有操作固定使用飞牛本机的 Docker，避免 context 指向其他主机。
docker() { command docker --host unix:///var/run/docker.sock "$@"; }

usage() {
  cat <<'HELP'
用法：在飞牛的源码根目录执行 bash update.sh [选项]

  --source-dir DIR       源码根目录，默认当前目录（需含 Dockerfile、terminal-buddy/）
  --container NAME       要更新的现有容器，默认 terminal-buddy
  --image IMAGE:TAG      成功后发布的镜像标签，默认 terminal-buddy:server
  --health-timeout SEC   新旧服务健康检查的最长等待秒数，默认 180
  --detach              启动独立更新容器后立即返回，不跟随日志
  --exit-on-success     更新成功后直接结束脚本，不进入交互式 Bash
  --keep-rollback       成功后保留旧容器、更新容器、快照与临时镜像标签
  -h, --help            显示帮助

不执行 git pull。构建时旧服务继续运行，切换和快照备份期间会短暂中断。
可从宿主机或自己的网页终端执行；新版网页会保留原窗口、持续重连并显示更新日志。
更新或失败回退仍由独立容器继续执行，浏览器刷新或断开不影响结果。
需能访问 /var/run/docker.sock；宿主机账号无权限时使用 sudo bash update.sh。
默认更新成功后自动清理旧容器、更新容器和临时镜像标签；失败时更新日志、
data/home 快照会保存在独立更新容器中供回退和排查，不会自动删除。
可设置 TB_UPDATE_KEEP_ROLLBACK=1 或使用 --keep-rollback 保留成功更新的回退材料；
TB_UPDATE_CLEANUP_DELAY 可调整清理前保留秒数（默认 10 秒）。
交互终端中更新成功后会进入 Bash 命令行，保留窗口并可继续操作。
更新自身容器时原网页终端仍会断开；需要保留窗口时请从飞牛 SSH 终端运行。
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-dir) SOURCE_DIR="${2:?--source-dir 需要目录}"; shift ;;
    --container) CONTAINER="${2:?--container 需要容器名}"; shift ;;
    --image) IMAGE="${2:?--image 需要镜像标签}"; shift ;;
    --health-timeout) HEALTH_TIMEOUT="${2:?--health-timeout 需要秒数}"; shift ;;
    --detach) DETACH=1 ;;
    --exit-on-success) KEEP_SHELL=0 ;;
    --keep-rollback) KEEP_ROLLBACK=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数：$1（运行 bash update.sh --help 查看用法）" ;;
  esac
  shift
done

[[ "${CONTAINER}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail "容器名无效"
[[ "${HEALTH_TIMEOUT}" =~ ^[1-9][0-9]{0,4}$ ]] || fail "健康检查超时需为 1～99999 的整数"
[[ "${KEEP_ROLLBACK}" =~ ^[01]$ ]] || fail "TB_UPDATE_KEEP_ROLLBACK 需为 0 或 1"
[[ "${CLEANUP_DELAY}" =~ ^[1-9][0-9]{0,3}$ ]] || fail "TB_UPDATE_CLEANUP_DELAY 需为 1～999 的整数"
[[ "${IMAGE}" != *@* && "${IMAGE}" != sha256:* ]] || fail "--image 需要可写的镜像标签，不能是摘要"
# 在没有显式标签时补 latest，避免把更新后缀误拼到镜像仓库名上。
if [[ "${IMAGE##*/}" != *:* ]]; then IMAGE="${IMAGE}:latest"; fi
SOURCE_DIR="$(cd -- "${SOURCE_DIR}" && pwd -P)"
WORKER_SCRIPT="${SCRIPT_DIR}/scripts/update-fnos-container.sh"
for file in Dockerfile .dockerignore terminal-buddy/package-lock.json \
  terminal-buddy/web/package-lock.json terminal-buddy/src-tauri/Cargo.lock; do
  [ -f "${SOURCE_DIR}/${file}" ] || fail "源码不完整，缺少 ${SOURCE_DIR}/${file}"
done
for dir in terminal-buddy/src terminal-buddy/web/src terminal-buddy/src-tauri/src \
  terminal-buddy/src-tauri/portable-pty-patched; do
  [ -d "${SOURCE_DIR}/${dir}" ] || fail "源码不完整，缺少 ${SOURCE_DIR}/${dir}"
done
[ -f "${WORKER_SCRIPT}" ] || fail "缺少独立更新脚本 ${WORKER_SCRIPT}"
command -v docker >/dev/null 2>&1 || fail "未检测到 docker"
[ -S /var/run/docker.sock ] || fail "未找到 /var/run/docker.sock"
docker info >/dev/null 2>&1 || fail "无法访问飞牛 Docker，请确认服务已启动且当前账号有权限"

OLD_ID="$(docker inspect --type container --format '{{.Id}}' "${CONTAINER}")"
OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${OLD_ID}")"
[ "$(docker inspect --format '{{.State.Running}}' "${OLD_ID}")" = true ] \
  || fail "原容器未运行，无法建立可用的回退基线：${CONTAINER}"
[ "$(docker inspect --format '{{.HostConfig.AutoRemove}}' "${OLD_ID}")" = false ] \
  || fail "不支持 --rm 容器：停止后原容器会被自动删除"
[ -z "$(docker inspect --format '{{.HostConfig.ContainerIDFile}}' "${OLD_ID}")" ] \
  || fail "不支持配置了 cidfile 的容器，复用它会影响原容器"
case "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "${OLD_ID}")" in
  container:*) fail "不支持共享其他容器网络命名空间的部署" ;;
esac

# 飞牛部署使用绑定挂载。对无法原样克隆的部署提前拒绝，保留旧服务。
# inspect 会在模板输出后追加换行；先捕获结果，同时确保读取失败能直接报错。
MOUNT_ROWS="$(docker inspect --format '{{range .Mounts}}{{printf "%s|%s|%s|%t\n" .Type .Source .Destination .RW}}{{end}}' "${OLD_ID}")" \
  || fail "无法读取原容器的挂载信息"
HAS_DATA=0
HAS_HOME=0
HAS_SOCKET=0
while IFS='|' read -r type source destination writable; do
  [ -n "${type}${source}${destination}${writable}" ] || continue
  [ "${type}" = bind ] || fail "仅支持 deploy-fnos.sh 的绑定挂载部署，发现 ${type}：${destination}"
  case "${destination}" in
    /data) [ "${writable}" = true ] || fail '/data 必须可写'; HAS_DATA=1 ;;
    /home/terminalbuddy) [ "${writable}" = true ] || fail '用户目录必须可写'; HAS_HOME=1 ;;
    /var/run/docker.sock)
      [ "${source}" = /var/run/docker.sock ] && [ "${writable}" = true ] \
        || fail "Docker socket 必须绑定宿主机 /var/run/docker.sock 并允许写入"
      HAS_SOCKET=1 ;;
    /tmp|/tmp/*) fail "更新任务需要独立的 /tmp，原容器不能绑定挂载此目录" ;;
    /data/*|/home/terminalbuddy/*) fail "快照目录中存在嵌套挂载，无法安全恢复：${destination}" ;;
  esac
done <<< "${MOUNT_ROWS}"
[ "${HAS_DATA}${HAS_HOME}${HAS_SOCKET}" = 111 ] || fail "原容器必须挂载 /data、/home/terminalbuddy 和 Docker socket"
[ -z "$(docker inspect --format '{{range $name, $net := .NetworkSettings.Networks}}{{if $net.IPAMConfig}}{{$name}}{{end}}{{end}}' "${OLD_ID}")" ] \
  || fail "原容器配置了静态 IP，保留旧容器时无法安全复用地址，请先改为动态地址"

APP_PORT=9600
while IFS= read -r entry; do
  case "${entry}" in TERMINAL_BUDDY_PORT=*) APP_PORT="${entry#*=}" ;; esac
done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${OLD_ID}")
[[ "${APP_PORT}" =~ ^[1-9][0-9]{0,4}$ ]] && [ "${APP_PORT}" -le 65535 ] || fail "原容器的服务端口无效"
docker exec "${OLD_ID}" curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null \
  || fail "原服务健康检查失败，请先恢复原服务后再更新"

# 清理旧版本脚本成功更新后留下的停止容器。当前服务已确认健康后才执行。
cleanup_stopped_update_containers() {
  local id name state restart removed=0
  while IFS=$'\t' read -r id name state; do
    [ -n "${id}" ] || continue
    case "${name}" in
      "${CONTAINER}-backup-"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*-[0-9]*|"${CONTAINER}-updater-history-"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*-[0-9]*) ;;
      *) continue ;;
    esac
    [ "${state}" = exited ] || continue
    restart="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "${id}")"
    [ "${restart}" = no ] || continue
    docker rm "${id}" >/dev/null
    removed=$((removed + 1))
  done < <(docker ps --all --format '{{.ID}}\t{{.Names}}\t{{.State}}')
  [ "${removed}" = 0 ] || log "已清理 ${removed} 个历史更新容器"
}
[ "${KEEP_ROLLBACK}" = 0 ] && cleanup_stopped_update_containers

UPDATER="${CONTAINER}-updater"
RUN_ID="$(date -u '+%Y%m%d%H%M%S')-$$-${RANDOM}"
CANDIDATE_IMAGE="${IMAGE}-update-${RUN_ID}"
BACKUP_NAME="${CONTAINER}-backup-${RUN_ID}"
CANDIDATE_NAME="${CONTAINER}-candidate-${RUN_ID}"
# 让浏览器端在旧容器停止前进入自更新监视模式，保留窗口并持续重连。
emit_update_marker start
if docker inspect --type container "${UPDATER}" >/dev/null 2>&1; then
  case "$(docker inspect --format '{{.State.Status}}' "${UPDATER}")" in
    exited)
      [ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "${UPDATER}")" = no ] \
        || fail "之前的更新任务仍等待自动恢复，请先查看 docker logs ${UPDATER}"
      if [ "${KEEP_ROLLBACK}" = 1 ]; then
        # 保留之前更新的快照和日志；不自动删除回退材料。
        docker rename "${UPDATER}" "${UPDATER}-history-${RUN_ID}"
      else
        docker rm "${UPDATER}" >/dev/null
      fi ;;
    *) fail "已有更新任务：${UPDATER}，请通过 docker logs 查看进度" ;;
  esac
fi

# 先占用固定的更新任务名，防止两次更新并发；此时不停止旧服务。
# 沿用旧镜像中的 bash/curl/docker，不依赖临时下载额外的更新工具镜像。
docker create --name "${UPDATER}" --network none --user 0 --workdir /tmp \
  --volumes-from "${OLD_ID}" --restart=no --stop-timeout 300 \
  --label "terminal-buddy.update.target=${CONTAINER}" \
  --env HOME=/tmp --env "CONTAINER=${CONTAINER}" --env "OLD_ID=${OLD_ID}" \
  --env "OLD_IMAGE_ID=${OLD_IMAGE_ID}" --env "IMAGE=${IMAGE}" \
  --env "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}" --env "BACKUP_NAME=${BACKUP_NAME}" \
  --env "CANDIDATE_NAME=${CANDIDATE_NAME}" --env "UPDATER=${UPDATER}" \
  --env "APP_PORT=${APP_PORT}" --env "HEALTH_TIMEOUT=${HEALTH_TIMEOUT}" \
  --env "KEEP_ROLLBACK=${KEEP_ROLLBACK}" --env "CLEANUP_DELAY=${CLEANUP_DELAY}" \
  --env "UPDATE_ID=${RUN_ID}" \
  --env "CLEANUP_NAME=${UPDATER}-cleanup" \
  --entrypoint /usr/bin/tini "${OLD_IMAGE_ID}" -- /bin/bash /tmp/tb-update-worker.sh >/dev/null

# 只清理尚未启动的更新任务；启动后无论终端断开还是 Ctrl+C，都由它继续负责。
WORKER_STARTED=0
cleanup() {
  if [ "${WORKER_STARTED}" = 0 ]; then
    docker rm "${UPDATER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
docker cp "${WORKER_SCRIPT}" "${UPDATER}:/tmp/tb-update-worker.sh"

log "使用当前源码构建：${SOURCE_DIR}（原服务保持运行，不执行 git pull）"
if ! docker build --file "${SOURCE_DIR}/Dockerfile" --tag "${CANDIDATE_IMAGE}" "${SOURCE_DIR}"; then
  fail "镜像构建失败，原容器、原镜像标签及数据均未切换"
fi
# 构建可能很久：切换前再次确认目标还是同一个运行中的容器。
[ "$(docker inspect --format '{{.Id}}' "${CONTAINER}")" = "${OLD_ID}" ] \
  && [ "$(docker inspect --format '{{.State.Running}}' "${OLD_ID}")" = true ] \
  || fail "构建期间原容器已被其他操作改变，停止本次更新"

emit_update_marker switch
log "启动独立更新任务；浏览器窗口会保持更新监视并自动重连"
log "新版网页会显示本地构建日志与独立更新容器日志，并在完成后自动重连"
if [ "${KEEP_ROLLBACK}" = 1 ]; then
  log "原容器将保留为 ${BACKUP_NAME}；快照保存在更新容器 /tmp/terminal-buddy-update/"
else
  log "更新成功后 ${CLEANUP_DELAY} 秒将自动清理旧容器、更新容器和临时镜像标签"
fi
# 先解除本进程的清理职责，避免 start 成功的一瞬间终端被关闭而误删更新任务。
WORKER_STARTED=1
if ! docker start "${UPDATER}" >/dev/null; then
  fail "更新任务未能启动，原服务未切换；请查看 docker inspect ${UPDATER}"
fi
if [ "${DETACH}" = 1 ]; then exit 0; fi

docker logs --follow "${UPDATER}" || true
EXIT_CODE="$(docker wait "${UPDATER}")"
[ "${EXIT_CODE}" = 0 ] || fail "更新未完成，退出码 ${EXIT_CODE}；回退结果与恢复材料位置见 docker logs ${UPDATER}"
log "更新完成：${CONTAINER}"
emit_update_marker end
if [ "${KEEP_SHELL}" = 1 ] && [ -t 0 ] && [ -t 1 ]; then
  log "终端已保留，可以继续输入命令；输入 exit 返回上级命令行或关闭窗口"
  # 更新已完成，移除脚本专用清理和信号处理，再交给交互式 shell。
  trap - EXIT HUP INT TERM
  exec /bin/bash -i
fi
