# Android AI 对话上下文与 Token 状态栏调研

调研日期：2026-10-22。本文依据当前仓库源码，以及下方列出的 Claude 官方文档、Anthropic SDK 类型和 OpenAI Docs；记录实现前的调研结论；功能已随后落地，实际字段与行为参见 [原生 AI 会话 API](原生AI会话API.md) 的会话用量说明。后续交互形态已由「输入框内状态栏」演进为「输入框上方的模型与用量悬浮卡片」（含模型与思考强度展示），现状见 `android/README.md` 的「Ai 模型与用量悬浮卡片」章节。

可以实现。建议在安卓 AI 对话页的输入框内部底部增加一行状态栏，展示当前上下文占用和本会话累计输入、输出 token，点击后展开详情。数据由 Rust 服务端从 Claude / Codex 的结构化协议采集，再随现有会话 REST / WebSocket 同步到安卓。主要工作在后端用量适配和统计口径，安卓展示改动较小。

**当前项目的接入条件已经具备。**

| 环节 | 当前实现与定位 | 对本功能的影响 |
| --- | --- | --- |
| 安卓会话模型 | `android/app/src/main/java/com/terminalbuddy/android/data/AiModels.kt:17`，`AiSession` 仅有消息、模型、状态等字段 | 需要增加可选 `usage` 模型 |
| 安卓输入框 | `android/app/src/main/java/com/terminalbuddy/android/ui/AiConversationScreen.kt:244`，`AiComposer` 中是一个圆角 `Surface`，里面为输入框和发送按钮的 `Row` | 在该 `Surface` 内改为 `Column`，原输入行下增加统计行 |
| 对话详情 | 同文件 `:124`，已有“对话信息”底部面板 | 可以复用 `AiSheet`，展开上下文及 token 明细 |
| Claude 调用 | `terminal-buddy/src-tauri/src/services/ai_chat_service.rs:273`，会话首次启动 `claude -p --output-format stream-json --verbose --include-partial-messages`，回合结束后保持进程与 stdin，后续消息写入同一进程；仅冷启动/恢复使用 `--resume` | 已有结构化用量来源，无需解析终端画面 |
| Claude 事件处理 | 同文件 `:353`、`:383`、`:408`，处理流式内容、完整助手消息与 `result` | 当前没有读取 `usage`、`modelUsage`，也没有处理压缩后的统计失效 |
| Codex 事件处理 | 同文件 `:496`，处理 app-server 的消息、工具和回合状态 | 当前没有处理 `thread/tokenUsage/updated` |
| Rust 会话模型 | `terminal-buddy/src-tauri/src/models/ai_chat.rs:23` | 需要增加可选统计字段，并在创建会话时初始化 |
| 持久化 | `terminal-buddy/src-tauri/src/services/ai_chat_service.rs:43`，`AiSessions/*.json` 原子保存；执行中约每 5 秒保存、结束再保存 | 可以一并保存统计及内部去重状态 |
| WebSocket | `terminal-buddy/src-tauri/src/web/handlers/ai_chat_handler.rs:57`，约每 300ms 比较 `revision`，发送会话元数据及变化消息 | 用量变化更新 `revision`，新增字段可自动进入现有推送，不需要新接口 |
| 安卓实时合并 | `android/app/src/main/java/com/terminalbuddy/android/data/AiRepository.kt:129`，使用新元数据，仅合并历史消息 | 新统计字段可随 `metadata.copy(messages = ...)` 保留 |
| 安卓状态同步 | `android/app/src/main/java/com/terminalbuddy/android/AiViewModel.kt:516`、`:563`，按 `revision` 接收，已有 REST 补偿 | 通常无需新增一套用量轮询 |
| 模型窗口配置 | `models/llm_provider.rs:37`、`models/codex_provider.rs:39` 已有 `context_window` | 可作为窗口大小的配置来源；0 代表跟随默认，并不代表窗口为 0 |
| 安卓模型目录 | `services/ai_catalog_service.rs:13`、`:23` 构造 `AiModelOption` 时没有携带窗口信息 | 若需要首轮响应前显示配置窗口，可以扩展目录；核心功能也可直接由会话 `usage` 返回 |

仓库现有 `src/services/aiUsage.ts` 主要提供供应商账户配额、余额及按日用量，不能直接提供某一原生会话的上下文占用。历史服务虽能读取 token，但目前 Claude 索引仅累加 `input_tokens` / `output_tokens`，Codex 历史解析主要保存累计输入 / 输出，都不足以直接作为原生会话的实时上下文统计。

**先固定三种统计口径。**

| 指标 | 含义 | 建议位置 |
| --- | --- | --- |
| 当前上下文 | 主对话最近一次模型调用所报告的上下文输入与有效窗口；压缩后会下降 | 状态栏常驻，显示百分比；详情显示已用 / 容量 |
| 本轮输入 / 输出 | 一次用户发送到本次执行结束期间，可能包含多次模型调用和工具往返的用量 | 点击状态栏后查看；执行中注明“统计中” |
| 本会话累计输入 / 输出 | 当前对话各轮用量总和；输入上下文重复发送会被重复统计 | 状态栏常驻，并在详情明确“本会话累计” |

“累计输入 / 上下文容量”不能作为上下文占用率。例如最新一次上下文输入 48k、窗口 200k，占用为 24%；整段对话累计输入可能已达 186k，仍然不表示当前占用为 93%。

**Claude 的数据与计算方式。**

Claude 官方状态栏文档目前明确：`context_window.current_usage` 来自最近一次 API 调用；`used_percentage` 使用输入统计，包含缓存读取与写入，不包含该次输出。若要遵循这个口径，计算为：

```text
当前上下文输入 = input_tokens
               + cache_read_input_tokens
               + cache_creation_input_tokens

上下文占用率 = 当前上下文输入 / 有效上下文容量 × 100%
```

这里的 `input_tokens` 是 Claude 原始字段；建议应用对外的 `inputTokens` 统一表示“包含缓存的总输入”，并单独提供缓存明细。

官方状态栏的 `context_window.total_input_tokens` / `total_output_tokens` 在当前文档中指最新响应对应的窗口计数，不能因名称包含 `total` 就当作整段会话累计消耗。状态栏显示的是最新响应的快照，不是实时对草稿文本的计数；与 `/context` 对新增内容的估算可能有差异。

当前项目使用的是 print / stream-json 模式，并未接入 Claude 状态栏回调。上面的 `context_window` 是状态栏脚本的输入协议，不能假设它会原样出现在 CLI 标准输出中。适合从已有事件重建对应指标：

- 从 `stream_event` 的 `message_start` / `message_delta` 及完整 `assistant.message.usage` 获取最新调用的用量；流式信息按消息 ID 合并，不能每收到一次快照就累加。
- 用主对话最近一次 API 消息更新上下文输入。按主消息与子任务来源区分，避免子 Agent 的独立窗口覆盖主对话窗口。
- 从 `result.usage` 获取当前执行的最终用量，替换本轮暂存统计；`result.modelUsage` 可提供分模型统计及 `contextWindow`，Anthropic 官方 SDK 类型已列出这些字段。两种最终摘要不能相加。
- 窗口大小优先使用当前主模型的运行时报告；缺失时采用本次启动生效的配置，并标注“配置值”。多个模型时不能把各模型窗口相加，也不能任取第一个模型。
- 对压缩相关系统事件使旧上下文快照失效，收到下一次有效用量再更新。累计消耗继续保留。

本项目支持模型别名、第三方供应商及服务端默认模型，所以不宜统一写死 200k。若 CLI 没有给窗口、配置又是跟随默认，就显示已知 token 数与“容量未知”。

还需要在实际落地时对照服务端所安装的 Claude CLI 版本，确认恢复会话后 `result.usage` 的统计作用域、消息分块的 usage 重复情况，以及错误 / 中断事件携带的字段。官方 SDK 类型能确认字段存在，不能代替目标版本的事件样本。

**Codex 使用同一界面，服务端单独适配。**

OpenAI Docs 明确列出了 app-server 的 `thread/tokenUsage/updated` 通知。当前项目接收 app-server JSON-RPC，只需在 `apply_codex_event` 增加这类通知处理，并继续使用已有的 thread / turn 过滤。

建议从该版本协议的最新调用快照、线程累计快照和模型窗口信息分别归一化上下文、累计量与容量。官方页面确认了通知，但本次查到的正文没有给出其完整字段 schema；`total`、`last`、`modelContextWindow` 等具体字段及作用域，应在实现时对照目标 CLI 的协议 schema 确认，不能仅据事件名称确定。

Codex 若返回线程累计快照，应替换 / 对齐对应累计值，不能在每次通知或恢复会话后把整份累计再加一遍。本轮用量可在明确累计作用域后，通过起止快照差或本轮账本得到。若缓存输入是总输入的子集、推理输出是总输出的子集，明细只用于展示，不能再加到总数上。

Claude 与 Codex 的上下文计数口径未必相同。Codex 优先使用其协议所报告的上下文和有效窗口；若只能从最新调用统计推导，应明确作为估算，不能直接宣称与 CLI 状态栏完全一致。

另一个接入细节是 `apply_codex_event` 当前遇到 `turn/completed` 就返回结束，随后子进程被回收。实现时需确认最终用量通知与完成事件的顺序，必要时补取最终统计，避免最后一份用量被丢弃。

**建议的安卓效果。**

状态栏放在输入框圆角容器内的底部，跟随输入区与键盘一起显示；不放进消息列表，因此不会随历史消息滚走。顶部已经展示 Agent 和模型，底部不必重复。

```text
┌─────────────────────────────────────────────┐
│ 给 Claude 发消息…                       [↑] │
│ 上下文 24% · 累计 ↑186k ↓9.2k            [⌄] │
└─────────────────────────────────────────────┘
```

箭头的无障碍描述分别为“累计输入 token”和“累计输出 token”。宽屏可直接显示“输入 / 输出”，窄屏优先缩短数字，必要时分为两行；统计行视觉紧凑，点击区域仍保留足够高度。

点击状态栏后使用现有 `AiSheet` 展示：

| 展示项 | 示例 |
| --- | --- |
| 当前上下文 | 48,000 / 200,000 token，24% |
| 本轮 | 输入 52,000，输出 1,200 |
| 本会话累计 | 输入 186,000，输出 9,200 |
| 缓存 / 推理明细 | 在 Agent 确实返回时显示，并说明是总量中的组成部分 |
| 数据状态 | 统计中、已完成、部分统计、升级后开始统计 |
| 窗口来源 | CLI 报告 / 会话配置；推导值注明估算 |

建议低于 70% 使用现有薄荷绿，70% 起使用提醒色，90% 起使用危险色。这只是界面提醒阈值，不代表 CLI 的实际自动压缩阈值。压缩中显示“上下文更新中”，不把未知显示成 0%。没有用量时显示“用量待返回”；旧服务端可隐藏统计行或显示“暂无统计”。

**建议的接口字段。**

在 `AiSession` 增加可选 `usage`，以下是应用自身协议的建议，非 Claude / Codex 原始事件格式：

```json
{
  "usage": {
    "context": {
      "usedTokens": 48000,
      "windowTokens": 200000,
      "basis": "input",
      "usedSource": "cliUsage",
      "windowSource": "cli"
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
      "coverage": "complete"
    }
  }
}
```

`basis` 表示占用数的统计口径；`usedSource` 区分 CLI 用量与估算；`windowSource` 区分运行时报告与配置。`lastTurn.state` 可使用 `provisional` / `final` / `partial`。字段未知时用 `null`，已知为零时才用 0。整数采用 Rust `u64` 与 Kotlin `Long`，旧会话反序列化默认 `usage = None / null`。

本轮最终摘要与过程中采集的消息 usage 是同一批用量的不同视图，要替换 / 校正，不能重复累计。建议在服务端建立按用户消息 ID 关联的本轮账本及内部去重记录，纳入现有私有持久化；API 只返回整理好的统计，不增加内部线程和去重信息的暴露。

现有请求 ID 已防止发送重试生成重复回合，但仍需对流式事件、分块快照、最终摘要分别做用量去重。用量更新通过现有 `update` 增加 `revision`，即可让只有统计变化的更新也被 WebSocket 推送。服务重启后恢复最后保存的统计，未收齐最终数据的本轮标记为部分统计。

**需要提前处理的边界与改动范围。**

旧 `AiSessions/*.json` 只保存精简消息，没有原始 usage。UI 文本还存在截断和数量上限，且不包含完整系统提示、工具定义等上下文，因此无法按字符数准确补出旧 token。默认标注“升级后开始统计”；需要补全历史时，再通过内部线程 ID 读取 CLI 转录文件做独立回填，并沿用统一口径。

手动停止和进程异常可能收不到最终摘要，应保留已经确认的用量并标记部分统计。服务端统计不依赖手机保持连接，手机重连后读会话快照即可。草稿计数、系统提示 / 工具 / 文件等上下文的逐项拆分，以及费用统计，建议作为后续扩展；现有协议和存储尚不足以保证这些明细完整准确。

| 实现文件 | 计划改动 |
| --- | --- |
| `terminal-buddy/src-tauri/src/models/ai_chat.rs` | 用量结构、可选字段、兼容旧数据 |
| `terminal-buddy/src-tauri/src/services/ai_chat_service.rs` | 采集 Claude / Codex 用量、统一统计、关联本轮、去重与持久化、压缩及异常处理 |
| `terminal-buddy/src-tauri/src/services/ai_catalog_service.rs` | 按需要传递启动时生效的窗口配置；若扩展模型目录，需同步所有 `AiModelOption` 构造点，包括 `claude_provider_service.rs` |
| `android/app/src/main/java/com/terminalbuddy/android/data/AiModels.kt` | Kotlin 用量数据类及可空兼容 |
| `android/app/src/main/java/com/terminalbuddy/android/ui/AiConversationScreen.kt` | 输入框内状态栏、点击展开详情；可将组件拆到 `AiUsageBar.kt` |
| `docs/原生AI会话API.md`、`android/README.md` | 描述字段、统计口径、旧会话与旧服务端行为 |

核心方案复用现有 REST、WebSocket、JSON 持久化和安卓状态同步机制，不需要新增 Tauri 命令或数据库表。建议先完成用量采集与统一模型，再接入状态栏；实现前重点确认目标 CLI 的事件字段、累计作用域、完成时序与压缩行为。

参考资料：

- [Claude Code：自定义状态栏及上下文字段](https://code.claude.com/docs/en/statusline#context-window-fields)。本次读取了该页面的 Markdown 版本，支持最新响应快照、输入含缓存及占用率公式的结论。
- [Anthropic 官方 Agent SDK Python 类型](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)。`ResultMessage` / `ModelUsage` 明确列出最终 usage、缓存及 `contextWindow`；链接指向可变的 main，落地以所安装 CLI 版本为准。
- [OpenAI Docs：Codex App Server](https://developers.openai.com/codex/app-server/)。支持 `thread/tokenUsage/updated` 通知这一数据入口；完整通知 schema 仍需与目标 CLI 对齐。
- [项目现有原生 AI 会话 API](原生AI会话API.md)。
