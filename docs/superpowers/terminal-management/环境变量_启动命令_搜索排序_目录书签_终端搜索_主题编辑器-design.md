# TerminalBuddy 体验完善功能设计

## 概述

为 TerminalBuddy 添加 7 个体验完善功能，补全已有数据模型的 UI、增强配置管理效率、改善终端交互体验。

## 功能 1：环境变量 UI

### 现状
Profile 数据模型已有 `environmentVariables: HashMap<String, String>`，后端启动 PTY 时已将环境变量传入 `CommandBuilder`，但前端 `ConfigEditDialog` 完全没有暴露此字段的编辑界面。

### 设计
- 在 `ConfigEditDialog` 表单中，"启动命令"和"启动路径"之间添加"环境变量"编辑区
- 采用 Key-Value 对列表形式：每行一个键值对，带删除按钮，底部有"添加变量"按钮
- 环境变量区域默认折叠，点击标题展开
- 键名输入框带常见变量名提示（PATH、HOME、NODE_ENV、JAVA_HOME 等自动补全）
- 界面风格与现有表单保持一致

### 影响范围
- 前端：`ConfigEditDialog.tsx` / `ConfigEditDialog.css` — 添加环境变量编辑区
- 后端：无需修改（已支持）

---

## 功能 2：多条启动命令 UI

### 现状
数据模型支持 `startupCommands: Vec<String>` 数组，但前端只提供单行文本框，且只存一条命令。

### 设计
- 将单行文本框改为可排序的命令列表：每行一条命令，带拖拽排序手柄和删除按钮
- 底部"添加命令"按钮，新行出现时自动聚焦
- 保留命令模板自动补全（每行独立触发）
- 命令执行顺序为列表顺序（从上到下），后端按序发送
- 现有单条命令自动迁移：读取配置时，若 `startupCommands` 只有一项且与旧字段值相同，直接显示为列表；保存时始终以数组形式写入

### 影响范围
- 前端：`ConfigEditDialog.tsx` / `ConfigEditDialog.css` — 改造启动命令编辑区
- 后端：无需修改（已支持 Vec<String>）

---

## 功能 3：配置文件搜索/排序

### 现状
配置面板只按 `group` 字段分组展示，配置多时查找不便，没有排序选项。

### 设计
- **搜索**：在 `ConfigPanel` 顶部添加搜索框，按名称实时过滤（输入时即过滤），搜索时保持分组结构，空组自动隐藏
- **排序**：搜索框右侧添加排序下拉（小图标按钮），选项：
  - 名称 A-Z / Z-A
  - 最近使用 / 最久未用
  - 创建时间 新→旧 / 旧→新
- 排序仅影响组内顺序，不跨组重排
- 搜索和排序状态不持久化（每次打开面板恢复默认）

### 影响范围
- 前端：`ConfigPanel.tsx` / `ConfigPanel.css` — 添加搜索框和排序控件
- 前端：`appStore.ts` — 添加搜索关键词和排序方式状态

---

## 功能 4：目录书签

### 现状
FileTree 只能从根路径逐层展开导航，切换常用目录效率低。

### 设计
- 在 FileTree 顶部（路径栏上方）添加书签栏，显示为可水平滚动的标签列表
- 右键点击 FileTree 中的目录 → 右键菜单增加"添加到书签"
- 点击书签标签 → FileTree 导航到该目录并展开
- 右键点击书签标签 → 可删除书签或重命名
- 书签数据存储在 `localStorage`，结构为 `{ name: string, path: string }[]`
- 书签栏可通过按钮收起/展开
- 默认内置常见书签：用户主目录、桌面、文档

### 影响范围
- 前端：`FileTree.tsx` / `FileTree.css` — 添加书签栏 UI
- 前端：`appStore.ts` — 添加书签状态管理

---

## 功能 5：终端内搜索

### 现状
终端输出大量内容后，无法快速定位关键信息。

### 设计
- **触发方式**：`Ctrl+F` 打开搜索栏（与浏览器行为一致），搜索栏位于终端区域顶部
- **搜索栏 UI**：输入框 + 上一个/下一个按钮 + 匹配计数（如 3/12）+ 关闭按钮
- **高亮匹配**：使用 xterm.js 的 `SearchAddon`，匹配文本高亮，当前匹配项用不同颜色
- **快捷键**：`Enter` 跳下一个，`Shift+Enter` 跳上一个，`Esc` 关闭搜索
- **大小写切换**：搜索栏提供大小写敏感开关按钮
- 每个终端实例独立搜索状态

### 影响范围
- 前端：`TerminalInstance.tsx` / `TerminalInstance.css` — 集成 SearchAddon，添加搜索栏 UI
- 依赖：`xterm-addon-search` npm 包
- 后端：无需修改

---

## 功能 6：自定义主题编辑器

### 现状
只有 8 个预设主题，用户无法自定义颜色。`ColorTheme` 类型仅 `{ id, name, background, foreground }`。

### 设计
- 在 `SettingsDialog` 中增加"主题管理"标签页
- 主题编辑器包含：
  - **预设主题列表**：8 个预设 + 用户自定义主题，选中即应用
  - **新建/编辑主题**：点击"新建主题"或编辑已有自定义主题，弹出颜色编辑面板
  - **颜色编辑面板**：提供颜色槽（背景、前景、光标、ANSI 黑/红/绿/黄/蓝/品红/青/白），每个槽可输入 HEX 或用原生颜色选择器
  - **实时预览**：编辑区右侧显示终端预览文本，颜色修改即时反映
  - **导入/导出**：自定义主题可导出为 JSON 文件
- 自定义主题存储在 `%APPDATA%/TerminalBuddy/Themes/` 目录
- 预设主题不可编辑，但可基于预设"另存为新主题"
- 删除自定义主题时需确认，正在使用的配置文件自动回退到默认主题

### UI 状态行为

| UI 元素 | 预设主题 | 自定义主题 |
|---------|---------|-----------|
| 选择/应用 | 可点击 | 可点击 |
| 编辑颜色 | 隐藏 | 可见 |
| "另存为新主题" | 可见 | 隐藏 |
| 删除按钮 | 隐藏 | 可见（需确认） |
| 导出 | 隐藏 | 可见 |
| 导入 | 可见（全局） | 可见（全局） |

### 影响范围
- 后端：新增 Theme CRUD 命令 + Theme Service + Theme Model
- 前端：`SettingsDialog` 扩展为标签页、新增 `ThemeEditor` 组件
- 前端：`types/index.ts` 扩展 `ColorTheme` 类型（增加 ANSI 颜色字段）
- 前端：`appStore.ts` 增加自定义主题状态

---

## 功能 7：URL 可点击打开

### 现状
`TerminalInstance.tsx` 已集成 xterm.js 的 `WebLinksAddon`，可检测终端输出中的 URL 并高亮，但点击行为未配置 Ctrl+click 修饰键，且打开 URL 的方式可能不符合预期。

### 设计
- **触发方式**：`Ctrl + 鼠标左键` 点击终端中的 URL，在默认浏览器中打开
- **视觉反馈**：鼠标悬停在 URL 上时，按住 Ctrl 键光标变为手形指针，URL 显示下划线高亮
- **实现方式**：通过 `WebLinksAddon` 的 `linkHandler` 回调，检测 Ctrl 键状态后调用 Tauri 的 `open_path` 命令（或 `shell.open` API）打开 URL
- **URL 识别范围**：http://、https://、ftp:// 开头的完整 URL，与 Windows Terminal 行为一致
- **防止误触**：仅 Ctrl+click 触发，普通点击不打开（避免干扰终端文本选择）

### 影响范围
- 前端：`TerminalInstance.tsx` / `TerminalInstance.css` — 配置 WebLinksAddon 的 linkHandler 和 Ctrl 键检测，添加悬停光标样式
- 后端：无需修改（已有 `open_path` 命令）

---

## 实现优先级

1. **环境变量 UI** — 数据模型已就绪，纯前端改动，风险最低
2. **多条启动命令 UI** — 数据模型已就绪，纯前端改动，风险最低
3. **URL 可点击打开** — WebLinksAddon 已集成，改动极小
4. **配置文件搜索/排序** — 纯前端改动，独立性强
5. **终端内搜索** — 仅需引入 xterm-addon-search，影响范围小
6. **目录书签** — 纯前端改动，数据存 localStorage
7. **自定义主题编辑器** — 需前后端同时改动，复杂度最高，放最后

## 依赖关系

功能 1-5、7 相互独立，可并行开发。功能 6 依赖 `ColorTheme` 类型扩展，但不影响其他功能。
