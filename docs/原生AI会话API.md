# 原生 AI 会话 API

为葫芦娃 Android「Ai」页提供结构化 Claude / Codex 消息。复用现有 Web API 登录、JWT 及已登记项目范围；不依赖浏览器、xterm.js 或 PTY 屏幕解析。

## 运行方式

- Claude：每回合启动 `claude -p --output-format stream-json --verbose --include-partial-messages`，文本通过 stdin 输入，后续回合使用 `--resume` 保留上下文。
- Codex：启动 `codex app-server`，通过 stdio JSON-RPC 完成初始化、thread 创建/恢复和 turn 提交，解析消息增量、工具执行、确认请求及完成事件。
- 使用服务器账户已有的 CLI 登录、模型供应商配置和工具权限；可在创建会话时指定模型。
- CLI 不在服务进程 PATH 中时，可通过 `TERMINAL_BUDDY_CLAUDE_BIN` / `TERMINAL_BUDDY_CODEX_BIN` 指定可执行文件绝对路径；同时会尝试用户的 `.local/bin`。
- 会话在数据目录 `AiSessions/*.json` 私有文件中保存，每回合开始/结束及运行中的定期检查点采用原子写入。服务重启后未完成任务显示为中断。
- 原生 AI 会话独立于现有 PC/Web PTY 终端；不会自动控制正在桌面终端里运行的 AI。

Claude print 模式由服务器原有权限配置决定可使用哪些工具，拒绝的操作会显示为消息。Codex 命令执行、文件修改确认与用户问题通过原生消息 API 回答；未支持的交互请求会返回明确协议错误，不自动批准。

## REST 与 WebSocket

REST 均要求现有 `ClaimsFromRequest` 鉴权，会话按登录用户名隔离。创建会话与每次发送消息都复核项目是否在登记范围内；执行进程直接以该项目为 cwd。

| 路径 | 请求 |
| --- | --- |
| `GET /api/ai/sessions` | 列表，不附带完整消息 |
| `POST /api/ai/sessions` | `{ "provider": "claude", "projectPath": "/workspace/project", "model": "可选" }` |
| `GET /api/ai/sessions/{id}` | 读取完整会话 |
| `POST /api/ai/sessions/{id}/messages` | `{ "text": "用户消息", "requestId": "UUID" }` |
| `POST /api/ai/sessions/{id}/stop` | 中断执行 |
| `POST /api/ai/sessions/{id}/approvals` | `{ "approvalId": "...", "decision": "accept 或 decline", "answers": {} }` |
| `DELETE /api/ai/sessions/{id}` | 删除空闲会话 |
| `/ws/ai/{id}?token=...` | 实时状态与消息 |

提交消息立即返回，CLI 在专用工作线程执行。`requestId` 持久化去重，避免网络超时后重试产生重复回合。同一会话互斥，服务器最多同时执行 4 个任务。单条用户输入上限 64 KiB，会话消息文本总量有界。

消息字段为 `id`、`role`（`user` / `assistant` / `tool`）、`text`、`createdAt`；会话还包含状态、模型、项目、确认请求、错误及单调递增 revision。内部 thread ID、归属账户和请求去重信息不会返回客户端。

WebSocket 首帧为 `{ "type": "session", "session": ... }`，之后为 `{ "type": "update", "session": "不含历史消息的会话对象", "messages": ["新增或变更的完整消息对象"] }`。客户端按消息 ID 更新有序列表；重连重新获取首帧，REST 可用于补偿。连接沿用全局配额，含 Ping/Pong、认证复核及超时回收。

## 源码

- `src-tauri/src/models/ai_chat.rs`：结构化数据模型。
- `src-tauri/src/services/ai_chat_service.rs`：会话持久化、进程生命周期、Claude/Codex 协议适配。
- `src-tauri/src/web/handlers/ai_chat_handler.rs`：REST 和 WebSocket；磁盘及任务启动操作均通过 `spawn_blocking`。
- `src-tauri/src/web/server.rs`：HTTP/WS 路由注册。

协议参考：[OpenAI Docs：Codex App Server](https://developers.openai.com/codex/app-server/)、[Claude Agent SDK 流式输出](https://platform.claude.com/docs/en/agent-sdk/streaming-output)。
