# 删除 AI 交付功能 — 设计文档

日期：2026-08-05
状态：已批准

## 背景与目标

移除项目中全部"AI 交付"（ai delivery / ai_delivery）功能代码，包括：后端服务、命令、模型、Web API handler、前端组件与类型、Web SPA 页面、配置项、文档。

**保留**（独立功能，不在删除范围）：
- 机器人（bot）通知功能 — 先于 AI 交付存在，含飞书/钉钉/微信推送、扫码授权、长连接、决策绑定机制
- Claude Code Hook 体系（claude_hook_service、hooks 命令、HookSettings 等）
- AI 用量功能（ai_usage.rs、AiUsagePanel、zhipuApiKey/qianfanCookie 等字段）
- 共享服务：TerminalService、git.rs、database_service 其余部分

## 一、整个文件删除

### Rust 后端
| 路径 | 说明 |
|---|---|
| `src-tauri/src/services/ai_delivery_service/`（整目录 9 文件） | mod/delivery/dispatch/entity/helpers/manager/quality/terminal/tests，~1.3 万行 |
| `src-tauri/src/commands/ai_delivery.rs` | 全部 `*_ai_delivery*`/`ai_*` tauri 命令 |
| `src-tauri/src/models/ai_delivery.rs` | 30+ 个 `Ai*` 结构体 |
| `src-tauri/src/web/handlers/ai_delivery_handler.rs` | REST 处理器 |

### 前端
| 路径 | 说明 |
|---|---|
| `src/components/ai-delivery/`（整目录） | 21 个 tsx/ts + 6 个 css + 3 个 utils |
| `src/types/aiDelivery.ts` | 类型定义 |
| `web/src/screens/AiDelivery.tsx` | Web SPA 页面 |

### 配置与脚本
| 路径 | 说明 |
|---|---|
| `src-tauri/tauri.conf.json` | 删 `label: "ai-delivery"` 独立窗口配置 |
| `src-tauri/capabilities/default.json` | 删 `"ai-delivery"` 窗口授权 |
| `scripts/verify-ai-delivery-drive.ps1` / `verify-ai-delivery-plan.ps1` / `verify-ai-delivery-launch.ps1` | 验证脚本 |
| 根目录 `ai-delivery-orchestrator-demo.html` | 演示页 |

### 文档（实现时逐一确认归属）
| 路径 | 处理 |
|---|---|
| `docs/ai-delivery-implementation-plan.md` | 删除 |
| `docs/fix-plans/2026-08-03-ai-delivery-ui-dispatch-fixes.md` | 删除 |
| `docs/superpowers/plans/2026-08-02-ai-delivery-iteration-{1,2,3,4}.md` | 删除 |
| `docs/superpowers/specs/2026-08-03-ai-delivery-service-split-design.md` | 删除 |
| `docs/superpowers/plans/2026-08-03-ai-delivery-service-split.md` | 删除 |
| `docs/superpowers/plans/2026-08-04-dag-tab-and-cross-repo-dependency.md` + 同名 spec | 删除（已确认整篇为 AI 交付看板 DAG 专属内容） |
| `docs/superpowers/specs/2026-07-25-terminalbuddy-ai-delivery-orchestrator-design.md` | 删除 |

## 二、引用点清理（Rust）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/lib.rs` | 删 ai_delivery import/use（含 `AiAgent`、`APP_HANDLE.set`）；setup 中恢复逻辑整块（recover_interrupted_attempts / rebuild_active_attempt_index / auto_init_runtimes / DEBUG 派发 / 运行中交付补派）；invoke_handler 中全部 ai_delivery 命令注册；on_page_load 与 on_window_event 中 `"ai-delivery"` 窗口分支。**保留全部 bot 命令与逻辑**（bot 命令注册、sync_bot_long_connections、requires_callback_server 分支） |
| `src-tauri/src/commands/mod.rs` | 删 `pub mod ai_delivery;` 与 `pub use ai_delivery::*;` |
| `src-tauri/src/services/mod.rs` | 删 `pub mod ai_delivery_service;` 与 pub use |
| `src-tauri/src/models/mod.rs` | 删 `pub mod ai_delivery;` 与 pub use |
| `src-tauri/src/web/handlers/mod.rs` | 删 `pub mod ai_delivery_handler;` |
| `src-tauri/src/web/server.rs` | 删 ai-delivery 19 条 REST 路由（约 45-130 行）；**保留 bot 路由** |
| `src-tauri/src/commands/notification.rs` | 删 `show_ai_delivery_notification` 函数；保留其余通知函数 |
| `src-tauri/src/commands/window.rs` | 删 `open_ai_delivery_window` 函数 |
| `src-tauri/src/services/database_service.rs` | 见第四节 |

## 三、机器人（bot）交叉点 — 保留功能，剥离 AI 交付部分

以下 **保留**（bot 通用机制，claude_hook_service 亦使用）：
- `services/bot_binding_service.rs`、`services/bot_long_connection_service.rs`、`services/bot_settings_service.rs`、`services/bot_scan.rs`、`services/bot_weixin_service.rs`
- `commands/bot.rs`、`models/bot.rs`、`web/handlers/bot_handler.rs`
- `bot_decision_bindings` 表、`weixin_runtime_states` 表及对应迁移/方法
- Cargo.toml 的 `lark-channel` 依赖

以下 **剥离**（AI 交付专属）：
| 位置 | 改动 |
|---|---|
| `web/handlers/bot_handler.rs` ~268-283 | 删"引用回复命中 AI 交付决策绑定"分支（resolve_delivery_decision_binding / answer_decision_request）及 `AiDeliveryService` import |
| `services/bot_long_connection_service.rs` ~323-342 | 同上 |
| `models/bot.rs` `BotChannelConfig` | 删 `ai_delivery_enabled` 字段（注释：AI 交付事件推送开关） |
| `services/bot_settings_service.rs` | 删该字段的读写行（26, 102, 134, 195） |

## 四、database_service.rs 处理

删除：
- `ai_entities` 建表 SQL（58-66 行）
- 迁移 `legacy-ai-entities-v1`（135-158）、`ai-runtime-deduplication-v1`（159-165）
- `deduplicate_ai_runtimes` 方法（246-345）
- `list_ai_entity*` / `get_ai_entity` / `save_ai_entity` / `delete_ai_entity(s)` 方法（347-425）
- import 中 `AiAgent`、`AiAgentRuntime`

保留（bot 功能）：`bot_decision_bindings` 表、`weixin_runtime_states` 表、迁移 `legacy-bot-bindings-v1`、`legacy-weixin-runtime-v1`、decision_bindings 相关方法。

**已安装用户的旧库**：`ai_entities` 等旧表保留不删、不读写（无害）；新安装不再创建。

## 五、引用点清理（前端）

| 文件 | 改动 |
|---|---|
| `src/main.tsx` | 删 AiDeliveryApp import 与 `'ai-delivery'` label 挂载分支 |
| `src/App.tsx` | 删 AiDeliveryFloatingButton / openAiDeliveryWindow import、`ai-delivery-notification-activated` 监听（~324-326）、`extraParamTag === 'AI 交付'` 终端过滤（~337）、悬浮按钮渲染与开关（~752-810） |
| `src/services/tauri.ts` | 删 aiDelivery 类型 import、30+ 个 `ai_*` invoke 封装（~634-673, 714-718）、openAiDeliveryWindow（~884-886）；bot 接口（93-116, 288-331）保留，仅删其中 `aiDeliveryEnabled` 字段（~107） |
| `src/utils/settings.ts` | 删 `aiDeliveryFloatingButtonPosition`、`aiDeliveryStateFilters` 字段（~57-58, 103-104） |
| `src/components/settings/BotChannelDialog.tsx` | 删 AI 交付推送开关（ai_delivery_enabled 对应 UI），保留 bot 配置 |
| `web/src/api.ts` | 删 AiDelivery 接口定义（4-9）与封装（94-114） |
| `web/src/App.tsx` | 删 AiDelivery import 与 `/ai-delivery` 路由分支（8, 51） |
| `web/src/screens/Nav.tsx` | 删"AI 交付"导航链接（~458） |
| `src/components/settings/AiUsagePanel.tsx` 等 | 保留（AI 用量功能） |

## 六、文档清理

| 文件 | 处理 |
|---|---|
| `README.md` / `README_zh.md` | 删 AI 交付段落（功能描述、目录结构、数据目录、changelog）；**保留**机器人通知描述 |
| `version.json` | 重写 changelogMd，去掉 AI 交付 v1.4.0 发布说明 |
| `RELEASE_NOTES_v1.4.0.md` | 整篇为 AI 交付发布说明 — 删除文件 |
| 根 `CLAUDE.md` | 删 AI 交付相关描述（117 行附近），更新模块清单 |
| `docs/bot-notification-setup.md` / `docs/机器人通知接入指南.md` | bot 保留，仅删其中 AI 交付关联内容 |

## 七、验证

1. `cd terminal-buddy/src-tauri && cargo check` — 零错误、零警告（至少无 ai_delivery 相关警告）
2. `cd terminal-buddy && npx tsc --noEmit` — 零错误
3. 全局 grep 确认无残留：`ai_delivery`、`AiDelivery`、`ai-delivery`（排除运行时数据与文档白名单）
4. `cargo test` 中 bot_binding_service 测试仍通过（bot 保留的验证）

## 八、不做的事

- 不删旧库中的 ai_entities 表数据（运行时数据，由用户自行决定）
- 不改 `commands/terminal.rs`、`commands/git.rs` 等共享服务
- 不动 `.codegraph/`、`.terminalbuddy-worktrees/`（运行时/空壳目录）
- 不删除机器人、Claude Hook、AI 用量功能
