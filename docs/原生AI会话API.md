# 原生 AI 会话 API

为葫芦娃 Android「Ai」页提供结构化 Claude / Codex 消息。复用现有 Web API 登录、JWT 及已登记项目范围；不依赖浏览器、xterm.js 或 PTY 屏幕解析。

## 运行方式

- Claude：每回合启动 `claude -p --output-format stream-json --verbose --include-partial-messages`，文本通过 stdin 输入，后续回合使用 `--resume` 保留上下文。
- Codex：启动 `codex app-server`，通过 stdio JSON-RPC 完成初始化、thread 创建/恢复和 turn 提交，解析消息增量、工具执行、确认请求及完成事件。
- `GET /api/ai/catalog` 汇总服务器 Claude 通用供应商、容器 Claude 配置及 Codex 供应商的可用模型，供手机首页选择；目录不包含密钥。
- 创建会话可指定 `providerId` 与模型；服务端保存所选供应商名称及标识。Claude 通过受限权限的临时 settings 应用对应地址、认证和模型配置，回合退出后删除；Codex 复用供应商注册与参数生成，按会话选择供应商与模型，不改变全局默认供应商。
- 不指定供应商时保持旧版 CLI 默认配置行为；显式选择的供应商或模型失效时提示重新选择，不静默回退。
- CLI 不在服务进程 PATH 中时，可通过 `TERMINAL_BUDDY_CLAUDE_BIN` / `TERMINAL_BUDDY_CODEX_BIN` 指定可执行文件绝对路径；同时会尝试用户的 `.local/bin`。
- 会话在数据目录 `AiSessions/*.json` 私有文件中保存，每回合开始/结束及运行中的定期检查点采用原子写入。服务重启后未完成任务显示为中断。
- 原生 AI 会话独立于现有 PC/Web PTY 终端；不会自动控制正在桌面终端里运行的 AI。
- 摘要标题复用 CLI 已有标题来源。列表、详情与 WebSocket 都会刷新，每个会话最多每 2 秒检查一次，回合结束强制检查；标题变化后原子保存并增加 `revision`，保持 `updatedAt` 不变。Android 首页可见时每 3 秒静默同步列表，对话页通过 WebSocket 接收标题变化，退到后台停止同步。

Claude print 模式由服务器原有权限配置决定可使用哪些工具，拒绝的操作会显示为消息。Codex 命令执行、文件修改确认与用户问题通过原生消息 API 回答；未支持的交互请求会返回明确协议错误，不自动批准。

## Agent 权限参数

原生 AI 会话读取服务端 `settings.json` 的 `agentCommands.claude` / `agentCommands.codex`，继承基础命令中的权限选项。每回合重新读取设置，新建与恢复已有会话均生效；供应商、模型和结构化输入输出仍由原生会话服务管理。

- 配置留空时与桌面端默认值一致：Claude 使用 `--dangerously-skip-permissions`；Codex 使用 `--dangerously-bypass-approvals-and-sandbox` 对应的免审批、完整访问策略。
- 显式填写命令时以该命令为准，不额外加默认免确认参数。Claude 支持继承 `--permission-mode`、`--dangerously-skip-permissions`、`--allow-dangerously-skip-permissions`、`--allowedTools` / `--allowed-tools`、`--disallowedTools` / `--disallowed-tools` 和 `--tools`。
- Codex 将 `--yolo` / `--dangerously-bypass-approvals-and-sandbox`、`--ask-for-approval` / `-a`、`--sandbox` / `-s`、旧版 `--full-auto` 及 `-c` / `--config` 中的审批/沙箱设置转换成 App Server 配置。
- Codex 的 `thread/start` 与 `thread/resume` 显式传入所配置的 `approvalPolicy` / `sandbox`，`turn/start` 同样传入审批策略；workspace-write 的目录和网络设置沿用线程有效配置。
- 配置中明确要求确认时，保留原生确认卡片；AI 主动询问用户的问题仍由用户回答。基础命令中的 shell 串联命令不会由原生服务执行。

例如，保留项目沙箱且不逐次询问可配置 `codex --ask-for-approval never --sandbox workspace-write`；希望按需确认可配置 `codex --ask-for-approval on-request --sandbox workspace-write`。

该修复仅涉及 TerminalBuddy 服务端。更新并重启服务后，已有会话下一次发送消息时会应用新的启动策略，无需重新创建对话或重装安卓 App。

## REST 与 WebSocket

REST 均要求现有 `ClaimsFromRequest` 鉴权，会话按登录用户名隔离。创建会话与每次发送消息都复核项目是否在登记范围内；执行进程直接以该项目为 cwd。

| 路径 | 请求 |
| --- | --- |
| `GET /api/ai/catalog` | 供应商列表：`id`、`agent`、`name`、`isDefault`、可用 `models` |
| `GET /api/ai/sessions` | 列表，不附带完整消息 |
| `POST /api/ai/sessions` | `{ "provider": "claude", "providerId": "llm:供应商UUID", "projectPath": "/workspace/project", "model": "已配置模型" }` |
| `GET /api/ai/sessions/{id}` | 读取完整会话 |
| `POST /api/ai/sessions/{id}/messages` | `{ "text": "用户消息", "requestId": "UUID" }` |
| `POST /api/ai/sessions/{id}/stop` | 中断执行 |
| `POST /api/ai/sessions/{id}/approvals` | `{ "approvalId": "...", "decision": "accept 或 decline", "answers": {} }` |
| `DELETE /api/ai/sessions/{id}` | 删除空闲会话 |
| `/ws/ai/{id}?token=...` | 实时状态与消息 |

提交消息立即返回，CLI 在专用工作线程执行。`requestId` 持久化去重，避免网络超时后重试产生重复回合。同一会话互斥，服务器最多同时执行 4 个任务。单条用户输入上限 64 KiB，会话消息文本总量有界。

消息字段为 `id`、`role`（`user` / `assistant` / `tool`）、`text`、`createdAt`；会话还包含状态、模型、项目、确认请求、错误及单调递增 revision。会话还返回非敏感的 `providerId`、`providerName`，供首页历史项和二级页面展示来源；旧会话这两个字段默认为空。内部 thread ID、归属账户和请求去重信息不会返回客户端。

WebSocket 首帧为 `{ "type": "session", "session": ... }`，之后为 `{ "type": "update", "session": "不含历史消息的会话对象", "messages": ["新增或变更的完整消息对象"] }`。客户端按消息 ID 更新有序列表；重连重新获取首帧，REST 可用于补偿。连接沿用全局配额，含 Ping/Pong、认证复核及超时回收。

## 会话用量 `usage`

`AiSession` 新增可选 `usage`，通过现有 REST 会话对象及 WebSocket 元数据返回。旧会话未采集时为 `null`，新增会话累计输入 / 输出初始为 0。所有未知计数为 `null`，不使用 0 冒充未提供的数据。

```json
{
  "usage": {
    "context": {
      "usedTokens": 48000,
      "windowTokens": 200000,
      "basis": "input",
      "usedSource": "cliUsage",
      "windowSource": "cli",
      "updating": false
    },
    "lastTurn": {
      "inputTokens": 52000,
      "outputTokens": 1200,
      "cacheReadInputTokens": 40000,
      "cacheCreationInputTokens": 0,
      "reasoningOutputTokens": null,
      "state": "final"
    },
    "sessionTotal": {
      "inputTokens": 186000,
      "outputTokens": 9200,
      "cacheReadInputTokens": 140000,
      "cacheCreationInputTokens": 0,
      "reasoningOutputTokens": null,
      "coverage": "complete"
    }
  }
}
```

- `context` 仅描述主对话最近一次模型调用。Claude 的 `basis=input`，计入原始输入、缓存读与缓存写，不加输出；子 Agent 的独立窗口不覆盖主窗口。Codex 从 `thread/tokenUsage/updated` 的 `last` 推导输入与输出之和，`basis=inputAndOutput`、`usedSource=calculated`，在客户端标记估算。`windowSource=cli` 表示运行时报告，`configuration` 表示启动时生效的配置。没有可信窗口时保留 `null`，不按模型名称写死容量。
- 压缩通知会清空 `usedTokens` 并设 `updating=true`，后续用量再填充；会话累计不清零。`usedTokens / windowTokens` 可以用于显示百分比，只有两个值均有效时才计算。
- `lastTurn` 描述最近一次用户发送触发的整轮执行，包含多次模型调用。`state=provisional` 表示执行中，`final` 表示已收到完整统计，`partial` 表示缺少完整结算。尚未发送时为 `null`。
- `sessionTotal` 表示累计消耗；`coverage=complete` 为完整统计，`sinceUpgrade` 为旧会话从升级后开始统计，`partial` 为包含不完整或无法确定起点的统计。停止、异常或服务重启会将未完成统计标记为部分统计。
- 对外 `inputTokens` 已包含缓存，`cacheReadInputTokens` / `cacheCreationInputTokens` 为其中的明细；Codex 的 `reasoningOutputTokens` 也是输出的组成部分，不能再叠加。
- Claude 按 API 消息 ID 合并流式 / 完整消息用量，最终 `result.usage` 或 `modelUsage` 替换本轮快照。Codex 按线程累计快照减去回合基线，恢复线程不会重复加上历史累计。最终完成事件后最多等待 300ms 接收紧随其后的用量通知。
- 统计和 Codex 恢复基线一起保存在 `AiSessions/*.json`，基线字段不返回客户端。仅用量变化也增加 `revision`，现有 WebSocket 和 REST 补偿可以直接同步，无需额外接口。

### 安卓悬浮卡片展示

安卓客户端在二级对话页输入框上方以一体化轻卡片展示用量：上层 11~12sp 显示 Agent 图标、模型与思考强度；下层为「上下文 / 进度条 / `26%(250K/950K)`」及输入、输出 token。统计统一使用十进制 K（1K = 1000 token），未上报显示 `—K`；`updating=true` 期间显示 `更新中(...)`，不显示旧占用率。输入 / 输出优先取 `lastTurn`，回合尚未开始时回退 `sessionTotal`。顶部标题栏保持单行对话标题。

### 模型与思考强度匹配

模型名与思考强度按会话 `provider` + `providerId` + `model` 匹配 `GET /api/ai/catalog` 的 `providers[].models[]`：模型名取目录 `label`，未命中回退会话 `modelLabel`；思考强度读 `models[].effort`，中文映射支持 关闭（none）/ 自动（auto）/ 跟随服务端（default）/ 极低 / 低 / 中 / 高 / 很高 / 最高 / 极高（ultra），未提供或未命中时显示「跟随服务端」。仅作展示，供应商与模型的选择仍由首页配置负责。新建会话的本地壳会预置零值 `usage`，首次发送前即可显示 0K。

## 源码

- `src-tauri/src/models/ai_chat.rs`：结构化数据模型。
- `src-tauri/src/services/ai_permission_service.rs`：继承 Agent 基础命令中的权限参数，并映射到原生 CLI / App Server。
- `src-tauri/src/services/ai_catalog_service.rs`：供应商目录与按会话准备的启动配置。
- `src-tauri/src/services/ai_chat_service.rs`：会话持久化、进程生命周期、Claude/Codex 协议适配。
- `src-tauri/src/services/ai_chat_usage.rs`：用量归一化、消息快照合并、累计基线及上下文压缩状态。
- `src-tauri/src/web/handlers/ai_chat_handler.rs`：REST 和 WebSocket；磁盘及任务启动操作均通过 `spawn_blocking`。
- `src-tauri/src/web/server.rs`：HTTP/WS 路由注册。

协议参考：[OpenAI Docs：Codex App Server](https://developers.openai.com/codex/app-server/)、[Claude Agent SDK 流式输出](https://platform.claude.com/docs/en/agent-sdk/streaming-output)。
