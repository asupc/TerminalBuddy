# 文本编辑器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TerminalBuddy 中集成 Monaco Editor，实现文本文件的标签式编辑功能。

**Architecture:** 扩展现有 TerminalSession 类型新增 `sessionType` 和 `isDirty` 字段，复用现有标签系统（标签栏/侧边栏/持久化）。后端新增 3 个文件 I/O 命令，前端新增 TextEditor 组件，TerminalPanel 按 sessionType 分流渲染。

**Tech Stack:** Rust/Tauri 2.x (后端命令), React 18 + TypeScript (前端), Monaco Editor via `@monaco-editor/react`, Zustand (状态管理)

**Design Doc:** `docs/superpowers/terminal-management/文本编辑器-design.md` — source of truth for business requirements

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/commands/fs.rs` | Modify | 新增 `read_file_content`、`write_file_content`、`get_file_size` 命令 |
| `src-tauri/src/lib.rs:6` | Modify | 导入新增命令 |
| `src-tauri/src/lib.rs:103-157` | Modify | 在 invoke_handler 注册新增命令 |
| `src/types/index.ts:1` | Modify | 扩展 TerminalType 加入 'editor' |
| `src/types/index.ts:97-105` | Modify | 扩展 TerminalSession 加入 sessionType、isDirty |
| `src/services/tauri.ts` | Modify | 新增 TypeScript 包装函数 |
| `src/components/TextEditor.tsx` | Create | Monaco Editor 编辑器组件 |
| `src/components/TextEditor.css` | Create | 编辑器样式 |
| `src/components/TerminalPanel.tsx:38-50` | Modify | 按 sessionType 分流渲染 |
| `src/components/FileTree.tsx:51-57` | Modify | 双击文本文件打开编辑器 |
| `src/components/TabSidebar.tsx:59-86` | Modify | 编辑器标签分组 + 图标 + 右键菜单 |
| `src/components/TabSidebar.tsx:368-387` | Modify | 编辑器标签右键菜单增加"关闭其它" |
| `src/components/TabSidebar.tsx:140-157` | Modify | 关闭编辑器标签的未保存确认 |
| `src/components/TabSidebar.tsx:159-173` | Modify | 关闭所有标签时区分编辑器/终端 |
| `src/components/TerminalTabBar.tsx:62-179` | Modify | 编辑器标签图标 + 未保存圆点 |
| `src/components/TerminalTabBar.tsx:21-50` | Modify | 关闭编辑器标签的未保存确认 |
| `src/stores/appStore.ts:5-12` | Modify | SavedTab 增加 sessionType、isDirty |
| `src/stores/appStore.ts:257-269` | Modify | addSession 编辑器标签默认分组 |
| `src/App.tsx:111-149` | Modify | 恢复编辑器标签 |

---

### Task 1: 后端 — 新增文件 I/O 命令

**Skills:** _none_

**Files:**
- Modify: `src-tauri/src/commands/fs.rs` (末尾追加)
- Modify: `src-tauri/src/lib.rs:6` (import 行追加)
- Modify: `src-tauri/src/lib.rs:103-157` (invoke_handler 追加)

**Acceptance Criteria:**

- [ ] `read_file_content` 命令能正确读取文本文件内容并返回 String
- [ ] `write_file_content` 命令能正确将内容写入文件
- [ ] `get_file_size` 命令能正确返回文件字节数
- [ ] 三个命令均在 `invoke_handler![]` 中注册，前端可调用

- [ ] **Step 1: 在 fs.rs 末尾追加三个命令函数**

在 `src-tauri/src/commands/fs.rs` 文件末尾追加：

```rust
#[command]
pub fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[command]
pub fn write_file_content(path: String, content: String) -> Result<bool, String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(true)
}

#[command]
pub fn get_file_size(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to get file size: {}", e))?;
    Ok(meta.len())
}
```

- [ ] **Step 2: 在 lib.rs import 行追加命令**

在 `src-tauri/src/lib.rs` 第 6 行的 import 列表末尾追加 `read_file_content, write_file_content, get_file_size`：

找到 `get_web_server_address};` 在其前面插入 `read_file_content, write_file_content, get_file_size, `。

- [ ] **Step 3: 在 invoke_handler 中注册命令**

在 `src-tauri/src/lib.rs` 的 `invoke_handler![]` 宏中，`get_web_server_address,` 之后追加：

```rust
            read_file_content,
            write_file_content,
            get_file_size,
```

- [ ] **Step 4: 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译通过，无错误

- [ ] **Step 5: Commit**

```bash
git add terminal-buddy/src-tauri/src/commands/fs.rs terminal-buddy/src-tauri/src/lib.rs
git commit -m "feat: 新增文件读取/写入/大小查询命令"
```

---

### Task 2: 前端类型与后端桥接

**Skills:** _none_

**Files:**
- Modify: `src/types/index.ts:1` (TerminalType)
- Modify: `src/types/index.ts:97-105` (TerminalSession)
- Modify: `src/services/tauri.ts` (追加 3 个函数)
- Modify: `src/stores/appStore.ts:5-12` (SavedTab)

**Acceptance Criteria:**

- [ ] `TerminalType` 包含 `'editor'`
- [ ] `TerminalSession` 包含 `sessionType` 和 `isDirty` 字段
- [ ] `services/tauri.ts` 中有 `readFileContent`、`writeFileContent`、`getFileSize` 三个函数
- [ ] `SavedTab` 包含 `sessionType` 和 `isDirty` 字段

- [ ] **Step 1: 扩展 TerminalType**

在 `src/types/index.ts` 第 1 行：

```typescript
export type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor';
```

- [ ] **Step 2: 扩展 TerminalSession**

在 `src/types/index.ts` 的 `TerminalSession` 接口（第 97-105 行）追加两个字段：

```typescript
export interface TerminalSession {
  id: string;
  profileId: string;
  profileName: string;
  terminalType: TerminalType;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
  sessionType?: 'terminal' | 'editor';
  isDirty?: boolean;
}
```

- [ ] **Step 3: 新增 tauri.ts 包装函数**

在 `src/services/tauri.ts` 的文件系统命令区域（`renamePath` 函数之后）追加：

```typescript
export const readFileContent = (path: string) => invoke<string>('read_file_content', { path });
export const writeFileContent = (path: string, content: string) => invoke<boolean>('write_file_content', { path, content });
export const getFileSize = (path: string) => invoke<number>('get_file_size', { path });
```

- [ ] **Step 4: 扩展 SavedTab**

在 `src/stores/appStore.ts` 的 `SavedTab` 接口（第 5-12 行）追加：

```typescript
interface SavedTab {
  profileId: string;
  profileName: string;
  terminalType: string;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
  sessionType?: 'terminal' | 'editor';
  isDirty?: boolean;
}
```

- [ ] **Step 5: 更新 saveTabsToStorage 映射**

在 `src/stores/appStore.ts` 的 `saveTabsToStorage` 函数（第 19-25 行）的 map 回调中追加：

```typescript
const tabs: SavedTab[] = sessions.map(s => ({
  profileId: s.profileId,
  profileName: s.profileName,
  terminalType: s.terminalType,
  colorTheme: s.colorTheme,
  tabColor: s.tabColor,
  groupId: s.groupId,
  sessionType: s.sessionType,
  isDirty: s.sessionType === 'editor' ? false : undefined,
}));
```

- [ ] **Step 6: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 7: Commit**

```bash
git add terminal-buddy/src/types/index.ts terminal-buddy/src/services/tauri.ts terminal-buddy/src/stores/appStore.ts
git commit -m "feat: 扩展 TerminalSession 类型和文件 I/O 桥接函数"
```

---

### Task 3: 文本文件扩展名工具与 store 编辑器逻辑

**Skills:** _none_

**Files:**
- Create: `src/utils/fileExtensions.ts`
- Modify: `src/stores/appStore.ts` (新增 ensureEditorGroup、openEditorSession、closeEditorSession)

**Acceptance Criteria:**

- [ ] `isTextFile('test.ts')` 返回 `true`，`isTextFile('test.exe')` 返回 `false`
- [ ] `getMonacoLanguage('test.tsx')` 返回 `'typescript'`
- [ ] `ensureEditorGroup()` 能自动创建"文本编辑"分组
- [ ] `openEditorSession(filePath)` 能创建编辑器 session 并加入 store
- [ ] 重复打开同一文件时切换到已有标签

- [ ] **Step 1: 创建 fileExtensions.ts 工具文件**

创建 `src/utils/fileExtensions.ts`：

```typescript
const TEXT_EXTENSIONS = new Set([
  // 代码
  '.js', '.jsx', '.ts', '.tsx', '.java', '.cs', '.cpp', '.c', '.h',
  '.py', '.rs', '.go', '.rb', '.php', '.swift', '.kt',
  // Web
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  // 配置/数据
  '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.gitignore',
  // 文档
  '.md', '.txt', '.log', '.csv',
  // Shell
  '.sh', '.bat', '.ps1',
]);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.html': 'html', '.vue': 'html', '.svelte': 'html',
  '.css': 'css', '.scss': 'css', '.less': 'css',
  '.json': 'json',
  '.md': 'markdown',
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.c': 'cpp', '.h': 'cpp',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.xml': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.sh': 'shell', '.bat': 'bat', '.ps1': 'powershell',
};

export function isTextFile(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function getMonacoLanguage(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return 'plaintext';
  const ext = filePath.slice(dotIndex).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] || 'plaintext';
}

export function getFileName(filePath: string): string {
  const sep = filePath.includes('/') ? '/' : '\\';
  const parts = filePath.split(sep);
  return parts[parts.length - 1];
}
```

- [ ] **Step 2: 在 store 中新增编辑器分组和 session 管理逻辑**

在 `src/stores/appStore.ts` 的 `AppState` 接口中追加方法声明（在 `updateSession` 之后）：

```typescript
  ensureEditorGroup: () => void;
  openEditorSession: (filePath: string) => void;
  closeEditorSession: (id: string) => void;
```

在 store 实现中（`updateSession` 之后）追加实现：

```typescript
  ensureEditorGroup: () => set((state) => {
    if (state.groups.some(g => g.id === 'editor-group')) return state;
    return { groups: [...state.groups, { id: 'editor-group', name: '文本编辑', collapsed: false }] };
  }),
  openEditorSession: (filePath) => set((state) => {
    // 重复打开：切换到已有标签
    const existing = state.sessions.find(s => s.sessionType === 'editor' && s.profileId === filePath);
    if (existing) {
      saveTabsToStorage(state.sessions, existing.id);
      return { activeSessionId: existing.id, settingsTabOpen: false };
    }
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      profileId: filePath,
      profileName: fileName,
      terminalType: 'editor',
      colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      tabColor: null,
      groupId: 'editor-group',
      sessionType: 'editor',
      isDirty: false,
    };
    const groups = state.groups.some(g => g.id === 'editor-group')
      ? state.groups
      : [...state.groups, { id: 'editor-group', name: '文本编辑', collapsed: false }];
    const sessions = [...state.sessions, session];
    saveTabsToStorage(sessions, id);
    return { sessions, activeSessionId: id, settingsTabOpen: false, groups };
  }),
  closeEditorSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? sessions[0]?.id ?? null
          : state.activeSessionId;
      saveTabsToStorage(sessions, activeSessionId);
      return { sessions, activeSessionId };
    }),
```

- [ ] **Step 3: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src/utils/fileExtensions.ts terminal-buddy/src/stores/appStore.ts
git commit -m "feat: 新增文件扩展名工具和编辑器 session 管理"
```

---

### Task 4: TextEditor 组件

**Skills:** _none_

**Files:**
- Create: `src/components/TextEditor.tsx`
- Create: `src/components/TextEditor.css`

**Acceptance Criteria:**

- [ ] 组件挂载时通过 `readFileContent` 加载文件内容
- [ ] 内容变更时通过 `onDirtyChange(true)` 通知父组件
- [ ] Ctrl+S 时通过 `writeFileContent` 保存，成功后 `onDirtyChange(false)`
- [ ] Shift+Alt+F 触发 Monaco 格式化
- [ ] 文件不存在时显示错误提示
- [ ] 编辑器占满父容器，自适应 resize

- [ ] **Step 1: 创建 TextEditor.tsx**

创建 `src/components/TextEditor.tsx`：

```typescript
import { FC, useEffect, useRef, useState, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { editor as MonacoEditor } from 'monaco-editor';
import { readFileContent, writeFileContent } from '../services/tauri';
import { getMonacoLanguage } from '../utils/fileExtensions';
import './TextEditor.css';

interface TextEditorProps {
  filePath: string;
  isDirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  isActive: boolean;
}

export const TextEditor: FC<TextEditorProps> = ({ filePath, isDirty, onDirtyChange, isActive }) => {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readFileContent(filePath)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setContent(null);
        }
      });
    return () => { cancelled = true; };
  }, [filePath]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    editor.addAction({
      id: 'save-file',
      label: '保存文件',
      keybindings: [MonacoEditor.KeyMod.CtrlCmd | MonacoEditor.KeyCode.KeyS],
      run: async (ed) => {
        const value = ed.getValue();
        try {
          await writeFileContent(filePath, value);
          onDirtyChange(false);
        } catch (err) {
          console.error('Failed to save file:', err);
        }
      },
    });

    editor.addAction({
      id: 'format-document',
      label: '格式化文档',
      keybindings: [MonacoEditor.KeyMod.Shift | MonacoEditor.KeyMod.Alt | MonacoEditor.KeyCode.KeyF],
      run: async (ed) => {
        await ed.getAction('editor.action.formatDocument')?.run();
      },
    });

    editor.onDidChangeModelContent(() => {
      onDirtyChange(true);
    });
  }, [filePath, onDirtyChange]);

  if (error) {
    return (
      <div className="text-editor-error">
        <div className="text-editor-error-icon">📄</div>
        <div className="text-editor-error-text">无法打开文件</div>
        <div className="text-editor-error-detail">{error}</div>
      </div>
    );
  }

  if (content === null) {
    return <div className="text-editor-loading">加载中...</div>;
  }

  return (
    <div className="text-editor-container">
      <Editor
        height="100%"
        language={getMonacoLanguage(filePath)}
        value={content}
        onMount={handleEditorMount}
        theme="vs-dark"
        options={{
          fontSize: 14,
          minimap: { enabled: true },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 4,
          insertSpaces: true,
          lineNumbers: 'on',
          folding: true,
          renderWhitespace: 'selection',
        }}
        onChange={(value) => {
          if (value !== undefined) setContent(value);
        }}
      />
    </div>
  );
};
```

- [ ] **Step 2: 创建 TextEditor.css**

创建 `src/components/TextEditor.css`：

```css
.text-editor-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.text-editor-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #888;
  font-size: 14px;
}

.text-editor-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #888;
}

.text-editor-error-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.text-editor-error-text {
  font-size: 16px;
  margin-bottom: 8px;
  color: #ccc;
}

.text-editor-error-detail {
  font-size: 12px;
  color: #666;
  max-width: 400px;
  text-align: center;
}
```

- [ ] **Step 3: 安装 Monaco Editor 依赖**
  **Skills:** _none_

Run: `cd terminal-buddy && npm install @monaco-editor/react`
Expected: 安装成功

- [ ] **Step 4: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add terminal-buddy/src/components/TextEditor.tsx terminal-buddy/src/components/TextEditor.css terminal-buddy/package.json terminal-buddy/package-lock.json
git commit -m "feat: 新增 TextEditor 组件 (Monaco Editor)"
```

---

### Task 5: TerminalPanel 集成编辑器渲染

**Skills:** _none_

**Files:**
- Modify: `src/components/TerminalPanel.tsx:1-54`

**Acceptance Criteria:**

- [ ] `sessionType === 'terminal'` 时渲染 `<TerminalInstance>`（不变）
- [ ] `sessionType === 'editor'` 或 `sessionType` 未定义时按原逻辑处理
- [ ] 编辑器标签激活时正确接收 `isActive` prop
- [ ] 编辑器标签的 `isDirty` 状态通过 `updateSession` 同步到 store

- [ ] **Step 1: 修改 TerminalPanel.tsx**

将 `src/components/TerminalPanel.tsx` 的内容替换为：

```typescript
import { FC, useCallback } from 'react';
import { TerminalInstance } from './TerminalInstance';
import { TextEditor } from './TextEditor';
import { TerminalTabBar } from './TerminalTabBar';
import { SettingsPage } from './SettingsPage';
import { useAppStore } from '../stores/appStore';
import { writeToTerminal } from '../services/tauri';
import { getAppSettings } from '../utils/settings';
import './TerminalPanel.css';

export const TerminalPanel: FC = () => {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const settingsTabOpen = useAppStore(s => s.settingsTabOpen);
  const closeSettingsTab = useAppStore(s => s.closeSettingsTab);
  const updateSession = useAppStore(s => s.updateSession);
  const settings = getAppSettings();

  const handleTerminalInput = useCallback(async (sessionId: string, data: string) => {
    try {
      await writeToTerminal(sessionId, data);
    } catch (err) {
      console.error('Failed to write to terminal:', err);
    }
  }, []);

  return (
    <div className="terminal-panel">
      {!settings.enableTabNavigation && sessions.length > 0 && (
        <TerminalTabBar />
      )}
      <div className="terminal-content">
        {settingsTabOpen ? (
          <SettingsPage onClose={closeSettingsTab} />
        ) : sessions.length === 0 ? (
          <div className="terminal-empty">
            <div className="empty-icon">⌨</div>
            <div className="empty-text">点击左侧连接启动终端</div>
          </div>
        ) : sessions.map((session) => (
          <div
            key={session.id}
            className={`terminal-tab-content ${activeSessionId === session.id ? 'active' : ''}`}
          >
            {session.sessionType === 'editor' ? (
              <TextEditor
                filePath={session.profileId}
                isDirty={session.isDirty ?? false}
                onDirtyChange={(dirty) => updateSession(session.id, { isDirty: dirty })}
                isActive={activeSessionId === session.id}
              />
            ) : (
              <TerminalInstance
                terminalId={session.id}
                colorTheme={session.colorTheme}
                onOutput={handleTerminalInput}
                isActive={activeSessionId === session.id}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/src/components/TerminalPanel.tsx
git commit -m "feat: TerminalPanel 按 sessionType 分流渲染编辑器/终端"
```

---

### Task 6: FileTree 双击集成

**Skills:** _none_

**Files:**
- Modify: `src/components/FileTree.tsx:51-57` (handleDoubleClick)

**Acceptance Criteria:**

- [ ] 双击 `.ts`、`.md` 等文本文件时打开编辑器标签
- [ ] 双击 `.exe`、`.png` 等非文本文件时仍调用系统默认程序
- [ ] 文件超过 1MB 时弹窗提示
- [ ] 已打开的文件再次双击时切换到已有标签

- [ ] **Step 1: 修改 FileTree.tsx 的 imports 和 handleDoubleClick**

在 `src/components/FileTree.tsx` 顶部新增 import：

```typescript
import { isTextFile, getFileName } from '../utils/fileExtensions';
import { getFileSize } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
```

将 `TreeNode` 组件中的 `handleDoubleClick`（第 51-57 行）替换为：

```typescript
  const handleDoubleClick = useCallback(async () => {
    if (node.is_directory) {
      onNavigate(node.path);
    } else if (isTextFile(node.path)) {
      try {
        const size = await getFileSize(node.path);
        if (size > 1024 * 1024) {
          alert('文件过大，无法在编辑器中打开（超过 1MB）');
          return;
        }
      } catch {
        // 无法获取大小时尝试打开
      }
      useAppStore.getState().openEditorSession(node.path);
    } else {
      openPath(node.path).catch((err) => console.error('Failed to open file:', err));
    }
  }, [node.is_directory, node.path, onNavigate]);
```

- [ ] **Step 2: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/src/components/FileTree.tsx
git commit -m "feat: FileTree 双击文本文件打开编辑器标签"
```

---

### Task 7: TabSidebar 编辑器标签渲染与关闭逻辑

**Skills:** _none_

**Files:**
- Modify: `src/components/TabSidebar.tsx:59-86` (sessionTree 构建)
- Modify: `src/components/TabSidebar.tsx:140-173` (关闭逻辑)
- Modify: `src/components/TabSidebar.tsx:368-387` (右键菜单)

**Acceptance Criteria:**

- [ ] 编辑器标签自动归入"文本编辑"分组
- [ ] 编辑器标签显示文件图标而非工作指示点
- [ ] 编辑器标签 `isDirty` 时显示圆点标记
- [ ] 编辑器标签右键菜单包含"关闭其它"
- [ ] 关闭未保存的编辑器标签时弹窗确认

- [ ] **Step 1: 修改 sessionTree 构建逻辑**

在 `src/components/TabSidebar.tsx` 的 `sessionTree` useMemo（第 59-86 行），将分组逻辑替换为：

```typescript
  const sessionTree = useMemo(() => {
    const groupMap = new Map<string, typeof sessions>();
    for (const session of sessions) {
      let groupName: string;
      if (session.sessionType === 'editor') {
        groupName = '文本编辑';
      } else {
        const profile = profiles.find(p => p.id === session.profileId);
        groupName = profile?.group || '默认';
      }
      if (!groupMap.has(groupName)) groupMap.set(groupName, []);
      groupMap.get(groupName)!.push(session);
    }
    return Array.from(groupMap.entries())
      .filter(([, s]) => s.length > 0)
      .sort(([a], [b]) => a.localeCompare(b, 'zh'))
      .map(([groupName, groupSessions]): TreeItem => ({
        id: groupName,
        label: groupName,
        isGroup: true,
        children: groupSessions.map((session): TreeItem => {
          const isEditor = session.sessionType === 'editor';
          return {
            id: session.id,
            label: session.profileName,
            icon: isEditor ? (
              <span className="tab-sidebar-file-icon">
                {session.isDirty && <span className="tab-sidebar-dirty-dot" />}
                📄
              </span>
            ) : (
              <span
                className={`tab-sidebar-dot${workingSessions[session.id] ? ' working' : ''}`}
                style={{ background: getWorkingDotColor(workingSessions[session.id], session.tabColor) }}
              />
            ),
            data: session,
          };
        }),
      }));
  }, [sessions, profiles, workingSessions, settingsVersion]);
```

- [ ] **Step 2: 在 CSS 中追加编辑器图标样式**

在 `src/components/TabSidebar.css`（或对应的样式文件中）追加：

```css
.tab-sidebar-file-icon {
  display: inline-flex;
  align-items: center;
  gap: 0;
  position: relative;
  font-size: 12px;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.tab-sidebar-dirty-dot {
  position: absolute;
  top: -2px;
  right: -4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e8e8e8;
}
```

- [ ] **Step 3: 修改关闭逻辑，编辑器标签需确认未保存**

在 `src/components/TabSidebar.tsx` 中，修改 `handleCloseTerminal` 函数（第 140-143 行）：

```typescript
  const handleCloseTerminal = async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session?.sessionType === 'editor') {
      if (session.isDirty) {
        setConfirmDialog({
          title: '未保存的更改',
          message: `文件「${session.profileName}」有未保存的更改，确定要关闭吗？`,
          onConfirm: async () => {
            setConfirmDialog(null);
            removeSession(sessionId);
          },
        });
        return;
      }
      removeSession(sessionId);
    } else {
      try { await closeTerminalCmd(sessionId); } catch (err) { console.error(err); }
      removeSession(sessionId);
    }
  };
```

- [ ] **Step 4: 修改 handleCloseAllTabs 以区分编辑器**

在 `src/components/TabSidebar.tsx` 中，修改 `handleCloseAllTabs`（第 159-173 行）：

```typescript
  const handleCloseAllTabs = () => {
    if (sessions.length === 0) return;
    const hasDirty = sessions.some(s => s.sessionType === 'editor' && s.isDirty);
    setConfirmDialog({
      title: '确认关闭所有标签',
      message: hasDirty
        ? `有未保存的文件更改，确定关闭所有 ${sessions.length} 个标签吗？`
        : `确定关闭所有 ${sessions.length} 个标签吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        for (const session of sessions) {
          if (session.sessionType !== 'editor') {
            try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
          }
        }
        useAppStore.getState().setSessions([]);
        setShowContextMenu(false);
      },
    });
  };
```

- [ ] **Step 5: 修改标签右键菜单，编辑器标签增加"关闭其它"**

在 `src/components/TabSidebar.tsx` 的标签右键菜单（第 368-387 行），替换为：

```typescript
      {tabContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setTabContextMenu(null)} />
          <div className="context-menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y }}>
            <div className="context-menu-item" onClick={() => {
              const session = sessions.find(s => s.id === tabContextMenu.sessionId);
              if (session) {
                setRenameValue(session.profileName);
                setRenamingSessionId(session.id);
                setTimeout(() => renameInputRef.current?.select(), 0);
              }
              setTabContextMenu(null);
            }}>重命名</div>
            <div className="context-menu-item danger" onClick={() => {
              handleCloseTerminal(tabContextMenu.sessionId);
              setTabContextMenu(null);
            }}>关闭</div>
            {sessions.find(s => s.id === tabContextMenu.sessionId)?.sessionType === 'editor' && (
              <div className="context-menu-item" onClick={() => {
                const currentSession = sessions.find(s => s.id === tabContextMenu.sessionId);
                if (!currentSession) return;
                const editorSessions = sessions.filter(
                  s => s.sessionType === 'editor' && s.id !== tabContextMenu.sessionId
                );
                for (const s of editorSessions) {
                  removeSession(s.id);
                }
                setTabContextMenu(null);
              }}>关闭其它</div>
            )}
          </div>
        </>
      )}
```

- [ ] **Step 6: 修改 session item 渲染，编辑器标签不显示工作指示点**

在 `src/components/TabSidebar.tsx` 中，找到 session item 渲染部分（约第 333-357 行），修改图标渲染逻辑。将编辑器标签的图标部分改为使用 sessionTree 中已构建的 icon：

在 `sessionTree` 的 children 渲染中，替换当前固定的工作指示点图标，改为使用 `child.icon`：

```typescript
                  <div
                    className={`tree-item tab-sidebar-item ${activeSessionId === child.id ? 'active' : ''}`}
                    style={{ paddingLeft: '20px' }}
                    onClick={() => setActiveSession(child.id)}
                    onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); handleCloseTerminal(child.id); } }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId: child.id });
                    }}
                  >
                    {child.icon || (
                      <span
                        className={`tab-sidebar-dot${workingSessions[child.id] ? ' working' : ''}`}
                        style={{ background: getWorkingDotColor(workingSessions[child.id], (child.data as any)?.tabColor) }}
                      />
                    )}
                    <span className="tree-name" style={(child.data as any)?.tabColor ? { color: (child.data as any).tabColor } : undefined}>{child.label}</span>
                    <span className="tree-item-end">
                      <button
                        className="tree-item-close"
                        onClick={(e) => { e.stopPropagation(); handleCloseTerminal(child.id); }}
                        title="关闭"
                      >
                        ×
                      </button>
                    </span>
                  </div>
```

同样修改重命名模式的图标部分（约第 305-309 行），使用 `child.icon` 替代固定的工作指示点。

- [ ] **Step 7: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 8: Commit**

```bash
git add terminal-buddy/src/components/TabSidebar.tsx
git commit -m "feat: TabSidebar 编辑器标签分组、图标和关闭确认"
```

---

### Task 8: TerminalTabBar 编辑器标签渲染

**Skills:** _none_

**Files:**
- Modify: `src/components/TerminalTabBar.tsx:21-50` (关闭逻辑)
- Modify: `src/components/TerminalTabBar.tsx:62-179` (渲染)

**Acceptance Criteria:**

- [ ] 编辑器标签显示文件图标（📄）
- [ ] `isDirty` 时标签名旁显示圆点
- [ ] 关闭未保存的编辑器标签时弹窗确认

- [ ] **Step 1: 修改关闭逻辑**

在 `src/components/TerminalTabBar.tsx` 中，修改 `handleCloseTerminal`（第 21-24 行）：

```typescript
  const handleCloseTerminal = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session?.sessionType === 'editor') {
      if (session.isDirty) {
        setConfirmDialog({
          title: '未保存的更改',
          message: `文件「${session.profileName}」有未保存的更改，确定要关闭吗？`,
          onConfirm: () => {
            setConfirmDialog(null);
            removeSession(sessionId);
          },
        });
        return;
      }
      removeSession(sessionId);
    } else {
      try { await closeTerminalCmd(sessionId); } catch (err) { console.error(err); }
      removeSession(sessionId);
    }
  }, [sessions, removeSession]);
```

需要在组件中新增 state（在现有 state 声明位置）：

```typescript
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
```

- [ ] **Step 2: 修改标签渲染**

在 `src/components/TerminalTabBar.tsx` 的标签渲染部分，修改每个标签的内容以支持编辑器标签：

找到标签内容渲染（约第 62-100 行），将图标和名称部分替换为：

```typescript
                {session.sessionType === 'editor' && (
                  <span className="tab-file-icon">📄</span>
                )}
                {session.sessionType !== 'editor' && (
                  <span
                    className={`tab-working-dot${workingSessions[session.id] ? ' working' : ''}`}
                    style={{ background: getWorkingDotColor(workingSessions[session.id], session.tabColor) }}
                  />
                )}
                {session.isDirty && <span className="tab-dirty-dot" />}
                <span className="tab-name" style={session.tabColor ? { color: session.tabColor } : undefined}>
                  {session.profileName}
                </span>
```

在 CSS 文件（`src/components/TerminalTabBar.css` 或对应样式文件）中追加：

```css
.tab-file-icon {
  font-size: 12px;
  line-height: 1;
}

.tab-dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e8e8e8;
  display: inline-block;
  margin-right: 2px;
}
```

- [ ] **Step 3: 新增确认弹窗渲染**

在 `TerminalTabBar` 组件的 return JSX 末尾（在最后一个 `</>` 之前）追加确认弹窗：

```typescript
      {confirmDialog && (
        <div className="confirm-dialog-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{confirmDialog.title}</div>
            <div className="confirm-dialog-message">{confirmDialog.message}</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmDialog(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDialog.onConfirm}>确定</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add terminal-buddy/src/components/TerminalTabBar.tsx
git commit -m "feat: TerminalTabBar 编辑器标签图标和关闭确认"
```

---

### Task 9: App.tsx 编辑器标签恢复

**Skills:** _none_

**Files:**
- Modify: `src/App.tsx:111-149` (restoreTabs)

**Acceptance Criteria:**

- [ ] 启动时恢复编辑器标签，无需 PTY
- [ ] 编辑器标签恢复时直接加入 store
- [ ] 文件不存在时跳过该编辑器标签

- [ ] **Step 1: 修改 restoreTabs 逻辑**

在 `src/App.tsx` 的 `restoreTabs` 函数中，修改恢复逻辑以支持编辑器标签。找到恢复循环（约第 120-140 行），在创建终端标签之前增加编辑器标签判断：

```typescript
        for (let i = 0; i < savedTabs.length; i++) {
          const tab = savedTabs[i];
          if (tab.sessionType === 'editor') {
            // 编辑器标签：直接加入 store，无需 PTY
            const session: TerminalSession = {
              id: crypto.randomUUID(),
              profileId: tab.profileId,
              profileName: tab.profileName,
              terminalType: 'editor',
              colorTheme: tab.colorTheme,
              tabColor: tab.tabColor,
              groupId: 'editor-group',
              sessionType: 'editor',
              isDirty: false,
            };
            // 检查文件是否存在
            try {
              const { getFileSize } = await import('./services/tauri');
              await getFileSize(tab.profileId);
              addSession(session, true);
            } catch {
              // 文件不存在，跳过
            }
          } else {
            // 终端标签：原有逻辑
            // ... 保持原有终端恢复代码不变
          }
        }
```

注意：实际的终端恢复代码保持不变，只在外层加 `if/else` 判断 `sessionType`。确保 `TerminalSession` 已从 types 导入。

- [ ] **Step 2: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/src/App.tsx
git commit -m "feat: 编辑器标签启动恢复支持"
```

---

### Task 10: 完整编译验证与手动测试

**Skills:** _none_

**Acceptance Criteria:**

- [ ] Rust 编译通过
- [ ] TypeScript 编译通过
- [ ] 手动测试：双击 .ts 文件打开编辑器标签
- [ ] 手动测试：Ctrl+S 保存文件
- [ ] 手动测试：关闭未保存标签弹出确认
- [ ] 手动测试：标签导航中编辑器分组正常显示

- [ ] **Step 1: Rust 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy/src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 2: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: 启动开发服务器手动验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npm run tauri dev`

验证项目：
1. 在文件树中双击一个 `.ts` 文件，确认编辑器标签打开
2. 修改内容，确认标签名旁出现圆点
3. Ctrl+S 保存，确认圆点消失
4. 关闭未保存的编辑器标签，确认弹出确认对话框
5. 如果启用了标签导航，确认编辑器标签归入"文本编辑"分组
6. 双击一个 `.exe` 文件，确认仍由系统默认程序打开
7. 再次双击已打开的文本文件，确认切换到已有标签

- [ ] **Step 4: Commit (如有修复)**

仅在修复问题时 commit。
