# 简版首页「进行中」Tab 合并与手机/电脑 Agent 会话统一（调研）

日期：2026-11-02。状态：**调研完成，可实施性成立，待拍板后实施**。本文是实施前调研，不代表代码已实现。

相关文档：[终端 Agent 会话接力](2026-11-01--terminal-agent-chat-relay.md)、[原生 AI 会话 API](../原生AI会话API.md)。

---

## 1. 需求（用户原话要点）

- 移除手机端简版首页的「服务端会话」Tab；
- 手机和电脑端的 Agent 会话**完全共享**，手机创建的会话可以直接在电脑上接力；
- 因此不再区分「最近任务」与「服务端会话」两个 Tab；
- 「最近任务」改为「**进行中**」，只加载打开（正在运行）的会话。

## 2. 现状调研：两套 Agent 会话体系

手机端（简版首页「开始对话」等入口）创建的是**原生 AI 会话**，PC/服务端终端里跑的是**终端 Agent 会话（relay）**，二者是独立体系（`docs/原生AI会话API.md`：「原生 AI 会话独立于现有 PC/Web PTY 终端」）：

|  | 原生 AI 会话 | 终端 Agent 会话（relay） |
| --- | --- | --- |
| 创建入口 | 简版首页「开始对话」（`AiViewModel.create`）、完整版 Ai 页 | 简版「项目配置」（`ServerTerminalViewModel.launch`，需服务端登记 profile）、PC 端终端 |
| 运行位置 | 服务端**无头进程**（`claude -p` / `codex app-server`），无 PTY | 服务端/PC 终端（PTY），`cmd.exe` 基座 + PTY writer 注入命令 |
| 手机端能力 | 完整对话：多轮、消息排队、后台任务进度、token 用量 | 只读镜像 + 受限回复（Claude/Pi 可回一句，Codex 只读） |
| 电脑端 | **看不到运行中进程**；转录进 PC 历史面板（共享索引） | `webApiShareSessions` 开启时 PC 终端列表可见，直接操作 = 接力 ✅ |

简版首页三 Tab 现状（`AiSimpleHome.kt:47-49`）：

- **最近任务**：`ui.sessions`/`ui.recentSessions` 全量本地 `AiSession`（含已结束），点击 `vm.open()` 进原生对话页；
- **历史会话**：当前项目的 CLI 转录历史（与 PC 历史面板共享索引）；`findLiveAgentSession()` 匹配 relay 运行中条目直接接管，否则 `resumeHistory()`（`AiViewModel.kt:706`）绑定同一 sessionId 恢复为原生会话继续——**已结束原生会话的再进入已被此路径覆盖**；
- **服务端会话**：relay 实时列表 `agentUi.sessions`，点击接管。

### 2.1 重要澄清：审批与任务通知本就统一（调研中纠正的误判）

最初误判「审批卡片是原生会话独有能力，统一走终端会丢失」。实际：**PC/终端会话的待决策与任务完成/失败事件通过 `/ws/notifications` 推送安卓 App，应答走 `/api/notifications/decisions`**（`services/app_notification_service.rs`，与微信/飞书机器人通知同源）；relay 聊天页的待决策按钮（`session.pendingDecisionCount`）也指向同一决策 Host。**被动响应（看输出、处理决策、收通知）在两套体系下能力一致。**

统一走终端后原生会话仅存的净损失：**手机主动驱动**——relay 回复接口只允许一句纯文本（≤2000 字符、不以 `/ ! @ #` 开头、无控制字符），无消息排队、后台任务进度快照、token 用量；Codex 终端会话手机端只读。用户已确认此取舍可接受。

## 3. 关键验证结果（可实施性依据）

1. **手机按 agent 直接起终端的链路已存在，服务端零改动**：`POST /api/terminals` 的 `StartTerminalRequest`（`web/handlers/terminal_handler.rs:30`）支持**空 `profileId` + `startupCommand`**——`create_blank_terminal` 创建空白终端（基座 `cmd.exe`）后把命令注入 PTY writer，与 PC 端「选 shell 注入命令」同机制。创建的终端 `owner=Web, creator=Mobile`（`TerminalClientKind` 请求头区分）。
2. **agent 基础启动命令对手机可见**：`GET /api/desktop/runtime-info`（`web/handlers/desktop_handler.rs:25`）返回 `agentCommands`（claude/codex/pi），注释明确「供 Web 前端把 Agent 基础启动命令用于模型启动与历史恢复」；手机带 JWT 可直接调用。备选：在 `/api/ai/catalog` 顺带带出，省一次请求（服务端小改）。
3. **共享可见性双向成立**：`list_terminals_info_for(actor)`（`commands/terminal.rs:1263`）按 `webApiShareSessions` + 权限矩阵（`models/terminal_access.rs`）过滤；共享开启时手机（Web 身份）能在 relay 列表看到 PC 终端会话，PC 终端列表能看到手机创建的终端并直接操作 = 接力。relay 列表 `sessions_for`（`services/terminal_agent_relay.rs:1329`）发现链：可见终端 → PID → summaries → 绑定。
4. **功能闭环无丢失**：删「最近任务」后，已结束原生会话从历史 Tab `resumeHistory()` 恢复（先 rescan 索引再绑定，含电脑端最新回合预填）；「进行中」+「历史」完全覆盖原三 Tab 的职责。
5. **手机端现有终端封装可复用**：`ServerTerminalViewModel.launch()`（`ServerTerminalViewModel.kt:120`）走 profileId 路径，新增「按 agent 直启」只需补一个空 profileId + `startupCommand` 的 repository 方法。

## 4. 方案（已与用户对齐）

| 项 | 内容 |
| --- | --- |
| Tab 改造 | `SimpleHomeTab` 删 `Server`；`Recent("最近任务")` → `Ongoing("进行中")` |
| 「进行中」数据源 | relay `agentUi.sessions` + 存量原生 running 会话（`AiSession.running`：running/approval/background/stopping）**混排**，按最近活动排序，行内标识来源；原生行点击进对话页，终端行点击进接管页 |
| 「开始对话」 | `vm.create` 改为按所选 agent 创建终端：runtime-info 拿 agentCommands → `POST /api/terminals`（`profileId=""` + `startupPath=项目路径` + `startupCommand`）→ 等待/引导进入接管页 |
| 已结束会话 | 不再出现在首页；历史 Tab 恢复（现有能力，不动） |
| 完整版模式 | 不动，原生会话体系保留给完整版 Ai 页 |
| PC 端 / 服务端 | 零改动（或 catalog 带 agentCommands 的小改） |

### 4.1 已拍板决策（2026-11-02）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 原生会话 PC 接力缺口 | 统一走终端（方案 C）：手机新会话改在终端里跑，天然双向接力；接受 relay 的受限回复与 Codex 只读（审批/通知本就统一推送） |
| 2 | 「进行中」列表形态 | 混排（不分组） |

## 5. 实现注意点

1. **启动到可接管的延迟**：终端创建成功 ≠ relay 会话立即可见（需等 Agent CLI 启动、转录文件生成、扫描发现，数秒级）。「开始对话」后不能直接跳接管页：先落终端页或轮询 `/api/terminal-agents` 匹配新终端 id（按 `terminalId` 关联），出现后引导接管。
2. **Codex 终端会话手机端只读**：`/api/terminal-agents/{id}/reply` 对 codex 不可用；原生 codex 多轮对话不再提供，决策仍可处理。
3. **存量原生会话**：改造前创建的 running 原生会话仍要在「进行中」正常显示与打开（混排两数据源即覆盖）；`resumeHistory()` 继续产生新原生会话，属预期保留路径。
4. **项目配置入口并存**：「项目配置」（profile 启动）与「开始对话」（agent 直启）两条路径并存，注意 `startupPath` 必须是已登记项目（`ensure_project_scope` 把关）。
5. **relay 发现依赖共享开关**：若 `webApiShareSessions` 关闭，手机看不到 PC 终端会话，「进行中」只剩自己创建的——空态文案需保留「检查会话共享已开启」的提示。

## 6. 影响面与工作量

- 改动集中在安卓端 Kotlin：`AiSimpleHome.kt`（Tab 与列表）、`AiViewModel`/`ServerTerminalViewModel`/repository（发起路径）、行组件与计数 badge；无服务端必改项、无 PC 端改动。
- 不动：历史 Tab 逻辑、relay 协议、原生会话 API、完整版界面。
- 验证：容器内 `compileDebugKotlin` + `testDebugUnitTest`（参照 `scripts/build-android.sh` 的容器模式），真机验证「开始对话 → 终端创建 → relay 接管 → PC 端接力」全链路。
