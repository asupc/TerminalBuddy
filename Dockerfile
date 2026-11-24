ARG DOCKER_CLI_IMAGE=docker:28-cli
FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM node:24-bookworm-slim AS frontend-deps
WORKDIR /build/frontend
COPY terminal-buddy/package.json terminal-buddy/package-lock.json ./
RUN --mount=type=cache,id=terminal-buddy-npm,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --ignore-scripts --no-audit --no-fund

FROM frontend-deps AS frontend
COPY terminal-buddy/index.html terminal-buddy/tsconfig*.json terminal-buddy/vite.config.ts ./
COPY terminal-buddy/src ./src
RUN npm run build:web:desktop

FROM rust:1-bookworm AS backend
# 构建阶段使用可覆盖的 Cargo 镜像源，避免 crates.io 的 TLS 故障阻断更新。
ARG CARGO_MIRROR_INDEX=sparse+https://rsproxy.cn/index/
RUN printf '%s\n' '[source.crates-io]' 'replace-with = "build-mirror"' \
    '[source.build-mirror]' "registry = \"${CARGO_MIRROR_INDEX}\"" \
    '[net]' 'retry = 5' '[http]' 'multiplexing = false' \
    > /usr/local/cargo/config.toml
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev libssh2-1-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build/src-tauri
ARG TARGETARCH
COPY terminal-buddy/src-tauri/Cargo.toml terminal-buddy/src-tauri/Cargo.lock terminal-buddy/src-tauri/build.rs ./
COPY terminal-buddy/src-tauri/src ./src
COPY terminal-buddy/src-tauri/resources ./resources
COPY terminal-buddy/src-tauri/portable-pty-patched ./portable-pty-patched
# 源码层失效后继续复用下载和依赖编译缓存；并发构建串行写入同一缓存。
# git 切换或源码归档可能保留较旧的 mtime，刷新本地源码时间，避免误用旧产物。
# cache mount 不进入镜像层，必须在同一条 RUN 中把最终二进制复制出来。
RUN --mount=type=cache,id=terminal-buddy-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=terminal-buddy-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=terminal-buddy-server-target-${TARGETARCH},target=/build/src-tauri/target,sharing=locked \
    touch build.rs \
    && find src portable-pty-patched -type f -exec touch {} + \
    && cargo build --locked --release --no-default-features --features server --bin terminal-buddy-server \
    && install -D target/release/terminal-buddy-server /out/terminal-buddy-server

FROM node:24-bookworm-slim
# procps 提供 Codex 后台服务依赖的 ps 命令，随运行镜像预装。
# Node 运行时供 Claude Code / Codex CLI 在容器内运行；npm 全局前缀指向用户可写的 ~/.local。
# /root 仅开放路径穿越，供 /root/... 工作区在容器内按宿主机同路径挂载。
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client libssl3 libssh2-1 tini procps && rm -rf /var/lib/apt/lists/* \
    && (userdel -r node 2>/dev/null || true) && (groupdel node 2>/dev/null || true) \
    && useradd --create-home --uid 1000 --shell /bin/bash terminalbuddy \
    && mkdir -p /data /workspace /home/terminalbuddy/.local/bin && chown terminalbuddy:terminalbuddy /data /workspace /home/terminalbuddy/.local \
    && chmod 0711 /root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY --from=backend /out/terminal-buddy-server /usr/local/bin/terminal-buddy-server
COPY --from=frontend /build/frontend/dist-web /opt/terminal-buddy/web
ENV TERMINAL_BUDDY_DATA_DIR=/data \
    TERMINAL_BUDDY_WEB_DIST=/opt/terminal-buddy/web \
    TERMINAL_BUDDY_WORKSPACE_DIR=/workspace \
    TERMINAL_BUDDY_PORT=9600 \
    TERMINAL_BUDDY_USERNAME=admin \
    TERMINAL_BUDDY_DEPLOYMENT=docker \
    NPM_CONFIG_PREFIX=/home/terminalbuddy/.local \
    PATH=/home/terminalbuddy/.local/bin:$PATH \
    HOME=/home/terminalbuddy \
    LANG=C.UTF-8 \
    TERM=xterm-256color
USER terminalbuddy
WORKDIR /workspace
EXPOSE 9600
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD curl --fail --silent http://127.0.0.1:9600/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/terminal-buddy-server"]
