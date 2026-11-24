#!/usr/bin/env bash
# 仅由 update.sh 放入独立容器执行；不能在待更新容器中直接运行。
# 不依赖 jq / Python，使用 inspect 的 JSON 和 Docker Engine API 克隆原部署。
set -euo pipefail
umask 077

STATE=/tmp/terminal-buddy-update
UPDATE_PUBLIC_DIR=/data/.terminal-buddy-update
UPDATE_LOG="${UPDATE_PUBLIC_DIR}/update.log"
KEEP_ROLLBACK="${KEEP_ROLLBACK:-0}"
CLEANUP_DELAY="${CLEANUP_DELAY:-10}"
CLEANUP_NAME="${CLEANUP_NAME:-${UPDATER}-cleanup}"
mkdir -p "${STATE}"

# 完整更新日志放在持久数据目录，网页终端断开后仍可手动查看。
mkdir -p "${UPDATE_PUBLIC_DIR}"
# 仅首次启动时初始化；自动重试回退不能覆盖上次的构建与切换日志。
if [ ! -f "${STATE}/log-initialized" ]; then
  if [ -f /tmp/tb-update-build.log ]; then
    cat /tmp/tb-update-build.log > "${UPDATE_LOG}"
  else
    : > "${UPDATE_LOG}"
  fi
  touch "${STATE}/log-initialized"
fi
chmod 0755 "${UPDATE_PUBLIC_DIR}"
chmod 0644 "${UPDATE_LOG}"
exec 3>&1
exec > >(tee -a "${UPDATE_LOG}") 2>&1
LOG_WRITER_PID=$!

# 退出前等待日志写入完成，保留最后的更新或回退结果。
flush_update_log() {
  exec 1>&3 2>&3 3>&-
  wait "${LOG_WRITER_PID}" || true
}

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { printf '[错误] %s\n' "$*" >&2; exit 1; }
docker() { command docker --host unix:///var/run/docker.sock "$@"; }

wait_healthy() {
  local id="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) consecutive=0 status health
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    status="$(docker inspect --format '{{.State.Status}}' "${id}" 2>/dev/null)" || return 1
    case "${status}" in exited|dead|removing) return 1 ;; esac
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${id}")" || return 1
    if [ "${status}" = running ] && { [ "${health}" = healthy ] || [ "${health}" = none ]; } \
      && docker exec "${id}" curl --fail --silent --max-time 3 \
        "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
      consecutive=$((consecutive + 1))
      [ "${consecutive}" -ge 3 ] && return 0
    else
      consecutive=0
    fi
    sleep 3
  done
  return 1
}

restore_directory() {
  local path="$1" archive="$2"
  [ -f "${archive}" ] || return 1
  # 仅清空预先确认的两个绑定目录；保留挂载点本身、目录属主及权限。
  case "${path}" in /data|/home/terminalbuddy) ;; *) return 1 ;; esac
  if [ "${path}" = /data ]; then
    # 更新日志不属于业务快照；保留目录及打开的日志文件，便于排查回退结果。
    find "${path}" -mindepth 1 -maxdepth 1 ! -name .terminal-buddy-update -exec rm -rf -- {} + || return 1
  else
    find "${path}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || return 1
  fi
  tar --acls --xattrs --numeric-owner --same-owner -xpf "${archive}" -C "${path}" || return 1
}

rollback() {
  local candidate_id='' existing_id name restart_policy previous_tag
  if [ -f "${STATE}/candidate-id" ]; then
    candidate_id="$(cat "${STATE}/candidate-id")" || return 1
  else
    candidate_id="$(docker inspect --format '{{.Id}}' "${CANDIDATE_NAME}" 2>/dev/null)" || candidate_id=''
  fi
  if [ -n "${candidate_id}" ]; then
    [ "${candidate_id}" != "${OLD_ID}" ] || return 1
    # 用成功的列表请求确认是否存在；不能把 Docker API 故障当成容器不存在。
    existing_id="$(docker ps --all --quiet --no-trunc --filter "id=${candidate_id}")" || return 1
    if [ -n "${existing_id}" ]; then
      [ "${existing_id}" = "${candidate_id}" ] || return 1
      # 必须确认新版已经停止且移除，才允许覆盖共享数据。
      docker logs --tail 80 "${candidate_id}" >&2 2>&1 || true
      docker rm --force "${candidate_id}" >/dev/null || return 1
    fi
  fi
  if [ ! -f "${STATE}/switch-started" ]; then
    log "切换尚未开始，原服务保持运行"
    return 0
  fi

  log "开始回退到原容器 ${OLD_ID:0:12}"
  if [ -f "${STATE}/data-may-have-changed" ] && [ ! -f "${STATE}/data-restored" ]; then
    # 新版可能执行过数据库迁移，不能只换回旧镜像；一并恢复完整 data/home。
    log "恢复更新前的数据与用户目录快照"
    [ -f "${STATE}/snapshot-complete" ] || return 1
    restore_directory /data "${STATE}/data.tar" || return 1
    restore_directory /home/terminalbuddy "${STATE}/home.tar" || return 1
    sync -f /data || return 1
    sync -f /home/terminalbuddy || return 1
    touch "${STATE}/data-restored" || return 1
    sync -f "${STATE}" || return 1
  fi
  name="$(docker inspect --format '{{.Name}}' "${OLD_ID}")" || return 1
  if [ "${name}" != "/${CONTAINER}" ]; then
    docker rename "${OLD_ID}" "${CONTAINER}" || return 1
  fi
  restart_policy="$(cat "${STATE}/restart-policy")" || return 1
  docker update --restart "${restart_policy}" "${OLD_ID}" >/dev/null || return 1
  docker start "${OLD_ID}" >/dev/null || return 1
  wait_healthy "${OLD_ID}" || return 1
  if [ -f "${STATE}/tag-may-have-changed" ]; then
    previous_tag="$(cat "${STATE}/previous-tag")" || return 1
    if [ -n "${previous_tag}" ]; then
      docker tag "${previous_tag}" "${IMAGE}" || return 1
    else
      docker image rm "${IMAGE}" >/dev/null || return 1
    fi
  fi
  log "回退成功：原容器已恢复名称、重启策略，且健康检查通过"
}

# 成功提交后启动一个 AutoRemove 清理容器，由它等待本容器退出并删除回退容器。
# 这样即使 update.sh 使用 --detach 或原网页终端已断开，也不会留下成功的更新容器。
schedule_cleanup() {
  local status
  [ "${KEEP_ROLLBACK}" = 0 ] || return 0
  if docker inspect --type container "${CLEANUP_NAME}" >/dev/null 2>&1; then
    status="$(docker inspect --format '{{.State.Status}}' "${CLEANUP_NAME}")"
    [ "${status}" = removing ] && return 0
    if [ "${status}" != running ]; then
      docker start "${CLEANUP_NAME}" >/dev/null || return 1
    fi
  else
    rm -f "${STATE}/cleanup-scheduled"
    docker create --rm --name "${CLEANUP_NAME}" --network none --user 0 --workdir /tmp \
      --volume /var/run/docker.sock:/var/run/docker.sock --restart=no \
      --env UPDATER="${UPDATER}" --env BACKUP_NAME="${BACKUP_NAME}" \
      --env CANDIDATE_IMAGE="${CANDIDATE_IMAGE}" --env CLEANUP_DELAY="${CLEANUP_DELAY}" \
      --label "terminal-buddy.update.target=${CONTAINER}" \
      --entrypoint /bin/bash "${OLD_IMAGE_ID}" -euc '
        code="$(docker wait "${UPDATER}")"
        [ "${code}" = 0 ] || exit 0
        sleep "${CLEANUP_DELAY}"
        docker rm "${BACKUP_NAME}" >/dev/null 2>&1 || true
        docker image rm "${CANDIDATE_IMAGE}" "${CANDIDATE_IMAGE}-rollback" >/dev/null 2>&1 || true
        docker rm "${UPDATER}" >/dev/null
      ' >/dev/null || return 1
    docker start "${CLEANUP_NAME}" >/dev/null || return 1
  fi
  touch "${STATE}/cleanup-scheduled"
  sync -f "${STATE}"
}

finish() {
  local code="$?"
  trap - EXIT
  # 回退过程中忽略终端信号，避免恢复一半再次被打断。
  trap '' HUP INT TERM
  set +e
  if [ -f "${STATE}/committed" ]; then
    chmod 0644 "${UPDATE_LOG}" 2>/dev/null || true
    docker update --restart=no "${UPDATER}" >/dev/null 2>&1
    if [ "${KEEP_ROLLBACK}" = 1 ]; then
      log "更新已提交；旧容器、快照与日志保留供回退排查"
    else
      schedule_cleanup || log "警告：自动清理任务启动失败，请稍后手动清理 ${BACKUP_NAME} 与 ${UPDATER}"
    fi
    flush_update_log
    exit 0
  fi
  [ "${code}" -ne 0 ] || code=1
  if rollback; then
    printf 'rolled-back\n' > "${STATE}/result"
    chmod 0644 "${UPDATE_LOG}" 2>/dev/null || true
    docker update --restart=no "${UPDATER}" >/dev/null 2>&1
    log "更新失败，原服务已保留或恢复；更新任务与快照保留供排查"
    flush_update_log
    exit "${code}"
  fi
  printf 'rollback-failed\n' > "${STATE}/result"
  chmod 0644 "${UPDATE_LOG}" 2>/dev/null || true
  log "回退未完成，Docker 将自动重启更新任务继续恢复。请勿删除原容器或本更新容器。" >&2
  log "查看日志：docker logs ${UPDATER}；恢复材料：${UPDATER}:${STATE}/" >&2
  flush_update_log
  exit 2
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# updater 异常退出后再次启动时，只恢复旧服务，不重新切换到新版。
if [ -f "${STATE}/committed" ]; then
  log "此前更新已提交"
  exit 0
fi
if [ -f "${STATE}/initialized" ]; then
  log "检测到上次任务中断，执行恢复流程"
  exit 1
fi

log "检查原服务及原部署配置"
for tool in docker curl tar find rm rmdir mktemp sync; do
  command -v "${tool}" >/dev/null 2>&1 || fail "原镜像缺少更新工具：${tool}"
done
[ "$(docker inspect --format '{{.Id}}' "${CONTAINER}")" = "${OLD_ID}" ] || fail "原容器已改变"
wait_healthy "${OLD_ID}" || fail "切换前原服务健康检查失败"
# 更新容器显式绑定宿主机的当前 socket：Docker 重建 socket 后，原容器可能仍绑定旧 inode。
# 以宿主机引擎作为基线，允许本次重建修复旧挂载；新版仍须严格复查用户权限和引擎身份。
docker info --format '{{.ID}}' > "${STATE}/old-engine-id"
if OLD_ENGINE_ID="$(docker exec --user terminalbuddy "${OLD_ID}" docker info --format '{{.ID}}' 2>"${STATE}/old-engine-error.log")"; then
  [ "${OLD_ENGINE_ID}" = "$(cat "${STATE}/old-engine-id")" ] \
    || fail "原服务连接的 Docker Engine 与宿主机不一致"
else
  log "原容器的 Docker 连接不可用，将通过重建刷新 socket 挂载，并在新版中复查"
fi
docker inspect "${OLD_ID}" > "${STATE}/original-container.json"
RESTART_NAME="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "${OLD_ID}")"
RESTART_MAX="$(docker inspect --format '{{.HostConfig.RestartPolicy.MaximumRetryCount}}' "${OLD_ID}")"
RESTART_POLICY="${RESTART_NAME:-no}"
if [ "${RESTART_NAME}" = on-failure ] && [ "${RESTART_MAX}" -gt 0 ]; then
  RESTART_POLICY="on-failure:${RESTART_MAX}"
fi
printf '%s\n' "${RESTART_POLICY}" > "${STATE}/restart-policy"
docker image inspect --format '{{.Id}}' "${IMAGE}" > "${STATE}/previous-tag" 2>/dev/null || : > "${STATE}/previous-tag"
touch "${STATE}/initialized"
sync -f "${STATE}"
# 工具和恢复状态就绪后再启用自动恢复，避免不兼容的旧工具镜像反复空转。
docker update --restart=unless-stopped "${UPDATER}" >/dev/null
NEW_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${CANDIDATE_IMAGE}")"
# 给旧镜像保留一个明确的标签，避免后续清理悬空镜像时丢失回退版本。
docker tag "${OLD_IMAGE_ID}" "${CANDIDATE_IMAGE}-rollback"

# 使用原 Config / HostConfig，仅替换 Image。包含端口、环境变量、用户、命令、
# restart、group_add、资源限制和所有绑定挂载，不另行生成可能覆盖配置的 Compose。
CONFIG_JSON="$(docker inspect --format '{{json .Config}}' "${OLD_ID}")"
OLD_CONFIG_IMAGE_JSON="$(docker inspect --format '{{json .Config.Image}}' "${OLD_ID}")"
NEW_IMAGE_JSON="$(docker image inspect --format '{{json .Id}}' "${NEW_IMAGE_ID}")"
IMAGE_FIELD="\"Image\":${OLD_CONFIG_IMAGE_JSON}"
[[ "${CONFIG_JSON}" == *"${IMAGE_FIELD}"* ]] || fail "无法定位原容器的镜像配置"
CONFIG_JSON="${CONFIG_JSON/"${IMAGE_FIELD}"/"\"Image\":${NEW_IMAGE_JSON}"}"
HOST_CONFIG_JSON="$(docker inspect --format '{{json .HostConfig}}' "${OLD_ID}")"
# 保留网络、别名和驱动选项；不拷贝旧 EndpointID、动态 IP/MAC 等运行时字段。
NETWORKS_JSON="$(docker inspect --format '{{ $first := true }}{ {{range $name, $net := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{ $first = false }}{{json $name}}:{"Aliases":{{json $net.Aliases}},"Links":{{json $net.Links}},"DriverOpts":{{json $net.DriverOpts}}}{{end}} }' "${OLD_ID}")"
printf '%s,"HostConfig":%s,"NetworkingConfig":{"EndpointsConfig":%s}}\n' \
  "${CONFIG_JSON%\}}" "${HOST_CONFIG_JSON}" "${NETWORKS_JSON}" > "${STATE}/create.json"
API_VERSION="$(docker version --format '{{.Server.APIVersion}}')"
log "先创建停止状态的候选容器，确认原部署配置可以复用"
HTTP_STATUS="$(curl --silent --show-error --max-time 60 --unix-socket /var/run/docker.sock \
  --output "${STATE}/create-response.json" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' --data-binary "@${STATE}/create.json" \
  "http://localhost/v${API_VERSION}/containers/create?name=${CANDIDATE_NAME}")"
if [ "${HTTP_STATUS}" != 201 ]; then
  cat "${STATE}/create-response.json" >&2
  fail "候选容器创建失败（HTTP ${HTTP_STATUS}），原服务未停止"
fi
docker inspect --format '{{.Id}}' "${CANDIDATE_NAME}" > "${STATE}/candidate-id.tmp"
mv "${STATE}/candidate-id.tmp" "${STATE}/candidate-id"
CANDIDATE_ID="$(cat "${STATE}/candidate-id")"

# 镜像和候选容器准备就绪后再倒计时，避免提示后仍等待部署前检查。
log "部署准备就绪；连接断开后独立更新任务仍会继续执行"
for ((remaining = 10; remaining > 0; remaining--)); do
  log "${remaining} 秒后开始部署，网页终端将会断开连接"
  sleep 1
done

# 从此处起任意错误/中断都必须恢复旧容器的重启策略和运行状态。
touch "${STATE}/switch-started"
sync -f "${STATE}"
docker update --restart=no "${OLD_ID}" >/dev/null
log "停止旧服务，备份 data/home（含 SQLite、密钥和 CLI 配置；备份期间暂停服务）"
docker stop --time 20 "${OLD_ID}" >/dev/null
[ "$(docker inspect --format '{{.State.Running}}' "${OLD_ID}")" = false ] || fail "旧容器未停止"
tar --acls --xattrs --numeric-owner --exclude=./.terminal-buddy-update \
  -cpf "${STATE}/data.tar" -C /data .
tar --acls --xattrs --numeric-owner -cpf "${STATE}/home.tar" -C /home/terminalbuddy .
touch "${STATE}/snapshot-complete"

docker rename "${OLD_ID}" "${BACKUP_NAME}"
docker rename "${CANDIDATE_ID}" "${CONTAINER}"
# 在 start 前落盘：即使启动部分成功后命令报错，也必须恢复可能迁移过的数据。
touch "${STATE}/data-may-have-changed"
# 同步快照及恢复标记后才允许新版写数据，保证 Docker 重启后能读取恢复材料。
sync -f "${STATE}"
docker start "${CANDIDATE_ID}" >/dev/null
log "等待新版健康检查与连续三次 HTTP 检查通过"
wait_healthy "${CANDIDATE_ID}" || fail "新版未能稳定通过健康检查"

# 不只检查 HTTP，也确认容器用户能写持久目录、能操作同一个宿主 Docker。
docker exec --user terminalbuddy "${CANDIDATE_ID}" /bin/bash -euc '
  for dir in /data /home/terminalbuddy; do
    probe="$(mktemp -d "${dir}/.tb-update-probe.XXXXXX")"
    rmdir -- "${probe}"
  done
'
NEW_ENGINE_ID="$(docker exec --user terminalbuddy "${CANDIDATE_ID}" docker info --format '{{.ID}}')"
[ "${NEW_ENGINE_ID}" = "$(cat "${STATE}/old-engine-id")" ] || fail "新版无法连接同一宿主机 Docker Engine"
# 最后发布正式镜像标签和提交标记；在此之前都可自动回退。
touch "${STATE}/tag-may-have-changed"
docker tag "${NEW_IMAGE_ID}" "${IMAGE}"
printf 'updated\n' > "${STATE}/result"
touch "${STATE}/committed"
sync -f "${STATE}"
log "更新成功：${CONTAINER}，镜像 ${NEW_IMAGE_ID:0:19}"
if [ "${KEEP_ROLLBACK}" = 1 ]; then
  log "旧容器 ${BACKUP_NAME} 保持停止且禁止自动重启；旧镜像、data/home 快照均已保留"
  log "快照导出：docker cp ${UPDATER}:${STATE}/ ./terminal-buddy-update-backup"
else
  log "${CLEANUP_DELAY} 秒后自动清理旧容器、更新容器和临时镜像标签"
fi
