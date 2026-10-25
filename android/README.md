# TerminalBuddy 安卓客户端（AI 对话）

Kotlin + Jetpack Compose 原生安卓工程，连接 TerminalBuddy 内嵌 Web API，实现**服务认证**与**原生 AI 对话**两部分。

界面与交互参考葫芦娃安卓客户端（`huluwa/android/app/src/main/java/com/huluwa/android/` 下的 `AiViewModel.kt`、`data/AiRepository.kt`、`data/AiModels.kt`、`ui/AiScreen.kt`、`ui/AiConversationMotion.kt`），配色改为 TerminalBuddy 的终端深色 + 薄荷绿强调色。

## 功能范围

| 模块 | 内容 |
| --- | --- |
| 认证 | 服务地址（支持反向代理子目录）、账号、密码登录；登录成功后先校验目标服务确实提供原生 AI 接口，再保存连接。每个账号的令牌用 Android Keystore AES/GCM 加密后写入 SharedPreferences，密码不落盘；支持多个账号添加、切换、重新登录和移除，401 仅使对应账号需要重新登录 |
| 首页 | 服务连接状态、项目选择、供应商与模型选择（只列出项目已启用的 Agent）、开始对话、最近对话列表与删除；更多菜单提供账号列表，内容静默同步，异常时仅在标题显示重连提示 |
| 对话 | 输入框上方模型与用量悬浮卡片（Agent 图标、模型、思考强度、上下文进度与输入输出 token，可收展；点击查看本轮、缓存及推理明细）、原生消息列表（用户 / AI / 工具执行日志，日志默认折叠、可展开）、流式回复、逐字显示、跟随滚动与「回到最新」、多行输入、发送即显示用户消息并清空输入、待确认消息气泡左侧发送进度、发送失败恢复草稿并复用 requestId 重试、中断、Claude / Codex 悬浮决策卡片（显示在 AI 上下文上方，单选与多选均确认本项后自动继续，全部完成后提交并收起；问题支持滑动 Tab 与前后切换，未完成也可切换并保留草稿；支持自定义回答、选项说明与待处理数量）、断线重连与 REST 轮询补偿 |
| 任务通知 | 决策、工具授权、任务完成及异常结束的系统横幅通知；点击恢复对应账号与会话，登录期间持续后台监听所有账号，进程回收后定时补偿 |
| 本地缓存 | 内存 + SQLite 缓存完整会话，再次进入立即显示已有正文并后台同步；项目与模型选择、已读记录、缓存和页面状态按账号隔离，切换保留各自磁盘缓存，退出或移除仅清理对应账号缓存 |
| 布局 | 与葫芦娃最新版一致的紧凑布局：首页为连接状态 + 新对话配置卡 + 两行最近对话列表（连续卡片、行内分割线），对话页独立为二级页并带单行导航、对话信息面板与底部操作面板 |
| 服务端能力 | 会话保存在服务端 `AiSessions/*.json`，App 退到后台任务继续执行；重新打开回到选择首页，可从「最近对话」继续 |

Codex 主回合结束后，服务端保留同一 app-server，继续接收后台命令、子代理及自动回复。后台执行时显示“后台任务执行中”；输入框为空时可中断任务，输入“继续”或补充要求后可直接发送。新版状态需要同时更新服务端和安卓客户端；旧版客户端仍能接收后续回复并发送消息。

Claude 用户决策与桌面端复用 `AskUserQuestion` / `PreToolUse` HTTP Hook 和同一个服务端决策处理流程，手机选择回填后继续执行；原生会话按运行实例隔离投递，桌面不会弹出手机的问题。Codex 通过自身提问协议接入同一套安卓悬浮卡片。

不包含终端页面、项目文件、Git 等桌面端其它能力。

## 任务通知

首次登录后，Android 13 及以上会申请通知权限；拒绝后可在首页提示或「更多 → 通知设置」中开启。决策和任务结束分别使用高重要性的系统横幅渠道，默认开启通知声音和双次振动，并统一设置高优先级消息通知。升级时将原有普通结果渠道迁移到新版横幅渠道，保留系统可识别的用户自选重要性、禁用状态和铃声设置；决策渠道继续沿用已有设置。任一渠道被降级或关闭声音与振动时，首页和对话页显示对应设置提示。

- 首页、其他对话页和切换到其他 App 后，决策与结束事件共用同一通知发送链路，由系统弹出类似微信的顶部横幅。若只出现在通知栏，请打开首页「更多」或对话页「对话操作」中的「决策横幅通知 / 结束横幅通知」，在系统中开启对应渠道的「悬浮通知 / 横幅 / 屏幕上弹出」、声音和振动；不同手机名称可能不同，勿扰模式也可能抑制提醒。应用无法代替用户开启厂商的悬浮开关。
- 需要选择、回答问题或授权工具时发送「需要你决策」通知，处理后自动移除；任务完成、失败或中断分别发送对应结果通知。每个账号、会话及决策独立去重，初次同步不会批量通知旧的已结束任务。
- 点击通知直接进入对应对话，支持 App 冷启动和已经打开的情况。任务所属账号与当前账号不同时先恢复原账号；登录过期则引导重新登录，再继续打开原任务。任务已删除时显示提示。
- 登录后即启动应用级监听和 `dataSync` 前台服务，约每 3 秒同步所有已登录账号的会话摘要；空闲时也保留接收，发现运行中会话后使用固定账号的独立 WebSocket 接收决策和结果，不依赖当前页面打开过该任务。发送前额外建立运行基线以捕获极短任务。页面退出、切换账号或保活服务启动失败不会取消存活进程中的监听。连接使用心跳检测，网络切换后立即重建订阅并唤醒补偿同步。通知栏的低重要性监听提示只在连接或运行状态变化时更新；只有所有账号退出登录后才停止监听及保活，CPU 唤醒锁只在任务执行期间持有。
- 首页与对话页均提供通知权限、决策及结束横幅渠道和后台运行设置。监听期间若检测到电池优化或后台限制，会提示「允许后台」；点击后由系统确认允许后台运行。厂商的自启动、后台活动和悬浮通知开关仍需按系统设置允许。通知未获权限、渠道被关闭或发送抛错时不记为已提醒，后续同步会重试待处理的决策及结果。
- 事件基线持久化到本机，WorkManager 每 15 分钟进行补偿同步。系统回收进程、Android 15+ 前台服务时长耗尽或系统省电调度时，补偿通知可能延迟；强行停止应用后需重新打开。手机仍需能访问所连接的 TerminalBuddy 服务，不依赖第三方推送平台。

## 源码结构

```text
app/src/main/java/com/terminalbuddy/android/
├── MainActivity.kt                 应用入口（edge-to-edge + Compose）
├── TerminalBuddyApplication.kt     依赖：AiRepository
├── AiViewModel.kt                  AI 页面状态、登录、会话生命周期、实时同步
├── notifications/
│   ├── AiTaskNotifications.kt      通知渠道、事件去重与持久化、账号和任务跳转信息
│   ├── AiTaskMonitor.kt            应用级实时订阅、心跳重连及摘要补偿
│   ├── AiTaskMonitorService.kt     登录期间持续接收消息的前台保活服务
│   └── AiTaskSyncWorker.kt         进程回收或服务超时后的定时补偿
├── data/
│   ├── AiModels.kt                 AiSession / AiMessage / AiCatalog / AiProject（camelCase 与 Rust 模型一致）
│   ├── AiRepository.kt             登录、REST 请求、WebSocket 实时会话流、按账号保存首页偏好
│   ├── AiAccountStore.kt           账号索引、独立加密登录信息与旧版单账号迁移
│   ├── AiSessionCache.kt           按账号隔离的内存与 SQLite 完整会话缓存
│   ├── SessionStore.kt             Keystore 加密令牌
│   ├── ServerAddress.kt            地址规范化、/api 拼接、/ws/ai 地址
│   └── Json.kt                     宽松 JSON 工具与错误文案
└── ui/
    ├── TerminalBuddyRoot.kt        根导航与微信式二级页转场
    ├── AiScreen.kt                 连接页、AI 首页、选择面板、删除确认
    ├── AiAccountsScreen.kt         账号列表、添加、切换、重新登录与移除
    ├── AiConversationScreen.kt     二级对话页、输入区、消息与确认卡片
    ├── AiApprovalCard.kt           悬浮决策卡片、多选草稿、自由切题、逐项确认与工具授权
    ├── AiConversationUsageCard.kt  输入框上方模型与用量悬浮卡片（收展动画、上下文进度条、token 行）
    ├── AiUsageBar.kt               模型与用量卡片入口（AiUsageCard）与用量详情（AiUsageSheet）
    ├── AiConversationMotion.kt     逐字显示与跟随滚动
    ├── AiAgentLogo.kt              Claude / Codex 标志图标
    ├── Theme.kt                    TerminalBuddy 深浅色配色
    └── Components.kt               标题栏、小图标、错误条、卡片等共享组件
```

## 近期交互与缓存同步

本轮迁移葫芦娃安卓端截至 `66d9fe6` 的 AI 近期改动，涵盖即时发送反馈、无感同步、完整会话缓存及多账号管理。TerminalBuddy 原有深浅主题、主题切换入口与原生 AI 长请求支持继续沿用。

- 点击发送后立即在消息区显示本地用户消息并清空输入框，可以继续编辑下一条；发送进度显示在刚发送的用户消息气泡左侧，服务端确认收到后隐藏。服务端确认后合并正式消息，避免 WebSocket 与 REST 响应重复插入。失败时撤回未确认占位，仅在输入框尚未填写新内容时恢复原草稿；重试复用同一个 `requestId`。
- 会话打开时先取内存，未命中时并行恢复 SQLite 正文与请求最新快照，旧磁盘结果不能覆盖已收到的网络结果。缓存仅保存服务端确认的完整快照，按 `revision` 防止倒退，流式更新每半秒合并落盘并只更新变化的消息行；从缓存恢复时直接初始化消息展示状态，减少进入页面时的闪空和重播。
- 首页已有数据时静默同步，不显示普通刷新动画；首页和对话标题只在断线重连时显示菊花与“重连中”，每次至少展示一秒。首页不提供手动刷新按钮。
- 「更多 → 账号切换」进入账号列表，可以保存同一服务器或不同服务器的多个账号；重复登录同一地址和用户名更新原条目。新登录与切换先验证目标服务，验证期间暂停原账号同步，失败保留原连接，返回可取消。登录过期可在列表重新登录；退出保留账号条目，移除当前账号会退出登录，操作只影响本机保存的信息，不删除服务端账号和对话。升级自动迁入原有单账号和该账号的首页偏好。

## 接口（均为 TerminalBuddy 现有 Web API）

REST 使用 `Authorization: Bearer <token>`，WebSocket 使用 `?token=` 查询参数；返回直接 JSON，不是 huluwa 的 `code/data` 包装。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/auth/login` | 服务账号密码认证，返回 `token`、`username` |
| `GET /api/projects` | 已登记项目与 `enabledAgents` |
| `GET /api/ai/catalog` | 可选供应商及模型（不含密钥） |
| `GET /api/ai/sessions` | 会话列表（不含消息） |
| `POST /api/ai/sessions` | 创建会话：`provider`、`providerId`、`projectPath`、`model` |
| `GET /api/ai/sessions/{id}` | 完整会话与消息 |
| `POST /api/ai/sessions/{id}/messages` | 发送消息：`text`、UUID `requestId` |
| `POST /api/ai/sessions/{id}/stop` | 中断当前回合 |
| `POST /api/ai/sessions/{id}/approvals` | 回答 Claude / Codex 确认与用户问题 |
| `DELETE /api/ai/sessions/{id}` | 删除空闲会话 |
| `/ws/ai/{id}?token=...` | 首帧完整会话，后续推送元数据与变化的消息 |

服务端实现见仓库 `docs/原生AI会话API.md`。

## AI 正文 Markdown

AI 助手正文使用原生 Compose Markdown 渲染，支持标题、粗体、斜体、删除线、有序及无序列表、引用、分隔线、链接、行内代码、多行代码与 GFM 表格。代码块和宽表格可横向滚动；长按仍可选择和复制文本。用户输入及工具执行记录保留原文。图片首版显示可点击链接，公式与 Mermaid 不在本轮范围。

每条消息保留自己的解析快照。解析在后台进行，流式阶段合并高频更新；新结果就绪前保留旧内容，输出结束后接收完整解析结果。相同正文不因工具记录、用量或连接状态更新而重新解析；列表项离屏再进入时复用已知结果。解析失败回退到原文，取消任务不覆盖旧结果。Markdown 解析状态不参与“思考中”显示判断。

两个 App 固定使用 `com.mikepenz:multiplatform-markdown-renderer-m3:0.38.0`，关闭文字尺寸补间，沿用现有消息列表的自动滚动。链接仅打开 HTTP/HTTPS；TB 的正文、链接、代码和表格随深浅主题切换。

## Ai 模型与用量悬浮卡片

Ai 二级对话页在原有输入框上方显示独立悬浮卡片，采用薄荷绿强调色、圆角细边框，随应用深浅主题切换。顶部标题栏仅显示单行对话标题；卡片首行依次展示“图标 + Codex / Claude + 模型 + 思考强度”，长模型名以省略号显示，右侧箭头可收起整张卡片；收起后不占布局高度，改为消息区右下角的浅色悬浮展开按钮。输入框保留原有外观、多行输入和发送 / 中断按钮。点击卡片首行，或从“对话操作 → 上下文与 Token”进入详情，可查看模型、思考强度、已用 / 容量、本轮用量、会话累计、缓存读写和推理输出明细。

- 模型和思考强度按当前会话的供应商标识、模型标识匹配服务端模型目录。思考强度显示中文等级；未提供时显示“跟随服务端”。
- 用量来自 TerminalBuddy 会话的 `usage`，复用原有 REST / WebSocket 实时同步；手机退到后台后服务端继续统计，重连恢复最新快照。
- 当前上下文与会话累计分别显示。Claude 上下文采用最近调用的输入量，包含缓存读取和写入；Codex 的上下文估算及配置容量使用 `≈` 标注。
- 缓存和推理明细是输入、输出的组成部分，不再重复相加；累计消耗可以超过上下文容量。
- 卡片刷新时保留本会话上次已知数值和上下文进度，新统计到达后直接替换；首次无数据时使用 `—K`，容量未知时不显示百分比，压缩后的等待状态在详情中说明。旧会话和中断后的部分统计会明确标注，旧版本服务端没有 `usage` 时仍可正常聊天。

相关代码为 `data/AiModels.kt`、`ui/AiUsageBar.kt`、`ui/AiConversationUsageCard.kt` 和 `ui/AiConversationScreen.kt`，接口口径见仓库 `docs/原生AI会话API.md`。

## 使用前提

1. 服务端为包含原生 AI 会话接口的版本（桌面端或独立服务器模式均可）。
2. 在 TerminalBuddy 开启 Web API，设置账号密码，并登记手机需要使用的项目目录。
3. 服务运行账户下已安装并登录 Claude Code / Codex CLI，供应商与模型在服务端配置；手机不保存模型 API Key。
4. 手机与服务端网络互通。模拟器访问本机服务用 `http://10.0.2.2:9600`；手机里的 `127.0.0.1` 指向手机自身。

## 构建

```bash
cd android
# 需要 JDK 17+ 与 Android SDK 36；local.properties 中配置 sdk.dir
./gradlew :app:assembleDebug        # 调试包
./gradlew :app:testDebugUnitTest    # 单元测试（地址处理、模型解析、请求体约束）
./gradlew :app:assembleRelease      # Release（未配签名时为 unsigned）
```

无需本机安装 JDK 与 Android SDK 的方式：在仓库根目录执行 `./build-android.sh`，通过一次性 Docker 容器产出 `dist/TerminalBuddy_<版本>_android.apk`（Release 已签名）。

在 Android Studio 中直接打开 `android/` 目录即可。

仓库根目录的一键脚本（参考葫芦娃 `build-android-release.bat`）：

```bat
build-android.bat            :: 自动找 JDK/SDK → 编译已签名的 Release APK → 安装 → 启动
build-android.bat <序列号>   :: 多台设备时指定目标
```

产物位于 `android/app/build/outputs/apk/release/app-release.apk`，使用项目现有 Release 签名。

脚本走 `scripts/build-android.ps1`：优先 `JAVA_HOME` 与 `android/local.properties` 的 `sdk.dir`，其次 Android Studio 自带 JDK 和 `ANDROID_HOME`；单台设备自动选择，多台提示输入序号。设置 `TERMINAL_BUDDY_NO_PAUSE=1` 可跳过结束时的等待按键。

## Release 签名

仓库内提交了专属签名 `android/release.keystore` 与凭据 `android/keystore.properties`（被 `.gitignore` 显式放行），任何机器 `:app:assembleRelease` 都会自动用它签名，产出的 APK 可覆盖升级。

- 别名 `terminal-buddy-release`，RSA 4096，SHA256withRSA，有效期至 **9999-12-31**（keytool 上限 2,912,148 天）
- 证书 SHA-256：`41F3E68E3D8FBF0DAF91F9D6A6B9DDC77B7C385E6640AC71F9394242CAADCF6A`
- 删除或更换该密钥后，已安装的旧版本只能卸载重装；请勿在其它应用上复用此签名

工程配置：包名 `com.terminalbuddy.android`，Kotlin 2.2.21，AGP 8.13.2，Gradle 8.13，Compose BOM 2025.10.01，OkHttp 4.12，kotlinx.serialization 1.9；minSdk 26 / targetSdk 36。
