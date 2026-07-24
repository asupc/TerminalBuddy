# 应用更新检查：常驻按钮 + 独立详情面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TitleBar 新增常驻 RefreshCw 按钮，点击展开 popover 显示检查状态（idle / checking / up-to-date / has-update）；同时移除「启动时检查更新」开关简化设置项。

**Architecture:** 复用现有 UpdatePopover 视觉，按 4 态机渲染内容；Bell+红点行为不变；启动钩子简化为总是调用 `checkAppUpdate()`；新增 `formatRelativeTime` 工具与 localStorage `appUpdate.lastCheckedAt`。

**Tech Stack:** Tauri 2, Rust (reqwest, serde_json), React 18, Zustand (existing), lucide-react (RefreshCw icon), markdown-it (existing), dompurify (existing).

## Global Constraints

- 应用当前版本号 `1.3.0`，维护于 `terminal-buddy/package.json` / `terminal-buddy/src-tauri/Cargo.toml` / `terminal-buddy/src/version.ts`（手动同步）。
- 后端 `AppSettings` 用 `#[serde(rename_all = "camelCase")]`，新增字段用 `#[serde(default = "...")]` 兼容旧 `settings.json`；删除字段允许旧文件残留（serde 忽略未知字段）。
- 前端 `getAppSettings()` 用 `{ ...DEFAULT_SETTINGS, ..._cachedSettings }` 合并旧数据缺字段自动回退。
- 所有 Rust↔TS 序列化使用 `#[serde(rename_all = "camelCase")]`。
- 前端 UI 文案用中文（简体）。
- 主题色用 CSS 变量（`--accent` / `--success` / `--warning` 等），不写死颜色。
- Tauri 2 命令在 `commands/mod.rs` 加 `pub mod xxx; pub use xxx::*;`，在 `lib.rs` 的 `use commands::{...}` + `invoke_handler!` 列表添加新函数名。
- **不新增依赖**（`reqwest` / `markdown-it` / `dompurify` / `lucide-react` 全部已存在）。
- Tauri WebView 不支持 `target="_blank"`：所有要打开外部 URL 的 `<a>` 必须用 `onClick` + `e.preventDefault()` + `window.open()`（沿用 `UpdatePopover` 已有的模式）。
- localStorage key：`appUpdate.dismissedVersion`（保留）+ `appUpdate.lastCheckedAt`（新增）。
- 上一版已有的 commit 标识：`1e622a2` (C-1)、`a4eb34e` (I-1+I-2)、`9c22249` (I-3+I-4)。本次改动会**回滚** `9c22249` 的 I-3+I-4 复杂度（settingsReady / updateCheckEnabled 监听器）。

---

## File Structure

新建：
- `terminal-buddy/src/utils/format.ts` — `formatRelativeTime` 工具

修改：
- `terminal-buddy/src-tauri/src/models/settings.rs` — 删除 `update_check_enabled`
- `terminal-buddy/src-tauri/src/commands/settings.rs` — 删除 `save_update_check_enabled`
- `terminal-buddy/src-tauri/src/commands/update.rs` — 移除 toggle 短路
- `terminal-buddy/src-tauri/src/lib.rs` — 移除注册
- `terminal-buddy/src/utils/settings.ts` — 删除 `updateCheckEnabled`
- `terminal-buddy/src/services/tauri.ts` — 删除 `saveUpdateCheckEnabled`
- `terminal-buddy/src/components/settings/BehaviorSettings.tsx` — 删除 toggle UI
- `terminal-buddy/src/components/UpdatePopover.tsx` — 重构为 4 态 props
- `terminal-buddy/src/components/UpdatePopover.css` — 加 spinner + up-to-date 样式
- `terminal-buddy/src/components/TitleBar.tsx` — 加 RefreshCw 常驻按钮 + 新 state
- `terminal-buddy/src/App.tsx` — 简化启动钩子 + lastCheckedAt 同步

---

## Task 1: 后端移除 `update_check_enabled` 全栈

**Files:**
- Modify: `terminal-buddy/src-tauri/src/models/settings.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/settings.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/update.rs`
- Modify: `terminal-buddy/src-tauri/src/lib.rs`

**Interfaces:**
- Removes: `AppSettings.update_check_enabled` field + `default_update_check_enabled()` fn + Default impl init
- Removes: `#[tauri::command] pub fn save_update_check_enabled(enabled: bool) -> Result<(), String>`
- Removes: `if !settings.update_check_enabled { return None; }` from `check_app_update`
- Removes: `save_update_check_enabled` from `use commands::{...}` and `invoke_handler!` in `lib.rs`

- [ ] **Step 1: 修改 `models/settings.rs`**

删除 `default_update_check_enabled` 函数定义（之前在 `default_single_instance` 后追加的 helper）。

删除 `AppSettings` 结构体中 `update_check_enabled: bool` 字段及其 `#[serde(default = ...)]` 属性（之前在 `enable_tab_navigation` 后追加的）。

删除 `impl Default for AppSettings` 中 `update_check_enabled: true,` 初始化行（之前在 `enable_tab_navigation: true,` 后追加的）。

- [ ] **Step 2: 修改 `commands/settings.rs`**

删除整个 `save_update_check_enabled` 函数（原位于 `save_single_instance` 之后）。

- [ ] **Step 3: 修改 `commands/update.rs`**

删除 `if !settings.update_check_enabled { return None; }` 这一行（连同其后的 return），保留 `update_service::fetch_update_info().await` 作为函数体的唯一表达式。

修改后函数体应为：

```rust
#[tauri::command]
pub async fn check_app_update() -> Option<UpdateInfo> {
    update_service::fetch_update_info().await
}
```

- [ ] **Step 4: 修改 `lib.rs` 第 7 行 `use commands::{...}` 列表**

从列表中删除 `save_update_check_enabled,`。注意：`check_app_update` 必须保留。

- [ ] **Step 5: 修改 `lib.rs` 的 `invoke_handler!` 列表**

从 `tauri::generate_handler![...]`（本项目惯用宏，函数名同样是 `check_app_update`/`save_update_check_enabled` 等）中删除 `save_update_check_enabled`。`check_app_update` 必须保留。

- [ ] **Step 6: 校验编译**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：`Finished ...` 无错误。

- [ ] **Step 7: 校验单测仍通过**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo test --lib services::update_service
```

预期：6 个测试仍通过（`compare_versions` 未动）。

- [ ] **Step 8: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src-tauri/src/models/settings.rs terminal-buddy/src-tauri/src/commands/settings.rs terminal-buddy/src-tauri/src/commands/update.rs terminal-buddy/src-tauri/src/lib.rs && git -c commit.gpgsign=false commit -m "refactor: 移除 update_check_enabled（启动总是自动检查）"
```

---

## Task 2: 前端移除 `updateCheckEnabled` 全栈

**Files:**
- Modify: `terminal-buddy/src/utils/settings.ts`
- Modify: `terminal-buddy/src/services/tauri.ts`
- Modify: `terminal-buddy/src/components/settings/BehaviorSettings.tsx`

**Interfaces:**
- Removes: `AppSettings.updateCheckEnabled: boolean`
- Removes: `DEFAULT_SETTINGS.updateCheckEnabled: true`
- Removes: `saveUpdateCheckEnabled(enabled: boolean): Promise<void>`
- Removes: 「启动时检查更新」toggle 区块 + `saveUpdateCheckEnabled` import

- [ ] **Step 1: 修改 `utils/settings.ts`**

从 `AppSettings` interface 删除 `updateCheckEnabled: boolean;`。

从 `DEFAULT_SETTINGS` 对象删除 `updateCheckEnabled: true,`。

- [ ] **Step 2: 修改 `services/tauri.ts`**

从文件末尾删除 `saveUpdateCheckEnabled` 函数定义。

- [ ] **Step 3: 修改 `BehaviorSettings.tsx`**

删除 `import { saveUpdateCheckEnabled } from '../../services/tauri';`（如果在文件里有引入；如无，跳过）。

删除整个 toggle 区块（之前在「纵向选项卡」与「右键粘贴」之间插入的 `<div className="settings-section">...「启动时检查更新」...</div>`）。

- [ ] **Step 4: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误（pre-existing MarkdownPreview.tsx 错误不计）。

- [ ] **Step 5: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/utils/settings.ts terminal-buddy/src/services/tauri.ts terminal-buddy/src/components/settings/BehaviorSettings.tsx && git -c commit.gpgsign=false commit -m "refactor: 前端移除 updateCheckEnabled 字段与开关 UI"
```

---

## Task 3: 新增 `formatRelativeTime` 工具

**Files:**
- Create: `terminal-buddy/src/utils/format.ts`

**Interfaces:**
- Produces: `export function formatRelativeTime(ms: number | null): string`
  - `null` → "尚未检查"
  - `< 60s` → "刚刚"
  - `< 60min` → "X 分钟前"
  - `< 24h` → "X 小时前"
  - `>= 24h` 同年 → "MM-DD HH:mm"
  - `>= 24h` 跨年 → "YYYY-MM-DD HH:mm"

- [ ] **Step 1: 创建 `utils/format.ts`**

```ts
/**
 * 把 Unix 毫秒时间戳格式化为「最后检查 X」文案。
 * - null → "尚未检查"
 * - < 60s → "刚刚"
 * - < 60min → "X 分钟前"
 * - < 24h → "X 小时前"
 * - >= 24h 同年 → "MM-DD HH:mm"
 * - >= 24h 跨年 → "YYYY-MM-DD HH:mm"
 */
export function formatRelativeTime(ms: number | null): string {
  if (ms == null) return '尚未检查';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚'; // 系统时间倒退保护
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === new Date().getFullYear()) return stamp;
  return `${d.getFullYear()}-${stamp}`;
}
```

- [ ] **Step 2: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 3: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/utils/format.ts && git -c commit.gpgsign=false commit -m "feat: 新增 formatRelativeTime 工具（最后检查 X 文案）"
```

---

## Task 4: 简化 `App.tsx` 启动钩子（移除 I-3/I-4 复杂度）

**Files:**
- Modify: `terminal-buddy/src/App.tsx`

**Interfaces:**
- Removes: `settingsReady` state、`updateCheckEnabled` state、`app-settings-changed` 监听器
- Removes: `if (!settingsReady) return;` 和 `if (!updateCheckEnabled) return;` 短路
- Changes: useEffect 依赖从 `[updateCheckEnabled, settingsReady]` 改为 `[]`
- Adds: `lastCheckedAt` state + localStorage 同步
- Adds: `<TitleBar>` 新 prop `onPromoteToUpdate(info)` 让手动检查结果也能驱动 Bell

- [ ] **Step 1: 删除 `settingsReady` 与 `updateCheckEnabled` state**

找到之前追加的：

```tsx
const [settingsReady, setSettingsReady] = useState(false);
const [updateCheckEnabled, setUpdateCheckEnabled] = useState(() => getAppSettings().updateCheckEnabled);
```

删除这两行。

- [ ] **Step 2: 删除 init effect 中的 `setSettingsReady(true)` 与 `setUpdateCheckEnabled(...)` 调用**

找到之前 init effect 末尾的：

```tsx
setUpdateCheckEnabled(getAppSettings().updateCheckEnabled);
setSettingsReady(true);
```

删除这两行。

- [ ] **Step 3: 删除 `app-settings-changed` 监听器**

找到之前添加的 useEffect：

```tsx
useEffect(() => {
  const handler = () => setUpdateCheckEnabled(getAppSettings().updateCheckEnabled);
  window.addEventListener('app-settings-changed', handler);
  return () => window.removeEventListener('app-settings-changed', handler);
}, []);
```

删除整个 useEffect 块。

- [ ] **Step 4: 修改启动钩子 useEffect**

找到：

```tsx
useEffect(() => {
  if (!settingsReady) return;
  if (!updateCheckEnabled) return;
  checkAppUpdate()
    .then(info => {
      if (!info) return;
      const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
      if (info.version === dismissed) return;
      if (compareVersions(info.version, APP_VERSION) <= 0) return;
      setUpdateInfo(info);
    })
    .catch(() => {});
}, [updateCheckEnabled, settingsReady]);
```

替换为：

```tsx
useEffect(() => {
  checkAppUpdate()
    .then(info => {
      const now = Date.now();
      localStorage.setItem('appUpdate.lastCheckedAt', String(now));
      if (!info) return;
      const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
      if (info.version === dismissed) return;
      if (compareVersions(info.version, APP_VERSION) <= 0) return;
      setUpdateInfo(info);
    })
    .catch(() => {});
}, []);
```

- [ ] **Step 4a: 新增 `onPromoteToUpdate` 回调，传给 `<TitleBar>`**

在 `App` 函数体内、`<TitleBar>` JSX 上方声明：

```tsx
const handlePromoteToUpdate = useCallback((info: UpdateInfo) => {
  const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
  if (info.version === dismissed) return;
  if (compareVersions(info.version, APP_VERSION) <= 0) return;
  setUpdateInfo(info);
}, []);
```

将 `<TitleBar>` 调用处新增 prop：

```tsx
onPromoteToUpdate={handlePromoteToUpdate}
```

- [ ] **Step 5: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 6: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/App.tsx && git -c commit.gpgsign=false commit -m "refactor: 简化 App 启动钩子（移除 settingsReady/updateCheckEnabled 复杂度）"
```

---

## Task 5: 重构 `UpdatePopover` 支持 4 态

**Files:**
- Modify: `terminal-buddy/src/components/UpdatePopover.tsx`
- Modify: `terminal-buddy/src/components/UpdatePopover.css`

**Interfaces:**
- New props:
  ```ts
  interface UpdatePopoverProps {
    status: 'idle' | 'checking' | 'up-to-date' | 'has-update';
    info: UpdateInfo | null;
    lastCheckedAt: number | null;
    currentVersion: string;
    onCheckNow: () => void;
    onDismiss: () => void;
    onIgnore: () => void;
  }
  ```
- 4 态独立渲染分支；`has-update` 沿用现有 changelog + 下载 + 忽略

- [ ] **Step 1: 重写 `UpdatePopover.tsx`**

完整文件内容（注意：`up-to-date` 态的关闭按钮调用 `onDismiss` 而非 `window.close()`，避免误关主窗口）：

```tsx
import { FC } from 'react';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { Check, Download, RefreshCw, X } from 'lucide-react';
import type { UpdateInfo } from '../services/tauri';
import { formatRelativeTime } from '../utils/format';
import './UpdatePopover.css';

const md = new MarkdownIt({ html: false, linkify: true });

export type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'has-update';

interface UpdatePopoverProps {
  status: UpdateCheckStatus;
  info: UpdateInfo | null;
  lastCheckedAt: number | null;
  currentVersion: string;
  onCheckNow: () => void;
  onDismiss: () => void;
  onIgnore: () => void;
}

export const UpdatePopover: FC<UpdatePopoverProps> = ({
  status,
  info,
  lastCheckedAt,
  currentVersion,
  onCheckNow,
  onDismiss,
  onIgnore,
}) => {
  const html = status === 'has-update' && info
    ? DOMPurify.sanitize(md.render(info.changelogMd || ''))
    : '';

  const handleDownload = () => {
    if (!info) return;
    window.open(info.downloadUrl, '_blank', 'noopener,noreferrer');
  };

  const handleIgnore = () => {
    if (!info) return;
    localStorage.setItem('appUpdate.dismissedVersion', info.version);
    onIgnore();
  };

  return (
    <div className="update-popover" role="dialog" aria-label="更新检查">
      <div className="update-popover-header">
        <div className="update-popover-title">{renderTitle(status, info)}</div>
        <button
          type="button"
          className="update-popover-close"
          onClick={onDismiss}
          title="关闭"
          aria-label="关闭更新检查面板"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {renderBody(status, info, html, lastCheckedAt, currentVersion)}

      <div className="update-popover-actions">
        {renderActions(status, info, onCheckNow, handleDownload, handleIgnore)}
      </div>
    </div>
  );
};

function renderTitle(status: UpdateCheckStatus, info: UpdateInfo | null) {
  switch (status) {
    case 'idle':
    case 'checking':
      return <span>检查更新</span>;
    case 'up-to-date':
      return (
        <>
          <Check size={14} aria-hidden="true" className="update-popover-check" />
          <span>当前已是最新</span>
        </>
      );
    case 'has-update':
      return (
        <>
          <Download size={14} aria-hidden="true" />
          <span>发现新版本 v{info?.version}</span>
        </>
      );
  }
}

function renderBody(
  status: UpdateCheckStatus,
  info: UpdateInfo | null,
  html: string,
  lastCheckedAt: number | null,
  currentVersion: string,
) {
  switch (status) {
    case 'idle':
      return (
        <>
          <div className="update-popover-meta">
            点击下方按钮立即检查最新版本
          </div>
          <div className="update-popover-meta">
            最后检查：{formatRelativeTime(lastCheckedAt)}
          </div>
        </>
      );
    case 'checking':
      return (
        <>
          <div className="update-popover-meta update-popover-checking">
            <RefreshCw size={12} aria-hidden="true" className="update-popover-spinner" />
            正在检查最新版本…
          </div>
        </>
      );
    case 'up-to-date':
      return (
        <>
          <div className="update-popover-meta">v{currentVersion} 是最新版本</div>
          <div className="update-popover-meta">最后检查：{formatRelativeTime(lastCheckedAt)}</div>
        </>
      );
    case 'has-update':
      return (
        <>
          <div className="update-popover-meta">发布于 {info?.releaseDate}</div>
          <div
            className="update-popover-changelog"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      );
  }
}

function renderActions(
  status: UpdateCheckStatus,
  info: UpdateInfo | null,
  onCheckNow: () => void,
  handleDownload: () => void,
  handleIgnore: () => void,
) {
  switch (status) {
    case 'idle':
      return (
        <button type="button" className="btn-primary" onClick={onCheckNow}>
          检查更新
        </button>
      );
    case 'checking':
      return (
        <button type="button" className="btn-secondary" disabled>
          检查中…
        </button>
      );
    case 'up-to-date':
      return (
        <>
          <button type="button" className="btn-primary" onClick={onCheckNow}>
            重新检查
          </button>
          <button type="button" className="btn-secondary" onClick={onDismiss}>
            关闭
          </button>
        </>
      );
    case 'has-update':
      return (
        <>
          <button type="button" className="btn-primary" onClick={handleDownload}>
            前往 Gitee 下载
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleIgnore}
            title="忽略此版本，下次发布新版前不再提示"
          >
            忽略此版本
          </button>
        </>
      );
  }
}
```

- [ ] **Step 2: 追加样式到 `UpdatePopover.css`**

在文件末尾追加：

```css
.update-popover-check {
  color: var(--success);
}

.update-popover-checking {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.update-popover-spinner {
  animation: update-popover-spin 1s linear infinite;
}

@keyframes update-popover-spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 3: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 4: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/components/UpdatePopover.tsx terminal-buddy/src/components/UpdatePopover.css && git -c commit.gpgsign=false commit -m "feat: UpdatePopover 支持 4 态（idle/checking/up-to-date/has-update）"
```

---

## Task 6: TitleBar 加常驻 RefreshCw 按钮 + popover 状态管理

**Files:**
- Modify: `terminal-buddy/src/components/TitleBar.tsx`

**Interfaces:**
- Adds: 常驻 RefreshCw 按钮（无条件渲染）
- Adds: popover 4 态 state
- Adds: `lastCheckedAt` state + localStorage 同步
- Bell 渲染条件不变（仍只 `updateInfo` 非空时出现）

- [ ] **Step 1: 修改 `TitleBar.tsx` props 接口**

`TitleBarProps` 当前已包含 `updateInfo` + `onUpdateDismiss`（来自上一版）。**新增**：

```tsx
  onPromoteToUpdate: (info: UpdateInfo) => void;
```

并在函数签名解构处添加 `onPromoteToUpdate`。

- [ ] **Step 2: 添加新 state 与 ref**

在现有 `useState` 群（约 line 46-50）之后追加：

```tsx
const [refreshHover, setRefreshHover] = useState(false);
const [checkStatus, setCheckStatus] = useState<UpdateCheckStatus>('idle');
const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(() => {
  const v = localStorage.getItem('appUpdate.lastCheckedAt');
  return v ? Number(v) : null;
});
const refreshHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

- [ ] **Step 3: 添加 hover handlers 与检查函数**

在现有 `handleUpdateEnter` / `handleUpdateLeave` 之后追加：

```tsx
const handleRefreshEnter = () => {
  if (refreshHoverTimer.current) clearTimeout(refreshHoverTimer.current);
  setRefreshHover(true);
};
const handleRefreshLeave = () => {
  refreshHoverTimer.current = setTimeout(() => setRefreshHover(false), 200);
};

const handleCheckNow = async () => {
  setCheckStatus('checking');
  try {
    const info = await checkAppUpdate();
    const now = Date.now();
    localStorage.setItem('appUpdate.lastCheckedAt', String(now));
    setLastCheckedAt(now);
    if (info) {
      const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
      if (info.version !== dismissed && compareVersions(info.version, APP_VERSION) > 0) {
        // 手动检查也驱动 Bell（同步状态）
        onPromoteToUpdate(info);
        setCheckStatus('has-update');
      } else {
        setCheckStatus('up-to-date');
      }
    } else {
      setCheckStatus('up-to-date');
    }
  } catch {
    setCheckStatus('up-to-date');
  }
};
```

`onPromoteToUpdate(info)` 由 App.tsx 提供的回调，内部再次过滤被忽略的版本与版本比较，确保 Bell 不会被误亮。

- [ ] **Step 4: 修改 cleanup useEffect**

在现有 cleanup useEffect（约 line 52-61）中追加对新 timer 的清理：

```tsx
if (refreshHoverTimer.current) {
  clearTimeout(refreshHoverTimer.current);
}
```

- [ ] **Step 5: 添加 imports**

在文件顶部 imports 中追加：

```tsx
import { RefreshCw } from 'lucide-react';
import { checkAppUpdate } from '../services/tauri';
import { compareVersions } from '../utils/version';
import { APP_VERSION } from '../version';
import { UpdatePopover, type UpdateCheckStatus } from './UpdatePopover';
```

- [ ] **Step 6: 修改 JSX — 在 `.titlebar-nav-btns` 区域加常驻 RefreshCw 按钮**

找到现有 `<div className="ai-usage-trigger">...</div>` 包裹的 AI 用量区块，在它**之前**插入新常驻按钮：

```tsx
<div
  className="ai-usage-trigger"
  onMouseEnter={handleRefreshEnter}
  onMouseLeave={handleRefreshLeave}
>
  <button
    type="button"
    className="titlebar-nav-btn"
    title="检查更新"
    aria-label="检查更新"
    onClick={handleCheckNow}
  >
    <RefreshCw aria-hidden="true" />
  </button>
  {refreshHover && (
    <UpdatePopover
      status={checkStatus}
      info={updateInfo}
      lastCheckedAt={lastCheckedAt}
      currentVersion={APP_VERSION}
      onCheckNow={handleCheckNow}
      onDismiss={() => setRefreshHover(false)}
      onIgnore={onUpdateDismiss}
    />
  )}
</div>
```

- [ ] **Step 7: 修改 Bell 按钮的 popover 调用**

找到现有 Bell 区块的 `<UpdatePopover info={updateInfo} onDismiss={onUpdateDismiss} />` 调用，改为新 props 形式：

```tsx
<UpdatePopover
  status="has-update"
  info={updateInfo}
  lastCheckedAt={lastCheckedAt}
  currentVersion={APP_VERSION}
  onCheckNow={handleCheckNow}
  onDismiss={() => setUpdateHover(false)}
  onIgnore={onUpdateDismiss}
/>
```

- [ ] **Step 8: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 9: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/components/TitleBar.tsx && git -c commit.gpgsign=false commit -m "feat: TitleBar 加常驻检查更新按钮"
```

---

## Task 7: 端到端验证

**Files:** 无

- [ ] **Step 1: Rust 全量单测**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo test --lib
```

预期：51 个测试全部通过（包含 6 个 `compare_versions`）。

- [ ] **Step 2: 前端类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 3: Rust 编译检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：0 错误。

- [ ] **Step 4: 静态 grep 确认关键接线**

```bash
cd "D:/gitee/TerminalBuddy" && grep -n "formatRelativeTime\|UpdateCheckStatus\|lastCheckedAt\|RefreshCw\|check_app_update" terminal-buddy/src/App.tsx terminal-buddy/src/components/TitleBar.tsx terminal-buddy/src/components/UpdatePopover.tsx terminal-buddy/src/utils/format.ts terminal-buddy/src-tauri/src/commands/update.rs terminal-buddy/src-tauri/src/lib.rs
```

预期：每个 key 至少命中 1 次。**不应再出现** `update_check_enabled` / `updateCheckEnabled` / `save_update_check_enabled` / `saveUpdateCheckEnabled`。

- [ ] **Step 5: 确认无残留**

```bash
cd "D:/gitee/TerminalBuddy" && grep -rn "update_check_enabled\|updateCheckEnabled\|save_update_check_enabled\|saveUpdateCheckEnabled" --include="*.rs" --include="*.ts" --include="*.tsx" terminal-buddy/ 2>/dev/null
```

预期：无输出（除 design / plan / spec 文档外不残留）。

- [ ] **Step 6: 提交（如有遗留修复）**

如有需要：
```bash
cd "D:/gitee/TerminalBuddy" && git add -A && git -c commit.gpgsign=false commit -m "fix: 端到端验证后的清理"
```

否则跳过。