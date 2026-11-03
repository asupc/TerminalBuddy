# 远程构建环境（debian99）

把 Terminal Buddy 的重负载构建（Windows exe 交叉编译、Android APK）从 NAS 挪到
构建主机 `debian99`（Debian 13，192.168.1.99，16 线程 / 15G 内存 / 442G NVMe）上执行。

## 为什么远程构建

- **NAS 常驻服务不再与编译抢资源**：原本构建容器受限额（`--memory=4g --cpus=8`）约束，
  远程构建无此限制，且 NAS 完全不承载编译负载。
- **规避 fnOS SMB 共享丢失的触发源**：`docker build` / `docker run` 的 overlay
  挂载事件可能让 fnOS 误删 vol2 的 SMB 共享（见全局工作约定）。重构建移走后，
  NAS 上的 Docker 操作只剩常驻服务，触发面大幅缩小。
- **绕开 fnOS 挂载权限 000 的坑**：源码同步到 Debian 本地磁盘后，rustc / npm
  看到的是正常权限文件（NAS 侧脚本内的 tar + chmod 兜底逻辑保留，双保险）。

## 日常使用

```bash
./scripts/remote-build.sh win        # 远程构建 Windows 单文件 exe，产物回传 dist/
./scripts/remote-build.sh android    # 远程构建 Android Release APK，产物回传 dist/
./scripts/remote-build.sh sync       # 只同步源码不构建
./scripts/remote-build.sh win --rebuild   # 参数透传给底层构建脚本
```

流程：tar-over-ssh 全量同步源码（排除 node_modules / target 等大目录，仅 ~13MB）
→ 远程执行 `scripts/build-windows-exe.sh` / `scripts/build-android.sh`（原样复用，
无任何修改）→ 产物 tar 回传本仓库 `dist/`。

增量编译缓存在 Debian 的 Docker 命名卷中（`terminal-buddy-win-cache` /
`terminal-buddy-android-cache`），与 NAS 侧历史一致，多次构建走增量。

## 一次性环境搭建（2026-11-02 已完成，重装系统时照此重建）

1. **SSH 免密**：NAS 的 `~/.ssh/config` 需有 `debian99`（huangmaoqiu）与
   `debian99-root`（root）两个别名，IdentityFile 均指向
   `~/.ssh/terminal_buddy_tb100_deploy`。公钥需在 Debian 对应用户的
   `~/.ssh/authorized_keys` 中。
2. **安装 Docker**（root）：
   ```bash
   ssh debian99-root 'apt-get update && apt-get install -y docker.io \
     && systemctl enable --now docker && usermod -aG docker huangmaoqiu'
   ```
3. **导入构建镜像**（内网管道直传，与 NAS 完全一致，免远程重新构建镜像）：
   ```bash
   docker save terminal-buddy-windows-builder:latest terminal-buddy-android-builder:latest \
     | ssh debian99 'docker load'
   ```
4. **迁移缓存卷**（增量编译的关键，跳过则首次构建为全量，需 30-60 分钟）：
   ```bash
   docker run --rm -v terminal-buddy-win-cache:/from:ro \
     terminal-buddy-windows-builder:latest tar -C /from -cf - . \
     | ssh debian99 'docker volume create terminal-buddy-win-cache >/dev/null; \
        docker run --rm -i -v terminal-buddy-win-cache:/to \
        terminal-buddy-windows-builder:latest tar -C /to -xf -'
   # android-cache 同理，换用 terminal-buddy-android-builder 镜像
   ```

## 故障排查

- **`无法免密 SSH 到 debian99`**：检查 `~/.ssh/config` 别名与密钥是否还在，
  `ssh debian99 'echo ok'` 手动验证。
- **远程磁盘不足**：`ssh debian99 'df -h ~'`。缓存卷会随增量产物缓慢增长，
  空间紧张时可 `docker volume rm` 对应卷后重建（代价：下次全量构建）。
- **产物校验**：`dist/` 下有 `.sha256`，与 NAS 本地构建产物格式完全一致。
