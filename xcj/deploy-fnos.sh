#!/usr/bin/env bash
# TerminalBuddy 一键部署到飞牛 fnOS（与 quantum/scripts/deploy-prod.sh 同口径）
#
# 模式：git pull → 本机 docker build 镜像（BuildKit 层缓存）→ 与远端镜像 ID 比对，
#   一致则跳过传输 → docker save | gzip 导出回滚 tar（本机留档）→ scp 推送飞牛 →
#   远端 docker load → docker compose up -d → 远端健康检查 → 两端清理。
#   飞牛侧的 docker-compose.yml 是权威（挂载/网络/端口/资源限制都在那边维护），
#   本脚本不生成、不修改它；镜像 tag 固定 terminal-buddy:server，load 覆盖后
#   compose 检测到镜像 ID 变化自动重建容器。
#
# SSH：走 ~/.ssh/config 别名（默认 fnos：HostName 192.168.1.71 / User huangmaoqiu /
#   IdentityFile ~/.ssh/id_ed25519），BatchMode 非交互——免密未配置会在预检失败并给
#   指引；全程无 sudo、无密码传递。
#
# 用法（在仓库根或任意目录执行均可）：
#   ./xcj/deploy-fnos.sh                # 拉代码 → 构建 → 上传 → 重建 → 健康检查 → 清理
#   ./xcj/deploy-fnos.sh --no-build     # 跳过构建，用飞牛现有镜像重建容器
#   ./xcj/deploy-fnos.sh --no-pull      # 不拉取代码，直接用当前工作区构建
#   ./xcj/deploy-fnos.sh --load <tar>   # 从既有 tar 包部署（回滚 / 免构建）
#
# 回滚：./xcj/deploy-fnos.sh --load <TARDIR>/terminal-buddy_<旧时间戳>.tar.gz
#   （本机 TARDIR 保留最近 KEEP_TAR 个 tar 包；被覆盖的旧镜像在飞牛以 dangling 形式
#   留底，需要时 docker tag <旧ID> terminal-buddy:server 后 up -d 即可）
#
# 首次部署（飞牛上还没有 compose 的新机器）：先在飞牛侧准备 APP_DIR、data/home 目录
#   与 docker-compose.yml（参考 DEPLOY_README.md 与 scripts/deploy-fnos-remote.sh 的
#   compose 模板），之后日常更新都走本脚本。
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

# ==================== 可覆盖配置 ====================
FNOS_SSH="${TB_FNOS_SSH:-fnos}"                                   # 飞牛 SSH 目标（~/.ssh/config 别名）
IMAGE="${TB_FNOS_IMAGE:-terminal-buddy:server}"
CONTAINER="${TB_FNOS_CONTAINER:-terminal-buddy}"
APP_DIR="${TB_FNOS_APP_DIR:-/vol2/1000/docker/terminal-buddy}"
REMOTE_COMPOSE_FILE="${TB_FNOS_COMPOSE_FILE:-${APP_DIR}/docker-compose.yml}"
HOST_PORT="${TB_FNOS_PORT:-9600}"                                 # 仅健康检查用，实际端口以远端 compose 为准
PULL_LATEST="${TB_FNOS_PULL:-1}"
KEEP_TAR=3                                                        # 本机回滚 tar 保留个数
# =====================================================

REPO_DIR="$(cd -- "$(dirname "$0")/.." && pwd -P)"
TARDIR="${TB_FNOS_TARDIR:-${REPO_DIR}/.runtime-data/fnos-tars}"   # 本机回滚 tar 目录（.runtime-data 不入库）
REMOTE_TARBALL="/tmp/terminal-buddy-image.tar.gz"

log()  { printf '\033[36m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\033[33m[%s] %s\033[0m\n' "$(date '+%H:%M:%S')" "$*" >&2; }
fail() { printf '\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'HELP'
用法：bash xcj/deploy-fnos.sh [选项]（可在任意目录执行）

  --no-pull           跳过开头的 git pull --ff-only，直接使用当前工作区
  --no-build          跳过本机构建，用飞牛上的现有镜像重建容器
  --load <tar包>      从既有 tar 包部署（回滚 / 免构建），不构建、不清理 tar
  -h, --help          显示帮助

环境变量：TB_FNOS_SSH（SSH 别名，默认 fnos）/ TB_FNOS_APP_DIR / TB_FNOS_COMPOSE_FILE /
TB_FNOS_PORT（健康检查端口）/ TB_FNOS_IMAGE / TB_FNOS_CONTAINER / TB_FNOS_TARDIR /
TB_FNOS_PULL。

SSH 免密：本脚本走 ~/.ssh/config 别名 fnos（192.168.1.71 / huangmaoqiu / id_ed25519），
BatchMode 非交互。首次配置：ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 &&
ssh-copy-id <user>@<host>（或直接编辑 ~/.ssh/config 添加 Host fnos 条目）。
HELP
}

DO_BUILD=1
MODE=build
LOAD_TAR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build)      DO_BUILD=0 ;;
    --no-pull)       PULL_LATEST=0 ;;
    --load)          MODE=load; LOAD_TAR="${2:?--load 需要一个 tar 包路径}"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) fail "未知参数：$1（可用：--no-build / --no-pull / --load <tar包> / --help）" ;;
  esac
  shift
done
if [ "${MODE}" = load ]; then
  [ -r "${LOAD_TAR}" ] || fail "tar 包不存在或不可读：${LOAD_TAR}"
fi

# SSH 统一封装：BatchMode 禁交互（无免密立即失败）；accept-new 首连自动收录指纹。
# 传远端的命令一律走 `rsh bash -s -- <参数> <<'EOF'` 形态，避免 ssh 拼参数丢引号。
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
rsh() { ssh "${SSH_OPTS[@]}" "$FNOS_SSH" "$@"; }

# 远端 compose up（幂等）：镜像 ID 变化时自动重建容器，并核对容器确实跑在目标镜像上。
compose_up() {
  rsh bash -s -- "${APP_DIR}" "${REMOTE_COMPOSE_FILE}" "${CONTAINER}" "${IMAGE}" <<'EOF'
set -eu
cd "$1"
docker compose -f "$2" up -d --remove-orphans 2>&1 | tail -n 5
running="$(docker inspect "$3" --format '{{.State.Running}}' 2>/dev/null || true)"
[ "${running}" = "true" ] || { echo "!! 容器 $3 未在运行" >&2; exit 1; }
img="$(docker inspect "$3" --format '{{.Image}}')"
want="$(docker image inspect "$4" --format '{{.Id}}')"
[ "${img}" = "${want}" ] || { echo "!! 容器实际镜像与 $4 不一致" >&2; exit 1; }
EOF
}

# 远端健康检查：轮询容器映射端口上的 /api/health（最多约 90s），失败时附最近日志。
health_check() {
  local step
  if [ "${MODE}" = load ]; then step=4; else step=6; fi
  echo "==> [${step}/${STEPS}] 健康检查（远端 127.0.0.1:${HOST_PORT}）"
  rsh bash -s -- "${HOST_PORT}" "${CONTAINER}" <<'EOF'
set -u
code=""
for _ in $(seq 1 30); do
  sleep 3
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$1/api/health" 2>/dev/null || true)
  [ "$code" = "200" ] && break
done
if [ "$code" != "200" ]; then
  echo "!! 健康检查失败（HTTP ${code:-无响应}），最近日志：" >&2
  docker logs "$2" --tail 20 >&2 || true
  exit 1
fi
echo "    ✓ /api/health -> 200"
EOF
}

finish() {
  echo
  log "部署完成：$1"
  [ -n "${FNOS_IP:-}" ] && echo "  访问地址 : http://${FNOS_IP}:${HOST_PORT}/"
  echo "  应用目录 : ${APP_DIR}（compose 为权威：${REMOTE_COMPOSE_FILE}）"
  [ -n "${TAR:-}" ] && echo "  本机 tar : ${TAR}"
  echo "  回到旧版 : bash xcj/deploy-fnos.sh --load ${TARDIR}/terminal-buddy_<旧时间戳>.tar.gz"
  echo "  查看日志 : ssh ${FNOS_SSH} 'docker logs -f --tail 100 ${CONTAINER}'"
}

STEPS=6
[ "${MODE}" = load ] && STEPS=4

# ---------- 0. 预检 ----------
echo "==> [0/${STEPS}] 预检：本机 docker / SSH 免密 / 远端 compose 与容器状态"
if [ "${DO_BUILD}" = 1 ] && [ "${MODE}" = build ]; then
  docker info >/dev/null 2>&1 || {
    echo "!! 本机 docker 不可用（当前用户 $(id -un) 是否在 docker 组？）。一次性配置：" >&2
    echo "   sudo usermod -aG docker $(id -un)   # 执行后重新登录生效" >&2
    exit 1; }
fi
if ! msg=$(rsh 'docker info >/dev/null 2>&1' 2>&1); then
  fail "SSH 免密登录 ${FNOS_SSH} 失败或远端 docker 不可用：${msg}
   首次配置：ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 && ssh-copy-id <user>@<host>（或编辑 ~/.ssh/config）"
fi
rsh bash -s -- "${REMOTE_COMPOSE_FILE}" "${CONTAINER}" <<'EOF'
set -e
[ -f "$1" ] || { echo "!! 远端缺 compose 文件: $1（首次部署见 DEPLOY_README.md）" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "!! 远端 docker compose 子命令不可用" >&2; exit 1; }
echo "    飞牛侧当前容器状态："
docker ps -a --filter "name=^/$2\$" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
EOF
PREV_ID="$(rsh "docker image inspect '${IMAGE}' --format '{{.Id}}' 2>/dev/null || true")"
if [ -n "${PREV_ID}" ]; then
  log "当前远端镜像：${IMAGE} ${PREV_ID:7:12}"
else
  log "远端还没有镜像 ${IMAGE}（首次部署或镜像被清理）"
fi
FNOS_IP="$(ssh -G "${FNOS_SSH}" 2>/dev/null | awk '/^hostname /{print $2; exit}')" || true

# ---------- 1. 拉取本机最新代码 ----------
if [ "${MODE}" = build ]; then
  if [ "${PULL_LATEST}" = "1" ]; then
    if [ -d "${REPO_DIR}/.git" ]; then
      command -v git >/dev/null 2>&1 || fail "未检测到 git，无法拉取代码；或用 --no-pull 跳过"
      log "拉取本机最新代码：git pull --ff-only"
      git -C "${REPO_DIR}" pull --ff-only \
        || fail "拉取失败（本机可能有未提交改动与远端冲突）。处理后再试，或用 --no-pull 直接用当前工作区。"
    else
      warn "${REPO_DIR} 不是 git 仓库，跳过拉取"
    fi
  else
    log "已跳过代码拉取（--no-pull）"
  fi
  git -C "${REPO_DIR}" diff --quiet 2>/dev/null \
    || echo "    注意：工作区有未提交改动，将一并构建进本次镜像（工作区全量构建）"
fi

TAG="$(date +%Y%m%d-%H%M)"

# ---------- 2. 本机构建镜像 ----------
if [ "${MODE}" = build ] && [ "${DO_BUILD}" = "1" ]; then
  echo "==> [2/${STEPS}] 本机构建镜像 ${IMAGE}（工作区全量构建，复用层缓存）"
  # 构建输出必须实时可见：此前 `| tail -n 15` 会把全部输出缓冲到构建结束才吐最后 15 行，
  # Rust 层失效时全量编译要 10-20 分钟，期间界面零输出，看起来就像卡死（曾因此被误判为挂起）。
  # 改为 --progress=plain + tee：屏幕实时滚动，完整日志留档 .runtime-data（不入库）。
  BUILD_LOG="${TARDIR}/build-${TAG}.log"
  mkdir -p "${TARDIR}"
  echo "    构建中：缓存全命中约 1 分钟，Rust 层失效则需 10-20 分钟，请勿关闭终端"
  echo "    完整构建日志：${BUILD_LOG}"
  BEFORE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null || true)"
  if ! docker build --progress=plain -f "${REPO_DIR}/Dockerfile" -t "${IMAGE}" "${REPO_DIR}" 2>&1 | tee "${BUILD_LOG}"; then
    fail "本机构建失败（完整日志 ${BUILD_LOG}）。可用 --no-build 复用现有镜像，或排查 Dockerfile / 源码错误"
  fi
  LOCAL_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
  if [ -n "${BEFORE_ID}" ] && [ "${BEFORE_ID}" = "${LOCAL_ID}" ]; then
    log "  本机镜像未变化（全部命中缓存）：${LOCAL_ID:7:12}"
  else
    log "  本机镜像已更新：${LOCAL_ID:7:12}"
  fi
  # 远端已是同款镜像：跳过导出与传输（约省 160MB 局域网传输），仅幂等对齐容器。
  if [ -n "${PREV_ID}" ] && [ "${PREV_ID}" = "${LOCAL_ID}" ]; then
    echo "==> [3/${STEPS}] 飞牛上已是相同镜像，跳过导出与上传"
    compose_up
    health_check
    finish "镜像未变化（${IMAGE} ${LOCAL_ID:7:12}），容器已按 compose 对齐"
    exit 0
  fi
elif [ "${MODE}" = build ]; then
  log "跳过本机构建（--no-build），使用本机现有镜像 ${IMAGE}"
  LOCAL_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null)" \
    || fail "本机也没有镜像 ${IMAGE}：先去掉 --no-build 构建一次"
fi

# ---------- 3. 导出回滚 tar ----------
if [ "${MODE}" = build ]; then
  echo "==> [3/${STEPS}] 导出镜像 tar 到本机 ${TARDIR}（回滚留档）"
  mkdir -p "${TARDIR}"
  TAR="${TARDIR}/terminal-buddy_${TAG}.tar.gz"
  docker save "${IMAGE}" | gzip -1 > "${TAR}"
  gzip -t "${TAR}"                   # 校验落盘完整（磁盘写满/中断在此暴露）
  echo "    镜像包：$(du -h "${TAR}" | cut -f1)  ->  ${TAR}"
else
  TAR="${LOAD_TAR}"
  echo "==> [1/${STEPS}] 使用既有 tar 包：${TAR}"
fi

# ---------- 4. 推送飞牛并 docker load ----------
echo "==> [4/${STEPS}] 推送飞牛并 docker load"
scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
    "${TAR}" "${FNOS_SSH}:${REMOTE_TARBALL}" || fail "镜像上传失败，请检查网络与飞牛磁盘空间"
rsh bash -s -- "${REMOTE_TARBALL}" "${IMAGE}" <<'EOF'
set -e
gzip -t "$1"                          # 校验传输完整（scp 中断/磁盘写满在此暴露）
out=$(docker load -i "$1"); echo "$out" >&2
# tr -d '\r'：docker load 的进度输出可能带 CR，避免污染解析出的镜像名
img=$(echo "$out" | tr -d '\r' | sed -n 's/^Loaded image: //p' | tail -n1)
[ -n "$img" ] || { echo "!! tar 包内未解析出镜像名（是否为本脚本导出的包？）" >&2; exit 1; }
# $2 是完整 repo:tag，要求 tar 内镜像与之完全一致（其他 tag 也拒绝，防误部署）
if [ "$img" != "$2" ]; then
  echo "!! tar 包里是 $img，不是 $2，拒绝部署" >&2; exit 1
fi
rm -f "$1"
EOF

# ---------- 5. 重建容器（远端 compose 为权威） ----------
echo "==> [5/${STEPS}] 重建容器（远端 compose）"
compose_up

# ---------- 6. 健康检查 + 清理 ----------
health_check
if [ "${MODE}" = build ]; then
  echo "==> [6/${STEPS}] 清理旧 tar（本机保留最近 ${KEEP_TAR} 个）"
  ls -t "${TARDIR}"/terminal-buddy_*.tar.gz 2>/dev/null | tail -n +$((KEEP_TAR + 1)) | xargs -r rm -f \
    || echo "!! 本机旧 tar 包清理失败（不影响本次部署）" >&2
fi
PREV_SHORT="无"
[ -n "${PREV_ID}" ] && PREV_SHORT="${PREV_ID:7:12}"
finish "${IMAGE} 已上线（原镜像 ${PREV_SHORT}）"
