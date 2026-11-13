#!/usr/bin/env bash
# Terminal Buddy 远程构建入口（兼容旧 scripts/ 路径）。
#
# 本文件只负责转发到 xcj/remote-build.sh；请优先直接使用 xcj/ 路径。
# 远端构建已改为在 Debian 构建主机上直接使用本机 Rust / Node / JDK /
# Android SDK / Gradle 工具链，不再使用 Docker 构建镜像或命名卷。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/xcj/remote-build.sh" "$@"
