# 远程构建环境（debian99）

把 Terminal Buddy 的重负载构建（Windows exe 交叉编译、Android APK）从 NAS 挪到
构建主机 `debian99`（Debian 13，192.168.1.99，16 线程 / 15G 内存 / 442G NVMe）上执行。

> 2026-11 起，Windows / Android 构建已改为在构建主机上直接使用本机工具链，
> 不再导入构建镜像，也不使用 Docker 命名卷缓存。`scripts/` 下的入口仅作为
> 旧路径兼容包装器，实际执行 `xcj/` 中的新脚本。

## 为什么远程构建

- **NAS 常驻服务不再与编译抢资源**：Rust / Node / Gradle 编译全部在构建主机上完成，
  NAS 不承载编译负载。
- **规避 fnOS 上的 Docker 构建副作用**：Windows / Android 构建不再在 NAS 上执行
  `docker build` / `docker run`，减少 overlay 挂载事件对 fnOS SMB 共享的影响。
- **绕开 fnOS 挂载权限 000 的坑**：源码同步到 Debian 本地磁盘后，rustc / npm /
  Gradle 看到的是正常权限文件；同步阶段仍保留 tar + chmod 兜底。

## 日常使用

```bash
./xcj/remote-build.sh win             # 远程构建 Windows 单文件 exe，产物回传 dist/
./xcj/remote-build.sh android         # 远程构建 Android Release APK，产物回传 dist/
./xcj/remote-build.sh sync            # 只同步源码，不构建
./xcj/remote-build.sh win --clean-cache
```

流程：tar-over-ssh 全量同步源码（排除 `node_modules` / `target` / `dist` 等目录）
→ 在构建主机执行 `xcj/build-windows-exe.sh` 或 `xcj/build-android.sh`（`DEPLOY_DIR`
置空，产物留在远端 `dist/`）→ 产物 tar 回传本仓库 `dist/`。

构建缓存直接复用构建主机用户目录：

- Windows：`~/.cache/terminal-buddy/xwin`、`terminal-buddy/src-tauri/target/x86_64-pc-windows-msvc`
- Android：`~/.android-sdk`、`~/.gradle`、`android/.gradle`、`android/app/build`

`--clean-cache` 会分别清空对应项目缓存；它不会删除 Docker 镜像或命名卷。

## 一次性环境搭建（重装构建主机时照此重建）

1. **SSH 免密**：NAS 的 `~/.ssh/config` 需有 `debian99`（huangmaoqiu）与
   `debian99-root`（root）两个别名，IdentityFile 均指向
   `~/.ssh/terminal_buddy_tb100_deploy`。公钥需在 Debian 对应用户的
   `~/.ssh/authorized_keys` 中。
2. **基础系统包与 Rust / Node**：SSH 到构建主机后，在仓库根执行一次
   `./xcj/build-windows-exe.sh --help` 不会安装依赖；直接执行一次构建即可让脚本
   自动补齐 `rustup`、`cargo-xwin`、clang / lld / cmake / ninja 等依赖。
3. **Android 工具链**：构建主机需有 JDK 17+；Android SDK 首次构建时由
   `xcj/build-android.sh` 自动下载到 `~/.android-sdk`（约 1–2 GB），Gradle wrapper
   与依赖缓存位于 `~/.gradle`。
4. **可选：保留旧 Docker 构建环境**：如果仍需回滚历史流程，Docker 镜像与命名卷
   可以保留；新入口不会读取它们。

## 环境变量

- `TERMINAL_BUDDY_REMOTE_HOST`：SSH 别名，默认 `debian99`。
- `TERMINAL_BUDDY_REMOTE_DIR`：远端源码目录，默认 `~/tb-build`。
- `DEPLOY_DIR`：由 `remote-build.sh` 固定为空，避免产物被移动到远端
  `/mnt/fnos/code`；本地直接构建时默认 `DEPLOY_DIR=/mnt/fnos/code`。

## 故障排查

- **`无法免密 SSH 到 debian99`**：检查 `~/.ssh/config` 别名与密钥是否还在，
  `ssh debian99 'echo ok'` 手动验证。
- **远程磁盘不足**：`ssh debian99 'df -h ~'`。Windows SDK / Android SDK / Gradle
  缓存都会占用用户目录空间；可用 `xcj/remote-build.sh win --clean-cache` 或
  `xcj/remote-build.sh android --clean-cache` 清理项目缓存。Android 的
  `--clean-cache` 只清 `android/.gradle` 与 `android/app/build`，不会清 `~/.gradle`
  的全局依赖缓存；需要彻底重下依赖时请在构建主机手动处理 `~/.gradle`。
- **产物位置**：回传的 exe / APK 直接位于 `dist/`，不再生成 `.sha256` 校验文件。
- **Windows 构建缺 `lib.exe`**：当前 `cargo-xwin` 交叉编译路径不应调用 MSVC 的
  `lib.exe`；若出现该错误，先确认 `cargo xwin cache xwin` 已完成且 `XWIN_CACHE_DIR`
  指向 `~/.cache/terminal-buddy/xwin`。
