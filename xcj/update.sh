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
#   自动交给后台任务继续执行，日志持久化，断线不影响更新结果。后台任务经 systemd-run
#   启动在独立 transient unit 中——systemd 重启按 cgroup 成员杀进程，setsid/nohup
#   只脱离终端会话、离不开服务的 cgroup，会被重启连带杀死（旧实现即因此只剩一行日志）。
#
# 飞牛（fnos）流程：
#   直接复用 xcj/deploy-fnos.sh：本机 docker build 镜像（BuildKit 缓存复用）→
#   与远端镜像 ID 比对，一致则跳过上传 → 飞牛 docker load → 远端 compose 重建容器 →
#   健康检查。SSH 走 ~/.ssh/config 别名 fnos（免密，BatchMode），--no-build /
#   --no-pull 等参数原样透传，详见该脚本头部说明。
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
FORCE=0
# =====================================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
LOG_DIR="${INSTALL_DIR}/data/.terminal-buddy-update"
BIN="${INSTALL_DIR}/terminal-buddy-server"
WEB="${INSTALL_DIR}/web"
# 上次成功部署时的源码指纹与产物哈希，用于判断「已是最新」而提前退出。
STAMP_FILE="${LOG_DIR}/deployed-local.state"

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
  --force              忽略「已是最新」的快速判定，强制重新构建并部署
  --source-dir DIR     显式指定源码仓库根目录（默认取脚本所在仓库的根目录）
  --keep-rollback      本机更新成功后保留 terminal-buddy-server.bak 与 web.old 回滚材料
  --health-timeout N   本机重启后健康检查最长等待秒数，默认 120
  -h, --help           显示帮助

  其余参数原样透传给 deploy-fnos.sh：--no-build / --no-pull / --load <tar> 等
  （仅目标包含 fnos 时使用）。

流程：git pull → 「已是最新」快速判定（源码指纹 + 产物哈希 + 运行进程一致则直接退出）
→ 本机构建（网页前端 + server 二进制）→ 产物指纹一致则跳过重启；
有变化时备份并原子替换 → systemctl restart → 健康检查（/api/health），失败自动回滚。
在 TerminalBuddy 网页终端内执行时，重启会断开当前会话（预期）：剩余步骤自动转入
脱离会话的后台任务，日志保存在 /opt/terminal-buddy/data/.terminal-buddy-update/。

环境变量：TB_LOCAL_INSTALL_DIR / TB_LOCAL_SERVICE / TB_LOCAL_PORT /
TB_LOCAL_HEALTH_TIMEOUT / TB_UPDATE_PULL / TB_UPDATE_KEEP_ROLLBACK / TB_UPDATE_FORCE，
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
    --force) FORCE=1 ;;
    --source-dir) REPO_ARG="${2:?--source-dir 需要路径}"; shift ;;
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
[[ "${FORCE}" =~ ^[01]$ ]] || fail "TB_UPDATE_FORCE 需为 0 或 1"
if [ "${TARGET}" = local ] && [ "${#PASSTHROUGH[@]}" -gt 0 ]; then
  log "提示：目标为 local，以下参数将被忽略：${PASSTHROUGH[*]}"
fi
# --source-dir 显式覆盖源码仓库根目录（默认取脚本所在仓库的根目录）。
if [ -n "${REPO_ARG:-}" ]; then
  REPO_DIR="$(cd -- "${REPO_ARG}" 2>/dev/null && pwd -P)" \
    || fail "--source-dir 路径无效：${REPO_ARG}"
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
    # 本脚本换二进制用的是 mv 原子替换，运行中进程的 exe 链接会变成「原路径 (deleted)」。
    # 不去掉后缀就会被误判为「不在服务进程树内」，从而走同步重启路径、把自己一并杀掉。
    exe="${exe% (deleted)}"
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

# ---------- 「已是最新」判定 ----------
# 源码指纹 = HEAD + 工作区改动（含未提交内容）+ 未跟踪文件内容。
# 只比 HEAD 会漏掉未提交改动：HEAD 不变但源码变了，必须重建。
# 只覆盖 terminal-buddy/：本地 server 构建只消费这个目录，android/ 等改动不该触发重建。
source_fingerprint() {
  local head diff_h untracked_h
  head="$(git -C "${REPO_DIR}" rev-parse HEAD 2>/dev/null)" \
    || { printf '%s' "NOGIT"; return 0; }
  diff_h="$(git -C "${REPO_DIR}" diff --binary HEAD -- terminal-buddy/ 2>/dev/null \
    | sha256sum | cut -d' ' -f1)"
  # 未跟踪文件按「内容 + 相对路径」参与指纹；-r 保证空列表时不给 sha256sum 喂标准输入。
  untracked_h="$( cd -- "${REPO_DIR}" \
    && git ls-files --others --exclude-standard -z -- terminal-buddy/ 2>/dev/null \
    | xargs -0 -r sha256sum 2>/dev/null | LC_ALL=C sort | sha256sum | cut -d' ' -f1 )"
  printf '%s:%s:%s' "${head}" "${diff_h}" "${untracked_h}"
}

# 读取 state 文件的单个键。用 sed 解析而非 source，避免数据目录被改写时执行任意代码。
stamp_get() {
  sed -n "s/^$1=//p" "${STAMP_FILE}" 2>/dev/null | head -n1
}

write_deploy_stamp() {
  local fp="$1" bin_sha="$2" web_sha="$3"
  as_owner sh -c 'cat > "$1"' _ "${STAMP_FILE}" <<STAMP
# 由 xcj/update.sh 自动生成，请勿手工编辑。
FINGERPRINT=${fp}
BIN_SHA=${bin_sha}
WEB_SHA=${web_sha}
DEPLOYED_AT=$(date '+%F %T')
STAMP
}

# 全部命中才算「已是最新」：源码没变、部署产物没被替换过、运行进程加载的就是该产物。
# 任一条不满足都照常走完整流程（宁可多构建一次，也不能漏部署）。
already_up_to_date() {
  local want_git=1
  if [ "${FORCE}" = 1 ]; then
    log "已指定 --force，跳过「已是最新」判定"
    return 1
  fi
  if ! git -C "${REPO_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
    log "源码目录不是 git 仓库，无法取源码指纹，本次照常构建"
    return 1
  fi
  if [ ! -f "${STAMP_FILE}" ]; then
    log "未找到上次部署记录（${STAMP_FILE}），本次照常构建"
    return 1
  fi
  [ -x "${BIN}" ] && [ -d "${WEB}" ] || { log "部署产物缺失，本次照常构建"; return 1; }

  local cur_fp saved_fp cur_bin cur_web
  cur_fp="$(source_fingerprint)"
  saved_fp="$(stamp_get FINGERPRINT)"
  if [ "${cur_fp}" != "${saved_fp}" ]; then
    log "源码自上次部署后有变化（或首次运行新版判定），需要重新构建"
    return 1
  fi
  cur_bin="$(sha256sum -- "${BIN}" | cut -d' ' -f1)"
  [ "${cur_bin}" = "$(stamp_get BIN_SHA)" ] \
    || { log "已部署二进制与上次记录不一致（可能被手工替换），本次照常构建"; return 1; }
  cur_web="$(dir_hash "${WEB}")"
  [ "${cur_web}" = "$(stamp_get WEB_SHA)" ] \
    || { log "已部署 web 与上次记录不一致（可能被手工替换），本次照常构建"; return 1; }
  if ! running_process_matches_file; then
    # 兜底防自激循环：本脚本常被配置成终端 Profile 的启动命令（如「update-local」），
    # 服务重启后网页端恢复页签会自动再跑一次。若这次又判「仅需重启」并重启服务，
    # 就会形成 重启 → 恢复页签重跑 → 再重启 的死循环。DEPLOYED_AT 很近说明后台任务
    # 刚完成（或正在完成）重启，直接认定已是最新，把重启交给那一次任务。
    local deployed_at deployed_ts now_ts
    deployed_at="$(stamp_get DEPLOYED_AT)"
    deployed_ts="$(date -d "${deployed_at}" +%s 2>/dev/null || true)"
    now_ts="$(date +%s)"
    if [ -n "${deployed_ts}" ] && [ $(( now_ts - deployed_ts )) -ge 0 ] \
       && [ $(( now_ts - deployed_ts )) -lt "${SELF_UPDATE_LOOP_GUARD:-180}" ]; then
      log "部署记录显示 ${deployed_at} 刚完成更新（进程尚未反映新版本），判定为已是最新，跳过本次重启"
      return 0
    fi
    log "部署文件未变但运行中进程尚未加载（上次更新后未重启），本次仅重启生效"
    return 1
  fi
  return 0
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

# 健康检查通过后才写指纹记录：失败的部署不能标记为「已最新」，
# 否则下次会误判跳过重建。PENDING_* 由 update_local 在重启前导出。
write_local_stamp_from_pending() {
  if [ -n "${PENDING_FP:-}" ]; then
    write_deploy_stamp "${PENDING_FP}" "${PENDING_BIN_SHA:-}" "${PENDING_WEB_SHA:-}" \
      && log "已记录本次部署指纹（下次相同源码会直接跳过）" \
      || log "警告：写入部署指纹失败（${STAMP_FILE}），不影响本次更新结果"
  fi
}

# ---------- 本机：重启 + 健康检查（同步路径，SSH / 物理终端场景） ----------
restart_and_verify_local() {
  log "重启服务：systemctl restart ${SERVICE}（普通用户需输入 sudo 密码）"
  sys_ctl restart "${SERVICE}" \
    || fail "无法重启 ${SERVICE}（需要 root）：新版本文件已部署但尚未生效，请执行 sudo systemctl restart ${SERVICE}，或用 sudo 重新运行本脚本"
  if wait_health; then
    log "本机更新完成：新版本健康检查通过（${BIN}）"
    write_local_stamp_from_pending
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
# 生成独立 cgroup 的后台任务：root 身份经 systemd-run 启动 transient unit，
# 与服务的 cgroup 完全隔离，服务重启、终端断开后仍继续执行。
# 任务负责「重启 → 健康检查 → 回滚 → 清理 →（可选）继续飞牛部署」，全部日志写入数据目录。
spawn_background_worker() {
  HELPER_SCRIPT="${LOG_DIR}/worker-${RUN_ID}.sh"
  HELPER_LOG="${LOG_DIR}/update-${RUN_ID}.log"
  # 参数在生成时写死进脚本（sudo 会重置环境变量，不能靠 export 传递）。
  # 飞牛凭据用绝对路径嵌入：后台任务以 root 运行，HOME 与原用户不同。
  RUN_FNOS=0
  [ "${TARGET}" != local ] && RUN_FNOS=1
  # 注意：PASSTHROUGH 为空数组时 printf '%q ' 仍会处理一次格式串，%q 产出空串的
  # 引号形式 ''，经 worker 里 eval 二次解释后凭空产生一个空字符串参数，导致
  # deploy-fnos.sh 报「未知参数：」——空数组时必须显式置空，不能依赖 printf。
  if [ "${#PASSTHROUGH[@]}" -gt 0 ]; then
    HELPER_PASSTHROUGH="$(printf '%q ' "${PASSTHROUGH[@]}")"
  else
    HELPER_PASSTHROUGH=''
  fi
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
    printf 'STAMP_FILE=%q\n' "${STAMP_FILE}"
    printf 'PENDING_FP=%q\n' "${PENDING_FP:-}"
    printf 'PENDING_BIN_SHA=%q\n' "${PENDING_BIN_SHA:-}"
    printf 'PENDING_WEB_SHA=%q\n' "${PENDING_WEB_SHA:-}"
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
  # 只有健康检查通过的部署才写指纹，否则下次误判「已是最新」而跳过重建。
  if [ -n "${PENDING_FP}" ]; then
    if own sh -c 'cat > "$1"' _ "${STAMP_FILE}" <<STAMP
# 由 xcj/update.sh 自动生成，请勿手工编辑。
FINGERPRINT=${PENDING_FP}
BIN_SHA=${PENDING_BIN_SHA}
WEB_SHA=${PENDING_WEB_SHA}
DEPLOYED_AT=$(date '+%F %T')
STAMP
    then
      wlog "已记录本次部署指纹（下次相同源码会直接跳过）"
    else
      wlog "警告：写入部署指纹失败（${STAMP_FILE}），不影响本次更新结果"
    fi
  fi
  if [ "${KEEP_ROLLBACK}" = "0" ]; then
    own rm -f "${INSTALL_DIR}/terminal-buddy-server.bak"
    own rm -rf "${INSTALL_DIR}/web.old"
    wlog "已清理回滚材料（保留可用 --keep-rollback）"
  else
    wlog "按 --keep-rollback 保留回滚材料"
  fi
  if [ "${RUN_FNOS}" = "1" ]; then
    wlog "继续飞牛 fnOS 部署（以源码属主身份执行：SSH 走其 ~/.ssh/config 的 fnos 别名）"
    if eval "own bash '${REPO_DIR}/xcj/deploy-fnos.sh' --no-pull ${HELPER_PASSTHROUGH}"; then
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

  # 必须用 systemd-run 把任务放进独立的 transient unit：systemd 重启服务时按 cgroup
  # 成员杀进程，而本任务正是从服务的 cgroup 里 spawn 出来的——setsid/nohup 只脱离
  # 终端会话、离不开 cgroup，会被重启连带杀死。systemd-run 产生的 unit 挂在
  # system.slice 下，与 terminal-buddy.service 的 cgroup 完全隔离，可安然度过重启。
  local unit="tb-update-${RUN_ID}"
  if [ "$(id -u)" -eq 0 ]; then
    systemd-run --unit="${unit}" --collect bash "${HELPER_SCRIPT}" \
      || fail "systemd-run 启动后台更新任务失败（unit ${unit}）"
  else
    # sudo 在当前终端上完成密码验证，随后由 systemd 在独立 unit 中以 root 运行任务。
    sudo systemd-run --unit="${unit}" --collect bash "${HELPER_SCRIPT}" \
      || fail "无法以 root 启动后台更新任务：请输入 sudo 密码，或改用 sudo bash xcj/update.sh 重新运行"
  fi

  log "已交接给后台更新任务（当前会话位于 TerminalBuddy 服务进程树内，重启后连接会断开——预期行为）"
  log "后台任务 unit：${unit}（journalctl -u ${unit} -e 可看实时输出）"
  log "后台日志：${HELPER_LOG}"
  log "重连后查看结果：tail -n 80 ${HELPER_LOG}"
}

# 运行中的服务进程是否已加载当前部署文件：mv 原子替换后 inode 变化，
# 旧进程仍持有旧 inode。用于识别「文件已更新但尚未重启生效」的中间状态。
running_process_matches_file() {
  local pid ino_proc ino_bin
  pid="$(systemctl show -p MainPID --value "${SERVICE}" 2>/dev/null || true)"
  { [ -n "${pid}" ] && [ "${pid}" != 0 ]; } || return 1
  # 注意必须带 -L：/proc/PID/exe 是指向真实二进制的符号链接，不带 -L 的 stat
  # 取到的是 procfs 链接自身的 inode（每次都可能不同），永远不可能等于 BIN 的 inode，
  # 会导致「已是最新」判定和「仅需重启」判定全部失效。
  ino_proc="$(stat -Lc %i "/proc/${pid}/exe" 2>/dev/null || true)"
  ino_bin="$(stat -Lc %i "${BIN}" 2>/dev/null || true)"
  [ -n "${ino_proc}" ] && [ "${ino_proc}" = "${ino_bin}" ]
}

update_local() {
  [ -d "${INSTALL_DIR}" ] || fail "本机部署目录不存在：${INSTALL_DIR}（本脚本只做更新，不做首次部署）"
  as_owner mkdir -p "${LOG_DIR}"

  # 构建之前先判：已是最新就直接退出，省掉 npm + cargo 的全量构建时间。
  if already_up_to_date; then
    log "已是最新版本，无需更新：源码、部署产物与运行进程均已一致（强制重建请加 --force）"
    return 0
  fi

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
    # 指纹记录可能因上次运行中断而缺失，这里补齐，让下次能走快速退出。
    write_deploy_stamp "$(source_fingerprint)" \
      "$(sha256sum -- "${BIN}" | cut -d' ' -f1)" "$(dir_hash "${WEB}")"
    return 0
  fi

  if [ "${files_changed}" = 1 ]; then
    log "部署新产物：备份旧版本并原子替换（${BIN}、${WEB}）"
    deploy_local_files
  else
    log "部署文件与上次构建一致，但运行中进程尚未加载（上次更新后未重启），本次仅重启生效"
  fi

  # 先记下源码指纹：即使随后健康检查失败，也要在重启成功后才有资格写，
  # 因此交给重启路径处理（同步路径在健康检查通过后写，后台路径由 worker 写）。
  export PENDING_FP="$(source_fingerprint)"
  export PENDING_BIN_SHA="$(sha256sum -- "${BIN}" | cut -d' ' -f1)"
  export PENDING_WEB_SHA="$(dir_hash "${WEB}")"

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
  # 以源码属主身份执行：deploy-fnos.sh 的 SSH 走该用户 ~/.ssh/config 的 fnos 别名，
  # docker 构建也以该用户跑（root 没有对应 ssh 配置与 docker 组成员关系）。
  log "开始飞牛 fnOS 更新（复用 deploy-fnos.sh：本机构建 → 推送镜像 → compose 重建）"
  as_owner bash "${REPO_DIR}/xcj/deploy-fnos.sh" --no-pull ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} \
    || fail "飞牛部署失败，详见上方 deploy-fnos.sh 输出"
}

if [ "${TARGET}" != fnos ]; then
  update_local
fi
if [ "${TARGET}" != local ]; then
  update_fnos
fi
log "更新流程结束"
