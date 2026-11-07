# 桌面端会话式聊天（原生会话 + 终端接力双形态）

日期：2026-11-07。状态：**需求已确认，可实施**。依据：当前仓库源码、Claude Code v2.1.318 实测（斜杠命令与 Skill 行为），以及交互预览 `design/desktop-chat-tabs-preview.html`。

相关文档：[原生 AI 会话 API](../原生AI会话API.md)、[终端 Agent 会话接力](./2026-11-01--terminal-agent-chat-relay.md)、[Android AI 对话上下文与 Token 状态栏调研](../Android%20AI对话上下文与Token状态栏调研.md)。

---

## 0. 摘要

在桌面端提供**会话式聊天**能力：把 Agent 会话以聊天标签页的形式呈现，与终端标签共处同一标签栏、占满右侧主区域。

桌面端此前从未接入原生 AI 会话；终端 Agent 接力曾做过侧栏面板（`7dbb0ad`），因「导航式面板体验差」在 `732ad1d` 全部移除（后端 relay 核心保留至今）。

本次采用**两种形态、全局设置二选一**：

| 形态 | 本质 | 新建方式 | 能力 |
| --- | --- | --- | --- |
| **原生会话** | 独立 CLI 进程，不经 PTY | App / 桌面新建 | 斜杠命令、Skill、审批卡、排队与插话、上下文用量 |
| **终端接力** | 真实终端里的 Agent，读取 JSONL 转录 | 在终端里启动 Agent | 只读镜像 + 受限回复；与手机共用同一 PTY |

**不做会话级形态切换**：形态由设置决定，会话创建后固定不变。

---

## 1. 已拍板决策

| # | 决策 | 说明 |
| --- | --- | --- |
| 1 | **形态在设置中全局选择** | 设置项「新会话形态」：原生会话 / 终端接力 |
| 2 | **不做单会话切换** | 标签上没有形态徽标、没有变形按钮 |
| 3 | **新设置只影响之后新建的会话** | 已打开的会话不因切换设置而变化，下次重建时按新设置 |
| 4 | **App 创建的会话默认走原生会话** | 该设置项的默认值 |
| 5 | **设置选「终端接力」时，App 打开接力保持现有形态** | 沿用安卓现有实现，不改协议、不改交互 |
| 6 | **`web_api_enabled` 默认改为 `true`** | 让浏览器模式可直接调用桌面命令；未设密码时 HTTP 服务不会启动，无暴露窗口（机制见 §4.1） |
| 7 | **Skill 在对话中展示为 `skill:名称`，可展开查看完整内容** | 不是丢弃，也不是刷屏 |

---

## 2. 现状与依据

### 2.1 地基盘点

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 原生 AI 会话服务 | `services/ai_chat_service.rs`（1922 行） | 完整，**桌面端零接入**（仅 `shutdown_all()` 被调用） |
| 会话 REST + WS | `web/handlers/ai_chat_handler.rs`（`/api/ai/*`、`/ws/ai/{id}`） | 完整，固定走 HTTP 鉴权 |
| `/` 补全数据源 | `system/init` 事件（`skills` / `slash_commands` / `terminal_slash_commands`） | **未接入**：service 不处理该事件，需新增捕获与下发（§4.8） |
| 终端 Agent 接力核心 | `services/terminal_agent_relay.rs`（3061 行） | 完整，`sessions_for` / `page_for` / `subscribe` / `reply` 均接受 `TerminalActor` |
| 接力 Tauri 命令层 | 已被 `56db750` 删除（143 行） | 可从该提交恢复 |
| 标签容器机制 | `TerminalPanel.tsx:297`、`appStore.ts:55` 的 `activeSpecialTab` | 完整，Git 历史 / 会话回放已在用 |
| 标签栏 | `components/terminal/TerminalTabBar.tsx` | 完整，需去掉「会话详情」分组标题 |
| Markdown 渲染 | `markdown-it` + `DOMPurify` + `highlight.js` | 已有依赖；`MarkdownPreview` 携带文件路径，聊天需另抽轻量组件 |
| 决策弹窗 | `components/shared/ClaudeDecisionDialog.tsx` | 处理 PTY 终端的 Claude 决策 |

### 2.2 为什么不是侧栏面板

`7dbb0ad` 的 `TerminalAgentPanel` 是 `nav-panel-slot` 下的侧栏，与 `ConfigNav` / `FileNav` / `HistoryPanel` 同宽（约 232px）。聊天在 232px 宽的侧栏里无法阅读长回复与代码块。

本次改为**标签页占满主区域**，复用 Git 历史页的容器模式（`position: absolute; inset: 0`）。

### 2.3 为什么两种形态都要保留

两者解决不同问题，且不可互换：

- **原生会话**没有终端。它是独立 CLI 进程，用户在桌面上看不到「原始终端输出」，因此**无法**提供「切换到终端查看」。
- **终端接力**的斜杠命令必须拒绝。它向**活的 TUI** 注入按键，斜杠会打开命令菜单，随后的 `\r` 可能选中未预期的菜单项。

把形态交给用户按场景选择，比强行统一更符合实际使用。

---

## 3. 斜杠命令与 Skill（实测结论）

**测试环境**：Claude Code v2.1.318，`claude -p --input-format stream-json --output-format stream-json --verbose`，与 `ai_chat_service.rs:691-693` 参数完全一致。

### 3.1 CLI 自身完成分流，服务端不应维护白名单

判定依据是 `result` 事件的 `num_turns`：为 0 表示 CLI 本地处理、未进入模型；为 1 表示当作普通提示词发送。

| 输入 | num_turns | 行为 | 处理 |
| --- | --- | --- | --- |
| `/cost` | 0 | 返回成本统计文本 | 原样发送 |
| `/model` | 0 | 返回当前模型与可用列表 | 原样发送 |
| `/model sonnet` | 0 | 真正切换模型 | 原样发送，成功后刷新 `session.model` |
| `/config` | 0 | 返回配置用法 | 原样发送 |
| `/compact` | 0 | 压缩上下文，返回空 | 原样发送，之后刷新会话快照 |
| `/clear` | 0 | 清空会话，返回空 | 原样发送，之后刷新会话快照 |
| `/help`、`/resume`、`/memory`、`/status` | 0 | 返回 "isn't available in this environment." | 原样发送 |
| `/init` | 1 | 展开为提示词交给模型 | 原样发送 |
| `/nonexistent-xyz`、`// xxx` | 1 | 当作普通文本 | 原样发送 |
| 普通文本 | 1 | 普通消息 | — |

**结论**：原生会话模式下**移除一切斜杠拦截**，原样交给 CLI。硬编码白名单只会随 CLI 版本过时。

风险仅剩三个状态一致性问题（非安全问题）：`/clear`、`/compact` 改变会话状态但返回空文本；`/model xxx` 切换模型但 `AiSession.model` 不更新。处理方式见 §6.3。

### 3.2 Skill 是斜杠命令的子集，但执行方式不同

`system/init` 事件提供三个集合：

| 集合 | 数量（实测） | 含义 |
| --- | --- | --- |
| `skills` | 19 | 已安装的 Skill（含插件带来） |
| `slash_commands` | 52 | 内建命令 ∪ 全部 Skill |
| `terminal_slash_commands` | 4 | `doctor` `color` `focus` `reload-plugins`，纯 TUI 命令 |

已实测确认 `skills ⊂ slash_commands`。判断一个命令是不是 Skill，只需检查它是否落在 `skills` 集合内。

**Skill 的执行方式**：CLI 把 Skill 文件（含参数替换、frontmatter 指令）展开成完整提示词，作为一条 user 消息发给模型。实测 `/code-review src-tauri` 展开后为 **5644 字符**，并回传一条 user 事件：

```
顶层键: ['agent_id', 'message', 'parent_tool_use_id', 'session_id',
         'subagent_type', 'task_description', 'timestamp', 'type', 'uuid']
parent_tool_use_id = 'forked-command-code-review'
```

`forked-command-` 前缀 + Skill 名，是识别 Skill 展开的精确标识（普通消息无此字段）。

### 3.3 现有代码的问题

`ai_chat_service.rs:839-845` 的 `user` 分支只处理 `tool_result`，**完全忽略文本块**。因此：

- 不会出现 5644 字符刷屏对话 ✓
- 但 Skill 内容也彻底丢失 ✗

按决策 7，需要新增处理而非继续忽略。

### 3.4 终端接力的斜杠命令维持拒绝

`terminal_agent_relay.rs:403` 现有规则不变：

```rust
if matches!(first, '/' | '!' | '@' | '#') {
    return Err("暂不支持斜杠命令与 !、@、# 开头的输入，请回到终端操作".to_string());
}
```

理由见 §2.3：这是向活 TUI 注入按键，与 print 模式机制根本不同。§3 的全部结论**不适用**于接力模式。

---

## 4. 服务端设计

### 4.1 设置项

`models/settings.rs` 新增字段：

```rust
/// 新会话形态：true = 原生会话（默认），false = 终端接力。
/// 只影响之后新建的会话；已打开的会话保持创建时的形态。
#[serde(default = "default_native_chat_sessions")]
pub native_chat_sessions: bool,
```

`Default` 构造与 `default_native_chat_sessions()` 均返回 `true`（决策 4）。

同时修改：`default_web_api_enabled()` 由 `false` 改为 `true`（决策 6）。

> **安全说明**：默认开启不存在暴露窗口。HTTP 服务是否启动由 `commands/web.rs` 的 `should_run_http_server()` 决定——`web_api_enabled && !web_api_password_hash.is_empty()`（机器人回调需要时例外）：未设密码时服务不启动、9600 端口无监听，且登录本身也会被拒（`auth_handler.rs:26-28`）。设置密码并重启服务后才绑定 `0.0.0.0`（`web/server/server.rs:452-454`，局域网可达），此时登录有 JWT + bcrypt + 限流防护。首次启动引导设置密码（P3）定位为 UX 收尾——消除「设置显示已启用但服务实际未监听」的困惑，而非安全补丁。

### 4.2 原生会话的 Tauri 命令层（新增）

`ai_chat_service` 全部函数接受 `owner: &str`，无 actor 概念。桌面端需固定 owner：

```rust
/// 桌面端原生会话的归属标识。与 Web API 账号一致，保证桌面与手机看到同一批会话。
fn desktop_owner() -> String {
    SettingsService::get_settings().web_api_username
}
```

新增 `commands/ai_chat.rs`，包 13 个命令（10 个会话命令 + 目录 1 个 + 历史 2 个）：

| 命令 | 对应 service 函数 | 说明 |
| --- | --- | --- |
| `ai_session_list` | `list(owner)` | 列表 |
| `ai_session_get` | `get(id, owner)` | 单会话 |
| `ai_session_create` | `create(owner, input)` | 新建 / 恢复 |
| `ai_session_send` | `send(id, owner, input)` | 发送 |
| `ai_session_stop` | `stop(id, owner)` | 中断 |
| `ai_session_answer` | `answer(id, owner, input)` | 提交决策 |
| `ai_session_delete` | `delete(id, owner)` | 删除 |
| `ai_session_pending_update` | `update_pending_input(...)` | 编辑排队消息 |
| `ai_session_pending_delete` | `delete_pending_input(...)` | 删除排队消息 |
| `ai_session_flush` | `flush(id, owner, request_id)` | 插话 |
| `ai_catalog` | `ai_catalog_service::catalog()` | 供应商与模型目录 |
| `ai_session_history` | `list_history(agent, ...)` | CLI 历史 |
| `ai_session_resume_history` | Claude：`create`（经 `CreateAiSession.resume_session_id` 分流）；Codex：`resume_codex_history` | 恢复历史。注：`resume_from_history` 是 `create` 内部的私有分流（`ai_chat_service.rs:163`），不是公开入口 |

注册：`commands/mod.rs` 导出 → `desktop.rs` 的 `generate_handler![]` → `web/handlers/desktop_dispatch.rs` 显式分支（浏览器模式，以 Web 身份）。

### 4.3 原生会话的实时同步

现有 `ai_chat_service` 不主动发事件，客户端依赖 300ms 轮询 `revision`（`ai_chat_handler.rs:136-155`）。桌面端两种选择：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A（推荐）** | 在 `touch()` 后用 `crate::runtime::Emitter` 发 `ai-session-update` 事件（含会话元数据与变化消息），前端 `listen` 订阅 | 实时、无轮询开销；需改 service（约 20 行） |
| B | 前端照抄 300ms 轮询 Tauri 命令 | 零后端改动；空闲时持续 IPC |

采用 A。事件载荷与 HTTP WS 的 `update` 帧同构，便于两端共用解析逻辑。

### 4.4 Skill 的处理（新增）

在 `ClaudeOutputState` 记录「本轮用户发送的原始文本」，用于兜底判定。

`apply_claude_event` 的 `user` 分支新增：

```rust
// Skill 展开：parent_tool_use_id 以 forked-command- 开头。
// 主判定认字段；字段缺失时用「文本显著长于本轮原始输入」兜底。
if let Some(parent) = value["parent_tool_use_id"].as_str() {
    if let Some(name) = parent.strip_prefix("forked-command-") {
        if let Some(text) = first_text_block(&value["message"]["content"]) {
            message_with_skill(cell, &format!("{turn}-skill-{name}"), name, &text);
            return Ok(false);
        }
    }
}
```

兜底路径：若 `parent_tool_use_id` 缺失，且回传文本长度 > 原始输入长度 × 3 且 > 500 字符，同样按 Skill 处理（名称从原始输入的首个 token 推导）。兜底的已知盲区：展开后不足 500 字符的短 Skill 在前缀字段缺失时不会命中，退化为普通用户气泡——可接受，不做额外处理。

`AI Skill` 消息落地为：

- `role = "user"`
- `text = 展开后的完整内容`
- `skillName = "code-review"`

### 4.5 数据模型变更

`models/ai_chat.rs` 的 `AiMessage` 新增一个可选字段：

```rust
/// Skill 展开的消息：Skill 名称（如 "code-review"）。普通消息为 None。
/// 前端据此渲染为可展开的 skill:名称 条目，而非普通气泡。
#[serde(default, skip_serializing_if = "Option::is_none")]
pub skill_name: Option<String>,
```

其余 6 处 `AiMessage { .. }` 构造点补 `skill_name: None`（均在 `ai_chat_service.rs`：259、278、454、520、613、1575，其他文件无构造点）。

兼容性：安卓端 `ApiJson` 配置了 `ignoreUnknownKeys = true`（`Json.kt:6`），旧版不会因新字段报错。

### 4.6 终端接力的 Tauri 命令层（恢复）

从 `56db750^` 恢复 `commands/terminal_agent.rs`（143 行）：`terminal_agent_list` / `messages` / `reply` / `subscribe` / `unsubscribe` / `heartbeat`，全部以 `TerminalActor::Pc` 调用。

同时需要恢复事件通道：`56db750` 一并删除了 relay 内的 `AGENT_UPDATE_EVENT`、`HeartbeatLease`、事件租约与 watcher 的 React 推送分支（约 149 行）。该提交还顺带删了 `desktop_dispatch.rs` 的 35 行分支、`desktop_handler.rs` 的 7 行与 `terminal_agent_handler.rs` 的 4 行，恢复时需一并核对。

> **注意**：`terminal_agent_relay.rs` 现有 `subscribe()` 返回 `mpsc::Receiver<TerminalAgentFrame>`，仅供同进程 WS handler 使用。桌面端是 Tauri webview，无法跨进程接收 channel。因此**必须恢复事件通道**（watcher 经 `crate::runtime::Emitter` 向 React 推送帧），不能只恢复命令层。

### 4.7 浏览器模式的双通道

`web_api_enabled` 默认改为 `true` 后，浏览器模式经 `/api/desktop/invoke` 调用，以 `TerminalActor::Web` 身份执行：

- 原生会话：owner 取 `claims.sub`（登录账号）
- 终端接力：`TerminalActor::Web`（遵守 `webApiShareSessions` 开关）

`desktop_dispatch.rs` 必须新增显式分支，**禁止**把 Tauri 命令函数直接 dispatch（否则会在非共享模式错误放开 Web→PC 写入）。

### 4.8 `/` 补全清单的数据链路（新增）

§5.3 的补全菜单数据来自 `system/init` 事件，而 `ai_chat_service` 目前**完全不处理**该事件（全文无 `slash_commands` / `skills` 的任何引用），需新增整条链路：

1. **捕获**：Claude 事件泵识别 `type == "system"` 且 `subtype == "init"` 的事件，提取 `skills`、`slash_commands`、`terminal_slash_commands` 三个集合（§3.2）。
2. **存储**：`AiSession` 新增可选字段，init 到达时写入。CLI 每次启动（含 `--resume` 恢复）都会发 init，随会话存储即天然满足 §5.3 的「随会话启动缓存、CLI 版本变化时自动更新」：

```rust
/// `system/init` 提供的命令清单，随会话启动刷新。Codex 无此机制，为 None。
#[serde(default, skip_serializing_if = "Option::is_none")]
pub slash_catalog: Option<SlashCatalog>,
```

`SlashCatalog` 含 `skills` / `slash_commands` / `terminal_slash_commands` 三个 `Vec<String>`。

3. **下发**：字段随 `ai_session_get` 与 §4.3 的 `ai-session-update` 事件（会话元数据部分）自然到达前端，无需独立命令。

安卓兼容性同 §4.5（`ignoreUnknownKeys`）。Codex 会话该字段恒为 `None`，前端隐藏 `/` 补全菜单。

---

## 5. 前端设计

### 5.1 标签与容器

- 新增特殊页签类型 `agent-chat`，与 `git-history` / `claude-replay` 并列。
- `appStore` 统一新增 `agentTabs: AgentTab[]`，以 `shape: 'native' | 'relay'` 区分两种形态，保证标签栏按打开顺序混排。
- 标签生命周期：原生会话被 `ai_session_delete` 删除、或接力终端关闭后，对应标签自动关闭；会话仅结束而未删除时，标签保留并显示「已结束」状态。
- 内容容器复用 `git-history-tab-content` 的 `position: absolute; inset: 0`。
- **去掉** `TerminalTabBar.tsx:349` 的「会话详情」分组标题，所有标签按打开顺序混排。

### 5.2 标签视觉

| 类型 | 图标 | 附加标记 |
| --- | --- | --- |
| 终端 | 终端图标 | — |
| 原生聊天 | 对话图标 | `CLAUDE` / `CODEX` 供应商角标 |
| 终端接力 | 终端图标 | `AGENT` 角标（提示这是 Agent 会话，可看对话） |
| Git 历史 / 会话回放 | 既有图标 | — |

不使用「形态徽标 + 变形按钮」（决策 2）。

### 5.3 原生会话页面

- 顶部：标题、状态徽标（执行中 / 等待确认 / 已完成）、模型、项目路径、「独立进程」说明
- 消息区：用户右气泡、助手左气泡（Markdown）、工具步骤折叠、**Skill 可展开条目**、审批卡
- 输入区：输入框、排队消息列表（插话 / 删除）、`/` 触发补全菜单、上下文用量

**`/` 补全菜单的数据源**：`system/init` 事件的 `slash_commands`，排除 `terminal_slash_commands`；分两组展示，用 `skills` 集合区分「内置命令」与「Skills」。该清单需随会话启动缓存，CLI 版本变化时自动更新。服务端捕获与下发链路见 §4.8。

### 5.4 终端接力页面

- 顶部：标题、`AGENT` 标记、「对话 / 终端」查看方式切换（**这是查看方式，不是会话形态**）
- 对话视图：只读镜像气泡 + 受限回复输入框（2000 字、3 秒冷却、禁 `/ ! @ #`）
- 终端视图：xterm 渲染同一 PTY

### 5.5 Skill 条目渲染

```
▾ [SKILL] skill:code-review              5.6 KB
  ┌──────────────────────────────────────────
  │ Review target: `src/services`
  │ `high effort → 8 inline angles → dedup`
  │ You are reviewing for recall at high …
  └──────────────────────────────────────────
```

- 标题：`skill:名称`
- 默认展开，内容区 260px 内滚动
- 内容过长时在条目内滚动，不撑高整个对话
- 用户原始输入（`/code-review src/services`）作为独立气泡保留在上方

---

## 6. 边界与风险

### 6.1 两种形态的会话互不可见

原生会话与终端接力是两套独立数据源（`AiSessions/*.json` vs 终端 + JSONL 转录）。同一个项目可能同时在两边各有一个会话，用户需要理解这一点。UI 上通过标签形态区分（`CLAUDE` 角标 vs `AGENT` 角标）。

### 6.2 桌面端无登录概念

`ai_chat_service` 按 `owner` 隔离。桌面端固定取 `web_api_username`（默认 `admin`），与手机一致，保证跨设备续聊。多台桌面共用同一数据目录时会串号——此场景暂不支持。同理，修改 `web_api_username` 会使 `desktop_owner()` 随之改变，旧会话按 owner 隔离将不可见；不做自动迁移，设置页保存时检测到用户名变更应提示需手动迁移 `AiSessions/*.json`。

### 6.3 斜杠命令的状态一致性问题

| 命令 | 问题 | 处理 |
| --- | --- | --- |
| `/clear` | 会话被清空但返回空文本 | 响应后刷新会话快照 |
| `/compact` | 上下文压缩，客户端看不到提示 | 响应后刷新会话快照 |
| `/model xxx` | 底层模型变了，`AiSession.model` 未更新 | 响应后刷新会话 |

不做这些刷新**不会出错**，只是显示滞后。作为收尾优化实现。

### 6.4 Skill 判定依赖 CLI 内部字段

`parent_tool_use_id` 的 `forked-command-` 前缀是 CLI 实现细节，版本升级可能变化。已设计兜底路径（§4.4），退化时仍能正确归类，不会刷屏。

### 6.5 终端接力的既有风险不变

见 `2026-11-01--terminal-agent-chat-relay.md` §7：无逐字流式、工具输出是摘要、写失败非确定性、残留绑定风险等。本次不改动 relay 核心。

### 6.6 Web API 默认开启

`web_api_enabled` 改为默认 `true` 后：

- 未设密码：HTTP 服务不启动（`should_run_http_server()` 要求密码非空），9600 无监听，无暴露窗口；唯一例外是配置了机器人回调（用户显式操作，且无密码时登录仍被拒）
- 设置密码并重启服务：绑定 `0.0.0.0`、局域网可达，登录有 JWT + bcrypt + 限流的暴力破解防护
- 首次启动引导设置密码（P3）属 UX 收尾：消除「设置显示已启用但服务实际未监听」的状态困惑

### 6.7 已打开会话不受设置变更影响

切换「新会话形态」设置后，已打开的标签保持原形态。会话关闭后按新设置重建（页签恢复走 `sessionRestore.ts`）。

---

## 7. 实施顺序

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P0 | 设置项（形态 + `web_api_enabled` 默认值）+ `AiMessage.skill_name`、`AiSession.slash_catalog` 模型变更 | `cargo check`、`cargo test --lib` |
| P0 | 原生会话 Tauri 命令层 + 事件通道（§4.2、§4.3） | 命令可被前端调用、事件能到达 webview |
| P0 | Skill 处理与兜底、`system/init` 清单捕获（§4.4、§4.8） | 单元测试：`forked-command-` 识别、兜底长度判定、init 三集合落库 |
| P1 | 标签体系：新增 `agent-chat` 页签、去掉分组标题（§5.1、§5.2） | 标签栏混排正确 |
| P1 | 原生会话页面：消息/Markdown/审批卡/输入区（§5.3） | 端到端可对话 |
| P1 | `/` 补全菜单（§5.3，数据链路 §4.8） | 命令与 Skill 分组正确 |
| P2 | Skill 条目渲染（§5.5） | 展开/折叠、长内容滚动 |
| P2 | 终端接力 Tauri 命令层 + 事件通道恢复（§4.6） | 接力标签可查看与回复 |
| P2 | 浏览器模式分支（§4.7） | 网页版调用不 404 |
| P3 | 斜杠命令状态刷新（§6.3）、首次启动密码引导（§6.6） | 手动验收 |

### 验证命令

```bash
cd terminal-buddy && npx tsc --noEmit
cd terminal-buddy/src-tauri && cargo check
cd terminal-buddy/src-tauri && cargo test --lib
cd terminal-buddy && python scripts/check-invoke-coverage.py
```

新增 Tauri 命令后必须跑 `check-invoke-coverage.py`；前端 `invoke()` 必须是 `generate_handler![]` 的子集。

---

## 8. 不做的事

| 项 | 原因 |
| --- | --- |
| 会话级形态切换 | 决策 2：形态由设置决定，创建后固定 |
| 把 PC 终端里的会话「移交」成原生会话 | `2026-11-01` 规格 §1.3 已论证收益小、风险高；本次沿用不做 |
| 补全列表由服务端硬编码 | CLI 已完成分流，硬编码会随版本过时（§3.1） |
| 终端接力支持斜杠命令 | 向活 TUI 注入按键，行为不可控（§3.4） |
| iframe 内嵌 Web 版 | 需二次登录、身份不同，且已有白屏前科（`5c83de2`） |

---

## 9. 参考资料

- 交互预览：`design/desktop-chat-tabs-preview.html`
- 原生会话 API 与数据模型：`docs/原生AI会话API.md`
- 接力协议与闸门：`docs/specs/2026-11-01--terminal-agent-chat-relay.md`
- 已移除的桌面面板实现：`7dbb0ad`（新增）、`732ad1d`（移除）
- 已移除的接力命令层：`56db750`（移除），恢复时参考 `56db750^`
