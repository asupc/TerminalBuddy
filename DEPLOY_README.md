# TerminalBuddy 一键部署说明

本目录的部署脚本用于把 TerminalBuddy 的 `codex/docker-web` 分支构建成 Docker 镜像，
并部署到 CentOS 7 服务器（192.168.3.202），端口 `9610 -> 9600`，再由飞牛上的 frpc 映射到公网。

## 文件说明

两条链路结构完全对称：**发起端**负责拉代码、打包、上传、触发；**目标端**是上传后在目标机
以 root 执行的构建部署脚本。

| 文件 | 作用 |
| --- | --- |
| `deploy-centos.sh` | **发起端（→ CentOS）**：拉代码 → 免密认证 → 打包上传 → 目标机执行 → 自检。可在任意装了 ssh/scp/tar/curl 的机器上跑 |
| `deploy-fnos.sh` | **发起端（→ 飞牛 fnOS）**：打包源码 → 上传 → 飞牛上构建镜像并重建容器 → 自检 |
| `update.sh` | **飞牛本地更新**：使用当前目录源码构建镜像，由独立容器切换服务，失败自动恢复原容器与数据 |
| `scripts/update-fnos-container.sh` | `update.sh` 的独立更新执行体：克隆原部署配置、备份数据、切换与故障恢复 |
| `scripts/deploy-centos-remote.sh` | CentOS 目标端执行体（上传后以 root 运行）：解压、生成 compose、基础镜像兜底、构建/载入镜像、重建容器、健康检查 |
| `scripts/deploy-fnos-remote.sh` | 飞牛目标端执行体（上传后以 sudo 运行）：目录属主、生成 compose、构建/载入镜像、重建容器 |

## 用法

在项目根目录执行（任意 Linux 机器均可作为发起端，本机不需要装 docker / Node / Rust）：

```bash
./deploy-centos.sh                  # 完整流程：git pull + 目标机构建 + 部署 + 自检
./deploy-centos.sh --no-build       # 跳过构建，用目标机现有镜像快速重建容器
./deploy-centos.sh --no-pull        # 不拉取代码，直接用当前工作区
./deploy-centos.sh --build-local    # 改在本机构建镜像后上传（需本机 docker 且同架构）
./deploy-centos.sh --host 192.168.3.202 --ssh-port 22
```

首次运行会生成部署密钥 `~/.ssh/terminal_buddy_centos_deploy` 并自动安装到目标机，
之后全程免密。密码按优先级读取：环境变量 `TB_CENTOS_PASSWORD` →
`~/.codex/private/centos-server/config.json` → `~/.claude/skills/esxi-server/.pass` → 交互式输入。

## 在目标机上直接执行

`scripts/deploy-centos-remote.sh` 也可以手动传到目标机后单独运行，参数即目标机上的路径与端口：

```bash
sudo bash deploy-centos-remote.sh \
  /root/terminal-buddy /root/terminal-buddy/data /root/terminal-buddy/home \
  /root/terminal-buddy/workspace 9610 0.0.0.0 terminal-buddy terminal-buddy:server admin /var/run/docker.sock
```

注意它只负责「解压已在 `/tmp/terminal-buddy-src.tar.gz` 的源码包 + 构建部署」，
不会自己拉代码；没有源码包时会直接报错。

## 可配置项（环境变量）

发起端 `deploy-centos.sh` 用 `TB_CENTOS_*` 前缀：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TB_CENTOS_HOST` | `192.168.3.202` | 目标机地址（也可用 `--host`） |
| `TB_CENTOS_USER` | `root` | 目标机 SSH 账号（也可用 `--ssh-port` 配套调整） |
| `TB_CENTOS_SSH_PORT` | `22` | 目标机 SSH 端口 |
| `TB_CENTOS_APP_DIR` | `/root/terminal-buddy` | 目标机应用目录（源码落在其 `src/` 下） |
| `TB_CENTOS_PORT` | `9610` | 宿主机映射端口 |
| `TB_CENTOS_BIND_ADDRESS` | `0.0.0.0` | 绑定地址，改 `127.0.0.1` 则仅目标机本机可访问 |
| `TB_CENTOS_CONTAINER` | `terminal-buddy` | 容器名 |
| `TB_CENTOS_IMAGE` | `terminal-buddy:server` | 镜像 tag |
| `TB_CENTOS_USERNAME` | `admin` | 网页登录账号 |
| `TB_CENTOS_DOCKER_SOCKET` | `/var/run/docker.sock` | 目标机 Docker socket，自动读取 GID 授权给容器用户 |
| `TB_CENTOS_SSH_KEY` | `~/.ssh/terminal_buddy_centos_deploy` | 部署密钥路径 |
| `TB_CENTOS_CONFIG` | `~/.codex/private/centos-server/config.json` | 凭据文件（也可用 `--config`） |
| `TB_CENTOS_PASSWORD` | 无 | SSH 密码，优先级最高（一般不用，首次装公钥时才需要） |
| `TB_CENTOS_PULL` | `1` | 是否先 `git pull`，设 `0` 等同 `--no-pull` |

目标端 `scripts/deploy-centos-remote.sh` 单独执行时用：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TB_IMAGE_MIRROR` | 内置四个备用源 | 基础镜像加速源，接受裸源或带 `/library` 后缀两种写法 |
| `TB_SKIP_BUILD` | `0` | 设 `1` 跳过构建，直接用现有镜像重建容器 |
| `TB_IMAGE_TARBALL` | `/tmp/terminal-buddy-image.tar.gz` | 预置镜像包路径，存在则直接 `docker load` |
| `TB_IMAGE_CURRENT` | `0` | 设 `1` 表示现有镜像即所需镜像，无需编译 |

示例：

```bash
TB_CENTOS_PORT=9620 TB_CENTOS_BIND_ADDRESS=127.0.0.1 ./deploy-centos.sh
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

## 一键部署到飞牛 fnOS（deploy-fnos.sh）

把 TerminalBuddy 部署到飞牛 NAS（192.168.3.77），与 CentOS 实例并存、互不影响。
飞牛默认禁止 root 登录，脚本用普通管理员账号 + `sudo` 完成，**不需要**在飞牛上装 Node.js / Rust。

```bash
./deploy-fnos.sh                 # 全流程：拉代码 → 打包源码 → 上传 → 飞牛上构建镜像 → 重建容器 → 自检
./deploy-fnos.sh --no-build      # 跳过构建，用飞牛上现有镜像重建容器
./deploy-fnos.sh --no-pull       # 不拉取本机代码，直接用当前工作区
./deploy-fnos.sh --build-local   # 改在本机构建镜像后上传（需本机 docker）
```

sudo 密码来源（按优先级）：环境变量 `TB_FNOS_PASSWORD` → 凭据文件（`--config`，默认
`~/.codex/private/fnos/config.json`）→ 交互式隐藏输入。密码只经 stdin 交给远端 `sudo -S`，
不写入命令行参数或日志。首次运行会自动生成部署密钥并安装公钥到飞牛，之后全程免密。

**默认在飞牛上编译**：部署机不需要安装 docker / Node / Rust，任意能 ssh 的机器都能发包，
源码包约 16MB，比搬运 158MB 镜像包省事。i3-N305（8 核 / 7.8G 内存）首次构建约 20-40 分钟；
之后源码指纹未变时**直接跳过构建**复用镜像，日常改配置或重建容器几乎瞬时完成。
基础镜像走「本地命中 → 离线备份 → 备用镜像源」三级兜底，构建所需的 npm / crates 源
在飞牛上实测可达。需要复用本机 Docker 层缓存时用 `--build-local`（本机需装 docker）。

默认配置（写在 `deploy-fnos.sh` 顶部，可用环境变量覆盖）：

| 项 | 默认值 |
|---|---|
| 目标主机 | `192.168.3.77:22` |
| 部署账号 | `397383523`（普通管理员，使用 sudo） |
| 应用目录 | `/vol1/1000/docker/terminal-buddy` |
| 数据目录 | `/vol1/1000/docker/terminal-buddy/data` → 容器 `/data` |
| 用户目录 | `/vol1/1000/docker/terminal-buddy/home` → 容器 `/home/terminalbuddy` |
| 工作区 | `/vol1/1000/docker/terminal-buddy/workspace`（容器内同路径） |
| 监听端口 | `9600`（容器内同为 9600） |
| 访问地址 | http://192.168.3.77:9600/ |

飞牛适配要点：

- **无 root 登录**：全部特权操作通过 `sudo` 执行，部署脚本以 root 运行后再降权到容器 uid 1000。
- **TrimACL**：飞牛 `/vol1` 以自家 TrimACL 判定权限，`setfacl` 无效。脚本以 `chown 1000:1000`
  为主，并在部署时用容器内 uid 1000 **实际写入探测** data / home / workspace 三个目录，
  失败即中止并给出 `trimacl -m a:u:1000:...` 的补救命令。
- **工作区同路径挂载**：容器内路径与宿主机一致，网页终端里 `docker compose` 的相对目录
  挂载（`.:/app`、`./data`）才能落到正确的宿主机路径。
- **项目名固定**：源码位于 `src/` 子目录，`.env` 中写入 `COMPOSE_PROJECT_NAME=terminal-buddy`，
  避免项目名变成 `src` 与既有容器/网络脱节。
- **Docker socket**：飞牛该 socket 的 GID 为 994，脚本自动读取并写入 `group_add`。
- **基础镜像兜底**（在飞牛上构建时使用）：本地命中 → 离线备份
  （`<应用目录>/base-images/`）→ 备用镜像源，避免飞牛镜像加速源故障时构建第一步就失败。

### 在飞牛上用当前源码更新自己（update.sh）

在包含 `Dockerfile` 和 `terminal-buddy/` 的源码根目录执行。既可在飞牛 SSH 终端中运行，
也可在 TerminalBuddy 自己的网页终端中运行：

```bash
cd /vol1/1000/docker/terminal-buddy/workspace/terminal-buddy
bash update.sh                       # 构建当前源码并更新，成功后保留交互式命令行
bash update.sh --exit-on-success     # 成功后结束脚本，适合自动化调用
bash update.sh --detach              # 启动独立切换任务后返回
bash update.sh --keep-rollback       # 成功后保留旧容器与快照，暂缓自动清理
bash update.sh --container terminal-buddy --health-timeout 300
```

源码也可位于原部署的 `/vol1/1000/docker/terminal-buddy/src`，或通过
`--source-dir /实际源码目录` 指定。宿主机账号没有 Docker 权限时使用 `sudo bash update.sh`。
支持 `TB_FNOS_CONTAINER`、`TB_FNOS_IMAGE`、`TB_UPDATE_HEALTH_TIMEOUT`、
`TB_UPDATE_KEEP_ROLLBACK` 和 `TB_UPDATE_CLEANUP_DELAY` 环境变量，
完整选项见 `bash update.sh --help`。

在 TerminalBuddy 完整网页终端里发起更新时，窗口不会因旧容器停止而关闭；页面会进入
自更新监视模式，持续等待服务恢复。构建和切换日志会保存在持久目录
`/data/.terminal-buddy-update/update.log`，服务恢复后自动补齐停机期间的日志。
完成后原地恢复终端页签与连接，不刷新整页；日志面板继续保留，可收起或下载。
此恢复流程不依赖「启动时恢复页签」开关。

在宿主机交互终端中更新成功后进入 Bash 命令行，窗口保留，可继续输入命令；
输入 `exit` 才返回上级命令行或关闭窗口。无交互终端时直接返回，
也可用 `--exit-on-success` 显式关闭这一行为。
如果是在被更新容器自身的网页终端里运行，旧容器停止时原终端进程会终止；
完整网页保留当前页面和日志面板，并在更新成功或回退完成后自动重建终端连接。
需要保留同一个操作系统进程时，仍应从飞牛 SSH 终端执行。
容器停机期间网页保留已收到的日志；新增日志在服务恢复后补齐。
上述更新监视适用于完整网页界面（`/`），手机精简界面（`/m/`）暂不支持。
当前已打开的网页需要先具备此更新监视功能，才能在后续自更新时接管重连。

更新沿用现有容器的端口、环境变量、网络、工作目录、Docker socket 附加组和绑定挂载，
不会重新生成 Compose 或覆盖 `.env`。适用于 `deploy-fnos.sh` 创建的绑定挂载部署；
自动删除容器、命名卷、静态 IP、嵌套数据挂载等无法安全原样恢复的配置会在切换前拒绝。

恢复流程：

1. 检查当前源码和原服务；使用独立标签构建镜像，构建失败时旧服务继续运行。
2. 由固定名称 `terminal-buddy-updater` 的独立容器执行后续操作，防止并发更新。
   网页终端断开不影响切换；更新任务意外退出或 Docker 重启后会继续恢复未完成的切换。
3. 先创建停止状态的候选容器，再停旧服务，将完整 `/data` 和 `/home/terminalbuddy`
   备份到更新容器中，包含 SQLite、登录密钥、CLI 安装和配置。停机时间包含快照耗时，
   请为两份目录的快照预留磁盘空间；项目工作区不参与快照恢复。
4. 保留并重命名旧容器，启动新版，通过 Docker 健康检查、连续 HTTP 检查、目录写入和
   Docker socket 检查后才发布正式镜像标签。
5. 切换失败时先移除新版，恢复启动前的数据快照，再恢复原容器名称、重启策略并启动，
   确认旧服务健康。回退暂时失败时，独立任务会自动重试，恢复材料持续保留。
6. 默认成功后由临时 AutoRemove 清理容器等待 10 秒，再删除旧容器、更新容器和
   临时镜像标签；`--keep-rollback` 或 `TB_UPDATE_KEEP_ROLLBACK=1` 可保留这些材料，
   `TB_UPDATE_CLEANUP_DELAY` 可调整清理前的保留秒数。

```bash
docker logs -f terminal-buddy-updater   # 重连后查看更新或回退结果
docker cp terminal-buddy-updater:/tmp/terminal-buddy-update/ ./terminal-buddy-update-backup
```

默认成功更新会在短暂延迟后自动删除 `terminal-buddy-backup-<本次编号>`、
`terminal-buddy-updater` 以及本次更新的临时镜像标签，不留下成功更新的容器残留。
如果使用 `--keep-rollback`，旧容器保持停止且禁用自动重启；旧镜像和快照保留，
再次更新时上一更新容器也会按要求保留或清理。
失败或回退材料不会在成功前删除；需要排查时，快照目录中的 `result` 为
`updated`、`rolled-back` 或 `rollback-failed`，`original-container.json` 保存更新前的
完整容器配置。这些文件包含用户数据和配置，应与正式数据采用相同的保管方式。
此脚本用于更新已有健康服务，首次部署仍使用 `deploy-fnos.sh`。

### 首次登录

部署完成后打开 http://192.168.3.77:9600/ ，页面会要求**创建管理员密码**（至少 8 个字符），
账号为 `admin`。数据目录此时是全新的，与 CentOS 实例完全隔离。

也可以预先准备密码：在飞牛上的 compose 中配置 `TERMINAL_BUDDY_PASSWORD_FILE: /run/secrets/...`
并在首次启动前提供该文件，密码只在首次启动时读取。

### 飞牛侧信息

| 项目 | 值 |
| --- | --- |
| 容器名 | `terminal-buddy` |
| 镜像 | `terminal-buddy:server` |
| 端口 | `0.0.0.0:9600 -> 9600/tcp` |
| 源码目录 | `/vol1/1000/docker/terminal-buddy/src` |
| compose | `/vol1/1000/docker/terminal-buddy/src/compose.fnos.yaml` |
| 部署状态 | `/vol1/1000/docker/terminal-buddy/.deploy-state` |
| 重启策略 | `unless-stopped` |
| 访问地址 | http://192.168.3.77:9600/ |

常用运维（在飞牛或经 ssh）：

```bash
docker logs -f --tail 100 terminal-buddy     # 查看日志
docker restart terminal-buddy                # 重启服务
docker compose -f /vol1/1000/docker/terminal-buddy/src/compose.fnos.yaml down   # 停止
```

### 安全边界

容器挂载了宿主机的 `/var/run/docker.sock`，因此**网页终端及其中的 Claude 可以管理飞牛上的
全部容器、镜像、卷和网络**，权限等价于宿主 root。该实例当前只监听局域网 `0.0.0.0:9600`，
**不要**直接映射到公网；确需公网访问请配置带 HTTPS 的反向代理并设置强管理员口令。
若只想发布单个端口到公网，可在飞牛的 frpc 配置中新增一条指向 `192.168.3.77:9600` 的映射。

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

## 登录有效期与持久化

网页端的登录状态现在**有效期 30 天**，并且**重启服务 / 重建容器后依然保持登录**：

- JWT 有效期由 `terminal-buddy/src-tauri/src/web/auth.rs` 的 `TOKEN_TTL_DAYS` 控制（默认 30 天）。
- JWT 签名密钥持久化在数据目录的 `jwt.key`（容器内 `/data/jwt.key`，权限 600）。
  密钥首次启动时自动生成，之后每次启动都复用同一个密钥，因此重启前后签发的 token 都有效。
- 该文件必须与 `/data` 一起备份。**删除 `jwt.key` 等于让所有已登录设备立刻掉线**，需要重新登录。
- 主动退出登录（或修改管理员密码后按需清理）仍会立即失效对应会话。

升级到本次改动之前部署的实例，第一次重建容器会生成新的 `jwt.key`，
浏览器里保存的旧 token 会失效一次，重新登录后即可长期保持。

验证方式（服务器上执行）：

```bash
ls -l /root/terminal-buddy/data/jwt.key        # 应存在且为 600 权限、64 字节
docker restart terminal-buddy                  # 重启后浏览器无需重新登录
```

## 常见问题
**1. 基础镜像拉取失败**
CentOS 7 直连 Docker Hub 通常超时。脚本已内置加速源，可用 `TB_IMAGE_MIRROR` 换源：
`docker.1ms.run/library`、`hub.rat.dev/library`、`dockerpull.org` 等。
飞牛侧（`deploy-fnos.sh` 默认即在飞牛上构建）同样内置四个备用源，并支持
`<应用目录>/base-images/` 离线备份，镜像源全线故障时仍可恢复。

**2. 健康检查不通过**
脚本会自动打印最近 40 行日志。默认原因是数据目录属主不是容器内 uid 1000，
`deploy-centos.sh` 已自动 `chown -R 1000:1000`；若手动改过目录需重新执行脚本。

**3. 127.0.0.1 访问返回 000**
端口只绑在服务器 IP（`TB_CENTOS_BIND_ADDRESS=192.168.3.202`）时属正常现象，用局域网地址访问即可。

**4. 端口 9610 被占用**
目标端脚本会先检查并给出占用进程；用 `TB_CENTOS_PORT` 换端口，同时记得同步修改飞牛 `frpc.ini`。

**5. 后续如何升级代码**
CentOS：在任意机器的工作区执行 `./deploy-centos.sh`（默认先 `git pull --ff-only`，
再打包上传到目标机构建部署）。
飞牛：执行 `./deploy-fnos.sh` 即可，脚本会自动重建镜像并只在镜像真正变化时
更新飞牛上的镜像与容器（未变化时飞牛侧服务零中断）。

**6. 飞牛部署报「目录对容器内 uid 1000 不可写」**
飞牛 `/vol1` 以 TrimACL 判定权限，POSIX ACL 不生效。按报错提示在飞牛上执行：

```bash
sudo chown -R 1000:1000 /vol1/1000/docker/terminal-buddy/{data,home,workspace}
sudo /usr/trim/bin/trimacl -m a:u:1000:rwxpdDaAeEc:sfd /vol1/1000/docker/terminal-buddy
```

**7. 飞牛的镜像 / 容器被系统清理**
飞牛会回收未被容器占用的镜像。重新执行 `./deploy-fnos.sh` 即可恢复；
由于本机保留构建缓存，重新导出镜像只是一分钟左右的事。

## 在网页终端和 Claude 中部署宿主机 Docker 容器

镜像包含 Docker CLI、Compose 和 Buildx（默认从 `docker:28-cli` 复制客户端，
可在构建时用 `--build-arg DOCKER_CLI_IMAGE=...` 更换）。容器通过挂载的
`/var/run/docker.sock` 连接宿主机现有 Docker Engine，新建的容器由宿主机运行。
TerminalBuddy 仍以 uid 1000 运行，通过附加用户组访问 socket。

### CentOS 一键部署

本次升级需要完整重建镜像，不能使用 `--no-build`：

```bash
./deploy-centos.sh --no-pull
```

目标端脚本会自动检查目标机 socket、读取其 GID，生成挂载和附加用户组，
并在部署后以应用用户检查 Docker、Compose、Buildx 及 Engine ID。
自定义或 rootless Docker 需把 socket 路径换掉：发起端设 `TB_CENTOS_DOCKER_SOCKET`，
目标端单独执行时改最后一个位置参数。

工作区同时挂载到宿主机同名绝对路径和旧的 `/workspace` 路径，旧项目文件仍可访问。
默认新工作区为 `/root/terminal-buddy/workspace`；已有项目如果登记的是 `/workspace/...`，
请在网页中将项目目录改为 `/root/terminal-buddy/workspace/...` 后重新打开终端，
以便 `docker compose` 的 `./data`、`.:/app` 等目录挂载使用正确的宿主机路径。
镜像仅对容器自身的 `/root` 开放路径穿越，不修改宿主机 `/root` 的权限。

### 手动 Compose 部署

Linux 在 `.env` 中设置以下变量（GID 用 `stat -c '%g' /var/run/docker.sock` 查询）：

```dotenv
TERMINAL_BUDDY_WORKSPACE=/srv/projects
TERMINAL_BUDDY_CONTAINER_WORKSPACE=/srv/projects
TERMINAL_BUDDY_DOCKER_SOCKET=/var/run/docker.sock
TERMINAL_BUDDY_DOCKER_GID=995
```

上面的 `995` 仅为示例，必须替换为实际 GID。然后执行 `docker compose up -d --build`。
自定义工作区应使用项目专用目录，避免覆盖容器的 `/data`、`/home/terminalbuddy` 或系统目录。
Windows Docker Desktop 使用 Linux 容器模式；保留容器工作区 `/workspace`，socket GID 通常为 `0`。
Windows 路径与容器路径不同，应用容器的 bind source 需要显式使用 Docker Desktop 能访问的宿主机路径，
或使用 Docker 命名卷。

### 使用与验证

在网页终端运行：

```bash
docker version
docker ps
docker compose version
docker buildx version
cd /root/terminal-buddy/workspace/你的项目
docker compose up -d --build
```

在该终端启动的 Claude 同样可以执行这些命令。服务器端也可执行
`docker exec --user terminalbuddy terminal-buddy docker ps` 验证权限。
如果旧项目仍需从 `/workspace` 启动，应在部署文件中为 bind source 写入宿主机绝对路径。

socket 授权允许网页终端及其中的 Claude 管理宿主机全部容器、镜像、卷和网络，
其权限可扩展到宿主机 root。请仅向可信用户提供此实例的访问权限。

## 容器环境检测与工具安装

Docker 网页版顶部的“容器环境”按钮位于检查更新按钮旁。登录后首次自动打开检测弹框，
同一浏览器、网页地址和账号只自动展示一次；之后可以随时点击按钮手动打开。
桌面版和直接运行在宿主机上的独立 Web 服务不显示此入口。

当前检测 Claude Code 和 Codex CLI：显示是否安装及版本，没有安装时可点击“一键安装”。
安装使用各工具的官方安装器，Claude 使用 stable 通道，在后台执行；关闭弹框不会中断，
重复请求不会创建多个安装进程，失败后可查看原因并重试。

镜像在构建时预装提供 `ps` 命令的 `procps` 依赖，重新构建镜像或创建容器后仍然可用，无需手动安装。
环境检测会实际查询服务进程，区分可用、缺失和查询失败。旧版或自定义镜像缺失该依赖时，
可点击“一键安装”，通过已挂载的 Docker socket 以 root 身份为当前容器补装。
安装在后台执行，关闭弹框不会中断，重复请求会被拦截，完成后自动重新检测；失败时显示原因并允许重试。
安装仅使用固定的 `procps` 包命令，目标容器由服务端识别，不接受客户端传入的容器 ID 或命令。

一键安装需要容器内 Docker CLI 能访问挂载到 `/var/run/docker.sock` 的宿主机 Docker。
“手动安装方法”保留了可复制的宿主机命令，自定义容器名需替换其中的 `terminal-buddy`。
旧镜像的一键补装保存在当前容器的可写层，重启容器会保留；要在重建容器后继续保留，
请更新源码、重新构建并使用已内置 `procps` 的新版镜像。

Claude 安装在容器用户的 `~/.local/bin` 和 `~/.local/share/claude`，不依赖宿主机 Claude 或 SSH。
现有部署已挂载完整的 `/home/terminalbuddy`，所以安装和用户配置会在重建容器后保留。
自定义部署也需要持久化这个用户目录，并确保容器用户（默认 uid 1000）有写入权限。

安装后在网页终端输入 `claude` 即可启动；模型登录或 API 配置由 Claude 的用户配置管理。
Claude 对代码的访问范围由容器挂载目录和文件权限决定。

### 自定义 Claude 模型配置

Docker 网页顶部“Claude 模型配置”按钮可新增、编辑、删除多条自定义配置，
也可从“容器环境”弹框进入。填写名称、Anthropic Messages 兼容的 API 基础地址、
API 密钥与模型 ID，支持 AUTH_TOKEN / API_KEY 认证、Opus / Sonnet / Haiku 模型映射，
以及高级环境变量 JSON。仅提供自定义配置，不包含接入商预设或协议转换代理。
“从 JSON 填入”支持 CC Switch / Claude settings.json 中的 env 对象。

保存和启用是两个操作：保存后点击条目的“启用”即可切换；编辑当前启用的条目时，
“保存并应用”同步更新容器配置。切换后需退出运行中的 Claude，再输入 `claude` 启动；
项目级设置、终端自定义环境变量及启动参数可能覆盖此处的用户级配置。

条目保存在 `/data/terminal_buddy.db` 的 `claude_providers` 表，完整 API 配置经服务端
AES-GCM 加密存储，网页不会读取回完整 API 密钥；编辑密钥留空表示保持原值。
备份或迁移时请同时保留 `/data/server.key`，否则无法解密历史条目。
当前启用条目和切换前配置也保存到数据库，支持“导入当前容器配置”和“恢复原配置”。
写入 settings.json 时保留 hooks、权限等无关设置，清理旧地址、凭据和模型映射，
通过临时文件原子替换；数据库提交失败时回退文件。接口要求网页登录认证，非 Docker 版禁用。

镜像不预装 Node.js、Codex CLI 或 Claude CLI，其他命令行工具可按需扩展 Dockerfile。

## Codex 启动提示找不到 ps

如果旧版或自定义镜像内运行 `codex` 时出现 `failed to invoke ps for pid-managed app server: No such file or directory`，说明容器缺少 `ps` 命令。新版 Dockerfile 已预装 `procps`，更新源码后重新构建镜像并重建容器即可长期解决。

暂时不更新镜像时，可在网页顶部打开“容器环境”，找到“procps（ps 命令）”卡片并点击“一键安装”。后台安装完成后会自动重新检测，确认“已经可用”后，在原终端重新运行 `codex`，无需重启服务。

使用 `deploy-centos.sh` 更新功能时，默认只构建当前目录的源码，不会自动拉取最新代码。请先更新实际部署分支，再完整部署：

```bash
git branch --show-current
git pull --ff-only
./deploy-centos.sh
```

更新时必须重新构建镜像并重建容器，才能使用镜像内置的 `procps`；`--no-build` 只复用现有镜像，不会加入新依赖。使用仓库默认 Compose 配置时，可执行 `docker compose up -d --build`。

一键安装不可用时，可以展开卡片中的“手动安装方法”，或在 Docker 宿主机执行以下命令：

```bash
docker exec --user root terminal-buddy sh -lc 'apt-get update && apt-get install -y --no-install-recommends procps'
docker exec --user terminalbuddy terminal-buddy sh -c 'command -v ps && ps -p "$$" -o pid=,ppid=,args='
```

补装后，在原网页终端重新运行 `codex`。补装仅对当前容器生效；后续请更新为已内置 `procps` 的新版镜像，避免每次重建容器都要安装。

暂时无法安装系统包时，可先执行 `codex --no-daemon`，按报错提示跳过后台服务。恢复或分叉会话时，对原命令保留全部参数并加上 `--no-daemon`。
