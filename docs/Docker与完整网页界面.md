# Docker 与完整网页界面

此分支让 Windows 桌面版与网页正式版复用 `terminal-buddy/src/` 的完整 React 界面。原 `web/` 轻量网页保持独立。网页正式资源输出到 `dist-web/`，桌面资源仍输出到 `dist/`。Docker 运行 `terminal-buddy-server`，不启动 Tauri 窗口、托盘或桌面终端插件。

## Windows 先看界面

双击 `terminal-buddy/preview-web.bat`，或执行：

```powershell
cd D:\terminal-buddy\terminal-buddy
npm ci --ignore-scripts --no-audit --no-fund
npm run dev:web:demo
```

打开 `http://127.0.0.1:1450/`。页面底部有“界面演示”标记，连接、文件与输出是示例数据，可查看布局、主题、侧栏、分屏和弹窗。此模式不连接真实终端。

## Windows 接入真实终端

独立服务端使用单独的 `terminal-buddy/server-data/`，不读取或覆盖现有桌面数据。以下命令会编译 Rust；仅在决定执行编译后使用：

```powershell
cd D:\terminal-buddy\terminal-buddy
.\start-web-server.ps1 -Rebuild -Workspace D:\你的项目目录
```

首次启动会要求设置网页登录密码，默认账号为 `admin`。编译之后再次运行脚本无需 `-Rebuild`。

本机独立服务端使用 `terminal-buddy/src-tauri/target/server/` 保存 Rust 编译产物，构建时关闭增量编译，避开已有的桌面或增量链接产物。完整 Rust 编译日志保存在 `terminal-buddy/server-data/logs/server-build.log`；编译失败时先查看日志中的第一条 `error`。

在另一个终端运行：

```powershell
cd D:\terminal-buddy\terminal-buddy
npm run dev:web
```

打开 `http://127.0.0.1:1450/` 登录。Vite 将 `/api` 和 `/ws` 转发到本机 9600 端口。演示模式与正式模式都使用 1450 端口，需要先停止原来的演示进程。开发模式的服务端 9600 页面需要已生成静态资源；界面开发时使用 1450 即可。

测试 Claude Hook 时，先关闭现有桌面应用，避免两端争用本机 19601 端口；Hook 绑定失败会在服务端日志中显示。普通终端不依赖该端口。

本次已编译完整网页静态资源，并在 `http://127.0.0.1:9610/` 启动真实服务，可以直接打开该地址。账号为 `admin`，预览密码保存在 `terminal-buddy/server-data/preview-password.txt`，无需修改现有桌面服务的 9600 端口。预览工作区为 `terminal-buddy/server-data/preview-workspace`。

本次服务停止后，可在 `terminal-buddy/` 中运行以下命令再次启动，沿用已保存的密码：

```powershell
.\start-web-server.ps1 -Port 9610 -Workspace .\server-data\preview-workspace
```

独立数据目录隔离的是 TerminalBuddy 配置与数据库；Claude 功能仍访问当前服务账号的 Claude 用户目录。Linux 容器中，该目录属于容器用户，不自动读取 Windows 用户目录。

## Windows 一键启动

在仓库根目录双击 `startDockerServer.bat`，默认优先使用已安装并运行的 Docker；Docker 不可用时退回本机独立服务端模式。两种方式使用同一份服务端程序，首次运行会按对应模式构建，服务就绪后自动打开浏览器。

需要 Docker 容器时，在命令行执行：

```bat
startDockerServer.bat docker
startDockerServer.bat docker-stop
startDockerServer.bat docker-logs
```

首次启动时，脚本会检查 `.env`，不存在就用默认值生成，并确认 `TERMINAL_BUDDY_WORKSPACE` 指向的目录存在；容器健康后自动打开浏览器。首次打开网页会要求创建管理员密码（至少 8 个字符），无需再手动准备密码文件。

## Linux Docker 部署

在仓库根目录复制 `.env.example` 为 `.env`，将 `TERMINAL_BUDDY_WORKSPACE` 改为服务器上已经存在的项目根目录。容器用户 UID 为 1000，挂载目录需要允许该用户读写。随后执行：

```bash
docker compose up -d --build
docker compose logs -f terminal-buddy
```

首次启动后，通过浏览器打开服务地址，在页面中创建管理员密码（至少 8 个字符）。也可以预先准备 `secrets/admin_password.txt` 只写入实际登录密码，并在 `compose.yaml` 中配置 `TERMINAL_BUDDY_PASSWORD_FILE: /run/secrets/admin_password` 与对应 `secrets` 段落；密码在首次启动时写入设置，之后不再读取该文件。密码文件应使用受限的目录权限管理。

默认端口只绑定宿主机 `127.0.0.1:9600`，可配置同机 HTTPS 反向代理转发 HTTP 和 WebSocket。需要直接在局域网访问时，显式将 `.env` 中的绑定地址改为 `0.0.0.0`。远程浏览器的主动剪贴板读取需要 HTTPS。

网页内“本地终端”在容器中执行；项目路径使用容器里的 `/workspace/...`。连接宿主机或其他服务器使用 SSH。镜像包含 Bash、Git 与 SSH 客户端；Node、Python、Claude、Docker CLI、kubectl 等开发工具按实际使用需求扩展镜像。默认不挂载宿主 Docker socket。

## 手机访问

手机和电脑直接打开同一个 Docker 服务地址即可，无需扫码。手机自动进入 `/m/`，使用与桌面版“扩展与服务 → Web 管理”相同的手机界面：会话、项目与命令、历史、文件，以及终端专用快捷键栏；电脑保持完整网页界面。两种界面使用相同的网页账号和密码验证。

请求桌面网站的手机和 iPad 也会按触屏设备识别；还可以直接打开 `http://<服务器IP>:<映射端口>/m/`，或从电脑登录页点击“打开手机界面”。Docker 服务的登录密码在“终端与连接 → 网页认证”中管理。Web 管理中原有的二维码仍可选用，其链接使用浏览器当前访问的地址、映射端口和 HTTPS 协议。

手机界面的数据来自当前 Docker 服务。已登记目录的项目即使没有连接配置或启动命令，也会出现在“项目与命令”中，可以通过项目旁的启动按钮进入该目录的默认 Shell。

手机接入已有终端时，历史输出会按各段产生时的行列尺寸回放，再适配当前屏幕，避免窄屏下光标定位、表格和边框错位。断线重连会重新发送当前尺寸；横竖屏切换和软键盘引起的可用空间变化也会同步到终端。

## 数据和运行语义

- `/data`：配置、SQLite、历史、上传缓存与 `server.key`。备份时必须包含密钥文件，否则保存的密码不能解密。
- `/home/terminalbuddy`：工具配置、SSH 与 Claude 用户目录。
- `/workspace`：宿主机项目根目录的挂载位置。
- 刷新网页重新接入存活终端，不按桌面启动恢复逻辑再次创建终端。
- 退出网页登录保留服务器会话；关闭终端标签才结束相应终端。
- 容器停止或重启会结束运行中的进程，数据卷保留配置和历史。
- 服务端模式是个人单账号服务，浏览器共用这个账号的配置和 Web 会话；没有多用户隔离功能。
- 服务端密码字段使用 AES-GCM，桌面版继续使用 DPAPI。跨端迁移现有密文需要重新录入密码。

## 平台差异与当前边界

网页保留桌面主体布局和主题。窗口最大化对应网页全屏，关闭按钮对应退出登录；浏览器最小化使用浏览器窗口按钮。服务器目录使用网页目录选择器，选择本机文件时先上传再返回服务器路径。

Windows 默认终端接管、系统托盘、注册表开机启动、`mstsc` 与桌面插件属于桌面能力，独立服务端不提供这些功能。整包数据导入导出和本地目录上传暂未接入浏览器下载流程，调用会明确提示不支持。SFTP 下载目前保存到用户选择的服务器目录。

## 验证状态

用户明确授权编译和启动后，已完成以下验证：

- 桌面前端与原轻量网页的 TypeScript 检查通过。
- 完整网页正式资源构建通过，输出到 `dist-web/`。
- Windows 独立服务端 Rust 检查与编译通过，并在 9610 端口运行。
- Windows 桌面端 `cargo check --lib` 通过；没有启动或打包新的桌面应用。
- 真实接口验证通过：登录与未登录拒绝、文件读写/重命名/删除、越界路径拒绝、Git 状态查询、保存密码加密和解密、WebSocket 终端执行与 Web 会话归属。
- 浏览器已登录完整界面，并通过键盘输入执行真实 PowerShell 命令；终端尺寸和文字显示已复查。

验证脚本为 `terminal-buddy/scripts/smoke-web-server.mjs`，仅允许连接本机服务，在已登记的隔离工作区内创建和清理随机测试文件、配置与终端。默认工作区必须先初始化为 Git 仓库；使用本次预览服务时，可从 `terminal-buddy/` 执行 `node scripts/smoke-web-server.mjs`。仅需要保留测试终端供界面查看时追加 `--keep-terminal`。

本机没有 Docker CLI，未构建或运行 Linux 镜像。Linux PTY、SSH/SFTP、Claude 完整交互与机器人功能尚未进行端到端验证。本次保留了正在运行的 Windows 桌面应用，其占用 19601 端口，因此独立服务的 Claude Hook 监听未启动。

## 修改范围

| 文件或目录 | 改动 |
| --- | --- |
| 根目录 `Dockerfile`、`compose.yaml`、`.dockerignore`、`.env.example`、`.gitignore`、`startDockerServer.bat` | 多阶段镜像、数据卷、项目挂载、默认忽略规则与 Windows 本机/Docker 一键启动 |
| `terminal-buddy/package.json`、`vite.config.ts` | 演示/正式网页模式、Tauri 浏览器适配别名、HTTP/WebSocket 开发代理 |
| `terminal-buddy/preview-web.bat`、`start-web-server.ps1` | Windows 演示启动和显式编译的独立服务启动 |
| `src/main.tsx`、`src/components/browser/`、`src/mock/setupMock.ts` | 登录入口，演示数据仅在演示模式启用 |
| `src/services/browser/`、`src/services/platform.ts`、`src/services/tauri/terminal.ts` | 请求、事件、终端数据、窗口、剪贴板、上传和目录选择的浏览器实现 |
| `src/App.tsx`、`src/services/sessionRestore.ts`、`src/stores/slices/sessionsSlice.ts`、`src/components/terminal/TerminalPanel.tsx`、`TerminalInstance.tsx` | 当前客户端归属、刷新接回会话、事件同步、避免重复页签、分屏适配和网页尺寸变化处理 |
| `src/types/index.ts`、`src/services/tauri/profiles.ts`、`src/components/profile-config/ConfigEditDialog.tsx`、`src/components/settings/ProfilesSettings.tsx`、`src/components/shell/NewTerminalMenu.tsx`、`TabNav.tsx`、`src/utils/openTerminalInDir.ts` | Linux Shell 类型和菜单 |
| `src/components/shell/TitleBar.tsx`、`src/components/settings/BehaviorSettings.tsx` | 网页窗口操作、禁用桌面专属选项 |
| `src/components/terminal/hooks/useDragDrop.ts`、`src/components/file-explorer/file-utils.ts`、`FileNav.tsx`、`RemoteFileTree.tsx`、`src/utils/projectPath.ts` | 浏览器文件上传、服务器路径分隔符和 Linux 大小写 |
| `src-tauri/Cargo.toml`、`Cargo.lock`、`build.rs`、`src/lib.rs`、`src/desktop.rs`、`src/runtime.rs`、`src/server_main.rs` | 桌面与服务端特性拆分、共享状态和事件、服务端配置与停止信号 |
| `src-tauri/src/commands/` | 命令属性按桌面特性启用，业务调用改用共享运行时，原生能力隔离；终端新增 Unix Shell 与 Web 输出订阅 |
| `src-tauri/src/services/` | 运行时调用解耦、桌面服务条件编译、服务端密码加密、固定数据目录和 SSH 编辑缓存 |
| `src-tauri/src/models/profile.rs`、`profile_validation.rs` | 加密错误阻止保存、区分密文类型、POSIX 参数引用 |
| `src-tauri/src/web/` | 完整网页业务命令白名单、上传与文件接口、事件连接、Git 后台任务和共享仓库互斥、真实路径范围检查、原子输出快照 |
| `src-tauri/src/services/platform_service.rs`、`src/components/browser/WebEntry.tsx`、`src/services/browser/connection.ts`、`core.ts` | 将 Windows 宿主构建号传递给网页终端，使用正确的 ConPTY 渲染参数 |
| `terminal-buddy/scripts/smoke-web-server.mjs` | 本机隔离工作区的真实 HTTP/WebSocket 集成验证 |

`portable-pty-patched/` 的库代码未修改，现有补丁继续使用。
