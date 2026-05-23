# 文本编辑器 设计文档

## 概述

在 TerminalBuddy 中新增文本文件编辑功能。用户在文件导航中双击文本类型文件时，在应用内打开编辑器标签，使用 Monaco Editor（VS Code 同款引擎）进行编辑，支持语法高亮和格式化。

## 决策记录

- **编辑引擎**：Monaco Editor（`@monaco-editor/react`），功能最完整，与 VS Code 体验一致
- **集成方案**：扩展现有 `TerminalSession`，新增 `sessionType` 字段区分终端和编辑器
- **文件保存**：Ctrl+S 直接保存到磁盘
- **未保存提示**：关闭标签时弹窗确认（保存/丢弃/取消）
- **重复打开**：同一文件只开一个标签，再次双击切换到已有标签
- **格式化范围**：单文件格式化，仅使用 Monaco 内置格式化器
- **文件大小限制**：1MB，超过时不打开编辑器

## 数据模型

### 扩展 TerminalSession

```typescript
export interface TerminalSession {
  id: string;                    // 终端为 PTY ID，编辑器为 UUID
  profileId: string;             // 终端为 profile ID，编辑器为文件完整路径
  profileName: string;           // 终端为 profile 名，编辑器为文件名
  terminalType: TerminalType;    // 扩展包含 'editor'
  colorTheme: { background: string; foreground: string }; // 编辑器时为默认值
  tabColor: string | null;       // 编辑器时为 null
  groupId: string;               // 编辑器默认为 'editor-group'
  sessionType: 'terminal' | 'editor';  // 新增：区分终端和编辑器
  isDirty?: boolean;             // 编辑器专用：未保存修改标记
}
```

### 扩展 TerminalType

```typescript
type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor';
```

### 编辑器标签 ID

编辑器标签的 `id` 使用 `crypto.randomUUID()` 生成，不依赖后端 PTY。

### 后端新增命令

在 `commands/fs.rs` 中新增：

| 命令 | 签名 | 说明 |
|------|------|------|
| `read_file_content` | `(path: string) -> string` | 读取文件文本内容 |
| `write_file_content` | `(path: string, content: string) -> bool` | 写入文件内容 |
| `get_file_size` | `(path: string) -> u64` | 获取文件字节数 |

在 `lib.rs` 的 `invoke_handler![]` 中注册。

## 标签导航分组

启用标签导航（TabSidebar）时：

- 首次创建编辑器标签时，自动创建"文本编辑"分组（id: `'editor-group'`）
- 新建编辑器标签的 `groupId` 自动设为 `'editor-group'`
- 该分组不可删除、不可重命名，但可折叠
- 用户可通过拖拽将编辑器标签移到其他分组

### TabSidebar 渲染调整

- 编辑器标签显示文件图标（而非终端的工作指示点）
- 编辑器标签 `isDirty` 时在名称旁显示圆点标记
- 编辑器标签右键菜单：重命名、关闭、关闭其它（关闭文件编辑分组下的其它标签）

### TerminalTabBar 渲染调整

- 编辑器标签显示文件图标 + 文件名
- `isDirty` 时显示未保存圆点

## 文件树集成

### 双击行为变更

| 文件类型 | 双击行为 |
|----------|----------|
| 目录 | 导航到该目录（不变） |
| 文本类型文件 | 在编辑器标签中打开 |
| 非文本类型文件 | 调用 `openPath()` 由系统默认程序打开（不变） |

### 支持的文本文件扩展名

- **代码**：`.js`, `.ts`, `.tsx`, `.jsx`, `.java`, `.cs`, `.cpp`, `.c`, `.h`, `.py`, `.rs`, `.go`, `.rb`, `.php`, `.swift`, `.kt`
- **Web**：`.html`, `.css`, `.scss`, `.less`, `.vue`, `.svelte`
- **配置/数据**：`.json`, `.xml`, `.yaml`, `.yml`, `.toml`, `.ini`, `.env`, `.gitignore`
- **文档**：`.md`, `.txt`, `.log`, `.csv`
- **Shell**：`.sh`, `.bat`, `.ps1`

### 大文件检查

双击文本文件时，先调用 `get_file_size`，超过 1MB 弹窗提示"文件过大，无法在编辑器中打开"，不创建标签。

### 重复打开

双击已打开的文件（`profileId` 匹配文件路径），调用 `setActiveSession` 切换到已有标签，不新建。

## 编辑器组件（TextEditor.tsx）

### 技术选型

Monaco Editor，通过 `@monaco-editor/react` 包装库集成。

### 核心功能

- 语法高亮：Monaco 内置支持 JS/TS/CSS/HTML/JSON/Markdown/Java/C#/C++/Python/Rust/Go 等
- 单文件格式化：Shift+Alt+F，依赖 Monaco 内置格式化器（仅 JS/TS/HTML/CSS/JSON）
- 行号显示
- 代码折叠
- 多光标编辑
- 查找替换（Ctrl+F / Ctrl+H）
- 自动缩进
- Ctrl+S 保存文件

### 组件接口

```typescript
interface TextEditorProps {
  filePath: string;           // 从 session.profileId 获取
  isDirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  isActive: boolean;
}
```

### 生命周期

- 挂载时调用 `read_file_content` 读取内容
- 内容变更时标记 `isDirty = true`
- Ctrl+S 时调用 `write_file_content` 写入，成功后 `isDirty = false`
- 标签隐藏时不销毁（CSS 隐藏/显示，与终端实例一致）
- 标签关闭时销毁编辑器实例

### 文件扩展名 → Monaco 语言映射

| 扩展名 | Monaco 语言 |
|--------|-------------|
| `.js`, `.jsx` | javascript |
| `.ts` | typescript |
| `.tsx` | typescript |
| `.html` | html |
| `.css`, `.scss`, `.less` | css |
| `.json` | json |
| `.md` | markdown |
| `.java` | java |
| `.cs` | csharp |
| `.cpp`, `.c`, `.h` | cpp |
| `.py` | python |
| `.rs` | rust |
| `.go` | go |
| `.rb` | ruby |
| `.php` | php |
| `.swift` | swift |
| `.kt` | kotlin |
| `.xml`, `.vue`, `.svelte` | xml/html |
| `.yaml`, `.yml` | yaml |
| `.toml`, `.ini`, `.env` | ini/plaintext |
| `.sh`, `.bat`, `.ps1` | shell/bat/powershell |
| `.txt`, `.log`, `.csv` | plaintext |

## TerminalPanel 渲染调整

当前逻辑不变，仅在遍历 sessions 时按 `sessionType` 分流：

- `sessionType === 'terminal'` → 渲染 `<TerminalInstance>`
- `sessionType === 'editor'` → 渲染 `<TextEditor>`

两者都通过 CSS `active` 类控制显示/隐藏。

## 关闭行为

| 标签类型 | 关闭逻辑 |
|----------|----------|
| 终端 | 关闭 PTY（不变） |
| 编辑器（已保存） | 直接关闭 |
| 编辑器（未保存） | 弹窗确认：保存 / 丢弃 / 取消 |

## 标签持久化与恢复

- 保存时额外存储 `sessionType`、`isDirty`（重置为 false）
- 恢复时，`sessionType === 'editor'` 的标签直接调用 `read_file_content` 重新加载
- 恢复时如果文件已不存在，跳过该标签并提示用户
- 不保存未保存的内容——用户需在关闭前手动保存

## UI 状态行为

编辑器标签在不同状态下的 UI 表现：

| UI 元素 | 已保存 | 未保存 (isDirty) | 文件不存在 |
|---------|--------|------------------|------------|
| 标签名称 | 文件名 | 文件名 + 圆点 | 文件名 |
| 保存按钮 (Ctrl+S) | 禁用 | 启用 | 禁用 |
| 格式化 (Shift+Alt+F) | 启用 | 启用 | 禁用 |
| 关闭标签 | 直接关闭 | 弹窗确认 | 直接关闭 |
| 编辑区域 | 可编辑 | 可编辑 | 显示"文件不存在"提示 |
| 标签图标 | 文件图标 | 文件图标(圆点) | 文件图标(灰色) |

## 依赖

- `@monaco-editor/react` — Monaco Editor React 包装库
- `monaco-editor` — Monaco Editor 核心（`@monaco-editor/react` 的依赖）
