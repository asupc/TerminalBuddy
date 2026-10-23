# TerminalBuddy 安卓客户端（AI 对话）

Kotlin + Jetpack Compose 原生安卓工程，连接 TerminalBuddy 内嵌 Web API，实现**服务认证**与**原生 AI 对话**两部分。

界面与交互参考葫芦娃安卓客户端（`huluwa/android/app/src/main/java/com/huluwa/android/` 下的 `AiViewModel.kt`、`data/AiRepository.kt`、`data/AiModels.kt`、`ui/AiScreen.kt`、`ui/AiConversationMotion.kt`），配色改为 TerminalBuddy 的终端深色 + 薄荷绿强调色。

## 功能范围

| 模块 | 内容 |
| --- | --- |
| 认证 | 服务地址（支持反向代理子目录）、账号、密码登录；登录成功后先校验目标服务确实提供原生 AI 接口，再保存连接。令牌用 Android Keystore AES/GCM 加密后写入 SharedPreferences，密码不落盘；401 自动清除登录态 |
| 首页 | 服务连接状态、项目选择、供应商与模型选择（只列出项目已启用的 Agent）、开始对话、最近对话列表与删除 |
| 对话 | 输入框上方模型与用量悬浮卡片（Agent 图标、模型、思考强度、上下文进度与输入输出 token，可收展；点击查看本轮、缓存及推理明细）、原生消息列表（用户 / AI / 工具执行日志，日志默认折叠、可展开）、流式回复、逐字显示、跟随滚动与「回到最新」、多行输入、发送失败保留原文并复用 requestId 重试、中断、Codex 操作确认卡片、断线重连与 REST 轮询补偿 |
| 布局 | 与葫芦娃最新版一致的紧凑布局：首页为连接状态 + 新对话配置卡 + 两行最近对话列表（连续卡片、行内分割线），对话页独立为二级页并带单行导航、对话信息面板与底部操作面板 |
| 服务端能力 | 会话保存在服务端 `AiSessions/*.json`，App 退到后台任务继续执行；重新打开回到选择首页，可从「最近对话」继续 |

不包含终端页面、项目文件、Git 等桌面端其它能力。

## 源码结构

```text
app/src/main/java/com/terminalbuddy/android/
├── MainActivity.kt                 应用入口（edge-to-edge + Compose）
├── TerminalBuddyApplication.kt     依赖：AiRepository
├── AiViewModel.kt                  AI 页面状态、登录、会话生命周期、实时同步
├── data/
│   ├── AiModels.kt                 AiSession / AiMessage / AiCatalog / AiProject（camelCase 与 Rust 模型一致）
│   ├── AiRepository.kt             登录、REST 请求、WebSocket 实时会话流
│   ├── SessionStore.kt             Keystore 加密令牌
│   ├── ServerAddress.kt            地址规范化、/api 拼接、/ws/ai 地址
│   └── Json.kt                     宽松 JSON 工具与错误文案
└── ui/
    ├── TerminalBuddyRoot.kt        根导航与微信式二级页转场
    ├── AiScreen.kt                 连接页、AI 首页、选择面板、删除确认
    ├── AiConversationScreen.kt     二级对话页、输入区、消息与确认卡片
    ├── AiConversationUsageCard.kt  输入框上方模型与用量悬浮卡片（收展动画、上下文进度条、token 行）
    ├── AiUsageBar.kt               模型与用量卡片入口（AiUsageCard）与用量详情（AiUsageSheet）
    ├── AiConversationMotion.kt     逐字显示与跟随滚动
    ├── AiAgentLogo.kt              Claude / Codex 标志图标
    ├── Theme.kt                    TerminalBuddy 深浅色配色
    └── Components.kt               标题栏、小图标、错误条、卡片等共享组件
```

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
| `POST /api/ai/sessions/{id}/approvals` | 回答 Codex 确认 / 用户问题 |
| `DELETE /api/ai/sessions/{id}` | 删除空闲会话 |
| `/ws/ai/{id}?token=...` | 首帧完整会话，后续推送元数据与变化的消息 |

服务端实现见仓库 `docs/原生AI会话API.md`。

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
