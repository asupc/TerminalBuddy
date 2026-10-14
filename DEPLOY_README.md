# TerminalBuddy 一键部署说明

本目录的部署脚本用于把 TerminalBuddy 的 `codex/docker-web` 分支构建成 Docker 镜像，
并部署到 CentOS 7 服务器（192.168.3.202），端口 `9610 -> 9600`，再由飞牛上的 frpc 映射到公网。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `deploy.bat` | Windows 一键部署入口：拉代码 → 免密认证 → 打包上传 → 远端构建 → 启动校验 |
| `deploy-centos.sh` | 服务器端一键部署：基础镜像兜底 → 生成 compose → 构建镜像 → 启动容器 → 健康检查 |
| `scripts/remote-deploy.sh` | `deploy.bat` 上传后在服务器执行的包装脚本（解压源码 + 调 `deploy-centos.sh`） |
| `scripts/remote-verify.sh` | 部署后校验脚本（容器状态、健康、HTTP、端口、数据卷） |
| `scripts/install-key.py` | 首次运行自动把本机公钥安装到服务器，实现后续免密 |

## 用法

在 Windows 上双击 `deploy.bat`，或在该目录执行：

```bat
deploy.bat                  :: 完整流程：git pull + 构建 + 部署 + 校验
deploy.bat --no-build       :: 跳过构建，用现有镜像快速重建容器
deploy.bat --no-pull        :: 不拉取最新代码，直接用本地源码
```

首次运行会生成密钥 `%USERPROFILE%\.ssh\terminal_buddy_deploy` 并自动安装到服务器
（复用 `~/.codex/private/centos-server/config.json` 中已保存的密码，无需手输）。

## 服务器端单独执行

若已登录服务器，也可以直接在项目根目录执行：

```bash
./deploy-centos.sh              # 构建 + 部署
./deploy-centos.sh --no-build   # 不构建，直接重建容器
./deploy-centos.sh --pull       # 构建前先 git pull
```

## 可配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TB_HOST_PORT` | `9610` | 宿主机映射端口 |
| `TB_DATA_DIR` | `/root/terminal-buddy/data` | 数据目录（容器 `/data`） |
| `TB_HOME_DIR` | `/root/terminal-buddy/home` | 用户目录（容器 `/home/terminalbuddy`） |
| `TB_WORKSPACE` | `/root/terminal-buddy/workspace` | 工作区（容器 `/workspace`） |
| `TB_USERNAME` | `admin` | 网页登录账号 |
| `TB_BIND_ADDRESS` | `0.0.0.0` | 绑定地址，改 `127.0.0.1` 则仅本机可访问 |
| `TB_IMAGE_MIRROR` | `docker.m.daocloud.io/library` | 基础镜像加速源（CentOS 7 直连 Docker Hub 常不通） |

示例：

```bash
TB_HOST_PORT=9620 TB_BIND_ADDRESS=127.0.0.1 ./deploy-centos.sh
```

## 服务器侧信息

| 项目 | 值 |
| --- | --- |
| 容器名 | `terminal-buddy` |
| 镜像 | `terminal-buddy:server` |
| 端口 | `192.168.3.202:9610 -> 9600/tcp` |
| 源码目录 | `/root/terminal-buddy/src` |
| compose | `/root/terminal-buddy/src/compose.centos.yaml` |
| 重启策略 | `unless-stopped` |
| 局域网地址 | http://192.168.3.202:9610/ |
| 公网地址 | http://123.57.172.104:9610/ （飞牛 frpc 转发） |

## 飞牛 frpc 配置

配置文件：`/vol1/1000/docker/frpc/frpc.ini`

```ini
[terminalBuddy]
type = tcp
local_ip = 192.168.3.202
local_port = 9610
remote_port = 9610
```

改完后重启 frpc：`docker restart frpc`

## 常见问题

**1. 基础镜像拉取失败**
CentOS 7 直连 Docker Hub 通常超时。脚本已内置加速源，可用 `TB_IMAGE_MIRROR` 换源：
`docker.1ms.run/library`、`hub.rat.dev/library`、`dockerpull.org` 等。

**2. 健康检查不通过**
脚本会自动打印最近 40 行日志。默认原因是数据目录属主不是容器内 uid 1000，
`deploy-centos.sh` 已自动 `chown -R 1000:1000`；若手动改过目录需重新执行脚本。

**3. 127.0.0.1 访问返回 000**
端口只绑在服务器 IP（`TB_BIND_ADDRESS=192.168.3.202`）时属正常现象，用局域网地址访问即可。

**4. 端口 9610 被占用**
脚本会先检查并给出占用进程；用 `TB_HOST_PORT` 换端口，同时记得同步修改飞牛 `frpc.ini`。

**5. 后续如何升级代码**
在项目目录 `git pull` 后执行 `deploy.bat`（默认就会先 `git pull --ff-only` 再构建部署）。

## 注意

镜像内**未**安装 Node.js / Codex CLI / Claude CLI。如需在网页终端里使用，
请在服务器上自行安装（或在 Dockerfile 中扩展），也可把宿主机二进制目录以只读方式挂载进容器。