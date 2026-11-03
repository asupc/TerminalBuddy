#!/usr/bin/env bash
# TerminalBuddy 统一更新入口：一条命令更新本机 systemd 服务与飞牛 fnOS Docker 容器。
#
# 用法（在任意目录执行均可，源码根目录取脚本所在仓库的根目录）：
#   bash xcj/update.sh                # 默认 all：先本机、验证通过后再飞牛
#   bash xcj/update.sh local          # 只更新本机 systemd 服务
#   bash xcj/update.sh fnos           # 只更新飞牛 fnOS 上的 Docker 容器
#
# 本机（local）流程：
#   git pull → 构建网页前端（build:web:desktop）→ 构建 server 二进制（cargo release）→
#   与已部署产物比对指纹，一致则跳过重启；有变化时备份旧二进制与 web 目录并原子替换 →
#   systemctl restart → /api/health 健康检查，失败自动回滚旧版本并再次重启。
#   若脚本正运行在 TerminalBuddy 自己的网页终端里（terminal-buddy-server 进程树内），
#   重启会断开当前会话（预期行为）：此时「重启 + 健康检查 + 回滚（+ 后续飞牛部署）」
#   自动交给脱离会话的后台任务继续执行，日志持久化，断线不影响更新结果。
#
# 飞牛（fnos）流程：
#   直接复用 xcj/deploy-fnos.sh：本机 docker build 镜像（BuildKit 缓存复用）→
#   与远端镜像 ID 比对，一致则跳过上传 → 飞牛载入镜像 → 重建容器 → 健康检查。
#   --host / --listen-port / --no-build / --build-on-nas 等参数原样透传，
#   SSH 密钥与 sudo 凭据见该脚本头部说明。
#
# 权限说明：
#   构建与文件替换以源码属主身份执行（root 运行时自动降权，避免产物属主漂移）；
#   systemctl restart 需要 root：root 直接执行，普通用户经 sudo（可交互输密码）。
#   允许顺手输入 sh xcj/update.sh：尽早切回 Bash，避免 Bash 专用语法在 dash 中报错。
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

# ==================== 可覆盖配置 ====================
INSTALL_DIR="${TB_LOCAL_INSTALL_DIR:-/opt/terminal-buddy}"
SERVICE="${TB_LOCAL_SERVICE:-terminal-buddy}"
PORT="${TB_LOCAL_PORT:-9600}"
HEALTH_TIMEOUT="${TB_LOCAL_HEALTH_TIMEOUT:-120}"
DO_PULL="${TB_UPDATE_PULL:-1}"
KEEP_ROLLBACK="${TB_UPDATE_KEEP_ROLLBACK:-0}"
# =====================================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
LOG_DIR="${INSTALL_DIR}/data/.terminal-buddy-update"
BIN="${INSTALL_DIR}/terminal-buddy-server"
WEB="${INSTALL_DIR}/web"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() {
  printf '[错误] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
用法：bash xcj/update.sh [local|fnos|all] [选项]（可在任意目录执行）

  local   只更新本机 systemd 服务（默认部署于 /opt/terminal-buddy，服务 terminal-buddy）
  fnos    只更新飞牛 fnOS 上的 Docker 容器（复用 deploy-fnos.sh：本机构建镜像并上传）
  all     两者都更新（默认；先本机构建并验证健康，再部署飞牛）

  --no-pull            跳过开头的 git pull --ff-only，直接使用当前工作区
  --keep-rollback      本机更新成功后保留 terminal-buddy-server.bak 与 web.old 回滚材料
  --health-timeout N   本机重启后健康检查最长等待秒数，默认 120
  -h, --help           显示帮助

  其余参数原样透传给 deploy-fnos.sh：--host / --listen-port / --no-build /
  --build-on-nas / --config 等（仅目标包含 fnos 时使用）。

流程：git pull → 本机构建（网页前端 + server 二进制）→ 产物指纹一致则跳过重启；
有变化时备份并原子替换 → systemctl restart → 健康检查（/api/health），失败自动回滚。
在 TerminalBuddy 网页终端内执行时，重启会断开当前会话（预期）：剩余步骤自动转入
脱离会话的后台任务，日志保存在 /opt/terminal-buddy/data/.terminal-buddy-update/。

环境变量：TB_LOCAL_INSTALL_DIR / TB_LOCAL_SERVICE / TB_LOCAL_PORT /
TB_LOCAL_HEALTH_TIMEOUT / TB_UPDATE_PULL / TB_UPDATE_KEEP_ROLLBACK，
以及 TB_FNOS_*（host / user / ssh-port 等，透传给 deploy-fnos.sh）。
HELP
}

# 保存原始参数：git pull 可能改写本脚本自身，重执行时需带同样的参数。
ORIGINAL_ARGS=("$@")
TARGET=''
PASSTHROUGH=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    local|fnos|all)
      [ -z "${TARGET}" ] || fail "只能指定一个更新目标（local / fnos / all）"
      TARGET="$1" ;;
    docker|nas)
      # 口语别名：飞牛上的部署形态就是 Docker 容器。
      [ -z "${TARGET}" ] || fail "只能指定一个更新目标（local / fnos / all）"
      TARGET=fnos
      log "已将目标 ${1} 视为 fnos" ;;
    --no-pull) DO_PULL=0 ;;
    --keep-rollback) KEEP_ROLLBACK=1 ;;
    --health-timeout) HEALTH_TIMEOUT="${2:?--health-timeout 需要秒数}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1") ;;
  esac
  shift
done
: "${TARGET:=all}"
[[ "${HEALTH_TIMEOUT}" =~ ^[1-9][0-9]{0,4}$ ]] || fail "健康检查超时需为 1～99999 的整数"
[[ "${KEEP_ROLLBACK}" =~ ^[01]$ ]] || fail "TB_UPDATE_KEEP_ROLLBACK 需为 0 或 1"
[[ "${DO_PULL}" =~ ^[01]$ ]] || fail "TB_UPDATE_PULL 需为 0 或 1"
if [ "${TARGET}" = local ] && [ "${#PASSTHROUGH[@]}" -gt 0 ]; then
  log "提示：目标为 local，以下参数将被忽略：${PASSTHROUGH[*]}"
fi

# 源码属主：root 运行时构建与文件替换都降权到该用户，避免产物属主漂移到 root，
# 导致普通用户下次构建时因 target / dist 目录不可写而失败。
SRC_OWNER="$(stat -c '%U' "${REPO_DIR}/terminal-buddy" 2>/dev/null || true)"
[ -n "${SRC_OWNER}" ] || fail "源码目录不完整：缺少 ${REPO_DIR}/terminal-buddy"
SRC_HOME="$(getent passwd "${SRC_OWNER}" | cut -d: -f6)"
[ -n "${SRC_HOME}" ] || fail "无法解析源码属主 ${SRC_OWNER} 的主目录"

as_owner() {
  if [ "$(id -u)" -eq 0 ] && [ "${SRC_OWNER}" != "root" ]; then
    sudo -u "${SRC_OWNER}" -H env "PATH=${SRC_HOME}/.cargo/bin:${PATH}" "$@"
  else
    env "PATH=${SRC_HOME}/.cargo/bin:${PATH}" "$@"
  fi
}

# systemctl 需要 root：root 直接执行；普通用户优先免密 sudo，否则交互输密码。
sys_ctl() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl "$@"
  elif sudo -n true 2>/dev/null; then
    sudo -n systemctl "$@"
  else
    sudo systemctl "$@"
  fi
}

# 检测当前脚本是否运行在 terminal-buddy-server 的进程树内（网页终端场景）。
# 重启服务会终止树内所有进程，包括本脚本，因此需要提前交接给脱离会话的后台任务。
in_terminal_buddy_tree() {
  local pid="$$" exe ppid
  while [ "${pid}" -gt 1 ]; do
    exe="$(readlink "/proc/${pid}/exe" 2>/dev/null || true)"
    [ "${exe}" = "${BIN}" ] && return 0
    ppid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d '[:space:]')"
    [ -n "${ppid}" ] || break
    pid="${ppid}"
  done
  return 1
}

dir_hash() {
  ( cd -- "$1" && find . -type f -print0 | LC_ALL=C sort -z \
      | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}

wait_health() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ---------- 拉取最新代码 ----------
if [ "${DO_PULL}" = 1 ]; then
  command -v git >/dev/null 2>&1 || fail "未检测到 git，无法执行 git pull（可用 --no-pull 跳过）"
  as_owner git -C "${REPO_DIR}" rev-parse --git-dir >/dev/null 2>&1 \
    || fail "源码目录不是 git 仓库：${REPO_DIR}（可用 --no-pull 跳过）"
  # git pull 可能改写本脚本自身，bash 是边读边执行的，必须记下执行前的指纹。
  SELF_PATH="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
  SELF_BEFORE="$(sha256sum -- "${SELF_PATH}" 2>/dev/null | cut -d' ' -f1 || true)"
  log "拉取最新代码：git pull --ff-only（目录 ${REPO_DIR}）"
  as_owner git -C "${REPO_DIR}" pull --ff-only \
    || fail "git pull 失败，源码未更新，未执行后续更新流程"
  SELF_AFTER="$(sha256sum -- "${SELF_PATH}" 2>/dev/null | cut -d' ' -f1 || true)"
  # 脚本被更新过就带着原参数重新执行，避免继续跑旧逻辑或读到撕裂的文件内容。
  if [ -n "${SELF_BEFORE}" ] && [ "${SELF_BEFORE}" != "${SELF_AFTER}" ] && [ -z "${TB_UPDATE_SELF_REEXEC:-}" ]; then
    log "update.sh 已被本次 pull 更新，使用新版本重新执行"
    export TB_UPDATE_SELF_REEXEC=1
    exec bash "${SELF_PATH}" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
  fi
  log "当前最新提交："
  git -C "${REPO_DIR}" --no-pager log -1 \
    --format='  commit %H%n  Author: %an <%ae>%n  Date:   %ad%n%n    %s' --date=iso
else
  log "已跳过 git pull（--no-pull），直接使用当前源码"
fi

# ---------- 本机：构建 ----------
build_local() {
  command -v npm >/dev/null 2>&1 || fail "未检测到 npm，无法构建本机版本"
  command -v cargo >/dev/null 2>&1 || [ -x "${SRC_HOME}/.cargo/bin/cargo" ] \
    || fail "未检测到 cargo，无法构建本机版本（可安装 rustup 到用户目录）"

  if [ ! -d "${REPO_DIR}/terminal-buddy/node_modules" ]; then
    log "安装前端依赖（npm ci）"
    ( cd "${REPO_DIR}/terminal-buddy" && as_owner npm ci ) || fail "npm ci 失败"
  fi
  log "构建网页前端（npm run build:web:desktop）"
  ( cd "${REPO_DIR}/terminal-buddy" && as_owner npm run build:web:desktop ) || fail "前端构建失败"

  # tauri-build 要求 frontendDist（../dist）存在；server 构建不产出它，确保目录在。
  as_owner mkdir -p "${REPO_DIR}/terminal-buddy/dist" \
    "${REPO_DIR}/terminal-buddy/src-tauri/resources/vscode-terminal"

  log "构建服务端二进制（cargo build --release，首次约 10-20 分钟，之后增量）"
  ( cd "${REPO_DIR}/terminal-buddy/src-tauri" \
    && as_owner cargo build --locked --release --no-default-features \
         --features server --bin terminal-buddy-server ) || fail "Rust 构建失败"

  NEW_BIN="${REPO_DIR}/terminal-buddy/src-tauri/target/release/terminal-buddy-server"
  NEW_WEB="${REPO_DIR}/terminal-buddy/dist-web"
  [ -x "${NEW_BIN}" ] || fail "构建产物缺失：${NEW_BIN}"
  [ -d "${NEW_WEB}" ] || fail "构建产物缺失：${NEW_WEB}"
  local size
  size="$(stat -c%s "${NEW_BIN}")"
  [ "${size}" -gt 10000000 ] || fail "二进制产物异常（${size} 字节），中止"
}

# ---------- 本机：备份并原子替换 ----------
# 运行中的 ELF 无法直接覆盖，先落 .new 再 mv 原子替换；web 目录同样用新旧目录交换。
deploy_local_files() {
  as_owner rm -rf "${WEB}.new"
  as_owner cp -a "${NEW_WEB}" "${WEB}.new"
  if [ -d "${WEB}" ]; then
    as_owner rm -rf "${WEB}.old"
    as_owner mv "${WEB}" "${WEB}.old"
  fi
  as_owner mv "${WEB}.new" "${WEB}"
  if [ -f "${BIN}" ]; then
    as_owner cp -a "${BIN}" "${BIN}.bak"
  fi
  as_owner install -m 0755 "${NEW_BIN}" "${BIN}.new"
  as_owner mv -f "${BIN}.new" "${BIN}"
}

rollback_local_files() {
  if [ -f "${BIN}.bak" ]; then
    as_owner mv -f "${BIN}.bak" "${BIN}" || true
  fi
  if [ -d "${WEB}.old" ]; then
    as_owner rm -rf "${WEB}.failed"
    as_owner mv "${WEB}" "${WEB}.failed" || true
    as_owner mv "${WEB}.old" "${WEB}" || true
  fi
}

# ---------- 本机：重启 + 健康检查（同步路径，SSH / 物理终端场景） ----------
restart_and_verify_local() {
  log "重启服务：systemctl restart ${SERVICE}（普通用户需输入 sudo 密码）"
  sys_ctl restart "${SERVICE}" \
    || fail "无法重启 ${SERVICE}（需要 root）：新版本文件已部署但尚未生效，请执行 sudo systemctl restart ${SERVICE}，或用 sudo 重新运行本脚本"
  if wait_health; then
    log "本机更新完成：新版本健康检查通过（${BIN}）"
    if [ "${KEEP_ROLLBACK}" = 0 ]; then
      as_owner rm -f "${BIN}.bak"
      as_owner rm -rf "${WEB}.old"
      log "已清理回滚材料（保留可用 --keep-rollback）"
    else
      log "按 --keep-rollback 保留回滚材料：${BIN}.bak、${WEB}.old"
    fi
    return 0
  fi
  log "健康检查失败，回滚旧版本"
  rollback_local_files
  sys_ctl restart "${SERVICE}" || true
  if wait_health; then
    fail "新版本健康检查未通过，已回滚旧版本且服务恢复；失败原因见 journalctl -u ${SERVICE} -e"
  else
    fail "回滚后健康检查仍未通过，请手动排查：journalctl -u ${SERVICE} -e"
  fi
}

# ---------- 本机：重启 + 健康检查（后台交接路径，网页终端场景） ----------
# 生成脱离会话的后台任务：root 身份（经 sudo 提升）setsid 启动，重启终端断开后仍继续。
# 任务负责「重启 → 健康检查 → 回滚 → 清理 →（可选）继续飞牛部署」，全部日志写入数据目录。
spawn_background_worker() {
  HELPER_SCRIPT="${LOG_DIR}/worker-${RUN_ID}.sh"
  HELPER_LOG="${LOG_DIR}/update-${RUN_ID}.log"
  # 参数在生成时写死进脚本（sudo 会重置环境变量，不能靠 export 传递）。
  # 飞牛凭据用绝对路径嵌入：后台任务以 root 运行，HOME 与原用户不同。
  RUN_FNOS=0
  [ "${TARGET}" != local ] && RUN_FNOS=1
  HELPER_PASSTHROUGH="$(printf '%q ' ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"})"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'HELPER_LOG=%q\n' "${HELPER_LOG}"
    printf 'SERVICE=%q\n' "${SERVICE}"
    printf 'PORT=%q\n' "${PORT}"
    printf 'HEALTH_TIMEOUT=%q\n' "${HEALTH_TIMEOUT}"
    printf 'INSTALL_DIR=%q\n' "${INSTALL_DIR}"
    printf 'KEEP_ROLLBACK=%q\n' "${KEEP_ROLLBACK}"
    printf 'REPO_DIR=%q\n' "${REPO_DIR}"
    printf 'SRC_OWNER=%q\n' "${SRC_OWNER}"
    printf 'RUN_FNOS=%q\n' "${RUN_FNOS}"
    printf 'HELPER_PASSTHROUGH=%q\n' "${HELPER_PASSTHROUGH}"
    printf 'TB_FNOS_SSH_KEY=%q\n' "${TB_FNOS_SSH_KEY:-${HOME}/.ssh/terminal_buddy_fnos_deploy}"
    printf 'TB_FNOS_CONFIG=%q\n' "${TB_FNOS_CONFIG:-${HOME}/.codex/private/fnos/config.json}"
    cat <<'WORKER'
# 由 update.sh 生成的后台更新任务：脱离会话执行「重启 → 健康检查 → 回滚 → 飞牛部署」。
set -euo pipefail
exec >>"${HELPER_LOG}" 2>&1
wlog() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
wait_health() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
# 文件操作以源码属主身份执行，避免回滚材料属主漂移到 root。
own() {
  if [ "$(id -u)" -eq 0 ] && [ "${SRC_OWNER}" != "root" ]; then
    sudo -u "${SRC_OWNER}" -H "$@"
  else
    "$@"
  fi
}
wlog "后台更新任务启动：重启 ${SERVICE} 并等待健康检查（超时 ${HEALTH_TIMEOUT}s）"
systemctl restart "${SERVICE}"
if wait_health; then
  wlog "健康检查通过：本机新版本已生效"
  if [ "${KEEP_ROLLBACK}" = "0" ]; then
    own rm -f "${INSTALL_DIR}/terminal-buddy-server.bak"
    own rm -rf "${INSTALL_DIR}/web.old"
    wlog "已清理回滚材料（保留可用 --keep-rollback）"
  else
    wlog "按 --keep-rollback 保留回滚材料"
  fi
  if [ "${RUN_FNOS}" = "1" ]; then
    wlog "继续飞牛 fnOS 部署（凭据不足会在此失败，届时在交互终端重跑 bash xcj/update.sh fnos）"
    export TB_FNOS_SSH_KEY TB_FNOS_CONFIG
    if eval "bash '${REPO_DIR}/xcj/deploy-fnos.sh' --no-pull ${HELPER_PASSTHROUGH}"; then
      wlog "飞牛部署完成"
    else
      wlog "飞牛部署失败（本机更新已完成），可重跑：bash xcj/update.sh fnos"
      exit 1
    fi
  fi
  wlog "===== 全部更新完成 ====="
  exit 0
fi
wlog "健康检查失败，回滚旧版本"
[ -f "${INSTALL_DIR}/terminal-buddy-server.bak" ] \
  && own mv -f "${INSTALL_DIR}/terminal-buddy-server.bak" "${INSTALL_DIR}/terminal-buddy-server" || true
if [ -d "${INSTALL_DIR}/web.old" ]; then
  own rm -rf "${INSTALL_DIR}/web.failed"
  own mv "${INSTALL_DIR}/web" "${INSTALL_DIR}/web.failed" || true
  own mv "${INSTALL_DIR}/web.old" "${INSTALL_DIR}/web" || true
fi
systemctl restart "${SERVICE}" || true
if wait_health; then
  wlog "已回滚旧版本且服务恢复；新版本失败原因见 journalctl -u ${SERVICE} -e"
else
  wlog "警告：回滚后健康检查仍未通过，请手动排查：journalctl -u ${SERVICE} -e"
fi
exit 1
WORKER
  } > "${HELPER_SCRIPT}"
  chmod 0755 "${HELPER_SCRIPT}"

  if [ "$(id -u)" -eq 0 ]; then
    setsid nohup bash "${HELPER_SCRIPT}" </dev/null >/dev/null 2>&1 &
  else
    # sudo 在当前终端上完成密码验证，随后由 root shell 里 setsid 出的后台任务独立运行。
    sudo bash -c "setsid nohup bash $(printf '%q' "${HELPER_SCRIPT}") </dev/null >/dev/null 2>&1 &" \
      || fail "无法以 root 启动后台更新任务：请输入 sudo 密码，或改用 sudo bash xcj/update.sh 重新运行"
  fi

  log "已交接给后台更新任务（当前会话位于 TerminalBuddy 服务进程树内，重启后连接会断开——预期行为）"
  log "后台日志：${HELPER_LOG}"
  log "重连后查看结果：tail -n 80 ${HELPER_LOG}"
}

# 运行中的服务进程是否已加载当前部署文件：mv 原子替换后 inode 变化，
# 旧进程仍持有旧 inode。用于识别「文件已更新但尚未重启生效」的中间状态。
running_process_matches_file() {
  local pid ino_proc ino_bin
  pid="$(systemctl show -p MainPID --value "${SERVICE}" 2>/dev/null || true)"
  { [ -n "${pid}" ] && [ "${pid}" != 0 ]; } || return 1
  ino_proc="$(stat -c %i "/proc/${pid}/exe" 2>/dev/null || true)"
  ino_bin="$(stat -c %i "${BIN}" 2>/dev/null || true)"
  [ -n "${ino_proc}" ] && [ "${ino_proc}" = "${ino_bin}" ]
}

update_local() {
  [ -d "${INSTALL_DIR}" ] || fail "本机部署目录不存在：${INSTALL_DIR}（本脚本只做更新，不做首次部署）"
  as_owner mkdir -p "${LOG_DIR}"
  build_local

  # 与已部署产物比对指纹：二进制与 web 均未变化、且运行中进程已加载当前文件时才跳过重启。
  local files_changed=1
  if [ -x "${BIN}" ] && [ -d "${WEB}" ]; then
    local bin_same=0 web_same=0
    [ "$(sha256sum -- "${BIN}" | cut -d' ' -f1)" = "$(sha256sum -- "${NEW_BIN}" | cut -d' ' -f1)" ] && bin_same=1
    [ "$(dir_hash "${WEB}")" = "$(dir_hash "${NEW_WEB}")" ] && web_same=1
    [ "${bin_same}${web_same}" = 11 ] && files_changed=0
  fi
  if [ "${files_changed}" = 0 ] && running_process_matches_file; then
    log "本机产物与当前部署一致（二进制与 web 指纹均未变化），跳过重启"
    return 0
  fi

  if [ "${files_changed}" = 1 ]; then
    log "部署新产物：备份旧版本并原子替换（${BIN}、${WEB}）"
    deploy_local_files
  else
    log "部署文件与上次构建一致，但运行中进程尚未加载（上次更新后未重启），本次仅重启生效"
  fi

  if in_terminal_buddy_tree; then
    RUN_ID="$(date -u '+%Y%m%d%H%M%S')-$$"
    spawn_background_worker
    exit 0
  fi
  restart_and_verify_local
}

update_fnos() {
  [ -f "${REPO_DIR}/xcj/deploy-fnos.sh" ] || fail "缺少 ${REPO_DIR}/xcj/deploy-fnos.sh"
  local c
  for c in ssh scp tar curl; do
    command -v "${c}" >/dev/null 2>&1 || fail "未检测到 ${c}（飞牛部署需要）"
  done
  # 凭据路径按当前用户解析为绝对路径后再导出，兼容各种运行身份。
  export TB_FNOS_SSH_KEY="${TB_FNOS_SSH_KEY:-${HOME}/.ssh/terminal_buddy_fnos_deploy}"
  export TB_FNOS_CONFIG="${TB_FNOS_CONFIG:-${HOME}/.codex/private/fnos/config.json}"
  log "开始飞牛 fnOS 更新（复用 deploy-fnos.sh；源码指纹一致时远端跳过构建）"
  bash "${REPO_DIR}/xcj/deploy-fnos.sh" --no-pull ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} \
    || fail "飞牛部署失败，详见上方 deploy-fnos.sh 输出"
}

if [ "${TARGET}" != fnos ]; then
  update_local
fi
if [ "${TARGET}" != local ]; then
  update_fnos
fi
log "更新流程结束"
