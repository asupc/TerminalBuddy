#!/usr/bin/env bash
# terminal-buddy 快速热更新：增量编译 server 二进制并替换进运行中的容器（不重建镜像）
#
# 与其他更新方式的分工（AI 请按改动范围选择，详见 memory「terminal-buddy-quick-update」）：
#   只改前端      构建后 docker cp dist-web 热替换，秒级，无需重启，见 memory「docker-live-frontend-injection」
#   改 Rust 代码  本脚本：builder 容器增量编译（增量命中后约 1-3 分钟）→ 原子替换二进制
#                 → docker restart → 健康检查，失败自动回滚旧二进制
#   正式发布      /vol2/1000/docker/terminal-buddy/self-update.sh（git pull + 全量重建镜像）
#                 热替换不更新镜像：docker compose up --force-recreate 或 GUI 重建容器会退回
#                 镜像内旧版，代码提交后最终仍需 self-update.sh 固化。
#
# 原理：
#   - docker restart 不清空容器可写层，docker cp 进去的二进制 restart 后保留；
#     只有 force-recreate（重建容器）才会恢复镜像内文件。
#   - 运行中的 ELF 无法直接覆盖（Text file busy），先 cp 成 .new 再在容器内 mv 原子替换。
#   - 编译缓存在卷 terminal-buddy-server-check-cache（/cache/cargo、/cache/target）。
#     首次 release 编译无缓存，需 10-20 分钟预热；之后增量约 1-3 分钟。
#   - /vol2 挂载在容器内呈现 mode 000，源码必须 tar 复制进容器再 chmod（同 build-windows-exe.sh）。
#
# 用法（在 terminal-buddy 容器内的 AI 终端，或 NAS 宿主上均可执行）：
#   bash /vol2/1000/code/terminal-buddy/scripts/quick-update.sh            # 构建 + 替换 + 重启 + 健康检查
#   bash .../quick-update.sh --build-only                          # 只构建到 staging，不动容器
#   bash .../quick-update.sh --delay 10                            # helper 替换前等待秒数（默认 15）
#   bash .../quick-update.sh --help
#
# 说明：
#   - 使用当前工作区代码（不 git pull）；工作区有未提交改动时仅警告不中止。
#   - 完整模式会 docker restart，运行在容器内的 AI 会话会中断（预期行为）；
#     交接信息写入 $TB_STACK/.quick-update-handoff.md，重连后 cd /vol2/1000/docker && claude --continue。
set -euo pipefail

SRC="${TB_SRC:-/vol2/1000/code/terminal-buddy}"
STACK="${TB_STACK:-/vol2/1000/docker/terminal-buddy}"
IMAGE="${TB_IMAGE:-terminal-buddy:server}"
CONTAINER="${TB_CONTAINER:-terminal-buddy}"
BUILDER="${TB_BUILDER_IMAGE:-terminal-buddy-windows-builder:latest}"
CACHE_VOL="${TB_CACHE_VOL:-terminal-buddy-server-check-cache}"
LOG="${STACK}/quick-update.log"
HANDOFF="${STACK}/.quick-update-handoff.md"
STAGING="${STACK}/terminal-buddy-server.staging"
DELAY="${TB_DEPLOY_DELAY:-15}"
BUILD_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --delay)      : ;; # 值在下一轮消费
    --help|-h)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      if [ "${PREV:-}" = "--delay" ]; then
        DELAY="$arg"
      else
        echo "未知参数: $arg（可用：--build-only / --delay <秒> / --help）" >&2
        exit 2
      fi
      ;;
  esac
  PREV="$arg"
done

log()  { printf '\033[36m[%s]\033[0m %s\n' "$(date '+%F %T')" "$*"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 预检 ----------
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
docker info >/dev/null 2>&1 || die "无法连接 Docker 守护进程；需挂载 /var/run/docker.sock"
[ -d "$SRC/terminal-buddy/src-tauri" ] || die "源码目录不存在: $SRC"
[ -f "$STACK/docker-compose.yml" ] || die "compose 文件不存在: $STACK/docker-compose.yml"
docker image inspect "$BUILDER" >/dev/null 2>&1 \
  || die "builder 镜像 ${BUILDER} 不存在，请先用 scripts/windows-build/Dockerfile 构建"
docker network inspect docker_network >/dev/null 2>&1 || die "外部网络 docker_network 不存在"

# 铁律：不创建/拉起已删除或已停止的容器（同 self-update.sh）
if [ "$BUILD_ONLY" = "0" ]; then
  docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER" \
    || die "容器 ${CONTAINER} 不存在。按铁律禁止重新创建，请先向用户确认是否恢复该栈。"
  [ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" = "true" ] \
    || die "容器 ${CONTAINER} 未运行。本脚本不会拉起已停止的容器。"
fi

# ---------- 1. 记录代码状态（不 pull，用当前工作区） ----------
COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then
  warn "工作区存在未提交改动，热更新将包含这些改动："
  git -C "$SRC" status --short | head -10
  DIRTY="dirty"
else
  DIRTY="clean"
fi
log "本次热更新代码版本: ${COMMIT}（${DIRTY}）"

# ---------- 2. builder 容器内增量编译 ----------
BUILD_NAME="tb-quick-build-$(date +%s)"
cleanup() { docker rm -f "$BUILD_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "启动 builder 容器 ${BUILD_NAME}（镜像 ${BUILDER}，缓存卷 ${CACHE_VOL}）"
docker run -d --name "$BUILD_NAME" --user root \
  -v "$SRC":/src:ro -v "$CACHE_VOL":/cache \
  --entrypoint bash "$BUILDER" -c 'sleep 3600' >/dev/null

log "[1/3] 复制源码进容器并增量编译（首次预热较慢，增量约 1-3 分钟）"
docker exec -i "$BUILD_NAME" bash -s <<'CONTAINER_SCRIPT'
set -euo pipefail
rm -rf /build && mkdir -p /build
(
    cd /src
    tar -cf - \
        --exclude='terminal-buddy/node_modules' \
        --exclude='terminal-buddy/web/node_modules' \
        --exclude='terminal-buddy/src-tauri/target' \
        --exclude='terminal-buddy/.winbuild-cache' \
        --exclude='terminal-buddy/release' \
        --exclude='terminal-buddy/dist' \
        --exclude='terminal-buddy/dist-web' \
        --exclude='terminal-buddy/web/dist' \
        --exclude='terminal-buddy/src-tauri/resources/vscode-terminal' \
        --exclude='terminal-buddy/server-data' \
        --exclude='.git' \
        --exclude='.codegraph' \
        terminal-buddy
) | tar -xf - -C /build --no-same-permissions --no-same-owner
# NAS 挂载上的文件权限呈现为 000，tar 会把 0 带进容器，统一改回可读写
chmod -R u+rwX,go+rX /build/terminal-buddy
# tauri-build 要求 frontendDist 存在；include_dir! 要求 vscode-terminal 目录存在（空目录即可）
mkdir -p /build/terminal-buddy/dist /build/terminal-buddy/src-tauri/resources/vscode-terminal

export HOME=/cache/home
export CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target
cd /build/terminal-buddy/src-tauri
cargo build --locked --release --no-default-features --features server --bin terminal-buddy-server
test -x /cache/target/release/terminal-buddy-server
echo "产物: $(ls -lh /cache/target/release/terminal-buddy-server | awk '{print $5, $9}')"
CONTAINER_SCRIPT

# ---------- 3. 拷出产物并校验 ----------
log "[2/3] 拷出产物到 ${STAGING}"
rm -f "$STAGING"
docker cp "${BUILD_NAME}:/cache/target/release/terminal-buddy-server" "$STAGING"
cleanup
trap - EXIT

SIZE="$(stat -c%s "$STAGING" 2>/dev/null || echo 0)"
[ "$SIZE" -gt 10000000 ] || die "产物异常（${SIZE} 字节），中止"
SHA="$(sha256sum "$STAGING" | cut -d' ' -f1)"
log "staging 就绪: $(ls -lh "$STAGING" | awk '{print $5}') commit=${COMMIT} sha256=${SHA:0:12}"

if [ "$BUILD_ONLY" = "1" ]; then
  log "--build-only 模式：未触碰容器。确认无误后去掉该参数执行完整热替换。"
  exit 0
fi

# ---------- 4. helper 容器执行替换（避免自杀中断） ----------
cat > "$HANDOFF" <<EOF
# terminal-buddy 快速热更新交接（$(date '+%F %T')）

- 代码 commit: ${COMMIT}（${DIRTY}）
- 新二进制 sha256: ${SHA}
- 容器: ${CONTAINER}（docker restart，不重建）
- 日志: ${LOG}
- 状态: 等待 helper 执行替换（约 ${DELAY} 秒后开始）

重连后：
1. 打开新的终端标签页
2. cd /vol2/1000/docker && claude --continue
3. cat ${LOG}
EOF

NAME="tb-quick-update-$(date +%s)"
log "[3/3] 启动 helper 容器 ${NAME}，${DELAY} 秒后替换并重启 ${CONTAINER}"
log "若当前会话运行在 ${CONTAINER} 内，重启后会话中断（预期行为），交接信息: ${HANDOFF}"
docker run -d --rm --name "$NAME" \
  --user root --network docker_network \
  -e TB_CONTAINER="$CONTAINER" -e TB_COMMIT="$COMMIT" -e TB_DELAY="$DELAY" \
  -e TB_STACK="$STACK" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$STACK":"$STACK" -w "$STACK" \
  --entrypoint /bin/sh "$IMAGE" -c '
    sleep "$TB_DELAY"
    log="$TB_STACK/quick-update.log"
    handoff="$TB_STACK/.quick-update-handoff.md"
    staging="$TB_STACK/terminal-buddy-server.staging"
    echo "===== $(date) quick-update start commit=$TB_COMMIT =====" >> "$log"
    if ! docker cp "$staging" "$TB_CONTAINER:/usr/local/bin/terminal-buddy-server.new" >> "$log" 2>&1; then
      echo "cp_failed，旧二进制未受影响" >> "$log"
      exit 1
    fi
    docker exec -u root "$TB_CONTAINER" sh -c \
      "cp -f /usr/local/bin/terminal-buddy-server /usr/local/bin/terminal-buddy-server.bak \
       && mv -f /usr/local/bin/terminal-buddy-server.new /usr/local/bin/terminal-buddy-server \
       && chmod 755 /usr/local/bin/terminal-buddy-server" >> "$log" 2>&1
    docker restart "$TB_CONTAINER" >> "$log" 2>&1
    code=""; i=0
    while [ "$i" -lt 30 ]; do
      code=$(curl -sS -m 3 -o /dev/null -w "%{http_code}" "http://$TB_CONTAINER:9600/api/health" 2>/dev/null || true)
      [ "$code" = "200" ] && break
      i=$((i + 1))
      sleep 2
    done
    echo "health_http=${code:-000}" >> "$log"
    if [ "$code" != "200" ]; then
      echo "健康检查失败，回滚旧二进制" >> "$log"
      docker exec -u root "$TB_CONTAINER" sh -c \
        "mv -f /usr/local/bin/terminal-buddy-server.bak /usr/local/bin/terminal-buddy-server" >> "$log" 2>&1
      docker restart "$TB_CONTAINER" >> "$log" 2>&1
      sleep 10
      code2=$(curl -sS -m 3 -o /dev/null -w "%{http_code}" "http://$TB_CONTAINER:9600/api/health" 2>/dev/null || true)
      echo "rollback_health=${code2:-000}" >> "$log"
      code="$code/rollback:${code2:-000}"
    else
      rm -f "$staging"
    fi
    docker inspect "$TB_CONTAINER" --format "status={{.State.Status}} image={{.Image}}" >> "$log" 2>&1
    echo "===== $(date) quick-update end =====" >> "$log"
    {
      echo
      echo "## 执行结果（$(date +%F\ %T)）"
      echo "- health_http=${code:-000}"
      echo "- 镜像未更新，正式发布仍需 self-update.sh；详见 $(basename "$log")"
    } >> "$handoff"
  ' >/dev/null || die "helper 容器启动失败"

log "替换已交给 helper 执行。重连后查看结果："
log "  cat ${LOG}"
log "  curl -sS http://127.0.0.1:9600/api/health"
