# 功能设计说明：Claude Code 机器人通知与远程决策

> 日期：2026-07-13  
> 状态：设计完成，待分阶段实现  
> 交付物：机器人通知、终端截图、引用回复回写终端的设计方案；本文件不包含实现代码。

---

## 1. 背景与目标

TerminalBuddy 已能识别 Claude Code 的三类状态：

- `confirmation`：等待用户确认；
- `question`：等待用户回答；
- `completed`：任务完成。

现有链路只发送 Windows 桌面通知。用户离开电脑后无法看到终端现场，也无法直接完成决策。本功能在现有检测器上增加机器人通道，目标是：

1. 向 QQ、微信、DingTalk、飞书等机器人发送文字通知；
2. 每条机器人通知附带对应终端的当前可见区域截图；
3. 用户引用“等待决策”的通知并回复时，将回复精确写入原决策会话的 PTY；
4. 支持多个机器人账号和多个通知目标，平台差异由适配器隔离；
5. 不降低现有 Windows 通知的可靠性，机器人发送失败时桌面通知仍正常工作。

## 2. 非目标与产品边界

- 首期不把机器人做成通用远程终端，机器人只能回复仍有效的 Claude Code 决策。
- 普通聊天消息、引用完成通知、过期引用都不能写入任何终端。
- 首期不转发连续终端输出，只发送触发通知时的一张静态截图。
- 不在前端 `ClientData/settings.json` 中明文保存 App Secret、Token 等凭据。
- “微信”默认指企业微信自建应用或经过风险确认的独立适配器。个人微信非官方协议存在封号和协议变更风险，不作为内置默认能力。
- 群 Webhook 只能作为单向通知降级方案。引用回复要求双向事件通道，不能用单向 Webhook 冒充完整接入。

## 3. 现有基础与复用点

| 现有模块 | 复用方式 |
|---|---|
| `src/services/claudeNotification.ts` | 保留状态检测、延迟、冷却和前台抑制逻辑；扩展通知事件数据和决策生命周期 |
| `src/components/TerminalInstance.tsx` | 持有 xterm 实例，在此注册截图提供器 |
| `src-tauri/src/commands/notification.rs` | 保留 Windows Toast；机器人通知从这里拆到独立服务 |
| `TerminalService::write_to_terminal` | 机器人回复最终仍走同一个 PTY 写入入口 |
| `crypto_service.rs` | 使用 Windows DPAPI 加密平台凭据 |
| `SettingsPage.tsx` | 新增独立“机器人通知”设置页，不继续挤入行为设置 |

机器人链路不能依赖 `webApiEnabled`。Web API 关闭时，桌面应用仍应维持机器人长连接并处理回复。

## 4. 参考项目结论

OpenClaw 与 Hermes 的共同做法是统一通道契约，并把入站、出站、媒体、会话路由和权限校验分开：

- 通道适配器负责连接、发送文本、发送图片、接收消息，不直接操作 agent 会话；
- 出站发送必须返回平台 `messageId`，供线程和引用回复路由；
- 入站消息先做身份、群策略、自消息过滤、去重，再交给会话路由；
- 图片先上传为平台媒体，再发送平台原生图片消息；失败时文字通知仍需送达；
- 飞书优先 WebSocket 长连接，不要求用户提供公网回调地址。

参考资料：

- [Hermes：Adding a New Messaging Platform](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/ADDING_A_PLATFORM.md)
- [Hermes：BasePlatformAdapter](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/base.py)
- [OpenClaw：Channel framework completeness](https://github.com/openclaw/openclaw/blob/main/.agents/skills/claw-score/references/completeness/channel-framework.md)
- [OpenClaw：Feishu outbound adapter](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/outbound.ts)
- [OpenClaw：Feishu inbound handler](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/monitor.message-handler.ts)

TerminalBuddy 不直接依赖 OpenClaw/Hermes 进程，只借鉴其适配器和路由边界。后续可额外提供兼容桥接适配器。

## 5. 总体架构

```text
Claude 输出
   │
   ▼
claudeNotification.ts ──检测/延迟/创建 decisionId──┐
   │                                               │
   ├── Windows Toast                               │
   └── 捕获 xterm 可见区域 PNG                      │
                                                   ▼
                                      dispatch_bot_notification
                                                   │
                                      BotNotificationService
                                                   │
                       ┌───────────┬───────────────┼───────────────┐
                       ▼           ▼               ▼               ▼
                    Feishu       QQ Bot         DingTalk         WeCom
                    Adapter      Adapter          Adapter         Adapter
                       │           │               │               │
                       └──── DeliveryReceipt(messageId) ───────────┘
                                                   │
                                      DecisionBindingStore
                                                   │
           引用回复事件 ──鉴权/去重/按 replyToMessageId 查找────────┘
                                                   │
                                        write_to_terminal(id, text)
```

核心原则：检测器只产生领域事件，平台适配器只处理平台协议，`DecisionBindingStore` 是外部消息与内部终端之间唯一允许的路由表。

## 6. 统一领域模型

建议在 Rust 新增以下模型，所有结构使用 `camelCase` 序列化：

```rust
struct BotNotification {
    event_id: String,
    decision_id: Option<String>,
    terminal_id: String,
    terminal_name: String,
    kind: NotificationKind,
    title: String,
    summary: String,
    prompt_excerpt: Option<String>,
    screenshot_png: Option<Vec<u8>>,
    created_at: DateTime<Utc>,
}

struct DeliveryReceipt {
    channel_id: String,
    target_id: String,
    message_id: String,
    media_message_id: Option<String>,
}

struct InboundMessage {
    channel_id: String,
    sender_id: String,
    conversation_id: String,
    message_id: String,
    reply_to_message_id: Option<String>,
    text: String,
    received_at: DateTime<Utc>,
}

struct DecisionBinding {
    decision_id: String,
    terminal_id: String,
    channel_id: String,
    target_id: String,
    external_message_id: String,
    status: Pending | Consumed | Cancelled | Expired,
    expires_at: DateTime<Utc>,
}
```

一个决策可发送到多个通道/目标，因此一个 `decisionId` 对应多条 `DecisionBinding`。任意一条合法回复成功写入后，该决策下所有绑定都变为 `Consumed`，避免手机和电脑重复作答。

## 7. 通道适配器契约

Rust 侧建立 `src-tauri/src/bot/`，不要把平台判断散落到 Tauri command 中：

```text
bot/
├── mod.rs
├── manager.rs              # 生命周期、重连、健康状态
├── models.rs               # 统一领域模型
├── binding_store.rs        # messageId ↔ decisionId 映射
├── credential_store.rs     # DPAPI 加解密与配置持久化
├── inbound_router.rs       # 鉴权、去重、过期检查、PTY 写入
├── adapters/
│   ├── mod.rs
│   ├── feishu.rs
│   ├── qq.rs
│   ├── dingtalk.rs
│   ├── wecom.rs
│   └── webhook.rs          # 单向降级，不支持回复
└── commands.rs             # Tauri 配置、测试、状态、通知命令
```

适配器必须具备：

- `start()` / `stop()`：连接和干净退出；
- `send_notification()`：发送文字，返回可引用的 `messageId`；
- `send_image()`：上传 PNG 并发送原生图片消息；
- `health()`：返回已配置、连接中、在线、错误等状态；
- 统一入站回调：产出 `InboundMessage`；
- 指数退避加抖动重连；
- 自消息过滤和 `messageId` 去重。

平台不支持可靠引用元数据时，不允许用“最近一次决策”猜测路由。可使用交互卡片回调或通知中的短决策码作为显式替代，但必须仍能唯一定位 `decisionId`。

## 8. 平台接入顺序与能力矩阵

| 平台 | 推荐接入 | 图片 | 引用/交互回写 | 首期优先级 |
|---|---|---|---|---|
| 飞书 | 自建应用机器人，WebSocket 事件订阅 | 先上传取得 `image_key`，再发图片消息 | 优先 `reply_to_message_id`，卡片按钮可作补充 | P0 |
| DingTalk | 企业内部应用机器人，Stream Mode | 通过机器人媒体接口上传/发送 | 有引用 ID 时直接映射，否则使用互动卡片回调 | P1 |
| QQ | QQ 开放平台机器人，Gateway WebSocket | 使用群/C2C 富媒体接口 | 使用平台消息引用；缺失时使用按钮或短决策码 | P1 |
| 企业微信 | 自建应用 + 回调服务 | 临时素材上传后发图片 | 回调能唯一关联时启用；否则使用模板卡片事件 | P2 |
| 群 Webhook | 飞书/DingTalk/企业微信群机器人 Webhook | 依平台能力 | 不支持可靠入站，仅通知 | P2 降级 |
| 个人微信 | 独立可选插件/外部桥接 | 依桥接实现 | 依桥接实现 | 默认不内置 |

飞书作为首个垂直切片：它同时覆盖长连接、文本、图片、引用回复和媒体上传，可用来验证统一契约。完成后再并行增加其他适配器，不在第一版同时调试四套协议。

## 9. 终端截图设计

### 9.1 不截整个窗口

直接截 Windows 窗口会遇到最小化黑屏、分屏裁剪、DPI 和其他 UI 泄露问题。截图应由 xterm 缓冲区生成，只包含目标终端的当前可见区域。

### 9.2 前端截图注册表

新增 `src/services/terminalSnapshot.ts`：

- `TerminalInstance` 挂载时注册 `terminalId -> capture()`；卸载时注销；
- `capture()` 读取 `terminal.buffer.active` 的当前 viewport；
- 在离屏 Canvas 中按 cell 绘制背景、前景、粗体、反色、宽字符和光标；
- 使用终端实际主题、字体和行列数，顶部增加终端名称与时间；
- 输出 PNG，最长边不超过 1600px，单图建议不超过 2MB；
- 截图失败或超过平台限制时只发送文字，并记录可见错误状态。

这种方式在窗口被遮挡或最小化时仍能生成稳定图片，也不会把连接导航、文件路径和其他分屏终端截进去。

### 9.3 隐私控制

- 设置中提供“附带终端截图”总开关，机器人通道默认开启但首次启用时明确提示可能包含密钥、Token 和业务数据；
- 可配置截图行数，默认当前可见 30 行；
- 后续可增加正则脱敏，本期不能宣称自动识别所有秘密；
- PNG 仅在内存中上传，不默认落盘。调试日志不得记录 Base64 或平台媒体下载地址。

## 10. 出站通知流程

1. 现有检测器确认事件，继续遵守通知延迟、冷却和前台抑制策略。
2. 为 `confirmation` / `question` 创建新的 `decisionId`；`completed` 不创建。
3. 从检测缓冲区提取纯文本摘要，限制长度并移除控制字符。
4. 请求目标终端截图，失败不阻断通知。
5. Windows Toast 与机器人发送并行执行，互不影响结果。
6. 每个适配器先发文字主体，再发或附加截图。
7. 只有文字主体发送成功且取得 `messageId` 后，才创建 `DecisionBinding`。
8. 平台媒体发送失败时保留文字消息和 binding，并在设置页状态中显示降级原因。

建议通知正文：

```text
Claude Code 等待回答
终端：生产环境排障
时间：2026-07-13 21:30:15

Claude 正在询问：是否继续执行数据库迁移？

请引用此消息回复。回复只会发送到本次待决策会话。
```

完成通知不显示“请引用回复”，其引用也不会建立回写路由。

## 11. 入站引用回复与 PTY 写入

入站路由必须按以下顺序执行，任一步失败都拒绝写入：

1. 校验平台签名/连接身份；
2. 丢弃机器人自身消息；
3. 按入站 `messageId` 去重；
4. 校验 `senderId` 在该通道允许名单中；
5. 要求存在 `replyToMessageId` 或可信交互回调中的 `decisionId`；
6. 查找绑定，要求 `status == Pending` 且未过期；
7. 确认 `terminalId` 仍存在，并且绑定属于决策通知而非完成通知；
8. 清理 NUL、ESC 等控制字符，限制 UTF-8 长度，规范换行为 `\r`；
9. 调用后端 `TerminalService::write_to_terminal`，默认在末尾追加一个 `\r`；
10. 写入成功后原子地把同一 `decisionId` 的全部绑定标记为 `Consumed`；
11. 回复机器人“已发送到终端：<name>”，并向桌面端 emit 审计事件。

不允许以下实现：

- 把无引用消息发送给当前激活终端；
- 用终端名称做模糊匹配；
- 用“最近一个 pending 决策”猜测目标；
- 先标记 consumed 再写 PTY，导致写入失败后无法重试；
- 把平台 Markdown、提及标签或引用正文一并写入终端。

首期每个决策只接受一次回复。多轮追问会由 Claude 产生新的通知和新的 `decisionId`。

## 12. 决策生命周期

- 新决策出现：创建 `Pending`；
- 用户在桌面终端交互：前端调用取消命令，改为 `Cancelled`；
- Claude 任务完成或终端关闭：改为 `Cancelled`；
- 机器人回复成功写入：改为 `Consumed`；
- 超过 TTL：改为 `Expired`，默认 TTL 为 30 分钟，可配置 1 至 1440 分钟；
- 应用重启：从持久化 binding 恢复，但仍需确认终端实例存在；PTY 不存在时立即过期。

binding 持久化到 `%APPDATA%/TerminalBuddy/Bots/decision_bindings.json`，使用临时文件 + rename 原子写入，并定期清理终态记录。文件不存消息正文和截图。

## 13. 设置界面

新增独立“机器人通知”页，使用 `MessageSquare` 图标。页面结构：

### 全局设置

- 启用机器人通知；
- 发送决策通知 / 完成通知；
- 附带终端截图；
- 截图最大行数；
- 决策回复有效期；
- 回写前追加回车；
- 允许的回复用户列表。

### 通道列表

每个通道一行显示平台、别名、目标会话、连接状态和最近错误，支持：

- 新增、编辑、禁用、删除；
- “测试连接”；
- “发送测试通知”；
- 查看所需权限和平台配置说明；
- Secret 输入只显示“已配置”，后端读取命令不得把明文返回前端。

通道配置保存到 `%APPDATA%/TerminalBuddy/Bots/channels.json`。敏感字段经 DPAPI 加密，非敏感展示字段保持普通 JSON，便于迁移和诊断。

## 14. 安全与可靠性

- 凭据仅在 Rust 后端解密和使用；前端保存时只提交，读取时返回 `hasSecret`。
- 所有入站消息必须有平台级鉴权；Webhook 回调需验签，长连接需校验官方 endpoint 和 TLS。
- `senderId` 默认拒绝，用户必须显式加入允许名单；群聊还需限制 `conversationId`。
- 终端回写是高风险能力，设置页首次启用时显示明确确认。
- 日志只记录 channel、eventId、messageId 的短哈希和状态，不记录 Token、完整聊天内容、截图。
- 适配器队列要有容量上限；同一通知按 `eventId` 幂等，重连后不得重复发送。
- 入站同一会话串行处理，避免两条同时回复通过 pending 检查。
- 网络失败使用指数退避；认证失败停止重试并在 UI 标红，避免持续触发平台风控。
- 退出应用时先停止接收入站，再等待发送队列短暂排空，最后关闭连接。

## 15. 分阶段实施

### 阶段 A：领域链路与截图

- 扩展 Claude 通知事件，增加摘要、`decisionId` 和取消生命周期；
- 实现 xterm viewport PNG；
- 实现 `BotNotificationService`、binding store、DPAPI 凭据存储；
- 增加 mock adapter，用本地事件验证出站、引用、过期、并发消费和 PTY 写入。

### 阶段 B：飞书垂直切片

- 完成 App ID/App Secret 配置和连接测试；
- WebSocket 接收消息事件；
- 文本与图片上传发送；
- `messageId`/引用回复路由；
- 白名单、去重、重连和状态展示。

阶段 B 完成后即形成可用版本，不等待其他平台。

### 阶段 C：DingTalk 与 QQ

- 复用统一契约增加 DingTalk Stream adapter；
- 增加 QQ Gateway adapter；
- 平台缺少可靠引用字段时，使用交互卡片或短决策码，禁止猜测。

### 阶段 D：企业微信与桥接

- 增加企业微信自建应用回调和媒体发送；
- 增加单向群 Webhook adapter；
- 评估 OpenClaw/Hermes 标准化桥接 adapter，个人微信只能作为显式风险插件启用。

## 16. 预计文件变更

### Desktop frontend

- 修改 `src/services/claudeNotification.ts`
- 修改 `src/components/TerminalInstance.tsx`
- 新增 `src/services/terminalSnapshot.ts`
- 新增 `src/components/settings/BotNotificationSettings.tsx`
- 修改 `src/components/SettingsPage.tsx`
- 修改 `src/services/tauri.ts`
- 修改 `src/utils/settings.ts`（仅非敏感 UI 偏好）

### Rust backend

- 新增 `src-tauri/src/bot/*`
- 新增 `src-tauri/src/models/bot.rs`
- 新增 `src-tauri/src/commands/bot.rs`
- 修改 `src-tauri/src/lib.rs`、`commands/mod.rs`、`models/mod.rs`
- 视具体平台增加 WebSocket、HMAC、URL 编码等依赖；不得触碰本地 patched `portable-pty`

## 17. 验收标准

1. Windows 通知行为与当前版本一致，机器人失败不影响桌面通知。
2. 飞书能收到决策、问题、完成三类中文文字通知。
3. 通知附带的 PNG 与目标终端当前可见内容一致，窗口最小化时仍可生成。
4. 两个终端同时等待决策时，分别引用回复能准确写入各自 PTY。
5. 无引用消息、引用完成通知、过期引用、非白名单用户都不会写入 PTY。
6. 同一决策在两个平台同时回复，只有第一条成功写入，第二条收到“决策已处理”。
7. 终端已关闭或用户已在桌面作答时，机器人旧引用无法写入。
8. 图片上传失败时文字仍到达，并在设置页显示降级错误。
9. 网络中断恢复后自动重连，不重复发送已经成功的通知。
10. 导出的配置和日志中不存在明文 App Secret、Token 或截图 Base64。
11. `npx tsc --noEmit`、`web/npx tsc --noEmit`、`cargo check` 全部通过。

## 18. 实施前需最终确认的产品选择

以下选择不阻塞阶段 A，但在接真实平台前必须确认：

- “微信”首个实现是否接受企业微信自建应用，而不是个人微信；
- 首发平台是否按本方案选择飞书；
- 机器人回复是原样文本加回车，还是第一版同时提供“允许/拒绝”交互按钮；
- 截图默认开启还是首次启用通道时由用户主动勾选。

建议默认值：飞书首发、企业微信代表微信、原样文本加一个回车、截图在启用机器人通知时默认勾选并显示隐私提示。
