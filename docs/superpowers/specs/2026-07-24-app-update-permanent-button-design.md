# 应用更新检查：常驻按钮 + 独立详情面板

- 日期：2026-07-24
- 范围：标题栏新增「手动检查更新」常驻入口，复用现有 UpdatePopover 视觉；移除「启动时检查更新」开关（由用户主动改用手动入口）
- 关联：上一版设计 `2026-07-24-version-check-update-design.md` 提到的「仅通知+手动下载」基础架构；本设计在该架构上补 UX 短板

## 1. 背景与目标

### 1.1 现状（已实现）

- 应用启动后 `App.tsx` 调用 `checkAppUpdate()`，检测到新版本时 `TitleBar` 出现 Bell + 红点 + popover。
- 「启动时检查更新」开关在「行为设置」里（默认开启）。

### 1.2 现状问题

- 没有常驻入口，用户**只能被动等 Bell 出现**才能看到更新提示。如果用户想「我现在就想看看有没有新版」，必须重启 app 或等下一次启动。
- 「启动时检查更新」开关语义模糊——开启关闭只是「要不要自动检查」，并没有解决「如何手动检查」的问题，且选项与 Bell 通知机制职责重叠。

### 1.3 目标

1. TitleBar `.titlebar-nav-btns` 区域加一个**常驻 `RefreshCw` 按钮**，任何状态下都可点。点击展开 popover 给出检查状态反馈。
2. 复用现有 `UpdatePopover` 视觉（hover popover，CSS 类 `update-popover` 等），不新建 Dialog。
3. Popover 支持 4 个态：`idle` / `checking` / `up-to-date` / `has-update`。前两态展示给用户**结果反馈**（不打扰），`has-update` 态沿用现有 changelog/下载/忽略流程。
4. Bell+红点行为**完全不变**（仅在 `has-update` 时出现），仅作为通知补强。
5. 移除「启动时检查更新」开关 + 后端 `update_check_enabled` 字段：app 启动**总是**自动检查（5s 超时、错误静默），手动按钮用于显式再查。
6. 新增 localStorage key `appUpdate.lastCheckedAt`，记忆上次检查时间戳；用于「最后检查 X 分钟前」展示。

### 1.4 非目标（YAGNI）

- 不引入周期定时检查。
- 不强制更新（manifest 中 `mandatory` 字段仍保留不强制执行）。
- 不实现应用内自动下载安装。
- 不做「上次检查时间」以外的历史记录。
- 不暴露 manifest URL 自定义设置。

## 2. 数据模型

### 2.1 删除：`AppSettings.update_check_enabled`

后端 `terminal-buddy/src-tauri/src/models/settings.rs` 删除：
- 字段 `update_check_enabled: bool`
- 默认函数 `default_update_check_enabled()`
- `Default for AppSettings` 中的初始化

前端 `terminal-buddy/src/utils/settings.ts` 删除：
- 接口字段 `updateCheckEnabled: boolean`
- `DEFAULT_SETTINGS.updateCheckEnabled: true`

向后兼容：旧 `settings.json` 残留的 `update_check_enabled` 字段会被 serde 忽略（多余字段不报错）。

### 2.2 新增：`appUpdate.lastCheckedAt` localStorage

- key：`appUpdate.lastCheckedAt`
- value：`number`（Unix 毫秒时间戳）或 `null`（未检查过）
- 写入时机：App.tsx 启动钩子的 `checkAppUpdate().then(...)` 与 `TitleBar` 手动按钮触发的 `checkAppUpdate().then(...)` 都会写。
- 读出时机：`UpdatePopover` 渲染「最后检查 X」文案时读。

### 2.3 manifest `version.json`

无改动。结构保持 `version / releaseDate / mandatory / changelogMd / downloadUrl` 五字段。

## 3. 架构

### 3.1 模块划分（变更部分）

```
TitleBar (新增常驻 RefreshCw 按钮 + 共享 update 状态)
  ├─ RefreshCw 常驻按钮 → 点击 → 展开 UpdatePopover → 调 checkAppUpdate
  ├─ Bell 红点按钮（不变，仅在 has-update 时出现）
  └─ UpdatePopover（重构 props，按 4 态渲染）

App.tsx (简化启动钩子)
  └─ useEffect([]) → checkAppUpdate() → 写 lastCheckedAt + 设 updateInfo
```

### 3.2 职责边界

- **App.tsx**：负责启动时拉一次 `checkAppUpdate()`，结果写到 `updateInfo` state + localStorage `lastCheckedAt`。不再判断 `updateCheckEnabled`，不再 gate。
- **TitleBar.tsx**：管理 popover 的显示/隐藏 + 当前态（idle / checking / up-to-date / has-update）+ 当前 `updateInfo` + 当前 `lastCheckedAt`。点击 RefreshCw 按钮触发手动 `checkAppUpdate()`，结果同样写入这三处。Bell 渲染条件保持不变。
- **UpdatePopover.tsx**：纯展示组件，props 驱动渲染。4 态独立互斥，由 TitleBar 决定传入哪种态。

### 3.3 状态机

```
        ┌─────────────────────────────┐
        ↓                             │
   ┌─────────┐  click   ┌─────────────┴──┐
   │  idle   │ ───────→ │    checking    │
   └─────────┘          └────────────┬───┘
        ↑                            ↓ check returns null
        │                  ┌─────────────────────┐
        │                  ↓                     ↓
        │            ┌──────────────┐    ┌─────────────┐
        └─ dismiss ──│ up-to-date   │    │ has-update  │
                     └──────────────┘    └─────────────┘
                            ↑  click RefreshCw (loop back to checking)
                            ↑
                          same path back from checking → up-to-date | has-update
```

- `idle`：刚启动未检查 OR 用户关闭 popover 后未点击。
- `checking`：手动按钮点击后或启动检查中。popover 始终展示。
- `up-to-date`：`checkAppUpdate` 返回 `null`（远端 ≤ 当前）。popover 展示「✓ 当前已是最新」。
- `has-update`：`checkAppUpdate` 返回 `UpdateInfo`。popover 展示 changelog + 下载/忽略。

## 4. 数据流

### 4.1 启动时

```
[App mount]
  → useEffect([]) → checkAppUpdate()
    → null: setLastCheckedAt(Date.now()); 不 setUpdateInfo
    → info: setLastCheckedAt(Date.now()); setUpdateInfo(info)
  → 写 localStorage.appUpdate.lastCheckedAt
```

### 4.2 手动点击 RefreshCw

```
[TitleBar RefreshCw click]
  → setUpdateCheckStatus('checking')
  → checkAppUpdate()
    → null: setUpdateCheckStatus('up-to-date'); setLastCheckedAt(Date.now()); setUpdateInfo(null)
    → info: setUpdateCheckStatus('has-update'); setLastCheckedAt(Date.now()); setUpdateInfo(info)
  → 写 localStorage.appUpdate.lastCheckedAt
  → Bell 自动按 updateInfo 是否非空显隐
```

### 4.3 「最后检查 X 分钟前」格式

`formatRelativeTime(ms)` 工具函数：
- `< 60s` → "刚刚"
- `< 60min` → "X 分钟前"
- `< 24h` → "X 小时前"
- `>= 24h` 且同年 → "MM-DD HH:mm"
- `>= 24h` 跨年 → "YYYY-MM-DD HH:mm"

实现于 `src/utils/format.ts` 新文件（与 `compareVersions` 同级工具目录约定）。

## 5. UI

### 5.1 Popover 各态

| 态 | 标题 | 主体 | 操作 |
|---|---|---|---|
| `idle` | "检查更新" | "点击下方按钮立即检查最新版本" + "最后检查: {相对时间}" 或 "尚未检查过" | [检查更新] |
| `checking` | "检查更新" | Spinner + "正在检查最新版本…" | 按钮 disabled |
| `up-to-date` | "✓ 当前已是最新" | "v{APP_VERSION} 是最新版本" + "最后检查: {相对时间}" | [重新检查] [关闭] |
| `has-update` | "发现新版本 v{info.version}" | 发布于 {date} + changelog | [前往 Gitee 下载] [忽略此版本] |

`has-update` 态沿用现有 UpdatePopover 渲染主体；其他三态是新加内容。

### 5.2 TitleBar 改动

`.titlebar-nav-btns` 区域：

```tsx
<div className="titlebar-nav-btns">
  {uiStyle === 'default' && (...PanelLeft/Folder 按钮...)}
  <button onClick={onGlobe2}>...</button>   // 现有 Web 管理
  <div className="ai-usage-trigger">...</div>  // 现有 AI 用量
  <div className="ai-usage-trigger"
       onMouseEnter={onEnter}
       onMouseLeave={onLeave}>
    <button onClick={onClickRefresh} title="检查更新">
      <RefreshCw />
    </button>
    {hover && <UpdatePopover status={...} info={...} lastCheckedAt={...} onCheckNow={onCheckNow} onDismiss={onDismiss} onIgnore={onIgnore} />}
  </div>
  {updateInfo && (
    <div className="ai-usage-trigger">
      <button><Bell /><span className="titlebar-status-dot update-available" /></button>
      {bellHover && <UpdatePopover status="has-update" info={updateInfo} ... />}
    </div>
  )}
</div>
```

刷新按钮图标 `RefreshCw`（来自 lucide-react），检查中可旋转动画。

## 6. 文件改动清单

### 删除

- 后端：
  - `terminal-buddy/src-tauri/src/models/settings.rs` 删除 `update_check_enabled` 字段、`default_update_check_enabled()`、`Default for AppSettings` 中初始化
  - `terminal-buddy/src-tauri/src/commands/settings.rs` 删除 `save_update_check_enabled`
  - `terminal-buddy/src-tauri/src/commands/update.rs` 删除 `if !settings.update_check_enabled` 短路
  - `terminal-buddy/src-tauri/src/lib.rs` 删除 `save_update_check_enabled` 注册（`use commands::{...}` 与 `invoke_handler!`）
- 前端：
  - `terminal-buddy/src/utils/settings.ts` 删除 `updateCheckEnabled` 字段与默认
  - `terminal-buddy/src/services/tauri.ts` 删除 `saveUpdateCheckEnabled` 包装
  - `terminal-buddy/src/components/settings/BehaviorSettings.tsx` 删除「启动时检查更新」toggle 区块与 `saveUpdateCheckEnabled` import

### 新增

- `terminal-buddy/src/utils/format.ts`：`formatRelativeTime(ms: number | null): string`
- `terminal-buddy/src/components/UpdatePopover.tsx` 重构为支持 4 态 props

### 修改

- `terminal-buddy/src/components/UpdatePopover.css`：加 spinner、`up-to-date` 勾选样式
- `terminal-buddy/src/components/TitleBar.tsx`：加 RefreshCw 常驻按钮 + popover state + Bell 保留
- `terminal-buddy/src/App.tsx`：简化启动钩子（去掉 updateCheckEnabled / settingsReady 依赖）；新增 `lastCheckedAt` 同步

## 7. 错误处理

- `checkAppUpdate()` 返回 `null`：网络失败 / 解析失败 / 远端 ≤ 当前 → popover 进入 `up-to-date` 或保持 idle（取决于是否触发过）
- `localStorage` 读写失败：catch 后静默，回退到 `null` 显示「尚未检查」
- 检查超时（5s 后端侧）：popover 自动从 `checking` 切到 `up-to-date`

## 8. 测试

复用现有 6 个 `compare_versions` 单测。新增内容无新测试需求：
- `formatRelativeTime` 是纯函数，建议加 3-4 个 jest/vitest 单测，但项目无前端测试基础设施，**不强制**；在 `src/utils/format.ts` 中以注释列出边界。
- TitleBar/App.tsx 行为靠手工 + 编译验证。

## 9. 与现有设计的偏差（要更新的文档）

- `docs/superpowers/specs/2026-07-24-version-check-update-design.md` §1.2 目标 2（"在设置页「通用」加一个开关「启动时检查更新」（默认开启）"）作废。
- §2.1 / §3.2 / §4.1 / §4.2 / §4.3 中所有 `update_check_enabled` 引用作废。
- §5 错误处理表格第二行（"前端 `invoke` reject"）改为 catch 后进入 `up-to-date`。

可在本次实施 commit 中附带一个 doc 修正 commit，或在本设计被采纳后单独修订。