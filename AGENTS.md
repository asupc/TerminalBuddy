# AGENTS.md

## 项目结构

- **仓库根目录只是个壳。** 桌面端与服务端源码均在 `terminal-buddy/` 下；原生安卓客户端在根目录 `android/` 下。
  - **桌面 / 完整网页前端（`terminal-buddy/src/`）**：React 19、TypeScript 6、Zustand 5、xterm.js 6、Monaco Editor、React Flow（`@xyflow/react`）。桌面版打包 `dist/`；`--mode browser` 构建出完整网页界面 `dist-web/`（Release 桌面端经 `rust-embed` deflate 压缩内嵌，独立服务端与 Docker 镜像直接托管目录）。
  - **Rust 后端（`terminal-buddy/src-tauri/`）**：Tauri 2、axum、Hyper / Tokio、portable-pty（ConPTY）、ssh2、bcrypt、jsonwebtoken、rusqlite（WAL）、sysinfo、cron / chrono-tz、zip。同一套源码编译两个互斥 feature 的二进制：
    - `terminal-buddy`（默认 `desktop` feature，入口 `src/desktop.rs`）：Windows 桌面端，含托盘、DPAPI、WebView2 定制、WinRT 通知与默认终端 COM Handoff。
    - `terminal-buddy-server`（`--no-default-features --features server`，入口 `src/server_main.rs`）：Linux / Docker 无头服务端，使用 `runtime.rs` 的无头 `AppHandle` + `EventBus`、AES-GCM 本地密钥加密与 `/api/auth/setup` 初始化。
  - **Android 原生客户端（`android/`）**：Kotlin + Jetpack Compose（包名 `com.terminalbuddy.android`，minSdk 26 / targetSdk 36），对接 Web API 实现原生 AI 对话、服务端终端操作、终端 Agent 接力、后台通知（前台保活 + WorkManager 补偿）与在线更新；内置简版 / 完整版两种界面模式（`AppUiMode`，默认简版），在「我的 → 界面模式」切换，无需分包构建。
  - **后端分层**：`commands/`（薄 Tauri 命令封装）→ `services/`（业务逻辑、持久化、调度与进程管理）→ `models/`（数据结构与校验），外加 `web/`（axum HTTP/WS 服务与 `desktop_dispatch.rs` 浏览器调用适配器）及 `runtime.rs`（桌面 / 服务端统一的 `AppHandle`、`Manager`、`Emitter`、`async_runtime` 抽象）。
- **独立手机 SPA（`terminal-buddy/web/`）已于 2026-10 彻底退役**：不参与任何构建与打包，手机浏览器直接使用 `src/` 构建的完整网页界面。`terminal-buddy/web/` 仅作历史参考保留，不要改动或重新引入；注意区分活跃的 Rust 模块 `terminal-buddy/src-tauri/src/web/`。
- **根目录辅助目录**：`xcj/`（用户日常一键构建/部署/更新 sh 入口）、`scripts/`（Windows `.bat`/`.ps1`、远端目标执行脚本 `deploy-*-remote.sh` 及旧路径兼容转发脚本）、`docs/`（设计规范与使用指南）、`design/`（UI 设计稿与静态预览）、`RELEASE_NOTES/`（版本发布说明）。

## 常用命令

### 桌面端 / 前端 / Rust（在 `terminal-buddy/` 下执行）

```bash
npm install                   # 安装前端依赖
npm run dev                   # 启动 Vite dev server（127.0.0.1:1450，strictPort，不含 Rust）
npm run dev:web               # 以 --mode browser 启动 Vite（调试完整网页界面）
npm run tauri dev             # 完整 Tauri 开发模式（Vite 1450 + Rust desktop）
npm run build                 # tsc && vite build（产物 dist/）
npm run build:web:desktop     # tsc && vite build --mode browser（产物 dist-web/）
npm run prepare:vscode-terminal  # 准备 VS Code 终端插件资源
npm run server:dev            # 启动独立服务端（cargo run --features server）
npm run tauri build           # 生产构建（NSIS 安装包）；beforeBuildCommand 会依次执行
                              # prepare:vscode-terminal + build + build:web:desktop
npx tauri build --no-bundle   # 仅编译桌面 exe（Windows 快捷脚本：terminal-buddy/build-fast.bat）
                              # 完整安装包脚本：terminal-buddy/build.bat

npx tsc --noEmit              # 前端 TypeScript 类型检查
python scripts/check-invoke-coverage.py  # 校验前端 invoke() 是否已全部注册到 desktop.rs

cd src-tauri && cargo check   # Rust 桌面端编译检查（default: desktop）
cd src-tauri && cargo check --no-default-features --features server  # Rust 服务端编译检查
cd src-tauri && cargo test --lib         # Rust 单元测试（53 个含单测文件、428 个用例）
```

独立 Node 测试与冒烟脚本位于 `terminal-buddy/scripts/`：
- `node scripts/test-*.mjs`（9 个聚焦前端纯逻辑与插件的单测脚本，含 `npm run test:vscode-terminal`）
- `node scripts/smoke-web-server.mjs`（针对本地预览服务端的 HTTP/WS 冒烟验证）

### 跨端构建、部署与更新（在仓库根目录执行）

- **用户入口 sh 脚本统一放在 `xcj/`**（2026-11 起约定）：
  - `xcj/update.sh`：统一更新入口（`local` 更新本机 `/opt/terminal-buddy` systemd 服务，支持在网页终端内通过 `systemd-run` 脱离 cgroup 后台完成重启/健康检查/失败回滚；`fnos` 复用 `deploy-fnos.sh`；默认 `all`）。
  - `xcj/deploy-fnos.sh` / `xcj/deploy-centos.sh`：Docker 服务端一键部署（飞牛 fnOS 本机构建镜像推送；CentOS 默认传源码远端构建）。
  - `xcj/build-windows-exe.sh`：Linux **本机**通过 `cargo-xwin` 交叉编译 Windows 单文件 exe（不走 Docker；自动补齐 `rustup`/`cargo-xwin`/系统包与 `~/.cache/terminal-buddy/xwin` 缓存，产物落仓库根 `dist/` 并附 `.sha256`，成功后移动到 `/mnt/fnos/code/`，不可用时留在 `dist/`；不产安装包，安装包在 Windows 用 `terminal-buddy/build.bat`）。
  - `xcj/build-android.sh`：Linux **本机**编译并 `apksigner` 校验 Release APK（JDK 17 + Android SDK 36 首次自动下载至 `~/.android-sdk`；构建前自增 `android/app/build.gradle.kts` 的 `versionName`/`versionCode`，失败自动回退，结束后清理 Gradle/Kotlin JVM；产物同样落 `dist/` 后尝试移动 `/mnt/fnos/code/`）。
  - `xcj/remote-build.sh`：将源码通过 `tar-over-ssh` 同步至远端构建主机（默认 `debian99`）执行 `build-windows-exe.sh` / `build-android.sh` 后回传 `dist/`。
- **其余脚本仍在 `scripts/`**：Windows 入口 `scripts/dev.bat`（直接启动 `tauri dev`）、`scripts/build-android.bat` / `scripts/build-android.ps1`（Windows 编译签名 APK 并 adb 安装启动）、`scripts/startDockerServer.bat`、远端目标执行脚本 `scripts/deploy-*-remote.sh` 以及旧路径兼容转发脚本。
- **Android Gradle 直接命令**（在 `android/` 下执行）：`./gradlew :app:assembleDebug`、`./gradlew :app:testDebugUnitTest`、`./gradlew :app:assembleRelease`（使用仓库内提交的 `release.keystore` 与 `keystore.properties` 自动签名）。
- **本机服务端构建模板备注**：`build-windows-exe.sh` 与 `build-android.sh` 在本机部署中已登记为服务端命令模板（「项目构建」分类，数据在 `/opt/terminal-buddy/data/command_templates.json`）。

## 验证顺序与规范

仓库没有配置 lint 或格式化工具。TypeScript strict 模式开启了 `noUnusedLocals` 和 `noUnusedParameters`，未使用的绑定会让 `tsc` 失败。改动后的推荐验证顺序：

1. 在 `terminal-buddy/` 下执行 `npx tsc --noEmit`
2. 在 `terminal-buddy/src-tauri/` 下执行 `cargo check`；若改动了跨模式共用模块、Web API 或 `runtime.rs`，再执行 `cargo check --no-default-features --features server`
3. 改动 Rust 后，在 `terminal-buddy/src-tauri/` 下执行 `cargo test --lib`
4. 新增、删除或改名 Tauri 命令及前端 `invoke()` 时，在 `terminal-buddy/` 下执行 `python scripts/check-invoke-coverage.py`
5. 改动涉及的前端逻辑若有对应 `scripts/test-*.mjs`（或 Android 改动），顺手运行对应测试或 `./gradlew :app:testDebugUnitTest`

`terminal-buddy/web/` 已退役且不参与任何构建，无需检查或维护。

## Rust 相关约定

- Edition 2021；lib crate 名为 `terminal_buddy_lib`（`rlib` + `cdylib`）。`desktop` 与 `server` 特性互斥（`lib.rs` 中有 `compile_error!` 保护）。
- `src-tauri/.cargo/config.toml`：`rustc-wrapper = "sccache"` 当前默认注释；在 `x86_64-pc-windows-msvc` 下配置了 `/DELAYLOAD:comctl32.dll` + `delayimp.lib`，避免无 Common-Controls v6 manifest 的 `cargo test` 二进制加载时报 `STATUS_ENTRYPOINT_NOT_FOUND`。
- dev profile 使用 `opt-level = 1` + 增量编译；release 使用 `panic = "abort"`、`lto = "thin"`、`opt-level = "s"`、`strip = true`、`codegen-units = 4`。
- `portable-pty` 通过 `[patch.crates-io]` 使用本地打补丁版本 `src-tauri/portable-pty-patched/` —— 未经补丁验证绝不要直接从 crates.io 更新。
- **Tauri 命令与浏览器模式同步注册**：
  - 桌面端命令在 `commands/` 定义（仅桌面可用模块/命令加 `#[cfg(feature = "desktop")]`，通用命令用 `#[cfg_attr(feature = "desktop", tauri::command)]`）→ 在 `commands/mod.rs` 重新导出 → 注册到 **`src-tauri/src/desktop.rs`** 的 `tauri::generate_handler![]`（由 `scripts/check-invoke-coverage.py` 校验前端 `invoke()` 子集）。
  - 浏览器完整界面（`--mode browser`）用到的命令还必须显式加入 `web/handlers/desktop_dispatch.rs`（或终端/权限敏感路径放在 `web/handlers/desktop_handler.rs`）；**严禁**把按 `Pc` 身份实现的命令（如 `commands/terminal_agent.rs`）原样暴露给浏览器，`desktop_dispatch` 必须显式以 `TerminalActor::Web` 身份调用。
  - `commands/workspace.rs` 的桌面端命令**故意不注册**在 `desktop.rs`（没有桌面端 UI 消费），不过 `workspace_service`、`Workspaces/*.json` 存储与 `desktop_dispatch.rs` 分支保留兼容。
- **序列化约定**：Rust ↔ TypeScript 统一使用 `camelCase`（`#[serde(rename_all = "camelCase")]`）。**唯一例外：** `commands/fs.rs::FileNode` 为 `snake_case`，前端文件树类型与之保持一致。
- **终端基座 PTY**：`commands/terminal.rs::base_shell()` 在 Windows 上固定启动 `cmd.exe`，在非 Windows 上启动 `$TERMINAL_BUDDY_SHELL`（默认 `/bin/bash`）；所选 shell / SSH / Docker / K8s 命令通过 PTY writer 注入（`mstsc` 直接启动系统远程桌面进程）。`TerminalLoadingMode::VsCode` 通过 `vscode_terminal_service.rs` 托管内置 Node 插件进程。
- **跨模式抽象与阻塞/原子写入**：
  - 共享模块统一导入 `crate::runtime::{AppHandle, Manager, Emitter, async_runtime}`，不要直接耦合 `tauri::*`。
  - 阻塞型 I/O、Git、历史扫描等在 Tauri 命令中走 `commands::claude_task` / `runtime::async_runtime::spawn_blocking`，在 axum handler 中走 `tokio::task::spawn_blocking`。
  - 所有**写入**数据的逻辑必须走 `PathService::require_data_dir()`（自定义 `dataPath` 不可用时显式报错，禁止使用会静默回退默认目录的 `get_data_dir()` 写入），落盘文件统一使用 `atomic_file::atomic_write`。

## 前端相关约定

- 界面文案一律使用简体中文。
- **状态与持久化**：Zustand 5 状态集中在 `stores/appStore.ts`，按域拆分为 `stores/slices/`（`profilesSlice`、`fileTreeSlice`、`sessionsSlice`、`tabsSlice`、`transfersSlice`、`windowSlice`、`claudeLaunchSlice`、`agentChatSlice`）及 `stores/taskSummaryStore.ts`。标签页快照（`saved_tabs`，浏览器模式下自动映射为 `web_saved_tabs`）、文件导航（`file_nav`）、前端设置（`settings`）、主题（`theme`）、命令覆盖/自定义（`cmd_overrides`、`cmd_custom`）等通过 `readClientData`/`writeClientData` 持久化到后端 `ClientData/*.json`（旧版 `localStorage` 由 `utils/migration.ts` 一次性迁移；`localStorage` 仅保留 `terminalBuddy.webToken`、`settings.dialogSize` 等本地 UI 项）。
- **前后端桥接**：Tauri 命令封装按域放在 `services/tauri/`，经 `services/tauri/index.ts` 统一重导出。`--mode browser` 下 `vite.config.ts` 将 `@tauri-apps/api/*` 与插件别名为 `src/services/browser/`（`core.ts`、`connection.ts` 等），经 `POST /api/desktop/invoke/{command}`（长任务返回 `$jobId` 后轮询 `/api/desktop/jobs/{id}`）、`/ws/terminal/{id}` 与 `/ws/events` 运行全套桌面界面。
- **命令模板**：`data/commandTemplates.ts` + `data/terminalSuggestions.ts`，由 `initPersistedTemplates()` 持久化至后端 `command_templates.json`。
- **终端与窗口**：xterm.js 6 + WebGL 渲染器，启用 `fit` / `search` / `clipboard` / `web-links` / `unicode11` 插件。窗口无边框（`decorations: false`），`TitleBar.tsx` 提供自定义窗口控件。主题通过 `<html>` 上的 `data-theme`（`dark` / `light`）与可选 `data-skin`（`cartoon` / `starry` / `cyber` / `sakura`）及 CSS 变量切换。
- **Dev Server**：`vite.config.ts` 监听 `127.0.0.1:1450`，将 `/api` 和 `/ws` 代理到 `TERMINAL_BUDDY_BACKEND`（默认 `http://127.0.0.1:9600`）。

## 数据模型与持久化

- **路径解析（`services/path_service.rs` & `settings_service.rs`）**：默认数据目录为 `$TERMINAL_BUDDY_DATA_DIR`，未设置时取系统配置目录 `TerminalBuddy/`（Windows `%APPDATA%/TerminalBuddy/`，Linux `~/.config/TerminalBuddy/`）。`settings.json` 固定保存在基础目录（支持 `$TERMINAL_BUDDY_DATA_DIR`，不跟随 `settings.dataPath`），其余数据跟随自定义 `dataPath`。
- **数据目录结构**：
  - `settings.json`、`projects.json`（含 `enabledAgents: { claude, codex }`）、`command_templates.json`
  - `Profiles/*.json`、`Workspaces/*.json`、`ClientData/*.json`（含 `web-uploads/`、`web-downloads/`、`ai-draft-images/`）
  - `llm_providers.json`（Claude 自定义供应商）、`codex_providers.json`（Codex 供应商）
  - `AiSessions/*.json`（原生 AI 会话状态）、`ScheduledTasks/tasks.json` & `ScheduledTasks/runs/<taskId>.json`
  - `ClaudeAssets/{skills,agents,commands}/`、`Trash/`、`TaskSessions/<terminalId>/`（Codex 日志）
  - `agent_session_registry.json`（`terminalId -> { provider, sessionId, sessionFile, cwd }`，7 天过期清理，兼容读取旧 `claude_session_registry.json`）
  - `jwt.key`（持久化 JWT 签名密钥）、`server.key`（服务端 AES-GCM 密钥）
  - `terminal_buddy.db`（SQLite WAL + `schema_migrations`）：Claude 会话索引与 FTS（`claude_sessions`、`claude_session_meta`、`claude_messages_fts`）、Codex 会话索引（`codex_sessions`、`codex_session_meta`、`codex_messages`）、`app_documents`（含 `command_history`）、Docker 容器 `claude_providers` / `claude_provider_state`。
- **敏感字段加密（`services/crypto_service.rs`）**：Profile 中的 `sshPassword` / `mstscPassword` 及供应商密钥在 Windows 桌面端使用 `dpapi:`（DPAPI），在 Linux 服务端与非 Windows 平台使用 `aesgcm:v1:`（本地 AES-GCM 密钥）。
- **核心模型**：
  - **Profile**：`id`、`name`、`group`、`terminalType`（`powershell` | `pwsh` | `cmd` | `bash` | `sh` | `zsh` | `ssh` | `docker` | `k8s` | `mstsc`，字符串而非 Rust 枚举）、`startupPath`、`startupCommands`、`environmentVariables`、`colorTheme`、`tabColor`、`windowSize`、`pinned`，及 SSH/Docker/K8s/MSTSC 字段。
  - **HistoryEntry**：`command` + 结构化 `note`（兼容旧字符串数组）。
  - **AppSettings（`models/settings.rs`）**：`closeBehavior`、`launchWindowMode`、`terminalLoadingMode`、`dataPath`、侧栏宽度、`enableTabNavigation`、`showTaskSummary`、`singleInstance`、`webApiEnabled`（默认 `true`，但需 `webApiPasswordHash` 非空才启动监听）、`webApiPort`（9600）、`webApiUsername`（`admin`）、`webApiPasswordHash`、`webPageTitle`、`sshDownloadDir`、`serverMonitorInterval`、`webApiShareSessions`（默认 `false`）、`nativeChatSessions`（默认 `false`）、`launchAtLogin`、`defaultTerminalEnabled`、`agentCommands`、`agentDownloadSource`、`agentAutoArchiveEnabled` / `agentAutoArchiveDays`、`agentIdleRecycleEnabled` / `agentIdleRecycleHours`。
- **Agent 支持范围**：Pi Agent 已于 v1.9.0 下线移除，系统统一收敛为 **Claude Code** 与 **Codex** 双 Agent。

## Web API 与核心服务

- **HTTP / WS 服务（`web/server.rs`）**：内嵌 axum 服务，采用手写 hyper accept 循环 + `TokioTimer`（支持 30 秒空闲请求头超时、2 秒端口绑定重试窗口与 10 秒优雅排空，而非 `axum::serve`）。JWT 鉴权（30 天有效期，`jwt.key` 持久化）、bcrypt 口令；登录暴力破解防护（`web/rate_limit.rs`）按 IP 计数并做指数退避封禁，配合全局 bcrypt 并发信号量（满时返回 429 + `Retry-After`）。HTML / SPA 路由统一加 `Cache-Control: no-store` 防止版本回滚命中旧首页缓存。
- **PC 与 Web 会话隔离（`models/terminal_access.rs`）**：由 `webApiShareSessions` 控制，权限判定必须调用 `TerminalService::authorize(id, actor, action)`，禁止在 handler 中硬编码 `owner` 比较。关闭共享时，Web 仅能访问 Web 终端，PC 终端在 WS `on_upgrade` 前即被拒绝（未知 404、无权 403），并每 5 秒复查一次权限；PC 可只读查看 Web 终端；Web 永远不能关闭 PC 终端。
- **浏览器桥接与文件/Git 边界**：
  - `desktop_handler.rs` 处理 `/api/desktop/invoke/{command}`、`/api/desktop/jobs/{id}`、`/api/desktop/upload`、`/api/desktop/file`、`/api/desktop/download`（支持单文件流式下载与目录跳过符号链接打包 ZIP 流式输出）及 `/ws/events`。
  - Git、原生 AI 会话与历史导出等受 `web/handlers/mod.rs::ensure_project_scope` 约束（只允许已登记项目目录，越界返回 403）；文件管理器命令允许浏览与操作服务端目录，而 Web 端 `save_projects` 禁止登记盘根 / 系统目录 / 用户家目录等过宽路径。
  - 耗时 Git 操作采用「发起即返回 + 轮询」模式，轻量 REST（`/api/git/*`）与浏览器 invoke（`desktop_handler`）共享同仓库互斥锁（忙碌返回 409）。
- **AI 会话、终端接力、Hook 与定时任务**：
  - **原生 AI 会话（`services/ai_chat_service.rs`）**：`/api/ai/*`、`/ws/ai`、`/ws/ai/{id}`，驱动服务端无头 Claude `stream-json` 与 Codex `app-server`，支持思考过程实时快照、子代理、Todo 清单、审批与空闲进程自动回收。
  - **终端 Agent 接力（`services/terminal_agent_relay.rs`）**：将运行中的 Claude/Codex 终端转录镜像为聊天气泡并支持向 PTY 注入回复，桌面端走 `commands/terminal_agent.rs`（Pc），浏览器走 `desktop_dispatch.rs`（Web），Android 走 `/api/terminal-agents*` 与 `/ws/terminal-agents/{id}`。
  - **Claude HTTP Hooks & App 通知**：Hook 服务监听本地 `19601` 端口（`web/claude_hook_server.rs`），通过启动模型终端时注入一次性临时 `--settings` 生效（启动时自动幂等清理旧版用户级残留）；待决策事件与任务完成/失败（含定时任务）通过 `/ws/notifications` 与 `/api/notifications/decisions` 推送给安卓端，统一由 `services/app_notification_service.rs` 管理。
  - **定时任务（`services/scheduled_task_service.rs`）**：支持 Cron（5 段 + IANA 时区）与单次任务，针对已登记项目 Profile 或 Agent Prompt（按 `nativeChatSessions` 设置走原生会话或终端接力），调度器随进程生命周期运行。
