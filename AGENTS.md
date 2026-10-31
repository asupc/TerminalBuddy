# AGENTS.md

## 项目结构

- **仓库根目录只是个壳。** 所有源码都在 `terminal-buddy/` 下。桌面端前端：`terminal-buddy/src/`，Rust 后端：`terminal-buddy/src-tauri/`。
- 桌面端前端：React 19、TypeScript 6、Zustand 5、xterm.js 6、Monaco Editor、React Flow；`src/` 以 `--mode browser` 构建出完整网页界面（`dist-web`，桌面版内嵌 + Docker 服务端托管）。
- **独立手机 SPA（`web/`）已于 2026-10 彻底退役**：所有构建脚本与 Rust 二进制都不再构建/打包它，手机浏览器直接使用完整网页界面。`web/` 目录仅作历史参考保留，不要改动，也不要在任何构建中重新引入。
- Rust 后端：Tauri 2、axum（Web API）、portable-pty（ConPTY）、ssh2、bcrypt、JWT、rusqlite。
- 后端分三层：**commands**（薄 Tauri 包装层）→ **services**（业务逻辑 + 持久化）→ **models**（数据结构），外加一个 `web` 模块提供 HTTP/WS API。

## 常用命令

除特别说明外，均在 `terminal-buddy/` 目录下执行。

```bash
npm install                  # 安装桌面端前端依赖

npm run dev                  # 只启动 Vite dev server（1420 端口，不含 Rust）
npm run tauri dev            # 完整 Tauri 开发模式（Vite + Rust 一起跑）
npm run build                # 类型检查 + Vite 构建（tsc && vite build）
npm run tauri build          # 生产构建（NSIS 安装包）；beforeBuildCommand 会自动执行
                             # prepare:vscode-terminal + 桌面端构建 + dist-web 构建

npx tsc --noEmit             # 桌面端 TypeScript 类型检查

cd src-tauri && cargo check  # Rust 编译检查
cd src-tauri && cargo test --lib   # Rust 单元测试（25 个文件、约 164 个用例）
```

仓库根目录 `scripts/` 下的快捷脚本：`scripts/dev.bat` 直接启动 `tauri dev`（不再预构建任何 Web 前端）；`scripts/build-windows-exe.sh` 在 Linux 上通过一次性 Docker 容器（`scripts/windows-build/Dockerfile`，cargo-xwin 交叉编译）一键产出 Windows 单文件 exe：源码只读挂载（`terminal-buddy/web` 退役目录随拷贝排除），构建与缓存在容器/命名卷内完成，宿主机不安装工具链，仅输出到仓库根目录 `dist/`（含 `.sha256`），不生成安装包 —— 需要 NSIS 安装包请在 Windows 上使用 `terminal-buddy/build.bat`。`scripts/build-android.sh` 在 Linux 上通过一次性 Docker 容器（`scripts/android-build/Dockerfile`，JDK 17 + Android SDK 36）构建 Android Release APK 并用 apksigner 校验签名：源码只读挂载，Gradle 缓存在命名卷 `terminal-buddy-android-cache` 内，产物输出到仓库根目录 `dist/`（含 `.sha256`）；Windows 上直装设备用 `scripts/build-android.bat`。安卓端内置简版 / 完整版两种界面模式（`AppUiMode`，默认简版），在「我的 → 界面模式」切换，不需要分别构建。

仓库没有 lint 和格式化工具。TypeScript strict 模式开启了 `noUnusedLocals` 和 `noUnusedParameters`，未使用的绑定会让 `tsc` 失败。测试方面只有 Rust 单元测试（`cargo test --lib`）和独立的 `node scripts/test-*.mjs` 脚本，前端没有测试套件。

## 验证顺序

1. 在 `terminal-buddy/` 下执行 `npx tsc --noEmit`
2. 在 `terminal-buddy/src-tauri/` 下执行 `cargo check`
3. 改动 Rust 后，再执行 `cargo test --lib`
4. 新增或删除 Tauri 命令时，在 `terminal-buddy/` 下执行 `python scripts/check-invoke-coverage.py`

`web/`（独立手机 SPA）已退役且不参与任何构建，无需对它做类型检查；所有构建产物只来自 `src/`（桌面 + browser 模式）。

## Rust 相关约定

- Edition 2021；lib crate 名为 `terminal_buddy_lib`（cdylib + rlib）。
- `sccache` 配置在 `src-tauri/.cargo/config.toml`。
- dev profile 用 `opt-level = 1` + 增量编译；release 用 LTO thin + strip。
- `portable-pty` 是**本地打补丁**的版本，位于 `src-tauri/portable-pty-patched/` —— 未经补丁验证，绝不要从 crates.io 更新它。
- 所有 Tauri 命令都注册在 `lib.rs` 的 `invoke_handler![]` 里。新增命令的流程：在 `commands/` 定义 → 在 `commands/mod.rs` 重新导出 → 加进 `invoke_handler![]`。前端的 `invoke()` 调用必须是该列表的子集，由 `scripts/check-invoke-coverage.py` 校验。
- `commands/workspace.rs` 后端已存在，但**故意不注册** —— 没有桌面端 UI 消费它，不过 `workspace_service` 与 `Workspaces/*.json` 存储仍然保留。
- Rust ↔ TypeScript 序列化统一用 `camelCase`（`serde(rename_all = "camelCase")`）。**唯一例外：** `commands/fs.rs::FileNode` 是 snake_case，桌面端与浏览器端的文件树类型与之保持一致。
- 终端的基座 PTY 始终是 `cmd.exe`；所选 shell / SSH / Docker / K8s / MSTSC 命令是通过 PTY writer 注入的。
- REST handler 里的重活（转录索引、目录列举、git 操作）必须走 `tokio::task::spawn_blocking`。

## 前端相关约定

- 界面文案一律用简体中文。
- 状态：Zustand store 在 `stores/appStore.ts`（标签页/书签持久化到 `localStorage`）。Tauri 桥接：`services/tauri.ts`（带类型的 `invoke()` 包装）。命令模板、覆盖项与历史缓存：`data/commandTemplates.ts`，由 `initPersistedTemplates()` 持久化到后端。
- xterm.js 6，WebGL 渲染器，启用 fit / search / clipboard / web-links / unicode 插件。
- 窗口无边框（`decorations: false`），`TitleBar.tsx` 提供自定义窗口控件。主题通过 `<html>` 上的 `data-theme` 属性切换 CSS 自定义属性。
- Web API 的 dev server 代理：`/api` → `http://localhost:9600`，`/ws` → `ws://localhost:9600`。

## 数据模型

- 所有用户数据都是 `%APPDATA%/TerminalBuddy/` 下的 JSON 文件：`Profiles/*.json`、`Workspaces/*.json`、`settings.json`、`command_templates.json`、`command_history.json`、`projects.json`（已登记的项目）。路径解析与自定义 `dataPath` 由 `services/path_service.rs` 负责。Claude 会话历史会索引进 SQLite 数据库（`terminal_buddy.db`，rusqlite，带 schema 迁移）。
- **Profile**：id、name、group、terminalType（`powershell` | `cmd` | `ssh` | `docker` | `k8s` | `mstsc`，是字符串而非 Rust 枚举）、startupPath、startupCommands、environmentVariables、colorTheme、tabColor、windowSize（多数为可选），以及 SSH/Docker/K8s/MSTSC 相关字段。
- **HistoryEntry**：`command` + 结构化的 `note`（向后兼容旧的字符串数组格式）。
- **AppSettings**：closeBehavior（Exit/Tray）、dataPath、tabSidebarWidth、enableTabNavigation、singleInstance、webApiEnabled、webApiPort、webApiUsername、webApiPasswordHash、sshDownloadDir、serverMonitorInterval、webApiShareSessions（默认 false，控制 PC 与 Web 的会话隔离）。

## Web API

内嵌的 axum 服务，用于远程终端访问。JWT 鉴权、bcrypt 口令、WebSocket 协议传输终端 I/O。路由用的是手写的 accept 循环（而非 `axum::serve`），这样 hyper 能拿到 `TokioTimer`，空闲连接才能超时回收。登录暴力破解防护（`web/rate_limit.rs`）按 IP 统计失败次数并做指数退避封禁，同时有一个全局 bcrypt 并发信号量（返回 429 并带 `Retry-After`）。

PC 端与 Web 端的会话隔离由 `webApiShareSessions` 设置控制，权限判定统一走 `src-tauri/src/models/terminal_access.rs` 里的权限矩阵 —— 永远不要在 handler 里硬编码 `owner` 比较，调用 `TerminalService::authorize(id, actor, action)` 即可。关闭共享时，Web 只能看到 Web 自己创建的终端，PC 终端在 WS 握手阶段就会被拒绝（403）；此时 PC 可以只读查看 Web 终端。Web 永远不能关闭 PC 的终端。终端 WS 在 `on_upgrade` **之前**就完成鉴权（未知返回 404，无权返回 403），并每 5 秒复查一次权限，因此会话中途关掉共享开关会立刻断掉在飞的连接。

REST 接口还覆盖项目启动（带启动参数预设）、Claude 会话历史（列表/详情/搜索/重命名/收藏/归档/删除/导出/批量删除 + 回放）、只读的项目文件树、Git 状态与分支/操作，以及机器人回调。文件树与 Git 访问由 `handlers::ensure_project_scope` 把关（只允许已登记的项目目录，越界返回 403）；耗时较长的 Git 操作采用「发起即返回 + 轮询」模式，同一仓库互斥（忙时返回 409），Web 端提交走的是 `git add -A`（按文件提交和高级 push 选项仅限桌面端）。Web 端创建终端复用桌面端路径（`create_terminal` / `create_blank_terminal`）。

<!-- CODEGRAPH_START -->
## CodeGraph

在已被 CodeGraph 索引的仓库中（仓库根目录存在 `.codegraph/` 目录），需要理解或定位代码时，**先**用 CodeGraph，不要直接 grep/find 或读文件：

- **MCP 工具**（可用时）：`codegraph_explore` 一次调用基本能回答所有代码问题 —— 返回相关符号的逐字源码以及它们之间的调用路径，包括 grep 追不到的动态分发环节。查询里带上文件名或符号名，就能读到它当前带行号的源码。如果列出来了但暂缓加载，用工具搜索按名字载入。
- **Shell**（总是可用）：`codegraph explore "<符号名或问题>"`，输出同上。

如果没有 `.codegraph/` 目录，完全跳过 CodeGraph —— 是否建立索引由用户决定。
<!-- CODEGRAPH_END -->
