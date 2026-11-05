# 终端 Agent 会话接力（App 聊天气泡查看 + 受限回复）

> **⚠️ 2026-11-02 范围收缩**：本功能原始目的是「桌面端的会话在 Android App 上接力」，桌面端/网页版不应再提供该面板。据此已移除：React 面板（terminal-agent 组件、ActivityBar/TitleBar 入口、租约心跳与事件桥保活）、6 个 `terminal_agent_*` Tauri 命令及 `desktop_dispatch` 浏览器分支、relay 内的 `terminal-agent-update` 事件通道（`subscription_ids` 帧、事件租约与 `heartbeat`）。**保留**：relay 核心的 REST（`/api/terminal-agents*`）与 WS（`/ws/terminal-agents/{id}`）通道、安卓端全部实现，以及随本功能一并落地的浏览器决策权限安全修正（`*_for_web` 系列）。下文 §4.10、§5.5、§6 中关于网页版面板 / Tauri 命令层 / 事件通道的描述已不适用，仅作历史设计记录保留。
>
> **2026-11-02 补充（简版入口落地）**：简版首页 Tab 扩为「最近任务 / 历史会话 / 服务端会话」三段，第三段直接渲染 `/api/terminal-agents` 列表、点击接管；历史会话 Tab 中与实时列表 provider+sessionId 匹配且 `phase != ended` 的条目标记「电脑运行中」并改为直接接管（不再另起 CLI 进程）。同时修复历史恢复链路的数据滞后：App 点按恢复前先 rescan 对应 Agent 的索引；服务端 `resume_from_history` 复用已有会话时，空闲会话按最新索引刷新预填消息。§2.2 中「简版不增加列表」一条就此作废。

日期：2026-11-01。状态：**复审通过，可作为 P0 实施依据**。本次复审纠正了原评审遗漏的运行时身份、游标、会话发现开关、事件桥保活及 Android 入口问题；实施以本版正文为准，旧行号只作定位参考，若源码已漂移以符号名为准。本文是设计审批，不代表代码已实现或构建/真机验证已通过。

相关文档：[原生 AI 会话 API](../原生AI会话API.md)、[Pi Agent 实施计划](../Pi%20Agent%20实施计划.md)、[完整使用与配置指南](../完整使用与配置指南.md) §17。

---

## 0. 摘要

让 Android App 以**聊天气泡**形式查看桌面终端里正在运行的 Claude / Codex / Pi 会话；Claude / Pi 在权限与阶段允许时可发一句简单回复、回答待决策问题，Codex P0 只读。**不渲染终端**。

| 里程碑 | 内容 | 估算 |
| --- | --- | --- |
| P0 | 服务端 4 条 REST + 6 个 Tauri 命令 + watcher + 阶段状态存储 | 3–4 人日（待开发后重估） |
| P0 | Android 完整版入口 + 对话/终端宿主 + 决策联动 | 2–3 人日 |
| P0 | React 网页版面板（两种构建同一份代码） | 2–3 人日 |
| P0 | 单测 + 三 Agent × 三客户端形态端到端验证 | 2 人日 |
| P1 | 历史翻页、按会话搜索 | 视需要 |

**产品前提（已确认）**：桌面端与 App 不会同时操作同一个会话。典型场景是离开电脑后用手机盯进度、回一句、做决策。

### 0.1 已拍板决策（2026-11-01）

| # | 问题 | 结论 | 落地位置 |
| --- | --- | --- | --- |
| 1 | 回复输入框默认开/关 | **默认开**（仍受 `canReply` 与 §4.6 闸门约束，不可用时禁用并给原因） | §5.2 |
| 2 | Codex 会话如何提示 | **在会话页内标记**「Codex 暂不支持在此确认与回复」，列表不单独分组；P0 因存活不可确认收紧为只读 | §4.6、§5.2、§7 |
| 3 | 是否显示 token 用量 | **不显示**（终端会话没有 `usage`，不伪造） | §5.2 |
| 4 | 网页版（React）是否同步该功能 | **同步**：与 App 同一里程碑交付，两种构建（`dist` / `dist-web`）同一份代码（见 §4.10、§5.5） | §4.10、§5.5 |

---

## 1. 现状与结论依据

### 1.1 已经存在的地基

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 终端 → Agent 会话绑定 | `services/terminal_task_service.rs` | `TrackedTerminal.binding = (provider, sessionId)`；来自启动参数注入（Pi 扩展、Codex `log_dir`）、Hook 上报、进程扫描兜底 |
| 绑定快照 / 摘要 | `session_bindings()`、`summaries(pids)` | `summaries` 顺带补写 `TrackedTerminal.transcript`（转录文件路径） |
| 持久化登记表 | `services/claude_session_registry_service.rs` | `agent_session_registry.json`，容器重启后按 terminalId 回查 |
| 三套转录解析器 | `claude_history_service::parse_replay_messages`、`codex_transcript::parse`、`pi_transcript::parse` | 统一产出 `SessionReplayMessage { seq, role, text, tools, toolName, timestamp }` |
| 转录定位 | `terminal_task_service::find_transcript(root, provider, id)` | Claude `projects/**/{id}.jsonl`；Codex `sessions/**/-{id}.jsonl`；Pi `find_session_file` |
| 阶段事件 | `claude_hook_handler::emit_terminal_event`、`pi_hook_handler::emit_event` | phase：`idle / running / attention / completed / failed / ended`；Pi 审批入口需另补 `attention` 上报 |
| Agent 存活发现 | `commands/claude_session.rs::terminal_processes` | relay 必须复用这条不受 `showTaskSummary` 开关控制的进程快照路径 |
| 决策通道 | `ClaudeHookService` + `AppNotificationService` + `/api/notifications/decisions` | Claude 的 AskUserQuestion / PreToolUse、Pi 的 ToolApproval 可推到 App 卡片；部分 Notification 只有 attention、没有卡片 |
| 终端权限矩阵 | `models/terminal_access.rs` | `authorize(id, Web, View/Input)`；`webApiShareSessions=false` 时 Web 看不到 PC 终端 |
| 终端列表过滤 | `TerminalService::list_terminals_info_for(TerminalActor::Web)` | 按共享开关过滤，App 现有「服务端终端」就用这条 |

### 1.2 为什么不能直接复用现有历史链路

- `/api/ai/history` + `rescan` 走 SQLite 索引，索引判定是 **文件 mtime + size 的增量批次**（`claude_history_service::INDEX_BATCH_FILES = 60`，剩余由后台补齐）。要看新回合必须再 POST 一次 rescan，且索引可能存在「本批未覆盖」的滞后。适合「回头翻旧会话」，不适合「盯进度」。
- App 现有历史列表点击直接 `POST /api/ai/sessions` + `resumeSessionId`（`AiServerSessionsScreen`）→ **在服务端另起一个 CLI 进程**。对正在终端里运行的会话会造成双写/分叉，必须绕开。
- 复用 SQLite 还会引入一次额外的写放大（索引 + 回放），而镜像只需要顺序读一个文件。

### 1.3 为什么不做「移交」（把会话迁移成原生 AI 会话）

移交需要先让桌面终端的 agent 退出（`/exit`、进程校验），再 `--resume` / `thread/resume` 接管，并保证互斥。在「同一时刻只有一个操作者」的前提下收益很小：

- 终端会话保持唯一进程，App 只是「第二个键盘 + 只读镜像」，不存在分叉；
- 桌面端环境（cwd、后台任务、子进程、临时文件）全部保留；
- 用户回到电脑时，会话原样在那里，不需要再切回来。

因此 **P0 不做移交**。终端会话结束后（`phase=ended`）如需继续，App 可走现有「恢复历史对话」路径（此时终端已不占用，安全）。

---

## 2. 范围

### 2.1 在范围

- 按终端列出「当前绑定的 Agent 会话」，含 provider、会话标题、模型、阶段、待决策状态；`ended` 但 PTY 未关闭时仍保留只读条目。
- 只读镜像：新增消息按条推送到 App，以聊天气泡 + 工具折叠渲染。
- 受限回复：Claude / Pi 的纯文本（支持回车换行的多行草稿），注入到该终端的 PTY；Codex P0 不可回复。
- 决策联动：有待决策时禁用输入框，引导到现有决策卡片。
- 阶段展示：`attention / running / idle / completed / failed / ended / unknown`。
- React 网页版入口：与 App 同功能、同状态语义；两种构建（`dist` / `dist-web`）共用同一份组件代码。

### 2.2 不在范围（明确不做）

- 多行输入、斜杠命令、`@` 文件补全、图片/附件粘贴。
- 逐字流式输出（转录是落盘后才有，App 表现为「按条推进」）。
- 终端尺寸调整（`Resize`）：App 不画终端，也不改 PTY 尺寸，桌面视图不受影响。
- 会话移交、`--resume` 接管正在运行的终端会话。
- Codex 的终端内决策卡片（Codex 无 Hook 通道，见 §7）。
- Android 简版专属入口：P0 只在完整版的「终端」页提供；简版沿用现有任务/决策通知，不在本轮增加一套列表。**（2026-11-02 已作废：简版首页第三 Tab「服务端会话」+ 历史会话运行中条目直接接管，见顶部补充说明。）**
- Claude 转录中的子 Agent / sidechain 独立展示：P0 按现有回放解析器输出，不另建父子会话树。
- SSH / Docker / K8s 等远端 PTY 内 Agent 的进程扫描补强：现有 Hook / 扩展能精确绑定的会话可显示；进程扫描无法确认存活时只读，`canReply=false`，不把未知状态当可写。
- 网页版的深度链接/分享、消息搜索：P2 不做。

### 2.3 术语：「网页版」是什么

仓库里有**两份前端产物**，源码同一份 (`terminal-buddy/src/`)，构建模式不同：

| 产物 | 构建命令 | 去哪里 |
| --- | --- | --- |
| `dist` | `npm run build`（production） | 桌面 Tauri 应用本体（`tauri.conf.json` 的 `frontendDist: ../dist`），直连 `invoke()` |
| `dist-web` | `npm run build:web:desktop`（`--mode browser`） | ① 独立 Docker 服务端在 `/` 托管（`rust_embed`）；② 桌面版内置 Web API 也托管同一份，给浏览器客户端；③ 手机浏览器直连 Docker 地址看到的就是它 |

`dist-web` 构建里，`vite.config.ts` 把 `@tauri-apps/api/*` alias 到 `src/services/browser/*`：`invoke()` → `POST /api/desktop/invoke/{command}`，`listen()` → `/ws/events`。所以**同一份 React 代码在两种构建里都能跑**，差异只在传输层（§4.10）。

与 Android 原生 App（`android/` 的 Compose 工程）是两套独立客户端，共用同一套 `/api`；已退役的独立手机 SPA（`web/`）不参与任何构建，本设计不涉及。

所以「网页版同步该功能」= 在 `src/` 里加一个面板，让用浏览器（电脑浏览器，或手机浏览器连 Docker 服务端）的人也能用聊天气泡看待接力的终端会话；桌面构建里同样可用，只是人在电脑前时直接看终端更快。

---

## 3. 总体设计

```
桌面/服务端终端  (claude | codex | pi)
   │
   │ 转录文件（JSONL，行级追加）
   ├──────────────▶ services/terminal_agent_relay.rs
   │                   ├─ 解析 → SessionReplayMessage（完整比较 + revision 判定重建）
   │                   ├─ 阶段表（note_phase）
   │                   └─ 回复幂等表
   │                        │
   │                        ├── REST  /api/terminal-agents
   │                        ├── REST  /api/terminal-agents/{id}/messages
   │                        ├── WS    /ws/terminal-agents/{id}
   │                        └── POST  /api/terminal-agents/{id}/reply
   │                                   │
   └────────◀── write_to_terminal(actor) ┘ （先写文本：单行原文 / 多行括号粘贴；停顿 150ms 再单独写 "\r"；REST/Web 用 Web，Tauri 用 Pc）

现有通道（不改动）：
  Hook ──▶ ClaudeHookService ──▶ /api/notifications/decisions ──▶ App 决策卡片
```

服务端只读文件、只写 PTY 输入，**不改动 SQLite schema、不改动 `settings.json`**。对外有两套薄传输层，共用同一个 `services/terminal_agent_relay.rs`：

| 传输 | 客户端 | 形式 |
| --- | --- | --- |
| REST + WS | Android | `/api/terminal-agents*` + `/ws/terminal-agents/{id}`（§4.1–§4.5） |
| Tauri 命令 + 事件 | React（桌面与网页两种构建） | `invoke('terminal_agent_*')` + `listen('terminal-agent-update')`（§4.10）；命令内部按桌面 Pc / 浏览器 Web 分身份鉴权 |

**统一模型**：`TerminalAgentSession` 是列表、首帧和状态更新的共同元数据；`TerminalAgentPage` 是完整快照页。消息协议首版即固定以下字段，不再让客户端猜测：

- `session`：§4.2 的完整条目，含 `revision`、`replyBlockedReason`；
- `messages`：本页实际携带的消息；`cursor` 是本页最后一条的 `seq`，无消息时为 `-1`，**不是消息条数或 `total`**；
- `total`：本次完整解析得到的展示消息数（截断前）；`truncated` 表示服务端只保留尾部窗口；
- `hasMore`：增量请求是否还有下一页；`nextCursor`：下次请求的游标；快照页该组字段不用于向前翻历史；
- `oldestRetainedSeq`：保留窗口中最小 seq，无消息为 `null`；`resetRequired`：客户端不能安全增量拼接，必须清空并采用本页快照；
- `revision`：服务端本次进程内单调递增的镜像重建代次（换绑、路径/文件身份变化、任何旧消息变化、从不可用恢复都 +1），追加不增加；重启后重新从 1 开始，客户端不得跨进程比较大小，只比较是否相等。

---

## 4. 服务端设计

### 4.1 契约总表

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/terminal-agents` | JWT + `list_terminals_info_for(Web)` | 可接力的终端会话列表 |
| GET | `/api/terminal-agents/{terminalId}/messages?afterSeq=&limit=&revision=` | JWT + `authorize(View)` | 首屏快照或限界增量；`revision` 为可选的客户端代次 |
| WS | `/ws/terminal-agents/{terminalId}?token=` | 握手前 `authorize(View)`，之后每 5 秒复核 | 实时快照 / 增量推送 |
| POST | `/api/terminal-agents/{terminalId}/reply` | JWT + `authorize(Input)` + 回复闸门 | 注入文本（多行用括号粘贴） |

全部使用现有 `ClaimsFromRequest` 与 `TerminalService`，**不新增权限动作位**。`webApiShareSessions=false` 时：列表不含 PC 终端、单终端按 `TerminalAccessError` 返回 404/403、握手前同样处理。无绑定的终端即使可见，也不存在 relay 资源：messages / subscribe 返回 404「该终端没有正在运行的 Agent」；reply 按 §4.6 返回 409。`afterSeq` 必须是 ≥ -1 的整数，`limit` 为 1–500，缺省 200，非法参数返回 400。

### 4.2 列表 `GET /api/terminal-agents`

```json
[
  {
    "terminalId": "…",
    "profileName": "项目 A",
    "terminalType": "powershell",
    "directory": "/workspace/a",
    "provider": "claude",
    "sessionId": "3f2c…",
    "title": "修复登录超时",
    "model": "claude-opus-4-5",
    "phase": "running",
    "phaseAt": 1762000000000,
    "lastActivityAt": 1761999990000,
    "pendingDecisionId": null,
    "pendingDecisionCount": 0,
    "canReply": true,
    "replyBlockedReason": null,
    "revision": 7,
    "mirror": { "available": true, "reason": null }
  }
]
```

实现要点（顺序不能反）：

1. 按调用者身份取 `TerminalService::list_terminals_info_for(actor)` 得到**可见终端**；Android / 浏览器是 `Web`，原生 Tauri 是 `Pc`。不要从 `session_bindings()` 反推可见性。
2. 从可见终端取 PID：把 `commands/claude_session.rs::terminal_processes` 改为 `pub(crate)`，relay 只向它传已经鉴权的 terminalId；**不得调用 `get_terminal_task_summaries` 代替**，后者在 `showTaskSummary=false` 时直接返回空，会让本功能默认无会话。
3. **先**调 `terminal_task_service::summaries(pids)`（补写 `transcript` 并刷新摘要），**再**调 `session_bindings()` 读绑定——顺序反了会拿到空的 `transcript`。`title` 取 `TerminalTaskSummary.summary`，`model` 同样来自该结构；无标题时客户端回退 sessionId 前缀。
4. `summaries` 会读 `/proc`、走静态 `SCAN_LOCK`，开销不小：**完整进程扫描结果**按 2 秒 TTL 缓存，watcher 的 tick 复用同一次扫描。缓存只能保存不带权限语义的扫描/摘要数据，每个调用者仍需各自过滤终端并计算 `canReply`，不得把 Web 列表直接给 Pc 或反之。扫描与文件解析都在 `spawn_blocking` 中执行，锁内不做 I/O。
5. 列表条目只保留 `binding` 存在且 provider ∈ {claude, codex, pi} 的终端。relay 发现不依赖 `webApiShareSessions` 之外的显示设置。
6. `canReply` 复用 §4.6 的第 1/2/3/7 条闸门（不检查文本、requestId 和频率），并返回配套的 `replyBlockedReason`：可回复为 `null`，不可回复必须是可直接显示的中文原因。阶段无 Hook / 存活无法确认等原因不能用空字符串代替。
7. `lastActivityAt = max(转录文件 mtime, phaseAt)`，两者都取不到时为 `null`（客户端显示「未知」而不是编造时间）。**不要用 `AgentSessionRecord.updated_at`**——它填的是读取时刻，恒为「刚刚」，没有信息量。mtime 在文件系统上持久，服务重启后仍可用。
8. `pendingDecisionId` 取该 terminalId 下按 `occurredAt` 升序的第一项；`pendingDecisionCount` 同时返回总数，供「有 N 项待确认」展示。决策是否仍有效只信 `ClaudeHookService` 当前快照，不复用已推送的旧值。

### 4.3 转录定位、解析与重建判定

- 路径优先级：`tracked.transcript` → `find_transcript(claude_root|codex_root|pi_root, provider, id)`。`find_transcript` 与 `TrackedTerminal` 是模块私有项，新增 `pub(crate) locate_transcript(terminal_id) -> Option<TranscriptLocation>`，返回当前 `(provider, sessionId, path, root)`；在 tracked 锁内复制必要数据，**释放锁后再递归找文件**，避免目录 I/O 阻塞 Hook 绑定。定位失败结果带 2 秒负缓存，成功路径随该绑定缓存。
- 路径 / sessionId 变化必须同步更新缓存与 `revision`。每个快照在读取前后各取一次元数据：大小或 mtime 已变化则丢弃本次结果并重试（最多 2 次），仍不稳定返回本轮旧快照并在下一 tick 重试，不把写入中的混合版本当成新代次。
- 读取时只解析到最后一个 `\n` 为止的完整字节；尾部半行不进入解析器。三家解析器对非法行的容错不等于半行安全，不能靠 `content.lines()` 碰运气。用 `read_to_string` 严格 UTF-8 读取，不用 lossy 转换；读文件失败 / 文件不存在 / UTF-8 错误 → `transcript_unreadable`；>128 MiB → `transcript_too_large`，不分配大字符串。
- 解析仍复用三家现有解析器与 `SessionReplayMessage`（字段一致，Android 可复用历史消息模型），但镜像同步**不假定解析器的 seq 在追加后稳定**。Claude 的 seq 允许空洞；Codex 会先全文去重再重编号；Pi 会按活动分支重建编号。
- 对当前解析得到的完整消息建立旧/新映射：优先按 `(seq, role, text, timestamp, tools, toolName)` 完整相等匹配；若新结果只是保留旧消息并在末尾增加，则发 `append`。**任何旧 seq 的完整内容变化、同 seq 重复、旧消息消失、total 变小、Codex 去重导致重排、Pi 活动分支叶节点变化，都提升 `revision` 并返回完整尾页 `rotated`，不做原地 patch。**
- Codex 必须加回归用例：先有 `event_msg(user x)`，后追加对应 `response_item(user x)`，旧 event 被去重时即使 total 不变也必须 `rotated`。Pi 换枝即使可见正文碰巧相同也 `rotated`（保留活动分支叶节点作为判据）。
- `MirrorCache { provider, sessionId, path, fileStamp, branchIdentity, allMessages, revision, parsedAt, lastAccessAt }`；`allMessages` 是该 revision 的完整基线（仅在 §4.3 超大阈值下裁剪），不是只保存最近 500 条。若性能要求保存多代基线则最多两代，否则 `revision` 不同一律 reset。单条解析任务串行，旧任务完成后若绑定 / 代次已变则丢弃结果。文件未变化不重复解析。
- 上限与降级（均为首版常量，集中定义，客户端不硬编码阈值）：

  | 条件 | 行为 |
  | --- | --- |
  | 完整解析文件 >32 MiB 或消息 >5000 条 | 内部只保留最后 500 条，`truncated=true`，`total` 仍是截断前完整解析消息数 |
  | 文件 >128 MiB | `mirror.available=false, reason="transcript_too_large"`，提示改用终端 / 历史页 |
  | 文件不存在、权限或 UTF-8 读取失败 | `mirror.available=false, reason="transcript_unreadable"`；JSONL 单行损坏按现有解析器跳过 |
  | 文件存在但 0 条消息 | `available=true`，空快照，`cursor=-1` |
  | 从不可用恢复 | `available=true`，`revision+1`，发完整 `mirror` 快照 |

- 缓存表按 terminalId 淘汰：终端关闭立即清理；绑定变化用新代次替换；30 分钟无人访问清理。`ended` 不等于终端关闭，缓存与只读快照保留。

### 4.4 消息页 `GET /api/terminal-agents/{id}/messages`

快照与重连补偿共用同一响应，客户端永远先检查 `resetRequired` / `revision` 再处理消息：

```json
{
  "session": {
    "terminalId": "…", "provider": "claude", "sessionId": "3f2c…",
    "profileName": "项目 A", "terminalType": "powershell", "directory": "/workspace/a",
    "title": "修复登录超时", "model": "claude-opus-4-5",
    "phase": "running", "phaseAt": 1762000000000, "lastActivityAt": 1761999990000,
    "pendingDecisionId": null, "pendingDecisionCount": 0,
    "canReply": true, "replyBlockedReason": null, "revision": 7,
    "mirror": { "available": true, "reason": null }
  },
  "messages": [{
    "seq": 120, "role": "assistant", "timestamp": 1761999990000,
    "text": "好的，我先看一下登录相关代码。",
    "tools": [{ "name": "Bash", "summary": "rg -n 'login' src/" }], "toolName": null
  }],
  "cursor": 120, "total": 128, "truncated": false,
  "hasMore": true, "nextCursor": 120, "oldestRetainedSeq": 0, "resetRequired": false
}
```

- **不带 `afterSeq`**：返回当前 revision 的尾部一页，供首屏；客户端清空本地后整体采用，不要求连续 seq。快照页 `hasMore=false`（历史向前翻页属于 P1）。
- **带 `afterSeq=N` 且 revision 相同**：按 seq 升序取**最早**的 `limit` 条 `seq>N` 消息；`hasMore` 表示后面还有，`nextCursor` 为本页最后 seq。客户端循环请求直到 `hasMore=false`，才认为追平。空增量页保留请求游标；请求为 `-1` 且仍无消息时 `cursor=-1`。
- **revision 不同、保留窗口已越过 N，或文件发生重写**：返回 `resetRequired=true` + 当前完整尾页（最多 500 条），客户端必须清空并整体替换，**不能**只拿 `seq>N` 的空结果继续显示旧消息。revision 未传或服务重启后的首次同步也按完整快照处理。N 不属于缓存窗口但小于 `oldestRetainedSeq` 时一定 reset；N 大于当前最大 seq 时，若 revision 相同则为尚未追平的空增量页，不因此 reset。
- `truncated=true` 仅表示窗口有截断，不单独触发清空；只有上述 `resetRequired` 才强制重建。客户端每次收到新 revision 都先重建，服务端 WS 也不能只发一个无内容的 `rotated` 让客户端再猜。
- **重连采用 WS 首帧原子快照，不做「REST 拉齐后再开 WS」的竞态交接**：Android 断线重连直接开 WS，以首帧 `mirror`（同本响应）替换旧状态，然后消费后续 `append`。若首帧为 `unavailable`，同样清空旧消息并进入提示态。REST 增量仅用于首屏、HTTP 重试或不适合保持 WS 时的手动刷新。
- `append` 帧也带 revision、cursor 和 `hasMore/nextCursor`；若单次变化超过推送上限，服务端直接发 `mirror` 快照而不是让客户端追赶无限队列。**REST 的 `hasMore` 追赶只适用于无 WS 的 REST 补偿；WS 的 append 必须能直接消费，若缓存窗口不足则直接发完整 mirror，不让 WS 客户端再隐式走 REST。** 每帧以 `terminalId` 判别归属；React 事件 payload 是完整帧对象。

### 4.5 WS `/ws/terminal-agents/{id}`（Android 专用）与共享 watcher

网页版不走这条：浏览器构建的 `listen()` 使用 `/ws/events` 事件桥，见 §4.10。两种订阅共用 relay 的 **per-terminal watcher**，但每个订阅都携带 `actor` 与唯一 `subscriptionId`，不能只有一个无身份计数：

- `subscribe(terminalId, actor)` 在同一临界区完成 `authorize(View)`、确认绑定、建立 sender、取得首帧快照并启动 watcher，返回 `subscriptionId + receiver + initialFrame`。首帧之前若文件已变化，以下一次重建为准，**不得出现首帧后又补一个同 revision 的乱序 append**。
- 每条 Android WS 是一个 Web 订阅，连接结束用 RAII guard 释放；React 每次 `terminal_agent_subscribe` 是一个 Pc 或 Web 订阅。watcher 只把帧发给仍然 `authorize(View)` 的订阅；每 5 秒分别复核，失权者收到 `error{code:"forbidden"}` 后被移除。不能因另一个身份无权而关闭整个 watcher。
- 订阅数 0→1 启动 1 秒 tick；归零后 30 秒停止。tick 检查绑定 / 文件 / 阶段 / 决策，复用 §4.2 的扫描缓存；产生完整快照或 append 后向该终端仍获授权的 WS sender 发帧，并通过 `crate::runtime::Emitter` 发同名 React 事件。
- `session_change_tx` 只是 `()` 类型的**唤醒信号**，创建、改名、关闭都会触发，不能据此认定目标关闭。收到后重新 `authorize` / 查目标 terminalId；仅目标不存在才终止该目标订阅。Agent `phase=ended` 时 PTY 仍可能活着：发 `status(ended)`、禁回复、保留只读 watcher；真正终端关闭才发 `error{code:"terminal_closed"}` 并结束。
- 每终端出站队列有界（64 帧），慢消费者溢出时断开并让其以首帧重建；不得用无界队列缓存超大转录。watcher 自己永远只有一份，不由各客户端另起 tick。

握手前完成 JWT 与 `authorize(Web, View)`（未知 404、无权 403），全局 WS 配额不足返回 409。握手后帧结构如下；所有帧都含 `terminalId`，有 `session` 的帧以完整 session 覆盖旧元数据：

| `type` | 时机 | 除 `terminalId` 外的 payload |
| --- | --- | --- |
| `mirror` | 首帧、需要重建、从不可用恢复 | 完整 `session` + §4.4 完整尾页字段 |
| `append` | 同 revision 纯尾部新增 | `revision/messages/cursor/total/truncated/hasMore/nextCursor`；快照内游标已超过本次变化窗口时可直接发 `mirror`，不伪造 hasMore 让 WS 客户端走 REST 追赶 |
| `status` | 阶段 / 决策 / 回复闸门变化 | 完整 `session`（含 revision 与 `replyBlockedReason`） |
| `rotated` | 换绑、路径/文件身份或旧消息变化 | **与 `mirror` 相同的完整尾页**，客户端清空后采用 |
| `unavailable` | §4.3 降级 | 完整 `session`（`mirror.available=false`）+ `reason`；客户端清空旧消息 |
| `error` | 终端关闭 / 失权 / 内部不可恢复错误 | `{ code, message }`；随后关闭连接 |

首帧只能是 `mirror` 或 `unavailable`；`rotated` 的 payload 与 mirror 相同，只用于告知原因。`append` 只允许同 revision，收到不同 revision 或 `resetRequired` 的帧客户端必须清空重建。单条推送最多 200 条消息，超过则改发 mirror。

连接看护：10 秒 Ping，每 5 秒复核权限与 JWT 有效期；无 Pong / 任何客户端帧 30 秒即断，避免死连接占用 watcher。镜像 WS 占全局 50 条配额，不占终端输出的每终端 5 条配额。帧上限沿用 AI 对话 WS 先例，但只对服务端发送的大消息放开；客户端只需 Pong，不接受业务输入。所有消息继续使用 `SessionReplayMessage` 的字段。

### 4.6 回复 `POST /api/terminal-agents/{id}/reply`

```json
{ "text": "先跳过这个测试，直接修登录超时", "requestId": "0f1c…" }
```

校验链（顺序固定，任何一步失败都不写 PTY）：

| # | 检查 | 失败返回 |
| --- | --- | --- |
| 1 | `authorize(id, actor, Input)` | 404 / 403（沿用 `TerminalAccessError` 的中文提示，含 `webApiShareSessions` 指引） |
| 2 | 该终端存在当前 agent 绑定；relay 快照身份与本次请求一致 | 409「该终端没有正在运行的 Agent」；换绑则要求刷新 |
| 3 | 无待决策，且 `phase != "attention"`（`list_pending_decisions()` 按 terminalId 过滤） | 有卡片：409 + `decisionId`；无卡片的 Claude attention：409 +「请打开终端处理当前确认」 |
| 4 | `requestId` 幂等（`(actor, terminalId, requestId)`，TTL 5 分钟，上限 500） | 成功重复：200 `duplicated=true`；同键不同文本：409 |
| 5 | 文本规则：trim 后非空、≤2000 个 Unicode 字符、不以 `/` `!` `@` `#` 开头、**除换行 `\n` 外不含任何控制字符**（`c != '\n' && c.is_control()`，覆盖 `\r` `\t` `\x03` `ESC` `DEL` 及 Unicode 控制区） | 400 + 具体中文原因 |
| 6 | 频率：同终端 3 秒内最多 1 条 | 429 + `Retry-After`（整数秒，向上取整） |
| 7 | 当前 `(provider, sessionId)` 的 `phase != "ended"`，且满足下表存活条件 | 409 + 明确的 `replyBlockedReason` |

写入分两次：先写文本（单行原文；多行用括号粘贴 `ESC[200~ … ESC[201~` 包住整个文本，避免换行被 TUI 当成多次回车），停顿 150ms 后再**单独**写入 `\r` 提交。REST / 浏览器命令传 `Web`，原生 Tauri 传 `Pc`。

**原子性与幂等**：用每终端 async mutex 串行执行「重新授权 → 重新读取绑定 / 阶段 / 决策 → 检查 requestId / 文本 / 限流 → 占位 → 写 PTY」。不能先检查后占位让两个并发请求同时通过。writer 成功后记录 completed，重复请求返回 `duplicated=true`。writer 失败返回错误并标记 `write_outcome_unknown`：PTY 的 `write_all/flush` 无法报告实际已写入字节数，**不保证恰好一次**，服务端和客户端均不自动重试；客户端提示「写入结果未知，请打开终端确认；如未生效请重新发送」，由用户新建 requestId 主动重试。限流只记录成功写入，失败记录 30 秒用于诊断 / 防重复试探，过期或换绑后不再复用旧键。

`requestId` 必须是 8–64 位 ASCII 字母 / 数字 / `-` / `_`；服务端不接受空串或任意长键。trim 只用于校验和判断同键文本是否一致，**实际注入保留用户原始非控制字符文本**（`\r\n` / `\r` 先统一成 `\n`）。列表中的 canReply 是提示，不代替写入前最后一次检查。

**为什么多行用 bracketed paste**：直接把带 `\n` 的文本写进 PTY，TUI 会把每个换行当成一次回车，导致每一行都被独立发送。括号粘贴把整段文本作为一个整体插入输入框，最后只用一个 `\r` 提交，与真人粘贴多行再回车等价。

**为什么回车必须单独写、且与文本隔开 150ms**：PTY 一次写入的长文本会被 Claude Code（Ink）的输入框判定为粘贴批量输入，紧随文本的 `\r` 会被并入粘贴内容而不是触发提交，表现为「文字进了输入框但没有发送」。把回车拆成第二次写入并留出停顿，相当于真人「输入完再按 Enter」，单行与多行都适用；短文本虽偶发正常，也不依赖长度阈值。

**为什么除换行外仍要拒绝其他控制字符**：PTY 写入与真人按键等价，`\x03`（Ctrl+C）会直接中断 agent 进程、`\x04` 是 EOF、`\t` 会触发补全——都比换行更危险。用 `c != '\n' && c.is_control()` 一条规则覆盖其余 C0/DEL/Unicode 控制区；`\n` 只有在括号粘贴里才允许，中文与 emoji 不属于控制字符，正常放行。

**「agent 仍在」判定**（避免把文本当命令打进 shell）：

| 阶段 | 允许回复 | 说明 |
| --- | --- | --- |
| `running` / `attention` | running 是；attention 一律否 | 有待卡片与无卡片 attention 都由第 3 条区分原因 |
| `idle` / `completed` / `failed` | 是，且要求 `phaseAt` 在 24 小时内 | Claude/Pi 停在输入框等输入 |
| `ended` | 否 | 会话已退出，输入会落到 shell |
| `unknown` | **否（P0 保守策略）** | 无 Hook 的 Codex 和服务重启后均只读，禁止把文本打进可能的 shell；待有可靠前台进程确认再放宽 |

返回：

```json
{ "accepted": true, "duplicated": false, "phase": "running", "at": 1762000001000 }
```

**不返回 delivered**。送达判定由镜像完成：App 看到自己那条文本以 `role=user` 出现在同 revision 镜像里 → 标记「已送达」；10 秒内未出现 → 提示「可能未生效，请打开终端确认」，**不自动重发**（Claude / Pi 忙碌时可能排队）。Codex P0 不可回复，不走此状态。

### 4.7 阶段状态存储

新增 `services/terminal_agent_relay.rs`：

- `note_phase(terminal_id, provider, session_id, phase, occurred_at)`：在两个现有 `emit_*` 中调用。**必须带 sessionId**，阶段表键为 `(terminalId, provider, sessionId)`；读取时与当前绑定完全匹配。
- **原子换绑条件**：`record_claude_session` 在写 binding 前先取当前绑定。相同 provider + sessionId 更新 phase；当前无绑定时允许建立绑定并记 phase；当前绑定为另一 sessionId 时，**只有 `SessionStart` 允许换绑并记 idle**，其余事件（含 SessionEnd）不得改变当前绑定，也不得写入当前会话阶段。旧会话阶段可按旧键留存但不参与 canReply。绝不能先无条件 `bind(old)` 再以 sessionId 不匹配为由忽略阶段。Pi 以扩展明确的 SessionStart 事件执行同一规则；普通 ToolCall / Input 不越过已有不同绑定。
- 阶段表允许每 terminal 保存最近若干代次，但至少保留 24 小时、上限 500 条并按最近使用淘汰。换绑后当前条目无匹配即 `unknown`，不是沿用旧 phase。启动时为空，服务重启后保守只读。
- Pi `ToolApproval` 入口不经过现有 `emit_event`：在审批开始时另写当前绑定的 `attention`，完成 / 超时 / 返回终端后写 `running`（若已结束或换绑则不覆盖）。`pendingDecisionId` 仍以 `ClaudeHookService` 为唯一事实来源。
- Claude `Notification(permission_prompt)` 可能没有结构化 pending decision；`attention` 与 `pendingDecisionId` 必须独立表示，不能假定 `attention ⇒ 一定有卡片`，也不能让无卡片 attention 继续可回复。
- 待决策不另存，回复闸门按 terminalId 过滤当前 pending；`pendingDecisionCount` 与最早一个 id 均从同一快照生成。

阶段来源覆盖面：

| Agent | 阶段事件 | 决策卡片 |
| --- | --- | --- |
| Claude | SessionStart / UserPromptSubmit / Notification / PreToolUse / Stop / StopFailure / SessionEnd | ✅（仅 AskUserQuestion；其他 permission_prompt 可能无卡片） |
| Pi | SessionStart / Input / ToolCall / ToolApproval / Stop / StopFailure / SessionEnd | ✅（ToolApproval） |
| Codex | 无 Hook（只有转录与进程发现） | ❌ |

### 4.8 错误响应

沿用现有 `ApiError` 与统一响应体 `{ "error": "<变体名>", "message": "<中文>" }`，并增加两个**可选**业务字段，不另建错误码注册表：

- 闸门失败用 `ApiError::Conflict`（409）；有待卡片时附带 `decisionId`，有无卡片 attention 等不可回复状态可附带 `replyBlockedReason`；
- 文本规则失败用 `BadRequest`（400）；
- 频率限制用 `TooManyRequests`（自带 `Retry-After` 头，客户端据此倒计时）；
- 权限失败按 `TerminalAccessError::NotFound / Denied` 映射 404 / 403，不能一律 403；中文提示保留 `webApiShareSessions` 指引。

Tauri 原生命令没有 HTTP 状态，统一返回 `Result<T, TerminalAgentCommandError>`，结构为 `{ code: "bad_request"|"forbidden"|"not_found"|"conflict"|"too_many_requests"|"internal", message, decisionId?, retryAfter? }`。浏览器 `/api/desktop/invoke` 适配器按相同错误码映射到上述 HTTP 状态 / `Retry-After` 头，不能经通用 `result()` 全部降级成 400。`requestId` 与 `terminalId` 永远不把服务端路径或 token 写入日志。

### 4.9 分层与可测试性

避免 service 反向依赖 `commands::terminal`，也避免闸门逻辑埋在 handler 里无法单测。**注册位置**：REST 路由加进 `web/server.rs` 的 Router（与 `/api/terminals` 同段），`web/handlers/mod.rs` 与 `services/mod.rs` 各自导出新模块：

- `web/handlers/terminal_agent_handler.rs`（新）：读 `AppState`、取 `TerminalService`，统一以 `TerminalActor::Web` 调共享 use case；REST 路由保持默认 2 MiB body 上限与 30 秒请求超时。
- `commands/terminal_agent.rs`（新）：原生 Tauri 入口以 `Pc` 调同一 use case；`web/handlers/desktop_dispatch.rs` 用显式分支调用同一组函数但以 `Web` 身份执行。**禁止把 Tauri 命令函数直接 dispatch 给浏览器**，否则会在非共享模式错误放开 Web→PC 写入。
- `services/terminal_agent_relay.rs`（新）：
  - `sessions_for(actor)` / `page_for(terminalId, actor, afterSeq, limit, revision)`：调用可见列表 → PID → summaries → binding 的固定链路；
  - `subscribe / unsubscribe(terminalId, actor, subscriptionId)`：管理带身份订阅、watcher 与首帧；
  - `reply(terminalId, actor, text, requestId, writer)`：在同一 per-terminal 临界区完成最终校验、幂等与 writer；writer 生产调用 `write_to_terminal(actor)`，测试是计数器；
  - 纯函数 `validate_reply(...)` 与 `diff_snapshot(old, new)`：覆盖回复闸门、完整消息比较、重建与游标分页；`note_phase(...)`、幂等表、路径缓存；
  - 把 terminalId 路径参数限制为现有 ID 字符集 `[A-Za-z0-9_-]{1,128}`，非法 400，不拼文件路径、不执行任何 shell 命令。

锁边界：`terminal_task_service` 的 tracked 锁、`TerminalService.instances` 锁、relay 状态锁均不得跨目录 / 文件 I/O 持有；回复 async mutex 不包裹 `spawn_blocking` 的文件扫描。这样 §9.1 的闸门 / 幂等 / 解析用例不需要真实 PTY，也不用初始化 `AppHandle`。

### 4.10 Tauri 命令与事件（React 页面）

React 页面在两种构建里是同一份代码：`--mode browser` 时 `vite.config.ts` 把 `@tauri-apps/api/*` alias 到 `src/services/browser/*`，`invoke()` 变成 `POST /api/desktop/invoke/{command}`，`listen()` 变成 `/ws/events` 事件桥。所以只需：

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `terminal_agent_list` | — | 同 §4.2，按调用端 actor 过滤 |
| `terminal_agent_messages` | `{ terminalId, afterSeq?, limit?, revision? }` | 同 §4.4 |
| `terminal_agent_reply` | `{ terminalId, text, requestId }` | 同 §4.6，浏览器与桌面分别以 Web / Pc 鉴权 |
| `terminal_agent_subscribe` | `{ terminalId }` | 创建带 actor 的租约，返回 `{ subscriptionId, initialFrame }`；事件按 §4.5 推送 |
| `terminal_agent_unsubscribe` | `{ terminalId, subscriptionId }` | 释放指定租约，重复释放幂等 |
| `terminal_agent_heartbeat` | `{ subscriptions: [{ terminalId, subscriptionId }] }` | 续租 30 秒；同时供浏览器事件桥保活，返回 `{ alive: [{ terminalId, subscriptionId }] }` |

实现约定：

- `commands/terminal_agent.rs`（新）只做薄包装；注册进 `src-tauri/src/desktop.rs` 的 `generate_handler![]`，并在 `commands/mod.rs` 重新导出。完成后跑 `python scripts/check-invoke-coverage.py`。
- 6 个命令都在 `web/handlers/desktop_dispatch.rs` 显式分支，以 Web 身份调用共享 service；`desktop_handler::check_arguments` 对带 terminalId 的命令做 View，reply 提级 Input，业务层仍必须重新鉴权。不得把桌面命令原样暴露给浏览器。
- **租约不是 ±1 计数**：每次 subscribe 返回 UUID 句柄，React 保存并原样释放；同一组件重渲染不会误减别人的订阅。每 15 秒 heartbeat 续租，30 秒未续租 / 明确 unsubscribe / 失权即释放；零租约后再延迟 30 秒停 watcher。心跳失败或 alive 不含当前句柄时，先退订旧句柄再重新 subscribe，以 `initialFrame` 原子替换。
- **浏览器事件桥必须保活**：现有 `/ws/events` 在 30 秒无客户端消息时主动断开；heartbeat 除了调命令，还向当前 event socket 发送 `{type:"ping"}`。服务端将其作为 activity、可回 `{type:"pong"}` 或不回业务事件。只在有活跃 Agent 租约时启动心跳，页面隐藏 / 离开立即清理。
- 事件：`app.emit("terminal-agent-update", frame)`，frame 与 §4.5 完全相同，判别字段为 `type`，**不是另造 `kind` 字段**。首帧由 subscribe 同步返回，后续 frame 含 `subscriptionIds`，watcher 只向当前租约内且仍获授权的订阅发；EventBus 是进程广播，React 收到后按自己的 subscriptionId 过滤，其他租约的帧立即忽略。不要每 tick 向无订阅终端广播。
- 发事件必须用 `crate::runtime::Emitter`（EventBus + Tauri 双通道），不能用只到桌面 webview 的 `tauri::Emitter`。每个顶层 frame 必须含 `terminalId`，让 `/ws/events` 能再次按 Web View 过滤。
- 事件桥断线 / `web-resync` / 服务重启后，不保留旧订阅假定有效：取消心跳 → 对新会话重新 subscribe → 用 initialFrame 清空替换；仅 `web-resync` 且后端确认租约仍活时可先 `messages(afterSeq)` 补偿，否则一律重建。
- 订阅 watcher 的原始扫描缓存不分身份共享最终可见结果；Pc 面板不应因 `webApiShareSessions=false` 看不到自己的终端，Web 面板也不应借 Pc 缓存看到 PC 终端。

---

## 5. 客户端设计（Android + 网页版）

### 5.1 入口与页面宿主

P0 仅 Android **完整版**的「终端」页增加入口；简版不改导航。`AiTerminalSessionsScreen` 额外观察独立 `TerminalAgentViewModel` 的列表：

- 在「已打开」之后增加「Agent 会话」区，直接渲染 `GET /api/terminal-agents` 的全部条目（provider 徽标、标题、阶段、待决策数），**它是完整数据源**。现有 `ServerTerminalRepository` 会过滤 `owner != web`，不能用普通终端列表推导 Agent 列表，否则主目标 PC 终端会消失。
- 普通终端卡保持「打开终端」原行为；若同 terminalId 有 Agent，再加「Agent 会话」快捷按钮。不要为了接力放开现有 `ServerTerminalViewModel.open()` 的 PC 限制。
- 进入终端 Tab、账号切换、从对话页返回、手动刷新时分别拉取 Agent 列表；普通终端列表与 Agent 列表各自 loading / error，不能因一个失败丢掉另一个。
- 新 `TerminalAgentSessionScreen` 持有「对话（默认）/ 终端」页签。现有 `ServerTerminalScreen` 自带头栏与返回逻辑，需抽出不含头栏的 `ServerTerminalContent` 复用，避免双顶栏。
- 在 `AiScreen` 以 `selectedAgentTerminalId` 选择新宿主，优先于普通终端分支；不需要改 `RootPage`。对话页返回只清 Agent 选中态；终端页签返回先 `leaveTerminal()` 再清 Agent 选中态，二者不能互相误清。
- P0 不做手机浏览器路由深链；React 面板入口见 §5.5。

### 5.2 对话页

- 消息区：`LazyColumn`。relay 消息直接复用 `AiHistoryMessage/AiHistoryTool` 同构模型；现有气泡与工具折叠依赖原生 AI 的 `AiAnimatedMessage`，按 `AiCodexHistory` 的方式包装 `animate=false`，或抽成 internal 通用 replay 气泡，**不要引入逐字动画状态**。`AiMarkdownContent` 同样先做消息适配。
- 顶部条：标题、模型、阶段（「正在执行 / 等待确认 / 最后活动 3 分钟前」）、刷新。无 Hook 时不编造 running。
- 输入区默认开启；`canReply=false` 禁用并显示服务端 `replyBlockedReason`。待决策按钮显示实际 `pendingDecisionCount`。
- **决策唤起协议**：保留 `TerminalBuddyRoot` 唯一 `ServerDecisionHost`，新增受控 `openRequest={decisionId, accountId?}` 与 `onRequestConsumed`，不要把页内点击伪装成 Activity 通知模型。对话页点击把当前 pendingDecisionId 经 root 传给 Host；Host 消费请求后聚焦目标卡片。目标已处理则关闭请求并提示，不永久等待。不得在对话页再实例化 Host 形成双悬浮按钮 / 双面板；账号切换立即关闭旧账号面板。
- 回复发送后本地显示「已输入到终端」，镜像出现匹配 user 消息后变「已送达」。用 `(revision, normalizedText, requestId)` 跟踪本地 pending，仅在相同 sessionId / revision 中匹配；超时提示「可能未生效，请打开终端确认」，不自动重发，也不把历史中已有的同文旧消息当送达。
- Codex 在会话页固定轻标记「Codex · 暂不支持在此确认与回复」（P0 的 `unknown` 阶段只允许只读）；不显示 token 用量。
- `mirror.available=false` 清空旧气泡、显示 reason 与「打开终端」；403 / 失权不得继续显示未授权的实时更新。409 的 `decisionId`、429 的 `Retry-After` 必须保留在 `TerminalAgentRepository` 的结构化异常中，现有仅 message 的通用请求封装不足。

### 5.3 生命周期

- 仅 Agent 宿主存在、当前是「对话」页签且 Activity 已 START 时建立镜像 WS；`ON_STOP`、离开宿主、切到终端页签都立即 `setVisible(false)`。切回对话直接重连 WS 并用首帧重建，不靠旧 socket 续传。
- `bindAccount()` 递增 generation，取消重连 / 补偿 / 发送任务，关闭 socket，清空选中会话、消息、revision、cursor 和草稿；所有回调同时校验 generation、账号、terminalId，杜绝旧账号回包污染新页面。
- 断线指数退避（1s/2s/5s/10s，上限 10s），后台 / 失权 / 终端关闭不再重连；用户可手动刷新。
- 后台通知沿用现有 `AiTaskMonitor`（决策 / 完成已经覆盖，不新增通知类型）。

### 5.4 改动文件

| 文件 | 类型 |
| --- | --- |
| `data/TerminalAgentModels.kt` | 新增：列表项 / 消息页 / 带 `type` 的 sealed WS 帧；复用历史 replay 消息结构 |
| `data/TerminalAgentRepository.kt` | 新增：REST + WS、结构化错误；`ServerAddress` 增加镜像 socket URL |
| `TerminalAgentViewModel.kt` | 新增：按账号隔离状态、generation、重连、发送、可见性 |
| `ui/TerminalAgentSessionScreen.kt` / `TerminalAgentChatScreen.kt` | 新增：双页签宿主 / 对话内容 |
| `ui/AiTerminalSessionsScreen.kt` / `ui/AiScreen.kt` | 修改：独立 Agent 列表与页面选择 |
| `ui/ServerTerminalScreen.kt` | 修改：抽可复用 Content，不改普通终端打开语义 |
| `ui/TerminalBuddyRoot.kt` / `ui/ServerDecisionHost.kt` | 修改：唯一 Host 的受控决策打开请求 |
| `ui/AiSimpleHome.kt` | 不改：P0 仅完整版 |

### 5.5 网页版（React）页面

同一份组件代码跑在两种构建里，差异只在传输层（`invoke` / `listen` 被 alias 到浏览器 shim，见 §4.10）：

| 文件 | 类型 |
| --- | --- |
| `src/services/terminalAgent.ts` | 新增：6 个命令的 typed wrapper、`onAgentUpdate`、租约与心跳管理；按 revision 处理首帧 / 增量 |
| `src/services/browser/connection.ts` | 修改：导出事件桥轻量 ping；不改变已有终端 WS 协议 |
| `src/components/terminal-agent/TerminalAgentPanel.tsx` + `.css` | 新增：列表 + 会话视图（仿 `HistoryPanel` / `ConfigNav` 外壳），`isActive` 控制订阅 |
| `src/components/terminal-agent/AgentChatView.tsx` | 新增：replay 气泡 / 工具折叠；抽一个不依赖 `filePath` 的安全 Markdown 渲染组件，不能直接复用 `MarkdownPreview` 的 props |
| `src/components/shell/ActivityBar.tsx` | 修改：`SidebarPanel` 增加 `agents` 与入口；同步处理 `lastClickRegion` 可空类型 |
| `src/App.tsx` | 修改：渲染 `TerminalAgentPanel`，沿用 `everOpened` / `isActive` 模式；不需要全局常驻 watcher |
| `src/stores/appStore.ts` | 修改：仅新增非持久化面板 / 选中会话状态；不把它混进 `config/historyPanelVisible` 的自动展开逻辑 |
| `src/components/shared/ClaudeDecisionDialog.tsx` | 修改：增加可选受控 `focusDecisionId/onFocused`；复用根节点现有唯一实例，不在面板内再弹一套 |
| `src/services/browser/core.ts` | 修改：必要时扩展结构化 invoke 错误（code、decisionId、retryAfter），其他命令行为不变 |

交互与 App 对齐：输入框默认开、禁用显示 `replyBlockedReason`、待决策置顶、Codex 只读标记、不显示 token 用量。点击待决策把 id 传给根 `ClaudeDecisionDialog` 聚焦，目标已处理要可关闭提示；不假装现有组件已支持外部打开。

「同步」的硬要求：

1. 进入具体会话才 subscribe，离开 / 面板不可见 / 页面隐藏立即 unsubscribe；React StrictMode 下清理函数必须等待已完成的 subscribe 或用 generation 防止迟到注册泄漏；
2. 以 subscribe 返回的 `initialFrame` 为原子基准，后续只接受相同 terminalId 且 revision 合法的 `terminal-agent-update`；`mirror/rotated/unavailable` 清空重建，`append` 不得重复或跨 revision 拼接；
3. 心跳同时续租与保活事件桥；断线、`web-resync`、租约丢失、JWT 失效按 §4.10 重建或进入登录态，不做盲目重发；
4. **补齐浏览器决策权限**：当前 `get_pending_claude_hook_decisions` 无 terminalId 参数，Web 调用可能枚举 PC 决策。浏览器 dispatch 该命令及回答 / 返回终端命令时，按 Web View 过滤目标终端，回答 / 返回终端要求 Input；Pc 原生行为不变。该权限修复与接力同里程碑，不能靠 UI 隐藏代替。

桌面构建中此面板同样可用，Pc 对自己终端不受 Web 共享开关影响；手机浏览器仍是 Web 身份，不能借桌面 UI 绕过共享开关。

---

## 6. 桌面端

UI 不新增专属交互（React 面板在桌面构建里与网页版同一份代码，见 §5.5），但桌面 Rust 侧有新代码：

- 新增 6 个 Tauri 命令并注册进 `desktop.rs` 的 `generate_handler![]`；Web 调用经显式 Web 适配分支；
- 两个 Hook handler 上报带 sessionId 的 `note_phase`，Pi 审批补齐 attention / running；
- watcher 通过 `crate::runtime::Emitter` 推 `terminal-agent-update`，React 租约按 §4.10 管理。

不显示「手机正在查看」之类提示（单一操作者前提，见 §2）。

---

## 7. 边界与已知风险

1. **没有逐字流式**：转录按消息落盘，所有客户端只能看到已完成的条目。盯进度够用，别承诺「实时打字机」。
2. **工具输出是摘要**：解析器只给 `name + summary`（如 `Bash · rg -n login src/`），完整 stdout 要点「终端」页。
3. **Codex P0 只读**：没有阶段事件与决策卡片，`unknown` 不允许回复；会话内标注「暂不支持在此确认与回复」。不能用最近 mtime 冒充进程存活。
4. **忙碌时的语义不可控**：Claude / Pi 可能排队或 steer。UI 用「已输入」而不是「已发送」，不做自动重发。
5. **斜杠命令/多行/图片一律拒绝**，返回明确中文原因，引导回桌面。
6. **残留绑定的风险**：用户退出 agent 回到 shell 后，绑定可能短暂残留。`ended` 与 `unknown` 均禁止写入；`ended` 保留只读镜像，真正 PTY teardown 才删除绑定、发 terminal_closed。
7. **服务端模式差异**：镜像只对「App 连接的这台服务端上活着的终端」有效。桌面 App 内置 Web API 时即本机终端；独立 Docker 服务端时是本机容器内终端，PC 上的终端不在那里。
8. **共享开关默认关闭**：`webApiShareSessions=false` 时 App 看不到桌面终端（403 并给出设置项名提示），这是既有产品合同，不因本功能放开。
9. **大文件降级**：超长 Codex rollout 会命中 `transcript_too_large`，此时只保留阶段与标题。
10. **无卡片 attention**：Claude `Notification(permission_prompt)` 可能只有阶段而没有 pending decision，此时输入同样禁用，但按钮应引导「打开终端」，不能等待永不会出现的 decisionId。
11. **旧会话事件**：同终端换绑后，旧 sessionId 的 Hook 不得改写新会话阶段、绑定或回复权限。
12. **浏览器事件桥空闲断开**：必须有心跳与重建，不是 UI 收到一次 `web-resync` 就算完成同步。
13. **写失败非确定性**：PTY writer 失败时已写字节数不可知；任何自动重试都可能重复注入。UI 明示结果未知，只允许用户确认后新建 requestId 主动重发。
14. **服务器时钟与文件 mtime**：仅用于展示和辅助判断，不能作为 Codex 可写依据；时间回拨不得绕过阶段过期或限流（内存限流用 monotonic clock）。

---

## 8. 兼容与迁移

- 无数据库迁移、无设置项新增、无数据文件新增（阶段表与幂等表都是内存态）。
- 纯新增路由与命令，旧 App 与旧网页端不受影响；`/api/terminals` 契约不变。`ApiError` 新增可选 `decisionId/replyBlockedReason` 字段向后兼容；Tauri 命令使用结构化错误。
- 现有浏览器决策命令的按终端权限过滤属于安全修正，需在本里程碑一起回归，不能以「兼容旧行为」继续暴露 PC 待决策。
- 新增 Tauri 命令后需同步：`commands/mod.rs` 导出、`desktop.rs` 的 `generate_handler![]`、`desktop_dispatch.rs` 白名单与 `check_arguments` 鉴权（§4.10）；并用 `python scripts/check-invoke-coverage.py` 验证前端调用已全部注册。REST 侧对称：`web/handlers/mod.rs` 导出、`web/server.rs` 注册路由、`services/mod.rs` 导出 relay。
- 服务重启后阶段表清空 → 列表 `phase=unknown`，App 退化显示 `lastActivityAt`。

---

## 9. 验证计划

### 9.1 单测（Rust，`cargo test --lib`）

| 用例 | 必须断言 |
| --- | --- |
| 半行 JSONL | 只读到最后换行；半条记录不出现，补齐后出现；重复损坏行不导致 revision 振荡 |
| Claude 追加 | 保留 seq 空洞，纯尾部新增为 append；cursor 是最后 seq 而非 total |
| Codex 去重重排 | event 后出现 canonical response_item 导致旧 event 消失、total 不变 → revision+1 完整 rotated |
| Pi 换枝 | 活动叶节点变化即 rotated，即使可见 role/text 恰好相同 |
| 完整消息 diff | timestamp / tools / toolName 任一变化均 rotated，不只比较 role/text；与 `SessionReplayMessage` 同步实现 `PartialEq` |
| 分页与截断 | 增量取最早 limit、hasMore/nextCursor 可追平；越过保留窗口或 revision 不同返回 resetRequired 完整尾页 |
| 换绑 / 路径变化 | 新 sessionId / 路径 / 不可用恢复均提升 revision；旧任务结果不得覆盖新快照 |
| 回复七闸门 | 逐条覆盖 §4.6，拒绝时 writer 次数为 0；无卡片 attention 与 unknown Codex 均拒绝 |
| 换行与控制字符 | `\n` 允许并走括号粘贴；`\x03` / `\t` / `\x7f` / `\r` / Unicode 控制区拒绝；中文与 emoji 放行 |
| 并发幂等 | 同 requestId 同文本并发只写一次；同键不同文本 409；写失败不自动重试、结果标未知，限流不被绕过 |
| 阶段身份 | 旧 sessionId 延迟 SessionEnd 不影响新会话；过期回退 unknown，上限淘汰 |
| 双身份 | 共享关闭时 Web 看不到 PC、Pc 仍可见；Pc 写 Web 终端在非共享下仍被拒绝 |
| watcher | 任意 session_change 不错误终止；仅目标关闭 / 失权移除对应订阅；ended 保持只读 |
| 租约 | unsubscribe 只释放指定句柄；30 秒未续租回收；重复释放幂等；慢消费者不造成无界队列 |
| 桌面 / Web 错误适配 | 404 / 403 / 409 / 429 与 decisionId / Retry-After 保留，不统一变 400 |

React 不新增测试框架，新增 `terminal-buddy/scripts/test-terminal-agent-protocol.mjs` 覆盖同步 reducer 的 mirror / append / rotated / 重复帧 / generation 处理。协议归并逻辑放在独立、无 Tauri / DOM 依赖的 `.mjs` 模块，TS 服务层以 JSDoc 类型或声明文件引用它，避免为运行 node 脚本另引 transpiler；禁止只靠手点替代协议用例。

### 9.2 端到端（阻断验收）

| 场景 | 验收 |
| --- | --- |
| Claude / Pi 镜像 | Android、浏览器、桌面 React 均显示标题、消息、工具摘要；追加与换会话不错乱 |
| Claude / Pi 回复 | 共享开启后 Web 可写；桌面 Pc 可写；终端实际收到恰好一条，忙碌时不自动重发 |
| Codex | 三端可看；P0 输入禁用且 reply 返回 409，绝不把文本写入 shell |
| 决策 | Pi 审批有 attention + 卡片；Claude 无卡片 attention 禁回复并引导终端；卡片回答后恢复 |
| 结束与关闭 | `/exit` 后 phase=ended 仍可只读；PTY 关闭才 error / 移除列表 |
| 非共享 | Web 列表消失、已有 WS 断开、reply 403；Pc 面板仍可看自己终端且写自己终端不受 Web 开关影响 |
| 断线 | Android 重连首帧重建；浏览器事件桥 >30 秒空闲不断租；web-resync / 进程重启后重新 subscribe |
| 账号与页签 | Android 切账号无旧回包，切终端页签镜像 WS 停止；返回路径不误关终端 |
| React 生命周期 | StrictMode / 快速进出面板无订阅泄漏，unsubscribe 不误删其他租约 |
| 安全边界 | 非共享下浏览器不能枚举或回答 PC 决策；终端 ID / requestId / 控制字符均按契约拒绝 |

至少各跑一轮：Windows 桌面 Tauri、浏览器连接桌面内置 Web API、Android 连接桌面服务；Docker 服务端另跑 Web-owned 终端，证明独立 headless 的 `runtime::Emitter` / EventBus 也可用。不得只验证桌面进程。

### 9.3 构建命令

```bash
cd terminal-buddy && npx tsc --noEmit              # 前端类型检查（含新增面板）
npm run build                                      # dist（桌面）
npm run build:web:desktop                          # dist-web（Docker / 浏览器）
python scripts/check-invoke-coverage.py            # 新增 Tauri 命令与前端 invoke 对齐
                                                    # （NAS 宿主无 python3 时在验证容器内执行）
cd src-tauri && cargo check && cargo test --lib
./scripts/build-android.sh                         # Docker 内 JDK 17 + SDK 36 构建 APK
```

未实际执行前，不报告编译或真机通过。

---

## 10. 决策记录

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 输入框默认开还是默认关 | **默认开**，仍受 `canReply` 与 §4.6 闸门约束 |
| 2 | Codex 会话如何提示 | **在会话页内标记**「暂不支持在此确认与回复」，列表不单列；P0 只读 |
| 3 | 是否显示 token 用量 | **不显示**（终端会话没有 `usage`，不伪造） |
| 4 | 网页版（React）是否同步该功能 | **同步**：纳入 P0，两种构建同一份代码（§4.10、§5.5） |

---

## 11. 评审记录（2026-11-01）

### 11.1 原评审（历史记录）

当时对照源码核对了 §1.1 的引用与 §4 的部分实施锚点，认为架构可行。以下为当时确认的事实，不代表本版协议已验收：

- 命令注册确在 `src-tauri/src/desktop.rs:431` 的 `generate_handler![]`（非 `lib.rs`）；
- `ClaudeHookService::list_pending_decisions()` 返回项带 `terminal_id`，按终端过滤待决策可行；
- `/ws/events` 事件桥（`desktop_handler.rs:270`）按 `payload.terminalId` 过滤，无该字段的事件会绕过过滤直发——§4.10 的警告属实且必要；
- `crate::runtime::Emitter` 是双通道（EventBus + Tauri 事件）的唯一正确发射口；
- 三家解析器统一产出 `SessionReplayMessage`（Claude 侧为类型别名），`codex_transcript` / `pi_transcript` 的 `pub(super)` 对 services 内新模块可见；
- Claude 解析器 `seq += 1` 先于行内 `continue`，seq 确有空洞，§4.3 的「单调不连续」语义正确；
- `summaries()` 确实补写 `tracked.transcript` 后回写绑定表，§4.2 的调用顺序要求成立；`bind()` 换绑会清空 transcript，`rotated` 的换绑检测与之自洽；
- `ai_chat_handler.rs:129` 已有 `max_message_size(usize::MAX)` 先例；`ApiError` 已有 `BadRequest / Conflict / TooManyRequests`（自带 `Retry-After`）；
- `write_to_terminal` 内部已自带 `authorize(Input)`（闸门第 1 条的重复检查无害）；WS 鉴权用 query `token`（与 `/ws/events` 一致）；
- 前端与 Android 引用组件（`ActivityBar` / `SidebarPanel` / `ClaudeDecisionDialog` / `appStore.*PanelVisible` 模式；`AiTerminalSessionsScreen` / `ServerTerminalScreen` / `AiAgentLogo` / `TbColors` / `AiMarkdownContent` / `ServerDecisionHost` / `AiTaskMonitor` / `ServerTerminalRepository` / `AiServerSessionsScreen`）全部存在。

评审修正（均已并入正文）：

| # | 修正 | 位置 |
| --- | --- | --- |
| 1 | 回复文本从「禁 `\r`/`\n`/ESC」收紧为「拒绝一切控制字符」——`\x03` 会经 PTY 中断 agent 进程、`\t` 触发补全，比换行更危险 | §4.6、§9.1 |
| 2 | 统一订阅/tick 生命周期：新增 per-terminal watcher + 引用计数，归零后 30 秒停（原文 §4.5「归零即退」与 §4.10「30 秒停」互相矛盾） | §4.5 |
| 3 | 补 `lastActivityAt` / `title` 的取值定义；点名 `AgentSessionRecord.updated_at` 恒为读取时刻、不可用 | §4.2 |
| 4 | 补 `locate_transcript` 封装要求：`find_transcript` / `TrackedTerminal` 均为模块私有，relay 不直接伸手 | §4.3 |
| 5 | 补「发事件必须用 `crate::runtime::Emitter`」：照抄 `desktop.rs` 的 `tauri::Emitter` 会让浏览器端静默收不到推送 | §4.10 |
| 6 | 补 `check_arguments` 对 `terminal_agent_reply` 的 `Input` 特判与 REST 路由注册位置（`web/server.rs`） | §4.9、§4.10 |
| 7 | 补首帧 `mirror`/`unavailable` 二选一、WS 全局配额（50 条，与现有通道共享）、`error` 帧的触发源 | §4.5 |
| 8 | 常量名修正（`INDEX_BATCH_FILES`）；网页版事件桥重连后的补偿拉取；`python` 在 NAS 宿主不可用时进容器执行 | §1.2、§5.5、§9.3 |

### 11.2 本次复审结论与修正（已并入正文）

**审批结论：按本版方案可以进入实施。** 代码事实复核覆盖终端权限矩阵、绑定 / 转录定位、三家解析器、Hook / 决策、双运行时 Emitter、桌面命令 Web 分发、事件桥、React 面板与 Android 页面宿主。复审没有运行编译或真机测试。

| # | 原稿缺口 / 错误 | 本版约束 |
| --- | --- | --- |
| 1 | 原 Tauri + Web 命令共用 Web actor，桌面看不到 PC 终端；直接 dispatch Pc 命令又会越权 | 显式 Pc / Web 双入口、共享 use case、逐订阅鉴权（§4.2、§4.5、§4.9、§4.10） |
| 2 | `cursor=total` 遇到 Claude seq 空洞会永久漏消息；截断与增量超页未定义 | cursor 为最后 seq；hasMore / nextCursor / resetRequired / oldestRetainedSeq 完整定义（§3、§4.4） |
| 3 | Codex 去重重排、Pi 换枝使「追加不影响 seq」不成立；diff 漏工具 / 时间字段 | 完整消息比较 + revision + 全量 rotated 快照，补反例测试（§4.3、§9.1） |
| 4 | REST 补偿遇换代可能保留旧消息，REST→WS 有竞态 | 首帧原子快照，重建代次比较，REST 不再作为 WS 前置条件（§4.4–§4.5） |
| 5 | 摘要开关关闭时 relay 发现为空 | 复用独立 PID 路径，禁止经 `get_terminal_task_summaries`（§4.2） |
| 6 | phase 无 sessionId，旧 SessionEnd 污染新会话；Pi 审批不进入 attention；无卡片 attention 可回复 | 原子绑定条件、sessionId 阶段键、Pi 审批补阶段、attention 一律禁写（§4.6–§4.7） |
| 7 | `session_change_tx` 被误当目标关闭；ended 与 terminal_closed 混淆 | 广播仅唤醒；ended 保留只读，PTY teardown 才关闭（§4.5） |
| 8 | 无身份计数 / ±1 会在 React 重渲染泄漏或误退订；事件桥 30 秒无消息即断 | subscriptionId 租约 + heartbeat + 事件桥 ping + 重建（§4.10） |
| 9 | `canReply=false` 无原因，409 decisionId / 429 Retry-After 在命令和客户端丢失 | `replyBlockedReason`、结构化错误、HTTP / Tauri 适配（§4.2、§4.8、§5.2、§5.5） |
| 10 | App 现有终端列表过滤 PC，导致主目标无入口；没有双页签宿主 / 决策受控打开协议 | 独立 Agent 列表、完整版 AiScreen 宿主、抽 Terminal Content、根 Host 受控唤起（§5.1–§5.4） |
| 11 | 「复用现有 Markdown / 决策弹窗」忽略 props 与私有气泡依赖 | 明确 replay 适配、无 filePath 的 Markdown 组件与受控决策聚焦（§5.2、§5.5） |
| 12 | mtime 无法证明 Codex 前台存活，写入可能落 shell | **P0 Codex 只读**；等待可靠存活确认后再开放（§4.6、§7） |
| 13 | 浏览器现有决策命令未按终端做 Web 权限过滤 | 同里程碑补 View / Input 授权，不靠隐藏 UI（§5.5、§9.2） |
| 14 | 幂等占位、同键不同文本、PTY 写失败语义不完整 | per-terminal 串行占位；写失败标未知，不自动重试（§4.6、§9.1） |

**实施顺序（阻断依赖）**：① 统一模型 / actor / 错误 → ② 绑定与独立发现 → ③ 快照 diff / 分页 / watcher → ④ 回复与阶段 / 决策 → ⑤ 6 命令与浏览器租约 → ⑥ React / Android 页面 → ⑦ §9 全部验证。每一步不得绕过前序权限与协议约束先做 UI 假数据。

### 11.3 变更记录：unknown 放行与阶段推断（2026-11-04）

用户反馈：App 打开服务端会话时提示「无法确认 Agent 是否仍在终端前台运行」，但终端实际显示正常。按用户决定放宽 §4.6 第 7 条与 §11.2 第 12 条的 P0 保守策略：

- **unknown 一律放行回复**：会话出现在列表里即表示发现链（PID + `/proc` 进程扫描）已确认 agent 进程仍在该终端内运行，「无 Hook 上报」不再作为禁回理由（Codex、手动启动的 Claude、服务重启后均可回复）。
- **阶段推断（同步状态）**：阶段表无记录时按镜像尾条推断——最后一条是用户消息 → `running`（Agent 正在处理），否则 → `idle`（等待输入）；`phaseAt` 取尾条时间戳或转录 mtime。推断值不写入阶段表，Hook 恢复上报后自动被真实值取代。
- **idle 闲置 24 小时判定**只在 Hook 上报过真实时间戳时生效；推断路径无时间戳视为存活。
- `ended` / `attention` / 待决策的禁回语义不变；「残留绑定写入落 shell」的残余风险由用户接受（§11.2 第 12 条原文保留作历史记录）。
- 同步变更：Android 会话页 Codex 轻标记改为「回复将作为一行输入写入终端」；App 列表（简版首页 + 完整版终端页）新增长按关闭服务端 Agent（`DELETE /api/terminals/{id}`，关闭承载会话的终端）。
