# Claude Code 终端增强功能 · 设计方案

> 状态：已修订，可实施 · 日期：2026-10-15（修订版，以 `master` 提交 `b89d25f` 为基准复核）
> 交互预览：同目录 `index.html`（浏览器打开即可点击体验四个视图：右键菜单启动 / 模型供应商 / 默认配置文件 / 会话恢复）
> 约束：全平台通用功能——桌面端与 Web 端共用同一套 Rust 后端（Tauri 命令 + REST 对等接口）。
> 路径约定：本文所有仓库路径均以仓库根为起点，源码在 `terminal-buddy/` 下（如 `terminal-buddy/src-tauri/src/...`）。
> 行号基准：本文引用的行号以 `b89d25f` 为准，实施时先按符号名搜索复核，行号漂移以符号为准。
> 后续实施按 §9 阶段进行；§11 为实施交接清单；§0 为本次修订的裁决汇总。

## 0. 修订裁决（实施前必读）

与初版相比，本次修订做了以下**影响实现**的裁决，均已对照代码验证：

1. **供应商双源共存，不合并**：`0db8e02` 已上线 Docker 容器专用的 SQLite 供应商链路（`services/claude_provider_service.rs` + `/api/container/claude/providers*`，`ensure_docker()` 门禁，重写 live `settings.json`）。本方案新建的 `llm_providers.json` 是**全平台、按终端生效**的另一套数据源，走 `--settings` 临时文件，零污染用户配置。两者 P0 互不读写：旧链路写用户级 `settings.json` 做基线，新链路的 `--settings` 按官方优先级覆盖基线（CLI `--settings` > 用户文件），天然兼容。旧链路冻结（仅修 bug），新菜单/引用展开只读新 JSON。二期再议迁移。
2. **删除 `start_claude_session` 新命令**：初版的 `TerminalService::start_claude_session` 不存在，且其“先生成临时文件再进 `create_terminal` 展开”的流程会造成双生成、快照分叉。改为**复用现有两命令**：前端直接调 `start_terminal`（`extra_startup_mode='independent'`）或 `start_blank_terminal`（`initial_command`），把引用标记当字符串传进去，后端在两处展开点统一展开并生成临时文件。这与现有 `--resume` 透传模式完全一致，Web 端复用 `POST /api/terminals`，无需新增 launch 路由。
3. **叶子统一用 `independent`，不用 `append`**：`apply_extra_startup_params` 的 `append` 是“给每条 `startup_commands` 加后缀”，空列表时引用会静默丢失（`terminal.rs:907-924`）。所有模型启动一律 `independent`：引用命令整体替换 `startup_commands`，但 Profile 的 shell / 路径 / env 仍然生效。一期**不继承** `profile.startup_commands` 原内容（如需 `--dangerously-skip-permissions` 等，走启动参数预设叠加）。
4. **一期仅本地 shell 类型**：`build_init_commands` 的 `ssh/docker/k8s` 分支完全丢弃 `startup_commands`（`terminal.rs:822-894`），引用无法注入。叶子模型区仅对 `powershell/pwsh/cmd/bash/sh/zsh` 显示；`ssh/docker/k8s/mstsc` 不显示。分组（项目）走 blank 链，恒为本地 shell，不受影响。
5. **临时文件改名前缀**：`container_environment.rs:208` 已占用 `terminal-buddy-claude-<uuid>`（安装器临时目录）。新临时 settings 改用 `terminal-buddy-claude-settings-<uuid>.json`，清扫时严格限定“文件 + `.json` 后缀”，避免误删目录。
6. **门禁脚本先修再用**：`terminal-buddy/scripts/check-invoke-coverage.py` 硬编码扫描 `src-tauri/src/lib.rs`，实际注册点已迁至 `terminal-buddy/src-tauri/src/desktop.rs:423` 的 `generate_handler!`，当前跑即抛 `ValueError`。P0 第一步先修脚本（改扫 `desktop.rs`），否则 §9 门禁无法执行。
7. **Blank 快照走整条命令，不走 `extra_startup_params`**：后端 `create_blank_terminal` 硬编码 `extra_startup_params: None`（`terminal.rs:1565-1566`），`TerminalInfo.extra_startup_params` 对 blank 恒为空。Blank 的引用重放走 `initial_command` / `startup_command` 整条，前端 `extraParams` 存整条（含引用），恢复时重跑。`restoreTerminalTab` 的 blank 分支必须加引用识别，**不是**“逻辑不变自然兼容”。
8. **关闭清理有两个挂接点**：正常关闭（显式关闭/Web 关闭/PTY EOF）走 `teardown_terminal` → `release_terminal_resources`（`terminal.rs:576-593/539-566`）；进程退出走 `shutdown_all_terminals`（`terminal.rs:1454-1475`）。两处都要接临时文件删除，初版只点了后者。
9. **路径指正**：Claude settings 走 `resolve_claude_config_dir()`（`home/.claude`），不是 `dirs::config_dir()`；供应商文件与落盘小表走 `PathService::require_data_dir()`（失败显式报错，不静默回退）；临时 settings 走 `std::env::temp_dir()`。
10. **引用只复用 `reject_control_chars`**：`quote_cmd_argument`（`models/profile_validation.rs:54`，初版误写作 `quote`）只用于连接字段值，不对整条命令做 quote。引用标记含 `:`，与 shell 无冲突（`reject` 只拦控制字符）；临时文件路径与模型名在展开后分别经 `quote_cmd_argument` 包裹。

## 1. 背景与目标

在现有 Claude 能力（会话历史、指示灯、Hook、MCP、资产库、Docker 容器模型配置）基础上，补齐三块能力：

1. **Claude 默认配置文件管理**（§3）：读取 `~/.claude/settings.json` 并允许用户修改；用户未设置的值展示官方说明与默认值；修改后写回覆盖，自动备份。
2. **大模型供应商管理**（§4）：接入多个供应商（可设默认），填写名称 / URL / Key 后手动拉取模型列表，勾选可用模型，设置上下文大小与推理等级。参考 cc-switch（`D:\github\cc-switch`）。与已上线的 Docker 容器模型配置（SQLite + 重写 live 文件）是两套独立功能，关系见 §0.1 与 §6。
3. **模型启动与会话恢复**（§5）：项目/配置导航与历史会话右键菜单接入供应商与模型；启动时按配置替换模型名、上下文、URL、Key、推理强度，新建 Claude Code 会话（临时 settings JSON 落到 temp 目录）；程序关闭后的页签恢复纳入同一引用机制。

术语：

- **引用标记**：`__TB_CLAUDE_REF__:<providerId>:<modelId>`，快照中代替临时文件路径的引用（§5.2）。`providerId` 为 uuid；`modelId` 为供应商侧模型 ID，保存时拒绝控制字符与空白字符（§4.1 校验规则），保证引用标记是命令中的首个空白分隔 token，无歧义。
- **引用展开**：后端在 `create_terminal` / `create_blank_terminal` 内凭引用标记重新生成临时 settings 并替换为新路径（共用核心 `expand_leading_claude_ref`，§5.2 展开契约）。
- **模型五件套**：地址 / Key / 模型 / 上下文 / effort，引用展开时覆盖的全部内容。profile 自身 env 与用户级 settings 其余键不受影响。
- **`independent` 统一语义**：所有含引用的启动一律 `extra_startup_mode='independent'`（profile 路）或 `initial_command` 整条（blank 路），引用标记永远在命令最前（§5.2 步骤 5）。

## 2. 已核实的官方语义（来源：code.claude.com/docs）

设计依赖以下官方行为，均已从文档核实：

- **加载优先级**：Managed settings > CLI `--settings` > 项目 local（`.claude/settings.local.json`）> 项目 shared（`.claude/settings.json`）> 用户（`~/.claude/settings.json`）。本方案依赖“`--settings` 覆盖用户文件”实现与旧 Docker 链路的共存（旧链路写用户文件，新链路按终端覆盖）。
- **`claude --settings <文件|内联JSON>`**：只覆盖同名键，省略的键保留文件值；文件须为常规文件且 ≤ 2 MiB。这是需求 3「临时 JSON + 启动参数」方案的官方依据。临时文件远小于 2 MiB，天然满足。
- **`--model`**：覆盖 `model` 键与 `ANTHROPIC_MODEL`；**`--effort`**：`low|medium|high|xhigh|max|ultracode`（推理等级最高档为 `max`；`ultracode` 不做）。
- **推理等级共五档，最高 `max`**：供应商 / 模型级推理等级取值 `low|medium|high|xhigh|max`。settings 文件内 `effortLevel` / `modelSettings.<模型>.effortLevel` 官方文档仅收录四档（`low|medium|high|xhigh`），`max` 经临时 settings 的 `env.CLAUDE_CODE_EFFORT_LEVEL`（本机实测有效）+ 启动命令 `--effort max` 双通道生效，不写入 `effortLevel` / `modelSettings` 字段。`max` 双通道属“文档推理 + 本机实测”，非官方明示，联调时按验收清单验证服务端实际命中。**所有档位**都写 `env.CLAUDE_CODE_EFFORT_LEVEL`：该 env 键优先级最高，用户级 settings.json 残留的同名值会穿透临时文件未写的键压制所选档位（2026-10-16 实测：残留 `max` 压制 `xhigh`）。
- **env 按 key 合并**：临时 settings 里只需列出要覆盖的 env 键（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` 等），其余继承。
- **上下文修正官方变量**：`CLAUDE_CODE_MAX_CONTEXT_TOKENS`（文档原话：用于 `ANTHROPIC_BASE_URL` 路由场景修正窗口假设）——即「上下文大小」的落点；输出上限 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`；thinking 预算 `MAX_THINKING_TOKENS`。
- **`modelSettings`**：按模型规范名映射 `{ effortLevel, maxEffortLevel, autoCompactWindow }`，同文件内优先于顶层 `effortLevel`。

## 3. 需求一：Claude 默认配置文件管理

### 3.1 路径解析

- 默认 `~/.claude/settings.json`（Windows 即 `%USERPROFILE%\.claude\settings.json`）。
- **复用现有 `resolve_claude_config_dir(None)`**（`terminal-buddy/src-tauri/src/services/claude_hook_settings.rs:112-137`），完整优先级：`selected_dir` 参数（仅 Hook 管理页用，settings 编辑器传 `None`）> `settings.claude_hook_config_dir` > 环境变量 `CLAUDE_CONFIG_DIR` > `home/.claude`。读写目标为 `<configDir>/settings.json`，与 Hook 安装位置保持一致。
- 文件不存在视为「全新」，编辑器展示全官方默认，保存时创建文件与父目录。
- **写锁**：读改写必须持有 `claude_settings_write_lock()`（`pub(crate)`，新 service 同 crate 可直接复用，无需放宽可见性），与 Hook 安装（`claude_hook_settings.rs:302,338`）和旧供应商 `activate`（`claude_provider_service.rs:280`）互斥，避免并发写丢配置。

### 3.2 「保留官方说明」的实现

维护一份内置**官方模板快照**（随版本更新）：每键 `{ key, 类型, 中文说明, 官方默认值, 来源 }`。

模板取三路并集（合计 **279 个模板键**；预览页 pills 显示实时计数；**文档数字为整理时快照，实施时以模板源文件与预览页实时计数为准**）：

1. **官方文档** `code.claude.com/docs/en/settings-reference`：约 150 个顶层键（含 `sandbox.*` 30+、`permissions.*`、`worktree.*` 等子键路径）。
2. **cc-switch**（`live/floor.rs` 的关键/独有/残留键全表 + 预设 env + 表单模型字段）：补官方文档未收录的写入键，如顶层 `apiBaseUrl/primaryModel/smallFastModel/apiKey/awsAuthRefresh/awsCredentialExport/gcpAuthRefresh`，env 的 4 档模型映射（Opus/Sonnet/Haiku/Fable，注意不是 effort 档位）+ 4 个 `_NAME` 显示名、`ANTHROPIC_API_KEY`、`AWS_*`、`CLOUD_ML_REGION`、`GOOGLE_APPLICATION_CREDENTIALS`、7 个协议选择器、OAuth 三件套、`SUBAGENT_MODEL_FORCE`、10 个 thinking/artifact/流式兼容开关、`AUTO_MODE_SERVER`、`GATEWAY_MODEL_DISCOVERY`、`API_TIMEOUT_MS`、`DISABLE_TELEMETRY`、`MAX_MCP_OUTPUT_TOKENS` 等。
3. **本机实测**（`C:\Users\Administrator\.claude\settings.json`，2026-10-15）：14 个顶层键 + 20 个 env；其中 6 个 env 键官方文档未收录，标「未收录」但照样进模板：`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_ATTRIBUTION_HEADER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`CLAUDE_CODE_USE_POWERSHELL_TOOL`（另有 `ENABLE_TOOL_SEARCH` 在本机为 `false`，属 cc-switch 独有键）。

分组与键数（一期表单分组，预览页同构）：

| 分组 | 键数 | 内容要点 |
|---|---|---|
| 模型与推理 | 29 | `model` / effort 三件套 / 白名单黑名单 / `modelSettings` / 4 档模型映射 + 显示名 / subagent / `EFFORT_LEVEL`（未收录） |
| 连接与认证 | 32 | `apiKeyHelper` / `apiBaseUrl` / 凭据三形态 / AWS / GCP / 7 协议选择器 / 登录网关 |
| 上下文与记忆 | 22 | 双压缩开关 / 窗口五件套 / thinking 预算 / 输出上限 / MCP 与文件读上限 / CLAUDE.md / autoMemory / skills 预算 |
| 权限与沙箱 | 44 | `permissions` 只读 + `defaultMode` 等 5 子键 / autoMode / 危险提示开关 / `sandbox.*` 全族（总配/开关/命令/凭证/文件/网络） |
| 代理与思考 | 31 | thinking 全局开关 / 10 兼容开关 / artifact 新旧开关 / `AUTO_MODE_SERVER` / `ultracode`（官方同名 bool 键，与 CLI `--effort ultracode` 档位无关，本方案不做后者） / agent teams / worktree |
| 界面与终端 | 55 | 主题 / tui / vim / 时间 / `statusLine` / spinner / 进度条 / 补全 / IDE / 语音 / 反馈 |
| 通知与远程 | 11 | 通知渠道 / 手机推送 / 远控 / SSH / deeplink |
| 插件与技能 | 18 | 插件开关与配置 / marketplace 四件套 / 技能开关 / channels |
| MCP | 11 | 服务器允许/拒绝/`mcp.json` 启停 / claude.ai 连接器 |
| Hooks 与自动化 | 9 | `hooks` 只读 / 全关 / workflow / HTTP hook |
| Git 与署名 | 4 | `attribution` / 旧署名开关 / git 指令注入 / PR 模板 |
| 更新·企业·隐私 | 13 | 更新通道 / 版本上下限 / 托管策略 / transcript 保留 / 预检开关 |

表单设计（预览页已实现，可直接体验）：

- **分组 pills + 搜索 +「仅看已自定义」**：三者组合过滤；pills 显示 `当前可见数/总数`。
- **来源徽标**：cc-switch 补的键标 `cc-switch`，本机实测键标 `本机`，官方未收录标 `未收录`。
- **控件按类型**：bool / env 开关（`1/0/true/false` 四态）/ effort 下拉（`effortLevel` 五档，max 档标注经 `--effort` 生效；`env.CLAUDE_CODE_EFFORT_LEVEL` 五档下拉）/ 枚举下拉 / 数值 / 文本 / 密码 / JSON 对象（textarea +「格式化」按钮，2 空格缩进）/ 字符串数组（textarea，JSON 数组形态 +「格式化」按钮）。
- **JSON 校验与保存拦截**：对象/数组编辑框实时校验，边框绿=有效、红=无效并显示解析错误；无效 JSON 在 JSON 视图构建时静默跳过（该键不进入预览），点「保存修改」时拦截并列出无效键名；格式化按钮对无效内容不清空只提示。
- 未设置的键：输入区留空并展示中文说明 + 官方默认值（置灰，「官方默认」徽标）。
- 已设置的键：「已自定义」高亮 + 一键「恢复默认」（删除该键）。
- `permissions.allow/ask/deny` 规则数组与 `hooks` 段**只读展示**（写回时原样保留）；`hooks` 由 Hook 管理页维护，避免互踩。
- **自定义 env 入口**：模板之外的 env 变量可手动添加键名与值，随文件保存。
- 读写用 `serde_json::Value` **深合并**（子键路径如 `permissions.defaultMode` / `sandbox.network.*` 只动目标叶子，不整段覆盖），**用户文件中的未知键原样保留**（前向兼容官方新键）。根节点非对象或 `env` 非对象时拒绝写入并提示修复（与 `claude_provider_service.rs:159-161` 同口径）。

**表单收敛规则**（不常用默认不显示）：

- 模板 279 键中仅 **35 个常用键**默认展示；其余默认收起，组标题标注「已收起 N 项不常用」。
- **已设置的键豁免**：用户文件里已有的值无论常用与否默认都展示，避免自己的配置被藏起来；对其点「恢复默认」后该行收起。
- 两个找回入口：工具栏「显示不常用」开关展示全部 279 键；**搜索穿透收起**（搜 `sandbox` 等关键词时，不常用匹配项直接出现，无需先开开关）。
- 分组 pills 显示 `当前可见数/总数`。

常用 35 键清单：

| 分组 | 常用键 |
|---|---|
| 模型与推理（11） | `model`、`effortLevel`、`modelSettings`、`maxEffortLevel`、`fallbackModel`、`env.ANTHROPIC_MODEL`、4 档 `ANTHROPIC_DEFAULT_*_MODEL`（Opus/Sonnet/Haiku/Fable）、`env.CLAUDE_CODE_SUBAGENT_MODEL` |
| 连接与认证（3） | `env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`、`env.ANTHROPIC_API_KEY` |
| 上下文与记忆（4） | `autoCompactEnabled`、`autoCompactWindow`、`env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| 权限与沙箱（4） | `permissions`（只读）、`permissions.defaultMode`、`permissions.additionalDirectories`、`skipDangerousModePermissionPrompt` |
| 代理与思考（1） | `env.DISABLE_TELEMETRY` |
| 界面与终端（6） | `theme`、`tui`、`editorMode`、`language`、`statusLine`、`defaultShell` |
| 通知与远程（1） | `preferredNotifChannel` |
| 插件与技能（2） | `enabledPlugins`、`extraKnownMarketplaces` |
| Hooks 与自动化（2） | `hooks`（只读）、`disableAllHooks` |
| Git 与署名（1） | `attribution` |
| MCP、更新·企业·隐私 | 无常用键，默认整组收起（有自定义值或开开关时出现） |

### 3.3 写回与备份

- 原子写复用 `services/atomic_file.rs::atomic_write_private`（Unix 0600，Windows `ReplaceFileW`；可能含 `ANTHROPIC_AUTH_TOKEN`，必须 private）。
- 每次写前备份上一版为 `settings.json.<YYYYMMDD-HHMMSS>.bak`（同目录，`backupId` 即文件名；同一秒多次写则追加 `-<n>` 防覆盖），保留最近 **10 个**（评审结论：接受）。备份列表按文件名时间倒序，`createdAt` 从文件名解析（`%Y%m%d-%H%M%S`，解析失败回退文件 mtime）；恢复时加写锁、用 `atomic_write_private` 回写。
- Hook 安装用的单文件 `settings.json.terminalbuddy.bak`（`claude_hook_settings.rs:160`）不受影响：备份列表只管理 `settings.json.*.bak` 且排除该固定名。
- 提供备份列表与一键恢复。

### 3.4 后端接口

`terminal-buddy/src-tauri/src/commands/claude_config.rs` 新增 4 命令（该文件已有 Memory/CLAUDE.md 的 8 命令；新 service 命名 `claude_settings_service` 以区别于已被占用的 `claude_config_service` 概念）。薄包装，走现有 `claude_task` 阻塞池；注册点是 `terminal-buddy/src-tauri/src/desktop.rs` 的 `generate_handler!`（约 L423），不是 `lib.rs`：

- `read_claude_settings` → `{ path, exists, content: Value }`
- `write_claude_settings(content: Value)` → `{ path, backupId }`
- `list_claude_settings_backups` → `[{ id, createdAt, size }]` / `restore_claude_settings_backup(id)` → `{ path }`
- REST 对等（JWT 鉴权，用户级数据，不套 `ensure_project_scope`，不做 `ensure_docker`）：`GET/PUT /api/claude/settings`、`GET /api/claude/settings/backups`、`POST /api/claude/settings/backups/{id}/restore`
- Docker 完整桌面客户端（`src/components/browser` 经 `/api/desktop/invoke` 转发）如需复用桌面 settings UI，需把 4 命令同步进 `web/handlers/desktop_dispatch.rs` 白名单；移动轻量端（`web/src`）走上述 REST 直连。

## 4. 需求二：大模型供应商管理

### 4.1 数据模型（`<dataDir>/llm_providers.json`）

`<dataDir>` 由 `PathService::require_data_dir()` 解析（`TERMINAL_BUDDY_DATA_DIR` > `settings.data_path`（须绝对路径）> 默认 `%APPDATA%/TerminalBuddy`；不可用时显式报错，绝不静默回退）。读写一律走 `require_data_dir()`，失败向前端抛中文错。单文件存数组，风格对标 `projects.json` 与 `ClientData/*.json`（注：`Profiles/*.json` 是每 profile 一文件，不是单文件数组，本方案不仿它）。

```jsonc
{
  "providers": [
    {
      "id": "uuid",
      "name": "公司中转站",
      "baseUrl": "https://ai-proxy.company.com/v1",
      "authType": "ANTHROPIC_AUTH_TOKEN", // 或 ANTHROPIC_API_KEY，默认 TOKEN
      "apiKey": "dpapi:...（加密，落盘形态见下）",
      "isDefault": true,
      "defaultEffortLevel": "high",   // low|medium|high|xhigh|max，必填
      "modelsUrl": "",                // 可选：自定义模型列表端点
      "enabledModels": [
        { "id": "claude-opus-5-5", "enabled": true, "contextWindow": 200000, "effortLevel": "max" },
        { "id": "claude-sonnet-4-6", "enabled": true, "contextWindow": 200000, "effortLevel": "" } // 空=跟随供应商默认
      ],
      "sortIndex": 0,
      "createdAt": "2026-10-15T...",
      "updatedAt": "2026-10-15T..."
    }
  ]
}
```

字段与校验说明（保存时后端强制，与旧 `ProviderInput::validate` 同强度）：

- `name`：1–80 字符，拒绝控制字符；`baseUrl`：`http/https`、有 host、无 userinfo/query/fragment、≤2048 字符、拒绝控制字符，保存时去尾部 `/`。
- `authType`：仅 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`；临时 settings 按此键写入 Key（旧链路已支持双形态，新链路对齐）。
- `apiKey`：编辑时空/缺省表示沿用已保存密钥（绝不把掩码或 `keyTail` 写回）；新密钥 ≤8192 字符、拒绝控制字符。落盘加密形态为 `dpapi:<base64>`（桌面）/ `aesgcm:v1:<base64>`（服务端，内层带 `v1:`，见 `crypto_service.rs:152`）。P0 需新增通用 helper（建议将 `models/profile.rs` 的私有 `decrypt_password` 提升为 `pub(crate)` 通用函数，或在 `crypto_service` 封装 `encrypt_secret_field/decrypt_secret_field`），Profile 仅处理两个密码字段的现状不可直接复用。
- `defaultEffortLevel` 必填且为五档之一；模型级 `effortLevel` 可空（空=跟随供应商默认），非空时须为五档之一。
- `enabledModels[].id`：trim 后非空、≤256 字节，**拒绝控制字符与任何空白字符**（保证引用标记是首个空白分隔 token，展开无歧义；主流模型 ID 均无空白，约束可接受）。`enabled` 默认 true；`contextWindow` 为 0/缺省表示不覆盖（不写 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，继承环境）；预留 `maxOutputTokens`（→ `CLAUDE_CODE_MAX_OUTPUT_TOKENS`），一期可不做 UI，但模型保留字段。
- `sortIndex` 决定列表与菜单顺序；`createdAt/updatedAt` 为 RFC3339 字符串（与 Profile 的 `created_at` 同口径，`chrono::Utc::now().to_rfc3339()`）。
- 返回给前端时 `apiKey` 脱敏，只给 `keySet: bool` + `keyTail: 末4位`（与旧链路的 `has_api_key` 不同，新接口统一用前者；`keyTail` 仅展示，保存时忽略）。
- 新模型一律 `#[serde(rename_all = "camelCase")]` + 序列化单测；`commands/fs.rs::FileNode` 的 snake_case 是历史例外，绝不仿照（且现有 `last_modified/lastModified` 前后端不一致是已知 bug，不在本期范围）。
- **模型引用完整性**：`enabledModels[].id` 是供应商侧的自由字符串（中转站可随时改名/下线）。删除供应商是引用失效的唯一来源，已在 §5.3 覆盖；单个模型被供应商下线时，引用展开只校验 `providerId`，不校验 `modelId`（claude 启动后自然报错，错误信息比我们代报更准确）。

### 4.2 模型列表拉取（参考 cc-switch 简化）

后端 `fetch_llm_provider_models(baseUrl, apiKey?, modelsUrl?, providerId?)`，复用现有 `reqwest 0.12`（`Cargo.toml:44`，桌面/服务端共用）：

- 候选 URL 策略（按序，单测锁定顺序）：`modelsUrl`（显式）> `baseUrl` 本身若以 `/v1` 结尾则 `{base}/models` > `{base}/v1/models` > `{base}/models` > 剥离已知兼容后缀（`/api/anthropic`、`/anthropic`、`/claudecode` 等）后重拼 `/v1/models` 与 `/models`。
- 按序 GET，单候选 15s 超时；404/405 换下一个候选继续，其他状态直接返回错误（含状态码与 body 前 200 字符，Key 脱敏）。
- 解析兼容 `{ data: [{ id }] }` 与 `{ models: [...] }`（元素为字符串或 `{ id|name }`）两种形态；去重、trim、过滤空与含控制字符项；返回 `[{ id }]`。
- 请求头：同时发送 `Authorization: Bearer <key>` 与 `x-api-key: <key>`（中转站二选一居多，双头兼容最广；401/403 时错误直透，不自动重试另一头，避免翻倍延迟）。
- Key 来源：前端传编辑面板当前草稿 Key；为空且带 `providerId` 时后端用已保存解密 Key（只读，不落盘）。
- 触发：前端「获取模型列表」按钮手动触发，不轮询；Tauri 命令与 REST handler 均为 `async` 直接 `await` reqwest（不走 `claude_task` 阻塞池，避免占阻塞线程）；前端 loading 态 + 禁止重复点击（requestId 守卫，过期响应直接丢弃）。
- 成功后在编辑面板内直接展示勾选表（已配置但未返回的模型置顶保留，避免配好后被刷掉）。

### 4.3 后端接口

Tauri 命令（`commands/llm_provider.rs` 新文件，`commands/mod.rs` 重导出，`desktop.rs` 注册；CRUD 走 `claude_task`，`fetch` 走 async 直调）：

- `list_llm_providers` / `save_llm_provider`（新建+更新合一，有 `id` 为更新）/ `delete_llm_provider` / `set_default_llm_provider` / `update_llm_provider_order`
- `fetch_llm_provider_models`（拉取，只读，不落盘）
- `list_claude_launch_targets`（供右键菜单：仅返回可用模型 `{ providerId, providerName, isDefault, models: [{ id, effort, contextWindow }] }`，`effort` 为解析后档位（模型空→供应商默认），按默认优先再 `sortIndex` 排序，不含 Key）
- REST 对等（JWT 鉴权，用户级数据，不套 `ensure_project_scope`）：`GET /api/llm-providers`、`POST /api/llm-providers`、`PUT /api/llm-providers/{id}`、`DELETE /api/llm-providers/{id}`、`POST /api/llm-providers/{id}/set-default`、`PUT /api/llm-providers/order`（`{ ids[] }`）、`POST /api/llm-providers/fetch-models`、`GET /api/llm-providers/launch-targets`。含 Key 的请求/响应加 `Cache-Control: no-store`（与旧 `claude_provider_handler.rs:17` 同）。
- 完整桌面客户端转发：7 个 Tauri 命令按需同步进 `desktop_dispatch.rs` 白名单。

### 4.4 前端 UI

- 桌面端：Claude 面板新增「模型」分段（或设置页独立段）：供应商卡片列表（默认徽标 / 可用模型数 / 默认推理等级徽标 / 设默认 / 编辑 / 删除，删除需二次确认）+ 卡片下方内联编辑面板（名称 / URL / 认证方式 / Key（`password`，保存后清空回显 `keySet/keyTail`）/ 获取模型 / 勾选表 / 上下文 / 模型推理等级 / 默认推理等级），不使用弹窗。点「新增供应商」或卡片「编辑」即在列表下方展开面板（单开：同一时间只展开一个，正在编辑的卡片显示「编辑中」徽标）；保存/取消后收起。拉取中的过期响应直接丢弃，不覆盖面板。
- Web 端：`terminal-buddy/web/src/screens/` 对等页面（建议 `LlmProviders.tsx`），走 REST。移动端无 hover，二级菜单改为弹窗/底部 sheet 选模型。

## 5. 需求三：模型启动与会话恢复

### 5.1 菜单结构（`ConfigNav.tsx` 叶子/分组菜单）

插入点（`terminal-buddy/src/components/profile-config/ConfigNav.tsx`）：叶子在「命令行」后、「添加配置」前（约 L512-513）；分组在「命令行」后、分隔线前（约 L586-587），且仅 `project.path` 存在时整个启动区才渲染（含模型区）。注意分组菜单标题为「启动项目」而非「启动」。

- **仅本地 shell 类型显示模型区**：叶子按 `profile.terminalType` 判断，`ssh/docker/k8s/mstsc` 不显示（后端会丢弃引用，见 §0.4）；分组走 blank 链恒显示。
- **默认供应商的可用模型**：平铺为一级菜单项（`▶ <模型名> [推理等级徽标]`，徽标显示解析后档位）。
- **其他供应商**：二级子菜单（`▸ <供应商名>` → 其可用模型）。
- 无供应商 / 无可用模型时：显示引导项「配置模型供应商…」跳转到供应商页（评审结论：用引导项）。
- 数据源：`list_claude_launch_targets`，挂载 + 供应商变更事件刷新，右键打开时用缓存（启动时后端再校验，stale 可接受）。

### 5.2 启动流程

前端：点击模型项 → 直接复用现有命令（**无新增 launch 命令**）：

- 叶子（配置）：`start_terminal(profileId, extra=<引用命令>, mode='independent', ...)`，`extra` 为 `[引用标记] [preset.params?]`。
- 分组（项目）：`start_blank_terminal(shell, ..., startup_path=project.path, initial_command=<引用命令>)`，引用命令同上。`initial_command` 与 shell 启动命令同批次延迟写入，避免 300ms 抢拍（`terminal.rs:1543-1551`，复用 `--resume` 已有模式）。

后端：引用展开发生在现有两命令内部，临时 settings 只在这里生成一次（无双生成）：

1. 读供应商配置并解密 Key；取模型 `contextWindow` / `effort`（模型级空值→供应商默认；`contextWindow` 为 0/缺省则不写对应 env）。
2. 生成临时 settings JSON，写入 `std::env::temp_dir()/terminal-buddy-claude-settings-<uuid>.json`，经 `atomic_write_private`（Unix 0600；Windows 依赖用户目录 ACL）。**永不含 `hooks` 键**（单测锁定）：

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://ai-proxy.company.com/v1",
    "ANTHROPIC_AUTH_TOKEN": "<解密后的 Key>", // 按供应商 authType 二选一
    "ANTHROPIC_MODEL": "claude-opus-5-5",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "200000", // contextWindow 缺省时整键省略
    "CLAUDE_CODE_EFFORT_LEVEL": "xhigh" // 所有档位都写：压制用户级 settings.json 残留的同名值
  },
  "model": "claude-opus-5-5",
  "effortLevel": "xhigh",
  "modelSettings": { "claude-opus-5-5": { "effortLevel": "xhigh" } }
}
// 注：示例为非 max 档。level=max 时不写 effortLevel / modelSettings
//（文件键仅收录到 xhigh），env.CLAUDE_CODE_EFFORT_LEVEL=max 仍写，见步骤 3。
```

3. 组装启动命令：`claude --settings <quoted-tempfile> --model <quoted-model> --effort <level>`。临时路径与模型名分别经 `quote_cmd_argument` 包裹（路径含空格时加引号；模型名含 `"`/`%` 时拒绝并中文提示）；所有档位都在临时 settings 的 env 写 `CLAUDE_CODE_EFFORT_LEVEL=<level>`——该 env 键优先级最高，用户级 settings.json 残留的同名值会把临时文件未写的档位压回去（2026-10-16 实测：残留 max 压制 xhigh）；`level=max` 时不写 `effortLevel` / `modelSettings` 字段。
4. 叶子基于该 Profile 的 shell / 路径 / env（`create_terminal` 现有逻辑），`independent` 替换掉 `profile.startup_commands` 原内容；分组基于项目路径走 blank 链。两路都经 `spawn_terminal` → `build_terminal_env`，`TERMINAL_BUDDY_*` 与 `CLAUDE_CONFIG_DIR` 注入不受影响。**禁止另起 spawn 路径**。
5. 记录 `terminalId → tempFile` 映射（内存 + 落盘小表，见 §5.3）。`terminal_id` 在 `create_*` 顶部已生成，展开函数签名需传入。
6. **快照存引用**：前端 `extraParams`（`independent`）/ 后端 profile 路 `extra_startup_params`（`independent`）/ blank 路 `initial_command`（整条）里存的都是引用标记开头的命令，而非 `--settings` 旧路径。**展开契约**：
   - profile 路：在 `create_terminal` 的 `apply_extra_startup_params`（约 L1235-1236）**之后**、`build_init_commands`（约 L1253）**之前**，对合成后的 `Vec<String>` **逐条**展开；
   - blank 路：在 `create_blank_terminal` 的 `initial_command` 校验入队（约 L1545-1551）处，先展开、再 `reject_control_chars`、再 `push`；
   - 共用核心 `expand_leading_claude_ref(command: &str, terminal_id: &str) -> Result<String, String>` + `Vec` 包装 `expand_claude_refs_in_commands`：仅当去首空格后以 `__TB_CLAUDE_REF__:` 开头时展开，`providerId` 取到下一个 `:`，`modelId` 取首个空白分隔 token 的剩余部分（保存时已禁空白，无歧义），剩余后缀（preset/`--resume`）原样拼在展开后的 `claude ...` 之后；不含引用的命令原样返回；
   - `reject_control_chars` 始终在展开后对最终命令执行（profile 路在 `build_init_commands` 末尾约 L901-903，blank 路在入队前约 L1549）；
   - 引用含 `:` 与 shell 无冲突（`reject` 只拦控制字符，`quote` 拒绝集为 `"`/`%`，uuid 与模型 ID 均不在其中）。

> 关于 `env.CLAUDE_CODE_EFFORT_LEVEL`：本机实测值为 `max` 且生效，确认为 effort 的环境形态；官方文档未收录。该 env 键优先级最高，会压制文件键 `effortLevel` / `modelSettings`（2026-10-16 实测：用户级残留 `max` 压制所选 `xhigh`）。因此临时 settings **所有档位**都写该 env 键，非 max 档同时写文件键双通道生效。

### 5.3 临时文件清理与引用失效

- 终端正常关闭时删除映射的临时文件：挂 `teardown_terminal` → `release_terminal_resources`（显式关闭/Web 关闭/PTY EOF 唯一出口，幂等）；进程退出挂 `shutdown_all_terminals`（只发信号不 wait，内存映射丢失属预期）。创建事务失败（`TerminalCreation` 回滚）时同样删除已生成的临时文件，避免展开成功但 spawn 失败泄漏。
- 落盘小表（`<dataDir>/claude_temp_map.json`，`require_data_dir()`，`{ terminalId: { path, createdAt } }`，无密钥用 `atomic_write` 即可）：只增不改；终端关闭时删对应条目；启动时读表删除仍存在的残留文件后清空表（比 24h 兜底更精确）。
- 启动时清扫 `temp_dir()` 下 `terminal-buddy-claude-settings-*.json` 中超过 24h 的残留，严格限定“文件 + `.json` 后缀”（勿碰 `terminal-buddy-claude-<uuid>` 安装器目录）。
- Web 端同链路（`POST /api/terminals` 同样走 `TerminalService`，清理逻辑天然复用）。
- **旧路径兜底**：引用展开时若检测到命令含旧版绝对路径形态（含 `terminal-buddy-claude-settings-` 且文件已不存在），拒绝启动并提示「模型会话配置已过期，请从右键菜单重新选择模型启动」（不静默降级为空会话，避免用户对着一个没模型的终端困惑）。
- **供应商被删**：展开时 `providerId` 不存在 → 同样拒绝启动并提示去重新选择（不自动回退到默认供应商，避免带错 Key 连到错误的网关）。
- **默认供应商被删**：删除默认供应商时，`sortIndex` 最小的剩余供应商自动接任默认（保证菜单平铺区永远有内容）；删到零个时菜单显示引导项（见 §5.1）。删除时若有引用该供应商的页签快照，不阻止删除，启动/恢复时按失效分支提示。

### 5.4 全平台说明

- 路径：Claude settings 经 `resolve_claude_config_dir()`；供应商文件与落盘小表经 `PathService::require_data_dir()`；临时文件经 `std::env::temp_dir()`。Windows / macOS / Linux 由后端统一处理。
- 基座：Windows PTY 基座固定 `cmd.exe`，非 Windows 为 `$TERMINAL_BUDDY_SHELL` 或 `/bin/bash`（`terminal.rs:47-51`）；另有 `default_shell_command`（首条命令 `powershell.exe`/`bash`）与 `target_shell`（容器内 `cmd.exe`/`sh`）两套概念，引用展开是纯字符串替换，与三者无关。
- 引用校验只复用 `reject_control_chars`；`quote_cmd_argument` 仅用于包裹临时路径与模型名参数值，不对整条命令做 quote。

### 5.5 Claude 会话入口的模型匹配

自定义模型不只挂在项目/配置导航，「恢复历史会话」同样要能选模型。挂接点（桌面端）：

- **历史面板右键**（`HistoryPanel.tsx` 单选菜单，约 L730-752）：在「恢复会话 / 恢复会话+preset」之后、查看详情之前插入「指定模型恢复」区——默认供应商可用模型平铺，其他供应商二级子菜单（与 §5.1 同构）。多选分支（约 L730-736）无恢复项，不挂接。选中后调 `resumeClaudeSession(session, preset?, vendorRef?)`，`vendorRef={ providerId, modelId }`。
- **历史面板双击**：行为不变（固定无 preset 的 `resumeClaudeSession(session)` + `--resume`，不强制选模型），避免打断现有习惯。注：初版“按原预设”措辞有误，双击从不带 preset。
- **总览卡片**：只有跳转/回放/清除，无启动语义，**不挂接**。
- Web 端 `ClaudeHistory.tsx`「恢复此会话」菜单项（约 L529-545）同步接入模型区（走 `POST /api/terminals` 同一引用展开）。注意 Web 现状（约 L149-179）直接 `createTerminal('', { startupCommand: 'claude --resume …' })`，无 preset；点击行是进回放而非恢复，与桌面双击语义不同，P2 保持差异，只加模型区。

启动命令组装（`resumeClaudeSession` 内，有 `vendorRef` 时 profile 与 blank 两路统一走 `independent` 语义）：

```
[__TB_CLAUDE_REF__:<providerId>:<modelId>] [preset.params] --resume <sessionId>
```

- 引用标记永远在最前，后端展开为 `claude --settings <新文件> --model <id> --effort <level>` 前缀后，再拼接预设参数与 `--resume`。
- 有 `vendorRef` 时**不继承** `profile.startup_commands`（`independent` 替换），profile 的 shell/路径/env 仍生效；`pickClaudeProfile` 规则不变（有项目时 `profile.group === project.name`，否则目录祖先最深匹配，`resumeClaudeSession.ts:31-51`，绝不跨项目借凭据）。
- 无 `vendorRef` 时保持现有两路不变：profile 路 `append`（`preset + --resume` 拼到原 `claude` 命令后），blank 路 `claude ${extraParams}` 且前端不存 `extraParams`。
- 有 `vendorRef` 的 blank 路必须存快照：`makeSession` 补 `extraParams=<整条引用命令>、extraParamMode='independent'`（现有 blank 不存是为非模型 resume 设计的，模型 resume 必须存，否则重启恢复丢失模型）。
- 页签快照（`extraParams`）存整条含引用的命令（不含 `--resume`，`--resume` 只在恢复时临时拼）；恢复/以此新建时后端重新展开引用，保证供应商改 Key 后重建拿到最新配置。
- preset 过滤：指定模型恢复时，只列出 `enabled && mode==='append'`（现有 `presetsFor`，`HistoryPanel.tsx:364-373`）且 `params` 不含 `--model/--settings/--effort` 的 preset，避免与引用展开的同名参数打架（CLI 以后者为准，代码不做去重，必须前置过滤）。

### 5.6 程序关闭后的会话恢复

模型终端的恢复纳入现有 `saveTabsToStorage → restoreTabs/restoreTerminalTab` 链路，不另起机制，但**有两处必需改动**（初版“逻辑不变自然兼容”不成立）：

**退出时（`App.tsx saveClaudeSessionsBeforeExit`，约 L271-312）：**

- 判定扩展：只改 `App.tsx:290-291` 的 `configuredClaude` 正则分支（另两套正则 `utils/claudeLaunch.ts:7` 与 `sessionRestore.ts:66` 不动），增加 `|| containsClaudeRef(command)`（与恢复链共用 helper：首个空白分隔 token 以 `__TB_CLAUDE_REF__:` 开头；`independent` 下 `configuredCommands=[extraParams]` 恒为首 token 命中，`append` 存量不会误命中）——模型终端的 `extraParams` 含引用标记，同样被识别为 Claude 终端并采集 `claudeSessionId`。`hookIdentified`（`runtimeKind==='claude'`）分支天然覆盖运行中的模型终端。
- 快照内容不变：`extraParams`（含引用标记、不含 `--resume`）+ `claudeSessionId` 照常落盘（`saved_tabs` 经 `writeClientData`）。
- 进程退出后，后端 `shutdown_all_terminals` 发信号终止全部 PTY（`kill_without_wait`，非同步 wait），内存中的 `terminalId → tempFile` 映射丢失；临时 settings 文件残留，由下次启动时读落盘小表 + 24h 清扫处理（见 §5.3）。

**启动时（`sessionRestore.ts`，需改两处）：**

1. 清理 `extraParams` 中的旧 `--resume`（现有正则 `/--resume\s+[0-9a-fA-F-]+/g`，不触碰引用标记，无需改动）。
2. `autoResumeClaudeSession` 开启且有 `claudeSessionId` → 临时拼接 `--resume <id>`（仅本次启动调用，不落盘，现有防叠加逻辑；默认值 `true`，`utils/settings.ts:127`）。
3. 传给 `startTerminal`（`independent`，`launchParams` 含引用）/ `startBlankTerminal`（`blankCommand`）→ 后端引用展开：按**当前**供应商配置重新生成临时 settings 并注入。
4. **必需改动一**：`blankCommand` 判定（约 L87-91）加引用识别——新增 `containsClaudeRef()` helper，`isClaudeCommand(base)` 判定改为 `isClaudeCommand(base) || containsClaudeRef(base)`（`containsClaudeRef` 仅判断首个空白分隔 token 是否以 `__TB_CLAUDE_REF__:` 开头，与后端展开条件一致）。否则含引用的 blank 命令会被当成“非 claude 命令”而丢掉 `--resume`。
5. **必需改动二**：失败提示——现有内嵌 `restoreTab` 的 `try/catch`（`restoreTabs` 内约 L147-162）只 `console.error`，P1.5 须补：引用展开失败（供应商被删）时 `showToast` 明确提示，单个页签失败不中断其余恢复（并发池隔离已存在）。

**恢复语义说明（写进 UI 文案与验收）：**

- 恢复的是「同模型配置的新终端 + `--resume` 接回对话」，不是 PTY 输出历史（输出历史重启必然丢失，现有行为一致）。
- `autoResumeClaudeSession` 关闭时：退出采集直接返回（`App.tsx:273`），`claudeSessionId` 不落盘；页签照常恢复为空模型终端（`extraParams` 引用重建，可新开对话），不拼 `--resume`。
- Web 端刷新不走恢复链（`restoreTabs` 的 `isBrowserClient()` 分支只恢复 editor + `reconcileBackendSessions`，后端 PTY 存活只重连 WS），不受影响。

## 6. 与现有能力的兼容（只增不改：除注明外不改现有行为）

- **Hook**：临时 settings 永不含 `hooks` 键（生成器强制 + 单测），用户级 hook 照常生效；env 按 key 合并，`TERMINAL_BUDDY_*` 等注入变量来自进程 env（`build_terminal_env`，`terminal.rs:688-709`），不受影响。新启动必须走 `create_*` → `spawn_terminal`，禁止另起 spawn 路径，否则丢注入。Hook 服务零改动。
- **指示灯 / 会话历史**：新会话是正常 claude 进程，Hook 事件驱动的指示灯（`terminalActivities` + `claudeIndicator` 五态）与 `~/.claude/projects` 索引链路零改动。注：初版“进程树检测”表述有误，`src-tauri` 内无 claude 进程树扫描（`process_tree` 仅 Git 用）；退出采集的 `get_claude_sessions_for_terminals` 进程快照同样零改动。
- **启动参数预设**：`startupPresets` 的 append 模式可继续叠加（如 `--dangerously-skip-permissions`），前后端均为纯字符串拼接，不会报错。但 preset 自带 `--model/--settings/--effort` 时会与引用展开的同名参数并存（CLI 以后者为准），故模型启动与指定模型恢复的 preset 列表必须前置过滤含这三者的 preset（§5.5）。
- **「以此配置新建终端」/ 重启恢复 / Web 以此新建**：三条路径都是快照重放，但分两路：profile 路重放 `extra_startup_params`（`independent`，含引用），Web 经 `TerminalInfo.extra_startup_params` 复用；blank 路后端快照恒为空，重放走 `initial_command` / `startup_command` 整条（含引用），前端 `extraParams`（`independent`）是唯一载体。后端启动时重新生成临时文件，因此原终端关闭删除旧文件后，重建不受影响。引用展开失败（供应商被删）时拒绝启动并明确提示。
- **Web 会话隔离**：`webApiShareSessions` 权限矩阵（`models/terminal_access.rs:46-79`，经 `TerminalService::authorize` 判定，handler 禁止硬编码 owner 比较）不变；供应商配置是用户级数据，桌面/Web 共享同一 `dataPath` 天然一致。WS 升级前鉴权（未知 404/无权 403，`ws.rs:58-88`）与 5 秒复查（`WS_AUTH_RECHECK_INTERVAL`）保持，新模型终端走正常终端链路自动继承。
- **旧 Docker 供应商链路**：`claude_provider_service` + `/api/container/claude/providers*`（`ensure_docker()` 门禁）冻结保留，仅限容器 Web。它写用户级 `settings.json` 做基线，新链路 `--settings` 按官方优先级覆盖基线，两者功能正交。旧链路单测已保证切换保留 `hooks/permissions`（`:311-324`），新 settings 编辑器写回时同样原样保留这两段。

## 7. 安全

- API Key：落盘加密（`llm_providers.json` 的 `apiKey` 字段，`dpapi:`/`aesgcm:v1:` marker）、返前端脱敏（只给 `keySet` + 末 4 位，保存时忽略回显）、日志脱敏（不打印 Key 与临时 settings 内容，只记 `providerId/modelId`；临时文件路径可记，内容禁记；`fetch` 错误 body 截断 200 字符且脱敏）。
- 临时 settings、供应商文件与 settings 备份：经 `atomic_write_private`（Unix 0600；Windows 依赖 `%TEMP%` / `%APPDATA%` 用户目录 ACL）。
- `fetch` 仅手动触发，不轮询；15s 超时 + 前端 loading/requestId 守卫防止卡住 UI（命令 async 直调，前端加 loading 态）。
- 引用展开的 `providerId/modelId` 校验：`providerId` 须为已存 uuid；`modelId` 已在保存时禁空白/控制字符，展开时再经 `quote_cmd_argument` 包裹，含 `"`/`%` 拒绝并中文提示。`reject_control_chars` 在展开后对最终命令执行，防注入。

## 8. 与 cc-switch 的取舍

| cc-switch 做法 | 本方案 |
|---|---|
| 切换供应商 = 重写 `~/.claude/settings.json` 相关段（floor/投影） | **旧链路已有**（`claude_provider_service::Projection`，Docker 容器专用，冻结保留）；**新链路不做**：供应商切换走 `--settings` 临时文件，零污染用户配置；settings 编辑器只做「读改回写 + 备份」 |
| 按供应商开终端：临时 JSON + `claude --settings` | **采用**：即本方案 §5.2 |
| 候选 URL 拉取模型 + 双形态解析 | **采用**（简化版，§4.2） |
| 端点测速 / 故障转移 / 用量统计 / models.dev 同步 | **一期不做**，数据模型预留字段（`modelsUrl`、`sortIndex`、`maxOutputTokens`），二期按需加 |
| SQLite 存储供应商 | **旧链路用 SQLite**（容器专用现状）；**新链路用 JSON 文件**，与本项目 `projects.json` / `ClientData/*.json` 单文件风格一致，桌面/服务端共用 `dataPath` |

## 9. 实施阶段与验收

- **P0-0 脚本修复（先行）**：修 `terminal-buddy/scripts/check-invoke-coverage.py` 改扫 `terminal-buddy/src-tauri/src/desktop.rs` 的 `generate_handler!`（当前硬编码 `lib.rs` 已失效），并在本文 §11 落盘正确运行路径（`terminal-buddy/` 下执行 `python scripts/check-invoke-coverage.py`）。
- **P0 后端**：`models/llm_provider.rs`（camelCase 模型 + 校验）+ `services/llm_provider_service.rs`（CRUD/加密helper/拉取/临时 settings 生成/清扫/落盘小表）+ `services/claude_settings_service.rs`（settings 读改回写/深合并/备份，持写锁）+ `commands/llm_provider.rs`（7 命令）+ `commands/claude_config.rs` 扩展（§3.4 四个命令）+ 引用展开（`expand_leading_claude_ref` + `Vec` 包装，接 `create_terminal` 的 apply 后/build 前与 blank `initial_command` 入队前，签名带 `terminal_id` 以登记映射）+ 清理双挂接点（`release_terminal_resources` + `shutdown_all_terminals` + 创建回滚）+ REST 对等接口（§3.4/§4.3，共 4+8 路由）+ `cargo test` 用例（校验/展开/投影永不含 hooks/备份轮转/候选 URL 顺序/序列化）。
- **P1 桌面 UI**：供应商管理页 + settings 编辑器（分组表单/JSON 双视图 + 搜索过滤 + 收敛规则 + JSON 格式化校验 + 深合并写回）+ `ConfigNav` 右键菜单区（含本地类型门控与引导项）+ 历史面板「指定模型恢复」区（含 preset 过滤）+ `resumeClaudeSession` 的 `vendorRef` 扩展（含 blank 快照补存）。注意 `tsc` strict 的 `noUnusedLocals/noUnusedParameters`。
- **P1.5 恢复链路**：退出采集加引用识别（只改 `App.tsx:290-291` 分支，与恢复链共用 `utils/claudeLaunch.ts` 的 `containsClaudeRef`）+ `restoreTerminalTab` blank 分支加引用识别 + 恢复失败 toast；联调验证引用重建与失效隔离。
- **P2 Web UI**：`web/src/screens/` 供应商页（建议 `LlmProviders.tsx`）+ settings 编辑器对等实现（REST 直连）；`Nav.tsx` 项目启动与 `ClaudeHistory.tsx` 恢复菜单同步接入模型区（移动端用弹窗/底部 sheet 替代二级 hover 菜单；保持“点击行进回放”与桌面双击的差异）。
- **P3 联调**：`npx tsc --noEmit`（桌面 + Web）、`cargo check`、`cargo test --lib`、`python scripts/check-invoke-coverage.py`（在 `terminal-buddy/` 下执行；新增 11 命令需同步覆盖率基线，无桌面调用的需书面理由）。

验收清单：

- 供应商 CRUD / 默认接任（删默认自动 `sortIndex` 最小接任）/ 拉取 / 勾选 / 删除二次确认；`authType` 双形态写入正确 Key 键；Key 编辑留空沿用，掩码不写回。
- settings 双视图编辑 + JSON 格式化 + 无效拦截 + 恢复默认 + 备份恢复（10 个轮转，Hook 单 `.bak` 不受影响）+ hooks/permissions 段不受影响；与 Hook 安装/旧供应商切换并发写不丢配置（写锁）。
- 右键菜单平铺/二级正确、仅列可用模型；`ssh/docker/k8s/mstsc` 无模型区；无供应商时显示引导项；分组无 path 时整区隐藏符合现有行为。
- 历史面板「指定模型恢复」可选中模型并拼出引用命令（含 preset 过滤掉 `--model/--settings/--effort`）；双击行为不变（无 preset）；多选菜单无恢复项。
- 启动后 `claude` 实际命中配置的 URL/模型/`max` 双通道（以会话内 `/model` 或服务端日志为准）；`contextWindow` 缺省时不写覆盖 env。
- 终端正常关闭/异常退出/创建失败三路临时文件均被清理；落盘小表条目同步删除；重启后残留清扫仅命中 `terminal-buddy-claude-settings-*.json` 文件。
- 退出重进后模型终端页签恢复且接回对话（`--resume` 生效，blank 与 profile 两路）；供应商被删时单页签失败隔离 + toast，不中断其余恢复；`autoResume` 关闭时恢复为空模型终端。
- Web 端全流程对等可用；Docker 下旧供应商 `activate` 仍可用，且新模型终端覆盖验证通过（`--settings` 优先于用户文件）。
- `check-invoke-coverage.py` 通过；`cargo test --lib` 通过。

## 10. 评审结论（已定）

1. 推理等级共五档、最高 `max`（`ultracode` 不做）：`max` 经 `env.CLAUDE_CODE_EFFORT_LEVEL` + `--effort max` 双通道生效，不写入 `effortLevel` / `modelSettings` 字段；所有档位都写该 env 键以压制用户级残留。——**接受**
2. 无供应商时菜单显示引导项（备选整区隐藏已否决）。
3. settings 备份保留 10 个。——**接受**
4. Web 端允许编辑供应商 Key（与桌面一致）。——**接受**
5. settings 编辑器 JSON 对象/数组行支持格式化 + 实时校验 + 保存拦截。——**接受**
6. 引用失效（供应商被删 / 旧路径残留）一律拒绝启动并提示重选，不静默降级、不自动回退默认供应商。——**接受**
7. 程序关闭恢复纳入本次计划：退出采集扩展 + 引用重建 + 单页签失败隔离。——**接受**
8. 供应商双源共存：旧 SQLite 链路冻结为 Docker 容器专用，新 JSON 为全平台模型启动唯一源，P0 不迁移，靠 `--settings` 优先级共存。——**接受（本次修订新增）**
9. 删除 `start_claude_session` 新命令，复用 `start_terminal`（`independent`）/ `start_blank_terminal`（`initial_command`），临时文件只在展开点生成一次。——**接受（本次修订新增）**
10. 一期仅本地 shell 类型显示模型区；模型启动不继承 `profile.startup_commands`，额外 flags 走 preset。——**接受（本次修订新增）**
11. 临时文件前缀改为 `terminal-buddy-claude-settings-`，清扫限定文件 + `.json`。——**接受（本次修订新增）**
12. P0 先修 `check-invoke-coverage.py`（改扫 `desktop.rs`），注册点以 `desktop.rs` 为准。——**接受（本次修订新增）**

## 11. 实施交接（新会话入口）

新会话按以下顺序阅读与实施：

1. 先读 §0 裁决与 §1 术语（`independent` 统一语义、无 `start_claude_session`、双源共存是全方案地基）。
2. 再读 §2 官方语义（`--settings` / `--effort` / `max` 双通道）与 §5.2（引用格式、展开点、失效分支：前后端对接契约）。
3. 后端从 P0-0 开始：先修覆盖率脚本 → 供应商 CRUD → 引用展开（含双挂接点清理）→ settings 读写（持写锁）→ REST 对等；每步跑 `cargo check` + `cargo test --lib`。
4. 前端对照预览 `index.html` 四个视图实现 P1/P2；新增 Tauri 命令后在 `terminal-buddy/` 下跑 `python scripts/check-invoke-coverage.py`。
5. 联调按验收清单逐项验证，重点验证：引用重建（以此新建/重启恢复，blank 与 profile 两路）、失效隔离、备份恢复、Web 对等、旧链路共存。

关键文件索引（实施时对照，行号以 `b89d25f` 为准，先按符号搜索复核）：

| 内容 | 文件 |
|---|---|
| 右键菜单（项目/配置） | `terminal-buddy/src/components/profile-config/ConfigNav.tsx`（叶子约 L484-512，分组约 L569-598） |
| 右键菜单（历史会话） | `terminal-buddy/src/components/claude-history/HistoryPanel.tsx`（单选菜单约 L730-752，preset 过滤约 L364-373） |
| 恢复命令组装 | `terminal-buddy/src/components/claude-history/resumeClaudeSession.ts`（`pickClaudeProfile` 约 L31-51） |
| 页签快照/恢复 | `terminal-buddy/src/stores/appStore.ts`（`saveTabsToStorage` 约 L69-105）、`terminal-buddy/src/services/sessionRestore.ts`（`restoreTerminalTab` 约 L61-131，`restoreTabs` 内嵌隔离约 L147-162） |
| 退出采集 | `terminal-buddy/src/App.tsx`（`saveClaudeSessionsBeforeExit` 约 L271-312，改 L290-291 分支） |
| 终端创建/引用展开点 | `terminal-buddy/src-tauri/src/commands/terminal.rs`（`apply` 约 L1235-1236、`build` 约 L1253、blank 入队约 L1545-1551、清理约 L539-593/1454-1475） |
| 校验与引用 | `terminal-buddy/src-tauri/src/models/profile_validation.rs`（`reject_control_chars`/`quote_cmd_argument`）、`terminal-buddy/src-tauri/src/services/atomic_file.rs`（`atomic_write_private`） |
| 本方案新增后端 | `terminal-buddy/src-tauri/src/models/llm_provider.rs`、`terminal-buddy/src-tauri/src/services/llm_provider_service.rs`、`terminal-buddy/src-tauri/src/services/claude_settings_service.rs`、`terminal-buddy/src-tauri/src/commands/llm_provider.rs` |
| 注册与覆盖率 | `terminal-buddy/src-tauri/src/desktop.rs`（`generate_handler!` 约 L423）、`terminal-buddy/scripts/check-invoke-coverage.py`（P0-0 先修） |
| 旧供应商链路（冻结参照） | `terminal-buddy/src-tauri/src/services/claude_provider_service.rs`、`terminal-buddy/src-tauri/src/web/handlers/claude_provider_handler.rs`、`terminal-buddy/src/components/browser/ClaudeProviders.tsx` |
| Web 对等 | `terminal-buddy/web/src/screens/`（`Nav.tsx` 项目启动、`ClaudeHistory.tsx` 恢复菜单约 L149-179/529-545）、`terminal-buddy/src-tauri/src/web/handlers/`（`terminal_handler.rs`、`desktop_dispatch.rs` 白名单） |
