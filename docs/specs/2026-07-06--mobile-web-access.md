# 手机端网页访问控制电脑 — 设计规格

- **日期**：2026-07-06
- **状态**：已通过头脑风暴确认，待实现
- **作者**：WangJing + Claude（头脑风暴）

## 1. 概述

为 TerminalBuddy 新增**手机端网页访问**功能：在同一局域网内，用手机浏览器打开电脑的局域网 IP + 端口，登录后即可：

1. 看到与电脑端**同步的连接导航**（profile 列表，按 `group` 分组）；
2. 每个 profile 下方实时显示**电脑端已打开的同款终端实例**，可点击接管；
3. 也可从任一 profile **新建**一个终端；
4. 进入终端页后可**发送文字、查看输出**，与电脑端**共享同一个 PTY**（双向同步）；
5. 可**关闭**已有连接。

**完全舍弃并重写**现有的 web 管理功能（`src-tauri/src/web/` + `web/src/`），只复用桌面核心引擎（`TerminalService` / `ProfileService` / `WebServiceState` / `SettingsService`）。

## 2. 范围与非目标

**范围内**：
- 全新的手机优先 Web SPA（2 个界面）。
- 全新的精简 Rust web 服务（axum + JWT + WS）。
- 新增 `list_terminals` 命令与 sessions 实时推送机制。
- 局域网访问、账号密码认证、xterm.js 渲染、共享会话。

**非目标（本期不做）**：
- 互联网远程访问 / NAT 穿透（frp / cloudflare tunnel 等）。
- mstsc（远程桌面）在手机端的「新建」入口——本期隐藏该 profile 的「+」。
- PC/Web 会话隔离（旧的 `webApiShareSessions` 隔离逻辑随 web 层重写作废，手机端采用完全共享模式）。
- 自动化测试（项目无测试基建；用人工验证清单代替）。

## 3. 已确认的关键决策

| 维度 | 决策 |
|---|---|
| 网络访问 | 仅**局域网**（手机与电脑同一 WiFi，访问 `电脑局域网IP:端口`） |
| 同步语义 | **共享会话**：手机旁观/接管电脑端已开终端，输入发到同一 PTY；新建终端桌面端也能看到并操作 |
| 认证 | **复用现有** `webApiUsername` / `webApiPasswordHash`（JWT + bcrypt） |
| 渲染 | **xterm.js**（与桌面端一致：ANSI 颜色、光标、TUI 全屏程序） |
| 共享模式 | 手机端**完全共享**：能看到/操作所有终端；手机新建的终端 `owner = Pc`，桌面端可完整读写。不做隔离 |
| mstsc | 本期**隐藏「+」**入口（mstsc 是电脑弹 RDP 窗口，无 PTY 流） |

## 4. 模块边界：删除 / 新增 / 复用

| 区域 | 处理 | 说明 |
|---|---|---|
| `web/src/*`（旧桌面风 SPA） | **删除重写** | 新建手机优先 SPA，仅 2 个界面 |
| `src-tauri/src/web/`（旧 server/auth/ws/handlers） | **删除重写**（路径保留，覆盖内容） | 新建精简 axum 服务，`lib.rs` 启动点原地接入 |
| `TerminalService` / `ProfileService` / `WebServiceState` / `SettingsService` | **复用，不碰核心逻辑** | 桌面引擎；`TerminalService` 内部追加 sessions 推送钩子 |
| 新增 Tauri 命令 `list_terminals` | **新增** | 暴露存活终端列表，含 profile 元数据 + owner；桌面端将来也可用 |
| 新增 `notify_sessions_changed()` 钩子 | **新增** | 在 `create_terminal` / `create_blank_terminal` / `close_terminal*` 末尾调用，驱动界面一实时刷新 |

## 5. 后端设计

### 5.1 REST 接口（`Authorization: Bearer <JWT>`）

| 方法 路径 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `POST /api/auth/login` | `{username, password}` | `{token, expiresIn}` | bcrypt 比对 `webApiPasswordHash`，签发 JWT |
| `GET /api/profiles` | — | `Profile[]` | 复用 `ProfileService`；手机端按 `group` 分组 |
| `GET /api/terminals` | — | `TerminalInfo[]` | 存活终端列表（`list_terminals` 的 HTTP 暴露） |
| `POST /api/terminals` | `{profileId, extraParams?}` | `{id}` | 新建：`create_terminal(owner=Pc)`，共享模式 |
| `DELETE /api/terminals/:id` | — | `{ok}` | 关闭：`close_terminal`，共享模式无 owner 限制 |
| `GET /` 及 `/assets/*` | — | SPA 静态资源 | 手机端 index.html / js / css；release 用 `include_dir!` 嵌入，dev 走 `web/dist` |

**`TerminalInfo` 结构**（`rename_all = "camelCase"`）：
```json
{ "id": "...", "profileId": "...", "profileName": "...", "group": "...", "terminalType": "ssh", "owner": "Pc" }
```
> `owner` 字段仅用于展示，共享模式下不参与权限判定。

### 5.2 WebSocket：两条职责分离

**① meta WS —— `/ws/meta?token=<JWT>`**（App 级，单连接，管界面一同步）
- 连上立即推一次 `{type:"sessions", list: TerminalInfo[]}`。
- 之后桌面端 / 手机端任一方开/关终端 → 推 `{type:"sessions", list:[...]}` 全量替换。
- 界面一据此实时增删「已打开」条目，**不轮询**。

**② terminal WS —— `/ws/terminal?id=<tid>&token=<JWT>`**（每终端一连接，管界面二 I/O）

| 方向 | 消息 | 含义 |
|---|---|---|
| 客户端→服务端 | `{type:"input", data}` | 写入 PTY（`write_to_terminal`） |
| 客户端→服务端 | `{type:"resize", rows, cols}` | **只增不减**（`resize_terminal(.., allow_shrink=false)`，保护桌面端视图） |
| 服务端→客户端 | `{type:"output", data}` | 先发 `peek_terminal_output` 快照（不扰动桌面端缓冲），再转发 `WebServiceState` 实时增量 |
| 服务端→客户端 | `{type:"exited"}` | PTY 退出（SSH 断开 / `exit`） |
| 服务端→客户端 | `{type:"error", message}` | 鉴权失败 / 终端不存在等 |

**选型说明**：界面二一次只看一个终端，**一个终端一条 WS**（而非多路复用），简单且和现有 ws 模式一致；meta 用独立全局连接负责列表同步。WS 鉴权用 query `token=`（浏览器 WS 握手无法带 Header）。

### 5.3 sessions 实时推送实现要点

- 新增 `SessionEvents`：基于 `OnceLock<UnboundedSender<()>>` 的信号通道，web 服务启动时注入发送端。
- `create_terminal` / `create_blank_terminal` / `close_terminal` / `close_terminal_with_check` 末尾调用 `notify_sessions_changed()`；无接收方时静默 no-op（web 未启用时不影响桌面）。
- axum 侧 spawn 任务：收到 `()` → 读 `TerminalService` 拼出 `TerminalInfo[]` → 推给所有 meta WS 客户端。
- 钩子在 `TerminalService` 内部，**桌面端开/关终端也会触发**，手机端界面一自然同步。

### 5.4 认证

- 复用 `SettingsService` 的 `webApiUsername` / `webApiPasswordHash`。
- 登录：bcrypt 比对密码；通过后签 JWT（含 username、过期时间），有效期建议 7 天。
- 后续 REST：`Authorization: Bearer <token>`；WS：`?token=<token>`。
- JWT 密钥：复用旧 web 模块的密钥来源（或新建固定密钥存于 settings），统一即可。

### 5.5 新增 Tauri 命令 `list_terminals`

```rust
// 返回所有存活终端的元信息（不暴露 writer/PTY 句柄）
#[command]
pub fn list_terminals(service: State<TerminalService>) -> Result<Vec<TerminalInfoDto>, String>
```
内部：锁 `instances`，逐条读 `id` / `profile_id` / `owner`，再用 `ProfileService::get_profile` 补 `profileName` / `group` / `terminalType`。注册进 `lib.rs` 的 `invoke_handler![]`。

### 5.6 共享模式与 owner

- 手机 `POST /api/terminals` 新建时 `owner = TerminalOwner::Pc`。
- 手机端所有读写/关闭**跳过** `check_pc_permission`（共享模式，不做 PC/Web 隔离）。
- 旧 `webApiShareSessions` 隔离逻辑随旧 web 层删除而作废；设置项保留但不再影响手机端。

## 6. 前端设计（新 SPA）

技术栈：**React + Vite + TS + xterm.js**（与旧 web/ 工具链一致），构建到 `web/dist/`。无 react-router，用极简 `view` 状态切换两个界面：
```ts
type View = { screen: 'nav' } | { screen: 'term'; terminalId: string; profileName: string };
```

### 6.1 界面一 · 连接导航页

- **顶栏**：标题 `TerminalBuddy` + meta WS 在线状态点 + 退出登录。
- **搜索框**：按名称 / 分组过滤 profile。
- **分组列表**：按 `group` 折叠分组，对应电脑端 ConfigPanel。
- **profile 卡片**：终端类型图标 + 名称 + 「+ 新建」按钮；其下方按 `profileId` 挂载活跃实例（点=接管）。
- **交互**：
  - 点 profile 卡片 → 展开/收起其下活跃实例。
  - 点「+」→ `POST /api/terminals {profileId}` → 进界面二。
  - 点活跃实例 → 进界面二（接管）。
  - **mstsc profile：隐藏「+」**（本期）。
- **数据**：`GET /api/profiles` + `GET /api/terminals`；meta WS 推 `sessions` 全量刷新。保留手动刷新兜底。
- **空态**：电脑端未配置连接时提示。

### 6.2 界面二 · 终端显示页

- **顶栏**：返回 + profile 名 + 连接状态点 + 菜单（关闭 / 复制 / 粘贴）。
- **xterm.js 画布**：铺满中段；进页面按实际像素算 rows/cols → 发 `resize`（只增不减）；横屏切换重算。
- **输入模型——「先输入后发送」**：上方输入框写完一行点「发送」→ `{type:"input", data: line+"\r"}`。提供「发送后自动补回车」开关（TUI 如 vim 时关掉，逐字符发）。规避手机 IME 逐键捕获问题。
- **特殊键芯片**：`Esc` / `Tab` / `Ctrl`(粘滞) / `Ctrl+C` / 方向键 / `/` / `-` / `|` 等直接发转义序列。
- **快捷命令抽屉**：复用桌面端 `command_templates`，点一条直接发送。
- **菜单**：关闭此连接（`DELETE`）/ 复制选中 / 粘贴剪贴板。
- **断线重连**：terminal WS 断 → 顶部「重连中…」横幅 + 指数退避重连 → 重连后重新 `peek` 快照续上；若期间 PTY 已退出 → 收 `{exited}` → 提示「连接已结束」并返回。

### 6.3 移动端适配

- viewport 锁定、禁 body 滚动/橡皮筋。
- `safe-area-inset` 适配刘海屏。
- `visualViewport` API 处理键盘弹起，避免遮挡输入栏。
- xterm scrollback 限制（如 1000 行）省内存；用 canvas 渲染（默认）保证低端机流畅。

## 7. 数据流总览

```
手机浏览器(局域网)  ──HTTP/WS──►  新 axum 服务(:端口, JWT)
                                   │
                    ┌──────────────┼────────────────────┐
                    ▼              ▼                    ▼
              ProfileService   TerminalService     WebServiceState
              (读 profile)    (建/写/关/peek)      (输出广播 pub/sub)
                    │              │ notify_sessions_changed()
                    │              ▼
                    │        SessionEvents 信号 ──► meta WS 推 sessions
                    │
                    └────────► 共享 PTY 实例池 ◄── 桌面端也在用同一池
```

- 界面一：REST（profiles / terminals）+ meta WS（sessions 增量）。
- 界面二：terminal WS（attach → peek 快照 + 实时 output；input / resize）。

## 8. 错误处理 / 断线重连 / 安全

- **登录失败**：401 + 错误信息；前端提示用户名/密码错误。
- **WS 鉴权失败 / token 过期**：服务端关闭连接并发 `{type:"error", message}`；前端跳回登录。
- **终端不存在**（被桌面端关闭）：`{type:"error"}` + 返回界面一并刷新列表。
- **PTY 退出**：`{type:"exited"}`；界面二显示「连接已结束」。
- **网络断开**：meta WS 与 terminal WS 各自指数退避重连（1s → 2s → 4s … 封顶 30s）；重连成功后 meta 重新拿 sessions、terminal 重新 peek。
- **安全**：
  - 仅监听局域网（沿用现有绑定策略）。
  - 所有 REST/WS 强制 JWT；密码 bcrypt 存储（已有）。
  - resize 只增不减，保护桌面端视图。
  - 输入写入走现有 `write_to_terminal` 的分块/限流（>256B 分块，2ms 间隔）。

## 9. 验证清单（人工）

项目无自动化测试，按以下清单逐项手测：

1. 电脑端开启 Web API（设置用户名/密码/端口），手机连同一 WiFi。
2. 手机浏览器打开 `http://<电脑局域网IP>:<端口>` → 登录页。
3. 错误密码登录被拒；正确密码登录进入界面一。
4. 界面一显示与电脑端一致的 profile 分组；mstsc 无「+」。
5. 电脑端打开一个 SSH profile 的终端 → 手机界面一对应卡片下方**实时出现**该实例（不刷新页面）。
6. 点该实例 → 进界面二，看到与电脑端**一致的当前输出**（含历史快照）。
7. 手机发送 `ls\n` → 电脑端同步执行并显示；电脑端输入 → 手机端同步显示输出。
8. 手机从该 profile「+」新建 → 电脑端 ConfigPanel/Tab 栏也能看到这个新终端。
9. 手机端关闭某终端 → 电脑端对应终端关闭；反之亦然，且界面一列表实时更新。
10. 手机切横屏 → 终端列数重算（只增不减）。
11. 手机锁屏/切后台再回前台 → 自动重连，输出续上。
12. 电脑端关闭该终端 → 手机端收到「连接已结束」。
13. 横屏特殊键（Tab/Ctrl+C/方向键）在 vim / cli 中生效。
14. token 过期后操作被拒，跳回登录。

## 10. 实施步骤建议（分阶段）

1. **后端骨架**：删旧 `src-tauri/src/web/`，新建精简 axum 服务（路由 + JWT 登录 + 静态托管）。`lib.rs` 接入启动点。
2. **sessions 基建**：新增 `list_terminals` 命令 + `SessionEvents` 信号 + `notify_sessions_changed()` 钩子（植入 create/close）。
3. **REST**：profiles / terminals CRUD（GET/POST/DELETE）。
4. **WS**：meta WS（sessions 推送）+ terminal WS（attach/peek/input/resize/exited）。
5. **前端骨架**：删旧 `web/src/`，搭 React+Vite 工程，登录页 + 极简路由 + API/WS 客户端。
6. **界面一**：分组导航 + 活跃实例挂载 + 实时同步。
7. **界面二**：xterm.js + 输入栏 + 特殊键 + 快捷命令抽屉 + 断线重连。
8. **移动适配打磨**：safe-area、键盘、横屏、性能。
9. **按第 9 节清单全量手测**。

## 11. 待决 / 后续

- **mstsc**：本期隐藏「+」；未来若要做远程桌面流到手机，另立设计。
- **互联网远程访问**：未来需要时引入 frp / cloudflare tunnel，另立设计（含额外安全加固）。
- **多终端切换**：当前界面二单终端；未来可在界面二底部加 tab 切换多个同时打开的终端。
- **JWT 密钥存储**：实现时确认是复用旧 web 模块密钥来源还是新建固定密钥（统一即可，不影响功能）。
