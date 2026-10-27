# TerminalBuddy Android APK 构建环境
#
# 镜像只提供工具链(JDK 17 + Android SDK 36);源码在运行时以只读方式挂载,
# 构建过程全部发生在容器内部,Gradle 缓存放在 Docker 命名卷中。
# 构建入口:scripts/build-android.sh。

FROM eclipse-temurin:17-jdk

ARG CMDLINE_TOOLS_VERSION=13114758
ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/35.0.0:${PATH}

# gosu:入口脚本降权到宿主用户;git/unzip/zip:Gradle 与 apksigner 需要
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip zip git gosu \
    && rm -rf /var/lib/apt/lists/*

# Android 命令行工具 + SDK 36(compileSdk/targetSdk 36)与 build-tools 35.0.0(AGP 8.13 默认)
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
        -o /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -f /tmp/cmdline-tools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-36" "build-tools;35.0.0"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /cache /build /out

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
