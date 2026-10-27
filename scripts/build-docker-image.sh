#!/usr/bin/env bash
# TerminalBuddy Docker 镜像构建与导出脚本 (Linux)
#
# 功能：
#   1. 检查 Docker 环境与 Dockerfile
#   2. 执行 docker build 构建镜像
#   3. 执行 docker save 导出 .tar 文件（可选 --gzip 导出 .tar.gz）
#
# 用法：
#   ./scripts/build-docker-image.sh               # 默认构建 terminal-buddy:server 并导出为 dist/terminal-buddy-server.tar
#   ./scripts/build-docker-image.sh --gzip        # 导出为 dist/terminal-buddy-server.tar.gz（压缩体积，省空间）
#   ./scripts/build-docker-image.sh --tag my:tag  # 指定镜像标签
#   ./scripts/build-docker-image.sh --no-build    # 跳过构建，直接导出已有镜像
#   ./scripts/build-docker-image.sh -o /path/to   # 指定输出目录

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${TB_IMAGE:-terminal-buddy:server}"
OUTPUT_DIR="${REPO_DIR}/dist"
OUTPUT_FILE=""
DO_BUILD=1
USE_GZIP=0

log()  { printf '\033[36m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'HELP'
用法：
  ./scripts/build-docker-image.sh [选项]

选项：
  -t, --tag <tag>         指定构建/导出的镜像标签（默认：terminal-buddy:server 或 $TB_IMAGE）
  -o, --output-dir <dir>  指定导出文件存放目录（默认：./dist）
  -f, --file <filename>   指定导出的文件名（默认：<tag-safe-name>.tar 或 .tar.gz）
  -z, --gzip              导出后使用 gzip 压缩（生成 .tar.gz）
  --no-build              跳过 docker build，直接将本地已有镜像导出为 tar 包
  -h, --help              显示此帮助信息

示例：
  ./scripts/build-docker-image.sh
  ./scripts/build-docker-image.sh --gzip
  ./scripts/build-docker-image.sh --tag terminal-buddy:1.8.0 --output-dir /data/backup
HELP
}

# ==================== 参数解析 ====================
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag)
      [[ $# -ge 2 ]] || fail "--tag 需要指定镜像标签参数"
      IMAGE="$2"
      shift 2
      ;;
    -o|--output-dir)
      [[ $# -ge 2 ]] || fail "--output-dir 需要指定目录参数"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -f|--file)
      [[ $# -ge 2 ]] || fail "--file 需要指定文件名参数"
      OUTPUT_FILE="$2"
      shift 2
      ;;
    -z|--gzip)
      USE_GZIP=1
      shift
      ;;
    --no-build)
      DO_BUILD=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数: $1（可使用 -h 或 --help 查看用法）"
      ;;
  esac
done

# ==================== 环境检查 ====================
command -v docker >/dev/null 2>&1 || fail "未检测到 docker 命令，请确认系统已安装 Docker 并加入 PATH"
docker info >/dev/null 2>&1 || fail "无法连接 Docker 守护进程，请确认 Docker 正在运行且当前用户具有操作权限"

if [[ "${DO_BUILD}" -eq 1 ]]; then
  [[ -f "${REPO_DIR}/Dockerfile" ]] || fail "未找到 Dockerfile：${REPO_DIR}/Dockerfile"
fi

mkdir -p "${OUTPUT_DIR}" || fail "无法创建输出目录：${OUTPUT_DIR}"

# 确定输出文件名
if [[ -z "${OUTPUT_FILE}" ]]; then
  SAFE_NAME="${IMAGE//\//_}"
  SAFE_NAME="${SAFE_NAME//:/_}"
  if [[ "${USE_GZIP}" -eq 1 ]]; then
    OUTPUT_FILE="${SAFE_NAME}.tar.gz"
  else
    OUTPUT_FILE="${SAFE_NAME}.tar"
  fi
fi

TARBALL_PATH="${OUTPUT_DIR}/${OUTPUT_FILE}"

# ==================== 构建镜像 ====================
if [[ "${DO_BUILD}" -eq 1 ]]; then
  echo
  log "[1/2] 开始构建镜像：${IMAGE}"
  log "      首次构建需要下载基础镜像和依赖编译，可能需要一些时间..."
  echo
  docker build -f "${REPO_DIR}/Dockerfile" -t "${IMAGE}" "${REPO_DIR}"
else
  echo
  log "[1/2] 跳过构建步骤，使用已有镜像：${IMAGE}"
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail "本地不存在镜像 ${IMAGE}，无法导出。请先构建或去掉 --no-build 参数"
fi

# ==================== 导出 tar 包 ====================
echo
if [[ "${USE_GZIP}" -eq 1 ]]; then
  log "[2/2] 导出镜像并压缩至：${TARBALL_PATH}"
  docker save "${IMAGE}" | gzip > "${TARBALL_PATH}"
else
  log "[2/2] 导出镜像至：${TARBALL_PATH}"
  docker save -o "${TARBALL_PATH}" "${IMAGE}"
fi

# ==================== 完成信息 ====================
IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}' 2>/dev/null || echo "未知")"
FILE_SIZE="$(du -h "${TARBALL_PATH}" | cut -f1)"

echo
printf '\033[32m%s\033[0m\n' "==================== [完成] 镜像已成功导出 ===================="
echo "  镜像标签 : ${IMAGE}"
echo "  镜像 ID  : ${IMAGE_ID}"
echo "  导出文件 : ${TARBALL_PATH}"
echo "  文件大小 : ${FILE_SIZE}"
echo
echo "目标机导入命令："
if [[ "${USE_GZIP}" -eq 1 ]]; then
  echo "  docker load < ${OUTPUT_FILE}"
  echo "  # 或："
  echo "  gzip -dc ${OUTPUT_FILE} | docker load"
else
  echo "  docker load -i ${OUTPUT_FILE}"
fi
echo "================================================================"
