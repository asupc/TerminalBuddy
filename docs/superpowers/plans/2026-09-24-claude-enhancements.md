# 功能设计说明：Claude Code 增强功能（12 项 + 指示灯优化）

> 交付物：给后续实施 agent 的设计说明。效果预览（HTML mock）：`design/claude-enhancements/index.html`。
> 决策已与用户确认（见文末「决策记录」），按本说明实施即可，不再重复选型。

---

## 背景与价值

TerminalBuddy 主要用于运行 Claude Code，已有 hook 基础设施（阶段追踪、结构化决策对话框、原生/机器人通知、`sessionId ↔ terminalId` 映射、标签页 `--resume` 恢复）。本次补齐真正的空白：**历史会话管理**（JSONL transcript 完全未利用）与 **Claude 资产管理**（memory / CLAUDE.md / skills / MCP 无 GUI），并优化会话活动指示灯语义。

## 总体布局

- Activity Bar 新增 2 个面板：`SidebarPanel` 扩为 `'config' | 'files' | 'tabs' | 'history' | 'claude'`。
  - **history**（清单 1–6）：会话历史列表 + 全文检索。
  - **claude**（清单 7、9–12）：内部分段 总览 | Memory | CLAUDE.md | 技能 | MCP。
- **回放视图**走 `activeSpecialTab` 特殊标签页（同 `GitHistoryPage` 模式）——长文本需要宽度。
- 打开时机：仅手动（Activity Bar / `Ctrl+Shift+H` 可配置 / 通知「查看会话记录」/ 欢迎页入口），不自动弹出。

## 一、数据层（清单 1–6 的共同地基，最先做）

**数据源**：`~/.claude/projects/<路径编码>/*.jsonl`（Claude Code 官方 transcript）。真实 cwd 从 JSONL 的 `cwd` 字段读，不猜路径编码规则。

**SQLite**（`terminal_buddy.db`，走 `DatabaseService` 迁移机制，新增迁移 `claude-history-v1`）：

```sql
claude_sessions (
  session_id TEXT PRIMARY KEY,  project_dir TEXT,
  file_path TEXT, file_mtime INTEGER, file_size INTEGER,
  title TEXT, first_prompt TEXT,
  started_at INTEGER, updated_at INTEGER, message_count INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, model TEXT, indexed_at INTEGER);

claude_session_meta (   -- 我们的侧车元数据（重命名/收藏/归档），不动 JSONL
  session_id TEXT PRIMARY KEY, custom_title TEXT,
  starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, notes TEXT);

claude_messages (       -- 检索走 LIKE（实施偏差：FTS5 默认分词把中文整句当 token，
  session_id, seq, role, content, timestamp);   -- 子串搜不动；trigram 又要求查询≥3字。
```

**`claude_history_service`**（解析逻辑放 `#[cfg(test)]` 可测模块）：
- 增量扫描按 `file_mtime/size` 跳过未变文件；面板打开时刷新 + 启动后台空闲扫描。
- JSONL 解析容错：无法解析的行跳过（内部格式会演化）。
- 索引范围：user/assistant 正文 + tool 名与文件路径；tool_result 截断 4KB。
- 标题：`summary` 行优先，否则首条真实 user 消息（跳过 tool_result / sidechain）截断。
- 命令面（全部注册进 `invoke_handler![]`，过 `python scripts/check-invoke-coverage.py`）：
  `claude_history_list / search / get_session_messages / rename / set_flags / delete / export / rescan`。

## 二、逐项设计

### 1. 会话历史面板（+ 6. 管理操作 = 右键菜单）
- 按项目分组、时间倒序；运行中会话（有 sessionId 映射）标「进行中」置顶。
- 右键菜单：恢复会话 / 查看详情·回放 / 导出… ‖ 重命名… / 收藏 / 归档 / 删除记录… ‖ 复制会话 ID / 打开所在文件夹。
- 删除 = 移入 `<dataPath>/Trash/` 不硬删；重命名/收藏/归档写 `claude_session_meta`。

### 2. 双击一键恢复（resume）
1. 查 `sessionId ↔ terminalId` 映射 → 已存在则聚焦该终端（不重复 resume）；
2. 否则 `startBlankTerminal(powershell, startupPath = session.projectDir)` → `writeToTerminal(id, "claude --resume <sessionId>\r")`。
- **注入 PTY 一律行尾 `\r`**（LF 会被 ConPTY 当 Ctrl+Enter，见 memory `paste-newline-must-be-cr`）。
- 可选设置「恢复时使用的 Profile」（自定义模型/参数），默认空白终端直启 `claude`。

### 3. 全文检索（跨全部历史会话）
- 与列表过滤共用搜索框：输入 ≥2 字符出现「全文」切换，回车直接进全文模式。
- LIKE 子串匹配 + 命中片段截取（见上「实施偏差」）；结果 = 会话标题 › 命中片段 · 时间 · 第 N 条消息。
- 点击命中 → 打开回放 special tab 并滚动锚定到该条消息（seq）。

### 4. 会话详情 / 回放视图（右键打开，特殊标签页）
- 顶栏：返回列表、标题、cwd、时间/模型/消息数/usage 聚合、[▶ 恢复此会话] [导出] [删除]。
- 消息渲染：user/assistant 正文（markdown 简渲染）；tool_use 折叠「工具名 · 入参摘要」；tool_result 折叠在工具块下。
- 按 seq 分页加载，大 JSONL 不一次读完（回放读 JSONL 文件本身，不依赖索引表）。

### 5. 导出（右键）
- 弹窗选格式 → 原生保存对话框（`tauri-plugin-dialog`）：**Markdown**（对话 + 工具调用摘要）/ **JSON**（原始转录）。HTML 不做（要了再加）。

### 7. 会话总览面板（claude 面板 · 总览段）
- 数据 = 现有 `terminalActivities` + hook 事件流，零新后端。
- 卡片：终端名 · 指示灯 · taskTitle/summary · 起始时间 · [跳转] [回放] [清除]。

### 8. 图片粘贴辅助
- 问题：ConPTY + xterm.js 剪贴板只有文本，图片进不了 PTY。
- 方案：图片 → 文件 → `@path` 引用。入口：终端右键「粘贴图片」/ 工具栏图标 / `Ctrl+Shift+V`。
- 流程：读剪贴板图片（`readImage`）→ 预览弹层（缩略图 + 可选备注）→ 存 `<dataPath>/ClientData/claude-images/<ts>.png` → 输入行插入 `@<path>` 纯文本。
- 「插入引用」不带回车；「插入并发送」追加 `\r`。SSH 远程会话禁用按钮。

### 9. Memory 浏览器（claude 面板 · Memory 段）
- 数据源 `~/.claude/projects/<编码>/memory/`（MEMORY.md + 条目文件）。
- 左文件列表（frontmatter type 徽章）右 markdown 查看/编辑；`[[链接]]` 点击跳转；新建条目按记忆格式模板带 frontmatter。

### 10. CLAUDE.md 管理器（claude 面板 · CLAUDE.md 段）
- 全局 `~/.claude/CLAUDE.md` 与项目 `<root>/CLAUDE.md` 两级（作用域切换）；「插入片段」常用段落模板；复用 TextEditor；提示叠加生效规则。

### 11. Skills / Subagents / Commands 管理器（claude 面板 · 技能段，3 子段）
**资产库 + 部署模型**（用户确认的深化方案，替代 `.disabled` 改名）：
- 库 = `<dataPath>/ClaudeAssets/{skills,agents,commands}/`，**唯一编辑处**。
- 启用到… → 复制到 `~/.claude/<x>/`（用户级）或 `<proj>/.claude/<x>/`（项目级）。
- 停用于… → 从目标移除（先备份到 `<dataPath>/Trash/`）。
- hash 漂移检测：部署副本 ≠ 库 → 标「⚠ 已偏离」→ 同步动作：覆盖部署 / 从目标回库。
- 从…导入：现有 `.claude/` 目录收编进库。
- 列表列：名称 / 描述（frontmatter）/ 部署徽章（【用户】【项目x】）/ 漂移标记。编辑 = special tab（frontmatter 表单 + body）。

### 12. MCP 管理器（claude 面板 · MCP 段）
- **用户级** = `~/.claude.json` 的 `mcpServers`；**项目级** = `<proj>/.mcp.json` + `~/.claude.json` 项目条目覆盖。页头作用域切换 + 项目选择器；**行内强制作用域徽章**。
- **连通探测（已确认）**：运行 `claude mcp list` 按行解析（该命令无 `--json`）。状态词：`✔ Connected` / `⏸ Pending approval` / `✖ Failed`。探测按需触发（会逐个 health-check 有延迟）+ 结果缓存带时间戳。
- 操作：新增向导（stdio/sse/http 分表单 + JSON 高级编辑）、编辑、删除、复制到另一作用域、在资源管理器显示配置。

### 其它. 会话活动指示灯优化
状态机（标签页小灯 + 总览卡片灯共用，事件源 = 现有 hook 流）：

| 事件 | 状态 | tooltip |
|---|---|---|
| **首个 hook 事件（无论类型，含 permission_prompt）** | 点亮「会话在场」 | — |
| UserPromptSubmit | 绿闪 running | Claude 执行中 |
| permission_prompt / 决策 | 黄闪 attention | 等待你的确认（点击处理） |
| Stop | 绿亮渐灭 completed | 任务完成 |
| StopFailure | **红长亮 failed** | 错误停止（点击清除） |
| SessionEnd / 终端关闭 | 灭 ended | Claude 会话已结束 |

- 长红保持到下次 running 或点击灯手动清除；**不受 30min stale 计时器影响**（`CLAUDE_RUNNING_STALE_MS` 只管 running）。
- 调整点：`services/claudeNotification.ts` 的 `applyTerminalEvent` + 后端 `claude_hook_handler.rs` 的 phase 映射 + tooltip 文案。

## 三、实施分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 一期 | 数据层 + 1 历史面板 + 2 恢复 + 3 检索 + 4 回放 + 5 导出 + 6 管理 | — |
| 二期 | 7 总览 + 指示灯优化 + 8 图片粘贴 | 7/指示灯复用 hook 事件流；8 独立 |
| 三期 | 9 Memory → 10 CLAUDE.md → 11 技能 → 12 MCP | 彼此独立，按序做（MCP 最复杂） |

## 四、风险与约束

- JSONL 为 Claude Code 内部格式：解析器容错（跳过坏行）+ 测试样本覆盖多种行类型。
- 所有注入 PTY 一律 `\r`；前端 UI 全中文；serde `rename_all = "camelCase"`。
- 新 invoke 全部进 `invoke_handler![]` 并过覆盖率脚本；纯逻辑（JSONL 解析 / FTS 查询构建 / 路径解码）进 `#[cfg(test)]`。
- 删除记录进 Trash 不硬删；WebView2 无 HTML5 拖放（如需拖拽用 mouse 事件）。
- 成本字段一期只展示 token 数（成本换算要价格表，等需要再加）。

## 决策记录（2026-09-24 用户确认）

### 实施记录

**一期（已完成 2026-09-24）**：数据层（`claude_history_service` + SQLite 迁移）+ 历史/恢复/检索/回放/导出/管理。偏差：FTS5 → LIKE（中文分词限制）。

**二期（已完成 2026-09-24）**：
- ⑫ 指示灯：`utils/claudeIndicator.ts` 状态机（presence/running/attention/completed/failed）；`TerminalActivityState` 增加 taskTitle/summary；`applyClaudeHookActivity` 带事件详情；StopFailure 长红不受 30min 过期影响、点击灯或总览「清除」复位；expire 只管 running 且保留会话在场；UserPromptSubmit 事件带上提示词标题（后端 `task_content` 新增 arm）；灯渲染点：SessionTreeItem / TerminalTabBar / 总览卡片。
- ⑦ 总览：`components/claude-panel/ClaudePanel.tsx`，ActivityBar 第 5 图标「Claude 总览」；卡片按 等待确认 > 错误停止 > 执行中 > 其它 排序；操作：跳转 / 回放（有 sessionId 时）/ 清除（failed）。
- ⑧ 图片粘贴：终端右键「粘贴图片…」（SSH / 只读终端禁用）→ `PasteImageDialog`（预览 + 备注）→ `@<path>` 引用 + 备注第二行插入（CR + 括号粘贴规范）；图片存 `dataPath/ClientData/claude-images/`（新命令 `save_clipboard_image_to_claude_cache`，clipboard.rs 抽出 DIB→PNG 公共实现）。原 `[图片:path]` 快捷粘贴行为保持不变。
- 边界：`Ctrl+Shift+V` 快捷键与工具栏图标入口未做（现有 HotkeyActionId 是固定集合，扩展需联动设置 UI）；总览面板暂无分段切换（三期加 Memory 等段位时一并加）。

**三期（已完成 2026-09-24）**：
- 后端：`claude_config_service`（项目发现 = claude_sessions 索引 ∪ 带 memory 的编码目录；memory frontmatter 解析 / [[链接]] 提取 / 安全名校验；CLAUDE.md 全局+项目读写）、`claude_assets_service`（资产库 `<dataPath>/ClaudeAssets/{skills,agents,commands}`；skills=目录、agents/commands=单 md；部署 = 复制到 `~/.claude/<kind>/` 或 `<proj>/.claude/<kind>/`；hash 漂移检测；停用/删库 → Trash；overwrite/pull_back 双向同步；从目录收编导入；新建模板）、`claude_mcp_service`（用户级 `~/.claude.json` mcpServers 整文件保留式读写 + 项目级 `.mcp.json`；`parse_mcp_list_output` 解析 `claude mcp list` 文本输出；probe 用 `cmd /C claude mcp list` + 200ms 轮询，超时可配）。22 个命令注册，Rust 158/158 测试通过。
- 前端桥接：`services/tauri/claudeConfig.ts`（8）/ `claudeAssets.ts`（10）/ `claudeMcp.ts`（5）。
- 前端 UI：`ClaudePanel` 改造为五段容器（总览 | Memory | CLAUDE.md | 技能 | MCP），分段切换不卸载（编辑中内容/探测结果保留）。四段组件在 `components/claude-panel/segments/`：
  - `MemorySegment`：项目下拉（🧠 徽章）→ 文件列表（type 彩色徽章 + hover 删除）→ 正文编辑（Ctrl+S）+ [[链接]] chips 点击跳转；新建（name/type/description）/删除（Trash Confirm）。
  - `ClaudeMdSegment`：全局/项目切换 + 片段模板下拉（沟通/编码/提交/测试规范）插入；未创建时提示「保存后新建」。
  - `AssetsSegment`：技能/子代理/命令三子段 + 过滤；**点击行展开操作区**（侧栏窄，不用右键）：部署列表每行 [覆盖]/[回库]（⚠已偏离时）/[停用]，底部 [启用到…]（radio：用户级+项目列表）/[编辑]（textarea，保存回库）/[删除]；[新建]（模板）；[导入]（来源 radio 用户级/项目 → 可收编清单 checkbox 多选 → 批量收编）。
  - `McpSegment`：用户级/项目级切换；[⟳检测连通]（`claude mcp list`，结果缓存为行内状态徽章 ✔/⏸/✖/·）；[＋新增]/[📂配置位置]（getClaudeMcpConfigPath → openInExplorer）；行内 [编辑]（transport segmented：stdio=命令+参数每行一个 / SSE/HTTP=url；高级 JSON 模式可配 env/headers，表单模式保存时保留 raw 附加字段）/[复制到…跨作用域]/[删除]。
- 验证：tsc --noEmit 通过；invoke 覆盖 149/149。


1. **指示灯语义**：「会话在场」由首个 hook 事件点亮（含 permission_prompt），不做单独"开始"信号。
2. **技能启停**：资产库 + 部署模型（库唯一编辑处、启用复制、停用移除 + Trash 备份、hash 漂移检测、双目标、目录收编导入），不做 `.disabled` 改名。
3. **MCP 连通探测**：要 `claude mcp list` 探测。已实测输出格式（无 `--json`）：
   ```
   Checking MCP server health…
   codegraph: codegraph serve --mcp - ✔ Connected
   playwright: cmd /c npx @playwright/mcp@latest - ✔ Connected
   dbhub: http://192.168.77.24:8484/mcp (HTTP) - ✔ Connected
   ```
