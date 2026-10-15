FROM node:24-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY terminal-buddy/package.json terminal-buddy/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY terminal-buddy/index.html terminal-buddy/tsconfig*.json terminal-buddy/vite.config.ts ./
COPY terminal-buddy/src ./src
RUN npm run build:web:desktop

FROM rust:1-bookworm AS backend
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev libssh2-1-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build/src-tauri
COPY terminal-buddy/src-tauri/Cargo.toml terminal-buddy/src-tauri/Cargo.lock terminal-buddy/src-tauri/build.rs ./
COPY terminal-buddy/src-tauri/src ./src
COPY terminal-buddy/src-tauri/portable-pty-patched ./portable-pty-patched
RUN cargo build --locked --release --no-default-features --features server --bin terminal-buddy-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client libssl3 libssh2-1 tini && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash terminalbuddy \
    && mkdir -p /data /workspace && chown terminalbuddy:terminalbuddy /data /workspace
COPY --from=backend /build/src-tauri/target/release/terminal-buddy-server /usr/local/bin/terminal-buddy-server
COPY --from=frontend /build/frontend/dist-web /opt/terminal-buddy/web
ENV TERMINAL_BUDDY_DATA_DIR=/data \
    TERMINAL_BUDDY_WEB_DIST=/opt/terminal-buddy/web \
    TERMINAL_BUDDY_WORKSPACE_DIR=/workspace \
    TERMINAL_BUDDY_PORT=9600 \
    TERMINAL_BUDDY_USERNAME=admin \
    TERMINAL_BUDDY_DEPLOYMENT=docker \
    PATH=/home/terminalbuddy/.local/bin:$PATH \
    HOME=/home/terminalbuddy \
    LANG=C.UTF-8 \
    TERM=xterm-256color
USER terminalbuddy
WORKDIR /workspace
EXPOSE 9600
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD curl --fail --silent http://127.0.0.1:9600/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/terminal-buddy-server"]
