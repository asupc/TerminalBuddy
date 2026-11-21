# 原生 AI 会话 API

为葫芦娃 Android「Ai」页提供结构化 Claude / Codex 消息。复用现有 Web API 登录、JWT 及已登记项目范围；不依赖浏览器、xterm.js 或 PTY 屏幕解析。

## 运行方式

- Claude：会话首次执行时启动 `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`，用户消息以 JSON 行写入 stdin。回合结束后**保持 stdin 与进程存活**：排队消息在当前回合任务（含后台任务与待确认请求）全部结算后直接写入同一个进程，不需要重启或 `--resume`；只在服务重启、历史恢复或中断/异常后的冷启动使用 `--resume`。运行中插话同样写入该 stdin，由 CLI 自行选择接收节点。空闲会话删除或服务退出时回收进程树。
- Codex：每个会话复用一个驻留的 `codex app-server`，通过 stdio JSON-RPC 完成初始化、thread 创建/恢复和 turn 提交。`turn/completed` 仅结束主回合，保留进程继续接收后台命令、子代理和自动唤醒回合的事件；后续用户消息送入同一进程，避免恢复历史时丢失仍在运行的任务。中断、删除会话和服务退出时回收进程树，删除后的迟到事件不能重建会话文件。
- `GET /api/ai/catalog` 汇总服务器 Claude 通用供应商、容器 Claude 配置及 Codex 供应商的可用模型，供手机首页选择；目录不包含密钥。
- 创建会话可指定 `providerId` 与模型；服务端保存所选供应商名称及标识。Claude 通过受限权限的临时 settings 应用对应地址、认证和模型配置，CLI 进程退出后删除；Codex 复用供应商注册与参数生成，按会话选择供应商与模型，不改变全局默认供应商。
- 不指定供应商时保持旧版 CLI 默认配置行为；显式选择的供应商或模型失效时提示重新选择，不静默回退。
- CLI 不在服务进程 PATH 中时，可通过 `TERMINAL_BUDDY_CLAUDE_BIN` / `TERMINAL_BUDDY_CODEX_BIN` 指定可执行文件绝对路径；同时会尝试用户的 `.local/bin`。
- 会话在数据目录 `AiSessions/*.json` 私有文件中保存，每回合开始/结束及运行中的定期检查点采用原子写入。服务重启后未完成任务显示为中断。
- 原生 AI 会话独立于现有 PC/Web PTY 终端；不会自动控制正在桌面终端里运行的 AI。
- 摘要标题复用 CLI 已有标题来源。列表、详情与 WebSocket 都会刷新，每个会话最多每 2 秒检查一次，回合结束强制检查；标题变化后原子保存并增加 `revision`，保持 `updatedAt` 不变。Android 首页可见时每 3 秒静默同步列表，对话页通过 WebSocket 接收标题变化，退到后台停止同步。

Claude print 模式继承服务器原有权限配置。用户决策与桌面模型终端复用相同的临时 HTTP Hook：`AskUserQuestion` → `PreToolUse` → 本机 `/api/claude/hooks` → 等待手机选择 → `updatedInput.answers` 回填；`--permission-prompt-tool stdio` 继续承担普通工具授权，授权结果写回 `control_response`。两类请求均通过会话 `approvals` 同步到手机，拒绝的操作会显示为消息。后台任务状态优先使用 CLI 的 `background_tasks_changed` 完整快照，兼容旧版 `task_started` / `task_notification` 事件，任务进度和完成摘要同步为工具消息；CLI 提前退出且仍有未完成任务时明确报错，不显示正常完成。Claude 用户问题、工具授权及 Codex 命令执行、文件修改确认与用户问题均通过原生消息 API 回答；未支持的交互请求会返回明确协议错误，不自动批准。

## Agent 权限参数

原生 AI 会话读取服务端 `settings.json` 的 `agentCommands.claude` / `agentCommands.codex`，继承基础命令中的权限选项。每回合重新读取设置，新建与恢复已有会话均生效；供应商、模型和结构化输入输出仍由原生会话服务管理。

- 配置留空时与桌面端默认值一致：Claude 使用 `--dangerously-skip-permissions`；Codex 使用 `--dangerously-bypass-approvals-and-sandbox` 对应的免审批、完整访问策略。
- 显式填写命令时以该命令为准，不额外加默认免确认参数。Claude 支持继承 `--permission-mode`、`--dangerously-skip-permissions`、`--allow-dangerously-skip-permissions`、`--allowedTools` / `--allowed-tools`、`--disallowedTools` / `--disallowed-tools` 和 `--tools`。
- 基础命令处于 `bypassPermissions`（`--dangerously-skip-permissions` 或 `--permission-mode bypassPermissions`）时，原生会话额外禁用 `EnterPlanMode`。计划模式会在 bypass 之上重新为 `WebFetch`、`WebSearch`、`Bash` 等工具发起授权请求，而聊天界面没有终端提示，模型自行进入计划模式会表现为反复弹出「需要授权：WebFetch」。
- Codex 将 `--yolo` / `--dangerously-bypass-approvals-and-sandbox`、`--ask-for-approval` / `-a`、`--sandbox` / `-s`、旧版 `--full-auto` 及 `-c` / `--config` 中的审批/沙箱设置转换成 App Server 配置。
- Codex 的 `thread/start` 与 `thread/resume` 显式传入所配置的 `approvalPolicy` / `sandbox`，`turn/start` 同样传入审批策略；workspace-write 的目录和网络设置沿用线程有效配置。
- 配置中明确要求确认时，保留原生确认卡片；AI 主动询问用户的问题仍由用户回答。基础命令中的 shell 串联命令不会由原生服务执行。

例如，保留项目沙箱且不逐次询问可配置 `codex --ask-for-approval never --sandbox workspace-write`；希望按需确认可配置 `codex --ask-for-approval on-request --sandbox workspace-write`。

权限参数的继承在服务端生效，更新并重启服务后，已有会话下一次发送消息时会应用新的启动策略。安卓决策卡片的多选、自定义回答和选项说明需要同步更新安卓 App。

## REST 与 WebSocket

REST 均要求现有 `ClaimsFromRequest` 鉴权，会话按登录用户名隔离。创建会话与每次发送消息都复核项目是否在登记范围内；执行进程直接以该项目为 cwd。

| 路径 | 请求 |
| --- | --- |
| `GET /api/ai/catalog` | 供应商列表：`id`、`agent`、`name`、`isDefault`、可用 `models` |
| `GET /api/ai/history?agent=claude` | CLI 历史会话列表（可选 `projectDir`、`includeArchived`），三种 Agent 共用同一结构，与 PC 端历史面板共享索引 |
| `POST /api/ai/history/rescan?agent=claude` | 展开历史列表前的增量索引，剩余由服务端后台补齐 |
| `GET /api/ai/sessions` | 列表，不附带完整消息 |
| `POST /api/ai/sessions` | `{ "provider": "claude", "providerId": "llm:供应商UUID", "projectPath": "/workspace/project", "model": "已配置模型" }`；可选 `resumeSessionId` 恢复 CLI 历史会话——项目以历史所在目录为准，预填最近 300 条消息，Claude/Codex/Pi 分别经 `--resume` / `thread/resume` / 会话文件复用续接，重复恢复同一历史线程返回已有会话 |
| `GET /api/ai/sessions/{id}` | 读取完整会话 |
| `POST /api/ai/sessions/{id}/messages` | `{ "text": "用户消息", "requestId": "UUID", "steer": false }`；`steer` 为「原生插话」：回复进行中发送时把消息直接交给运行中的 CLI 进程，由它选择合适节点接收；默认排队，等当前回合任务完成后由服务端写入同一个 CLI 进程 |
| `POST /api/ai/sessions/{id}/flush` | `{ "requestId": "可选，指定要插话的排队消息" }`——把该消息直接交给运行中的 CLI 进程；worker 已退出（中断/出错后队列保留）时按选中消息启动新回合 |
| `PATCH /api/ai/sessions/{id}/pending/{requestId}` | `{ "text": "修改后的消息" }`——原地编辑尚未发送的排队消息，保留请求标识和队列顺序，返回最新会话；空白消息或已出队的消息拒绝修改 |
| `DELETE /api/ai/sessions/{id}/pending/{requestId}` | 删除尚未发送的排队消息并返回最新会话，保留请求去重记录，避免旧发送请求重试时重新入队；已出队的消息拒绝删除 |
| `POST /api/ai/sessions/{id}/stop` | 请求中断执行：向 worker 发送停止信号，等待 CLI 收尾 |
| `POST /api/ai/sessions/{id}/force-stop` | 强制结束：立即摘除旧 worker、终止整棵进程树并清空审批与排队消息，返回 `status=forceStopped` 的最新会话；旧 worker 迟到退出不会覆盖状态，下一条消息会新建续接回合 |
| `POST /api/ai/sessions/{id}/approvals` | `{ "approvalId": "...", "decision": "accept 或 decline", "answers": {} }` |
| `DELETE /api/ai/sessions/{id}` | 删除空闲会话 |
| `/ws/ai/{id}?token=...` | 实时状态与消息 |

提交消息立即返回，CLI 在专用工作线程执行。`requestId` 持久化去重，避免网络中断后重试产生重复回合。回复进行中发送的消息默认进入服务端排队（`pendingInputs`，随会话快照同步给客户端），当前回合任务（含后台任务与待确认请求）全部结束后按序写入同一个 CLI 进程续发，不重启进程也不需要 `--resume`；「原生插话」（`steer` 或 flush 接口）把消息直接交给运行中的 CLI 进程，由 CLI 选择接收节点，不打断当前任务——中断/出错后保留的队列在用户下次发送或 flush 时按序带出。同一会话由单个工作线程串行处理输入；Codex 主回合结束但仍有后台工作时返回 `background` 状态，允许发送“继续”等补充消息，并保留中断能力。后台命令按条目状态更新，子代理结合协作事件、线程通知与只读状态查询更新，不把子线程结束误判为主回合完成；新的主回合切换事件过滤标识，上一回合的已知后台命令仍可回传输出。不同会话的任务不设并发配额。应用不限制会话数量、每会话消息数量、用户输入长度、回复及工具输出长度、CLI 单行输出长度或任务运行时长，正文和错误输出均完整记录。标题预览不影响消息正文。

安卓对话页的排队消息以单行省略展示，每条右侧依次提供删除按钮和发送箭头，点击删除后不再自动发送。队列操作与 worker 出队串行，若消息已开始执行则拒绝编辑或删除，不影响已发送的正文。更改持久化后通过会话 revision 和实时快照同步。安卓对话页的「对话操作」提供「强制结束会话」，二次确认后调用强制结束接口；普通「中断回复」仍保留在输入框。

AI REST 接口不使用普通 API 的请求正文大小和处理超时限制；安卓 AI 请求及实时流也不设固定连接、读写或调用超时。模型及供应商自身的上下文窗口、输出能力、额度和限流仍以其实际支持为准。

消息字段为 `id`、`role`（`user` / `assistant` / `tool`）、`text`、`createdAt`；会话还包含状态、模型、项目、确认请求、错误及单调递增 revision。会话还返回非敏感的 `providerId`、`providerName`，供首页历史项和二级页面展示来源；旧会话这两个字段默认为空。内部 thread ID、归属账户和请求去重信息不会返回客户端。

会话元数据额外返回 `desktopOpen`：桌面端当前是否打开着该会话。它由桌面端标签页变化时通过本地命令整体上报，只保存在服务进程内存中，不写入会话文件，服务重启后清空；安卓简版首页的「已打开」据此展示与电脑端一致的原生会话（再加上手机本次运行打开过的会话），不再依赖手机本地「曾经点开过」的持久记录。

消息还带可选的 `todo`（布尔）标记：`TodoWrite` 的工具调用与其 `tool_result` 置为 `true`，正文仍保留原始 `TodoWrite\n{input JSON}` 供历史恢复回填清单，客户端渲染时应跳过这类消息（清单由会话级 `todos` 呈现）。

会话新增三个可选字段（值为空时不序列化，旧会话与非 Claude 会话自然缺省）：

- `todos`：当前任务清单，数组，元素为 `{ content, status, activeForm? }`，`status ∈ pending | in_progress | completed`。数据来自 Claude 的两条工具路径，规则不同：
  - `TodoWrite`（全量快照）：每次调用**整体替换**清单，不叠加；
  - `TaskCreate` / `TaskUpdate` / `TaskList`（增量）：`TaskCreate` 在结果行 `Task #N created successfully: 标题` 到达时按编号插入，`TaskUpdate` 按 `taskId` 改字段，`TaskList` 的 `#N [status] 标题` 多行结果整表校准。编号即清单序号（从 1 起）。

  这两组工具在 Claude Code 2.1.x 默认关闭（`system/init.tools` 里没有它们，模型会明确回答"工具不存在"），原生会话在 `--settings` 临时配置里默认打开 `CLAUDE_CODE_ENABLE_TODO_TOOLS` / `CLAUDE_CODE_ENABLE_TASKS`；用户已在同一位置显式配置的值不会被覆盖。历史恢复时按最后一条 `TodoWrite` 快照或重放 `Task*` 序列回填，解析失败静默跳过。上一轮任务结束、进入新回合时清单清空。
- `agents`：本轮派发过的子代理，数组，元素为 `{ taskId, toolUseId?, name, model?, description?, status, taskType?, background, parentTaskId?, depth, startedAt, endedAt?, summary?, durationMs?, toolUses? }`，`status ∈ running | completed | failed | stopped | killed | paused`。`taskType` 是 CLI 的任务类型（子代理为 `local_agent` 等）；`model` 由该任务事件携带时才有值，缺失时客户端只展示名称与耗时。

`agents` 由 Claude 的 `system/task_started`、`task_updated`、`task_notification` 与 `background_tasks_changed` 快照维护：以快照做校准（快照中消失的条目置 `stopped` 而非删除），`run_id` 字典序更小的迟到帧直接丢弃，终态不回退。`ambient`（内部杂务）、`skip_transcript` 条目，以及**后台命令**（`task_type = local_bash` / `background_shell`，例如后台运行的 Bash 命令——CLI 对它们下发同构的 `task_*` 事件，但它们不产生任何子代理消息）都不进 `agents`；`awaited` 条目进 `agents`，但不计入「后台任务未完成」的回合结束判定。`toolUseId` 与消息的 `subagentKey`（`{turn}:{parent_tool_use_id}`）后半段相同，客户端据此筛选该子代理的完整过程。上一轮任务结束、会话中断、服务重启或进程退出时，仍在 `running` 的条目标为终态，不会残留「执行中」。子代理工具在 CLI 2.1.x 起由 `Task` 改名为 `Agent`，后端两代名字都识别；加载旧会话时会把历史里被误记成子代理的后台命令一并清理。这两组字段只随会话文件存活，不跨会话共享；Codex 会话当前不产生 `agents`。
- `thinking`：主线程当前思考的实时快照，`{ text, startedAt, updatedAt, active, blocks, totalChars }`，无思考时为 `null`。
  它回答的是长回合里「模型到底在干什么」：Claude 的 `stream_event` 会持续下发 `thinking_delta`，**此前后端直接丢弃**，实测一个会话第一轮就有 164 段思考、42 万字，前 28 分钟没有一行正文，界面上只剩一个「已等待 N 秒」的呼吸灯。现在这些增量累积进 `thinking.text`，客户端据此在「思考中」状态行里滚动显示最新一句、可展开看全文。

  三条边界必须遵守：
  - **不落盘**：`thinking` 只随实时帧下发，写入会话文件时被剔除（思考不是聊天记录，且每批 delta 重写整个会话文件的写放大不可接受）；服务重启后该字段自然为空。
  - **不进 `messages`**：思考不参与历史回放、不占消息 ID 空间、不参与 `result` 阶段的「本轮是否已有正文」判定。客户端不要把它当消息渲染。
  - **只留尾部**：`text` 只保留最近 4000 字符（截断点回退到段落边界），因此 `totalChars` 是**截断前**的累计字符数，用来说明模型确实在推进；`text.length` 与 `totalChars` 不等时前端可提示「只保留最近 N 字」。

  `active` 表示这一段是否仍在输出：正文或工具块开始、思考块 `content_block_stop`、回合收尾时都会置 `false`。`blocks` 是本回合已开始的思考段数（正文/工具之后的思考算新的一段）。子代理的思考不进这里，只走带 `parent_tool_use_id` 的子代理消息。上一轮任务结束、进入新回合时清空。Codex 会话当前不产生 `thinking`。

WebSocket 首帧为 `{ "type": "session", "session": ... }`，之后为 `{ "type": "update", "session": "不含历史消息的会话对象", "messages": ["新增或变更的完整消息对象"] }`。客户端按消息 ID 更新有序列表；重连重新获取首帧，REST 可用于补偿。AI 连接不占用普通终端的全局配额，不限制帧或消息大小，不按固定发送或心跳超时断开；保留 Ping/Pong 和认证复核，实际连接关闭、网络错误、令牌失效或关闭 Web API 时结束订阅，服务端任务仍独立执行。

会话另外返回两个轻量字段：`createdAt`（创建时刻，毫秒）与 `compactions`（本会话上下文压缩次数）。旧会话没有 `createdAt` 时为 0，客户端可用首条消息时间回落；`compactions` 只在压缩边界事件（Claude `compact_boundary`、Codex `thread/compacted`）计数，`status=compacting` 与 `item/started contextCompaction` 属于同一次压缩的伴随事件，不重复计数。桌面端底部「会话状态」行据此显示运行时长、最近回复、压缩次数、Git 分支与未提交变更、平均输出速度、本轮活跃 MCP / Skill、CLI 版本及 MCP 配置数量；取不到的项不渲染，窄屏自动换行。

## 安卓聊天决策

待处理请求通过现有 `AiSession.approvals` 和 `status=approval` 实时同步。安卓端将决策卡片悬浮覆盖在消息区底部、AI 上下文卡片上方，不占正文布局高度、不随消息滚动；收到决策先收起软键盘。单选点选后自动提交，多题逐题选择，全部答完后提交；多选和自定义回答点击确认后提交。卡片显示选项说明与待处理数量，内容超长时内部滚动。

点击提交、拒绝或暂不回答后立即收起当前卡片，服务端处理中的旧快照不会令其重新出现；提交失败会恢复卡片并提示错误。重新连接恢复最新待决策快照；Claude Hook 过期、会话中断或 Codex 的 `serverRequest/resolved` 会移除对应卡片。

客户端统一提交按题目 ID 索引的答案，必须回答全部问题后才能接受：

```json
{
  "approvalId": "待处理请求标识",
  "decision": "accept",
  "answers": {
    "question-0": { "answers": ["选项一", "选项二"] }
  }
}
```

Codex 在初始化时启用 `experimentalApi` 与 `features.default_mode_request_user_input`，新旧会话均优先调用标准 `request_user_input`。原生 `item/tool/requestUserInput` / `tool/requestUserInput` 转换为决策卡片，沿用 CLI 的题目 ID 与答案数组，等待用户提交答案后响应。初始化后先通过 `config/read` 读取按项目目录合并的有效配置，将决策工具指引追加到原有 `developer_instructions`；新建及恢复线程时均传入合并后的 `developerInstructions`，让已有对话同样遵循标准决策流程。

新线程另外通过 `dynamicTools` 注册应用专属的 `terminal_buddy_request_decision`，用于标准工具不可用或需要多选的场景，避免与 Codex 内置 `request_user_input_async` 同名。其 `item/tool/call` 转换成同一套卡片数据，回答按 `contentItems` / `success` 返回，等待用户真实选择后才完成工具调用。已注册旧工具名的线程仍兼容处理 `request_user_input_async` 动态调用，但不再向新线程注册该名称。

普通文本不会被当成决策，内置异步请求返回的 `accepted` 也不代表卡片已展示或用户已确认。决策指引要求模型调用可用的标准工具或应用专属工具，收到真实答案前不把决策视为完成。更新并重启服务端后，已有 Codex 会话在恢复时应用新指引，无需重新创建对话或修改安卓卡片。

Claude 启动时会登记本次运行独有的 Hook 目标与令牌，把桌面端 `managed_hooks_object()` 注入模型临时 settings；默认 CLI 配置同样生成临时文件，不修改用户级配置。用户提问由桌面与安卓共用的 `ClaudeHookService` 保存并等待，按题目顺序补充 `question-0` 等 ID 后投递到当前原生会话。手机回答先按会话归属鉴权，再把答案按原始问题文本索引提交给同一决策服务，HTTP Hook 回填 `updatedInput.questions` / `updatedInput.answers`，多选标签以逗号连接。

原生 Hook 目标不向桌面广播决策，桌面待处理列表也不返回手机请求。中断或进程退出时注销目标并释放等待者；超时、暂不回答返回 Hook `deny`，不再另走 stdio 提问。普通工具授权仍由 stdio 回传 `allow` / `deny`；未回答或空白的答案由服务端拒绝，避免提交后丢失待决策请求。更新并重启服务端后，已有 Claude 会话下一次发送消息即应用该机制；安卓端继续使用现有悬浮决策卡片。

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
      "state": "final",
      "startedAt": 1738425000000,
      "endedAt": 1738425060000
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
- `lastTurn` 描述最近一次用户发送触发的整轮执行，包含多次模型调用。`state=provisional` 表示执行中，`final` 表示已收到完整统计，`partial` 表示缺少完整结算。尚未发送时为 `null`。`startedAt` / `endedAt` 为本轮开始与收尾时刻（毫秒）；`endedAt` 只在收到 `result`、回合结束、中断或进程退出时写入，客户端据此计算平均输出速度（`outputTokens / 时长`），流式快照不会重置计时起点。
- `sessionTotal` 表示累计消耗；`coverage=complete` 为完整统计，`sinceUpgrade` 为旧会话从升级后开始统计，`partial` 为包含不完整或无法确定起点的统计。停止、异常或服务重启会将未完成统计标记为部分统计。
- 对外 `inputTokens` 已包含缓存，`cacheReadInputTokens` / `cacheCreationInputTokens` 为其中的明细；Codex 的 `reasoningOutputTokens` 也是输出的组成部分，不能再叠加。
- Claude 按 API 消息 ID 合并流式 / 完整消息用量，最终 `result.usage` 或 `modelUsage` 替换本轮快照。Codex 按线程累计快照减去回合基线，恢复线程不会重复加上历史累计。主回合完成后保留 300ms 接收紧随其后的用量通知；该等待只用于统计结算，不回收 Codex 进程。自动唤醒继续沿用最近一次用户输入的累计基线。
- 统计和 Codex 恢复基线一起保存在 `AiSessions/*.json`，基线字段不返回客户端。仅用量变化也增加 `revision`，现有 WebSocket 和 REST 补偿可以直接同步，无需额外接口。

### 安卓正文 Markdown

AI 正文继续通过原有消息字段传输原始 Markdown，不改变 REST 或 WebSocket 结构。安卓端使用原生 Compose 组件渲染标题、强调、列表、引用、链接、代码和 GFM 表格；工具消息保留日志样式。客户端对正文进行消息级缓存和后台解析，新结果就绪前保留旧结果，解析状态不参与业务思考状态切换。图片首版显示链接；公式和 Mermaid 不在本轮范围。

### 安卓悬浮卡片展示

安卓客户端在二级对话页输入框上方以一体化轻卡片展示用量：上层 11~12sp 显示 Agent 图标、模型与思考强度；下层为「上下文 / 进度条 / `26%(250K/950K)`」及输入、输出 token。统计统一使用十进制 K（1K = 1000 token），首次尚无已知统计时显示 `—K`；刷新、回合切换及 `updating=true` 期间保留本会话上次已知数值和上下文进度，新统计到达后直接替换；进度条只在拿到大于 0 的有效进度时前进，缺失、刷新中或计算结果为 0 都沿用上一次进度，避免归零后随快照回弹。已用量同样如此：一旦拿到过正值，之后的 0 视为统计缺失而不再覆盖已知值（新会话首次的 0 仍照常显示），避免 `0K/950K` 闪一下再跳回真实数值。容量（总上下文大小）也只接受大于 0 的新值，缺失或 0 都沿用上一次已知容量，不会短暂回退成 `—K`。从未拿到过有效比例时（例如容量始终未上报）不绘制进度条，只显示「上下文 `已用/容量`」文字，占用率显示 `—` 而不是误报成 `0%`。详情继续显示服务端的统计与等待状态。输入 / 输出优先取 `lastTurn`，回合尚未开始时回退 `sessionTotal`。卡片仅在展开时占据布局高度；收起后显示消息区右下角的浅色悬浮展开按钮，消息区使用腾出的空间。顶部标题栏保持单行对话标题。

### 模型与思考强度匹配

模型名与思考强度按会话 `provider` + `providerId` + `model` 匹配 `GET /api/ai/catalog` 的 `providers[].models[]`：模型名取目录 `label`，未命中回退会话 `modelLabel`；思考强度读 `models[].effort`，中文映射支持 关闭（none）/ 自动（auto）/ 跟随服务端（default）/ 极低 / 低 / 中 / 高 / 很高 / 最高 / 极高（ultra），未提供或未命中时显示「跟随服务端」。仅作展示，供应商与模型的选择仍由首页配置负责。新建会话的本地壳会预置零值 `usage`，首次发送前即可显示 0K。

## 源码

- `src-tauri/src/models/ai_chat.rs`：结构化数据模型。
- `src-tauri/src/services/ai_permission_service.rs`：继承 Agent 基础命令中的权限参数，并映射到原生 CLI / App Server。
- `src-tauri/src/services/ai_catalog_service.rs`：供应商目录与按会话准备的启动配置。
- `src-tauri/src/services/ai_chat_service.rs`：会话持久化、进程生命周期、Claude/Codex 协议适配。
- `src-tauri/src/services/ai_chat_approval.rs`：交互答案校验、Hook 问题格式归一化及普通授权协议响应。
- `src-tauri/src/services/ai_chat_claude_hooks.rs`：原生 Claude Hook 目标登记、鉴权环境与会话事件投递。
- `src-tauri/src/services/ai_chat_usage.rs`：用量归一化、消息快照合并、累计基线及上下文压缩状态。
- `src-tauri/src/services/app_notification_service.rs`：终端完成 / 失败与决策的 App 通知事件流及待决策快照。
- `src-tauri/src/web/handlers/ai_chat_handler.rs`：REST 和 WebSocket；磁盘及任务启动操作均通过 `spawn_blocking`。
- `src-tauri/src/web/handlers/app_notification_handler.rs`：`/ws/notifications`、待决策列表与回答接口。
- `src-tauri/src/web/server.rs`：HTTP/WS 路由注册。

协议参考：[OpenAI Docs：Codex App Server](https://developers.openai.com/codex/app-server/)、[Claude Agent SDK 流式输出](https://platform.claude.com/docs/en/agent-sdk/streaming-output)。

## 安卓后台通知连接

`/ws/ai?token=...` 复用原生 AI 会话的 JWT 认证和账号归属校验，为每个账号提供一条独立于 `/ws/ai/{id}` 对话流的通知连接。连接首帧、会话版本变化和每 10 秒的空闲心跳均返回 `{"type":"sessions","sessions":[...]}`；会话字段与 `GET /api/ai/sessions` 一致，`messages` 为空，不复制或发送完整历史。服务端每秒在 `spawn_blocking` 中读取元数据，并持续检查令牌和服务开关。连接当前账号只能获取该账号自己的会话。

通知连接另有每 10 秒一次的协议 Ping；客户端 45 秒没有任何回应或单帧发送等待超过 15 秒时回收连接，防止后台断网/冻结后遗留的 Socket 持续占用服务端资源。该限制仅用于 `/ws/ai` 通知摘要，不改变 `/ws/ai/{id}` 正文流和任务执行的时限；客户端继续以原有摘要帧接收数据，保持协议兼容。

会话新增向后兼容的 `resultRevision`，默认 `0`，在完成、失败或中断时记录对应版本并随会话持久化。Android 将它与本机事件基线比较，补发断线期间错过的结束事件；仅标题或用量变化不会生成结束标记，首次完整列表同步建立账号历史基线，不批量通知旧结果；此后新出现且已经结束的会话也会补报，避免断线期间新建并完成的任务永久丢失提醒。新版后台通知连接需要更新服务端和安卓 App；旧客户端继续使用原有接口，新客户端连接旧服务端时保留 REST 补偿同步。

## 服务端终端任务通知（App）

App 通道覆盖非原生会话（PC / Web 终端）里 Claude / Pi 的完成事件与待决策事件。服务端在 `claude-hook-terminal-event` 的 `completed` / `failed` 与 `claude-hook-decision` 产生时写入内存事件流。

| 路径 | 请求 / 响应 |
| --- | --- |
| `GET /api/notifications/decisions` | 当前仍在等待的决策快照 |
| `POST /api/notifications/decisions/{id}/answer` | `{ "answers": { "问题原文": "回答" } }`，全部回答后回填原 Claude / Pi 决策 |
| `/ws/notifications?token=...` | 首帧 `{ "type":"snapshot", "decisions":[...] }`；随后 `{ "type":"event", "event":{...} }` 与每 10 秒 `{ "type":"heartbeat" }` |

事件字段为 `id`、`kind`（`decision` / `completed` / `failed` / `resolved`）、`terminalId`、`terminalName`、`provider`、`title`、`summary`、`decisionId`、`questions`、`expiresAt`、`occurredAt`。`questions` 与 `ClaudeHookQuestion` 一致，包含 `question`、`header`、`options`、`multiSelect`；多选答案用逗号连接。`resolved` 事件只携带 `decisionId`，App 收到后撤销通知与待办。

服务端只保留内存中的待决策快照（进程重启后由 Hook 状态自动结束并发布 `resolved`），完成事件不做离线补发；App 断线重连先接收快照，再用 `GET /api/notifications/decisions` 周期性补偿。旧服务端没有该接口时，安卓端暂停该通道且不影响 `/ws/ai` 的原生 AI 通知。
