# TerminalBuddy Windows exe 交叉编译环境
#
# 仅保留为历史参考；当前构建入口为 xcj/build-windows-exe.sh（本机工具链），
# 本 Dockerfile 不参与当前构建。

FROM rust:1-bookworm

ARG CARGO_XWIN_VERSION=0.23.1
ARG NODE_VERSION=24.22.0
ARG NODE_ARCH=x64

ENV DEBIAN_FRONTEND=noninteractive

# clang/llvm/lld：cargo-xwin 交叉编译 MSVC 目标所需
# cmake/ninja：部分 C 依赖（如 zlib）的构建脚本会用到
# gosu：入口脚本降权到宿主用户
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils git gosu \
        clang lld llvm \
        build-essential cmake ninja-build pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Debian 的 clang 包没有 clang-cl 入口；clang 会按 argv[0] 自动进入 CL 模式，
# 这里补一个同名软链接供 cargo-xwin 调用。
RUN if ! command -v clang-cl >/dev/null 2>&1; then \
        ln -s "$(command -v clang)" /usr/local/bin/clang-cl; \
    fi

# 官方 Node.js 二进制：只用于构建前端，版本与项目要求（Vite 8）匹配
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
        -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm -f /tmp/node.tar.xz \
    && node --version \
    && npm --version

# x86_64 Windows 标准库 + ring 等依赖可能用到的 llvm 工具，再安装 cargo-xwin
RUN rustup target add x86_64-pc-windows-msvc \
    && rustup component add llvm-tools \
    && cargo install cargo-xwin --version "${CARGO_XWIN_VERSION}" --locked

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /cache /build /out

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
