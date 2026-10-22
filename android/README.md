# TerminalBuddy 安卓客户端（AI 对话）

Kotlin + Jetpack Compose 原生安卓工程，连接 TerminalBuddy 内嵌 Web API，实现**服务认证**与**原生 AI 对话**两部分。

界面与交互参考葫芦娃安卓客户端（`huluwa/android/app/src/main/java/com/huluwa/android/` 下的 `AiViewModel.kt`、`data/AiRepository.kt`、`data/AiModels.kt`、`ui/AiScreen.kt`、`ui/AiConversationMotion.kt`），配色改为 TerminalBuddy 的终端深色 + 薄荷绿强调色。

## 功能范围

| 模块 | 内容 |
| --- | --- |
| 认证 | 服务地址（支持反向代理子目录）、账号、密码登录；登录成功后先校验目标服务确实提供原生 AI 接口，再保存连接。令牌用 Android Keystore AES/GCM 加密后写入 SharedPreferences，密码不落盘；401 自动清除登录态 |
| 首页 | 服务连接状态、项目选择、供应商与模型选择（只列出项目已启用的 Agent）、开始对话、最近对话列表与删除 |
| 对话 | 原生消息列表（用户 / AI / 工具执行日志，日志默认折叠、可展开）、流式回复、逐字显示、跟随滚动与「回到最新」、多行输入、发送失败保留原文并复用 requestId 重试、中断、Codex 操作确认卡片、断线重连与 REST 轮询补偿 |
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
    ├── AiScreen.kt                 连接页、首页、二级会话页
    ├── AiConversationMotion.kt     逐字显示与跟随滚动
    ├── Theme.kt                    TerminalBuddy 配色
    └── Components.kt               标题栏、图标、错误条等共享组件
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

工程配置：包名 `com.terminalbuddy.android`，Kotlin 2.2.21，AGP 8.13.2，Gradle 8.13，Compose BOM 2025.10.01，OkHttp 4.12，kotlinx.serialization 1.9；minSdk 26 / targetSdk 36。
