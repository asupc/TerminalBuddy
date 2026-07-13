# 功能设计说明：VSCode 风格侧边栏

> 交付物：给后续 agent 的设计说明（不做实施清单）。讲清楚"为什么、做什么、大致边界"。

---

## 背景与价值

现在 TerminalBuddy 的「配置导航」「文件浏览」「Git 跟踪」三个功能入口散在 TitleBar 按钮 + 嵌入到 FileNav 内部，且 Git 只针对当前目录。

**为什么要改：**
- 用户同时维护多个 Git 仓库时，切换仓库要靠改 `currentDirectory`，体验割裂
- FileNav 是"导航式"（当前目录变就整个侧栏刷），不是"资源管理器式"（固定根、看整树）
- 入口分散在 TitleBar，没有一致的主导航

**改造后价值：**
- 一致入口 — 所有视图统一在左侧 Activity Bar
- 多仓库切换 — 工作区列表点一下切到
- 看代码更直接 — 文件树里双击直接进编辑器 Tab，不用先点开目录再双击

---

## 设计思路

### 整体形态（仿 VSCode）

```
┌─ TitleBar（窗口控制/设置/关于；不再放 ☰📁）──────────────┐
├──┬──────────┬──────────┬──────────────────────────────┐
│AB│ Sidebar  │ TabNav   │ TerminalPanel               │
│  │ (互斥)    │          │                              │
└──┴──────────┴──────────┴──────────────────────────────┘
AB = Activity Bar（38px 固定图标列）
Sidebar 互斥渲染：配置 / 文件浏览器 / Git 工作区
```

### Activity Bar 行为

- 三个图标：配置 / 文件 / Git
- 点同一图标已激活 → 折叠 Sidebar
- 点其他图标 → 切换视图 + 展开
- 底部固定：+ 添加 Git 仓库、⚙ 设置

### 三个 Sidebar 视图

**1. 配置视图** — 复用现有连接面板，按分组展示 Profile（搜索/排序/右键），不变。

**2. 文件视图（改造重点）** — 从"导航式"改成"资源管理器式"：
- 固定一个根目录（用户可选）
- 整树点 ▶ 展开/折叠，不再"换目录刷整栏"
- 双击文件 → 直接开编辑器 Tab
- 顶栏按钮：换根 / 刷新 / 复制路径 / 在资源管理器中显示 / 新建文件夹 / 新建文件

**3. Git 视图（新增重点）** — 多工作区：
- 上半：工作区列表（添加 / 切换 / 重命名 / 删除）
- 下半：复用现有 GitNavBar（pull/commit/push/history/分支切换）
- 切工作区 = 把 GitNavBar 的当前目录换到新仓库，所有 Git 操作作用于新仓库

### 用户场景示例

> "我同时维护 terminal-buddy 和另一个 demo 仓库，现在要在 terminal-buddy 切到 feat/x 分支提交"

**改造前：** 改 currentDirectory 到 terminal-buddy → 看到 GitNavBar 刷新 → 切分支 → 提交。中间穿插"侧栏跳一下"的视觉噪音。

**改造后：** 点工作区列表里的 terminal-buddy → GitNavBar 刷新（因为换了 prop） → 点分支按钮 → 提交。整个过程不停留在"切换目录"这一步。

> "我要在 `src/foo.ts` 加个函数"

**改造前：** 在 FileNav 点 ▶ 展开 src 目录 → 找 foo.ts → 双击。如果当前目录不对还要先改目录。

**改造后：** 文件浏览器里树已经展开，点 foo.ts 双击进编辑器 Tab。

---

## 关键设计决策

### 决策 1：复用优先

- **复用**：ConfigNav、GitNavBar、TextEditor、openEditorSession、openGitHistoryTab
- **不重新发明**：不重写 Git pull/commit/push 弹窗；不重写文件编辑器
- **新增**：ActivityBar、Sidebar 容器、ExplorerView、GitWorkspacesView、WorkspaceList、ExplorerActions、ExplorerTree

**为什么：** 现有 GitNavBar 完整支持 pull/commit/push/history；TextEditor 已能用。重新写一遍风险高、收益零。

### 决策 2：状态合并

把两套独立开关合并成一组：

- 旧：`configPanelVisible` + `fileTreeVisible`（两个布尔，分别控制两个侧栏）
- 新：`sidebarVisible` + `activeSidebarView ∈ {config, explorer, git}`（一组控制 Sidebar）

**过渡方案：** 迁移期双轨，启动时把旧值映射到新值；最后清理旧字段。

### 决策 3：文件视图固定根

不要再用 `currentDirectory` 渲染文件树（那正是"导航式"的根源）。文件视图需要一个独立状态"explorerRoot"。

- `currentDirectory` 用于 GitNavBar 和"在打开的终端里 cd"（保持不变）
- `explorerRoot` 用于文件视图（新增）

两者**不耦合**：在 Git 切到 B 仓库不会改文件视图的根。

### 决策 4：多工作区持久化

工作区列表存到 settings.json（沿用现有 `client_data_service` 流程），不引新文件、不引新依赖。

**字段形状：** `{ id, name, path, lastOpened }`，前端 store + 后端 settings.json 同时持有。

### 决策 5：极小后端改动

只补 2 个新命令：`create_file(path)`、`create_directory(path)`（FileNav 缺这两个，ExplorerActions 要）。

其他后端**完全不动**。

---

## 大致边界

### 涉及范围

- `App.tsx`、`TitleBar.tsx`（删旧按钮）
- `stores/appStore.ts`（合并状态 + 新增工作区 actions）
- `services/gitWorkspaces.ts`（持久化）
- `utils/settings.ts` + `src-tauri/src/models`（settings 字段扩展）
- 后端新增 2 个 fs 命令
- 删除 `FileNav.tsx + FileNav.css`

### 不涉及

- Git pull/commit/push 弹窗的内部逻辑
- TextEditor（Monaco）集成
- 终端 PTY 管理
- Web 远程访问（不增加新命令）
- SSH 远程文件视图（继续走 RemoteFileTree）

### 降级 / 兜底

- ExplorerRoot 路径无效 → 显示空状态 + "选择根目录"按钮
- 工作区路径无效 → 列表项标灰，GitNavBar 自动不渲染
- 旧 settings.json 没新字段 → 按旧 `configPanelVisible/fileTreeVisible` 决定首次进入哪个视图

---

## 验收标准

1. Activity Bar 三按钮互斥切换 + 同按钮折叠生效
2. 三个 Sidebar 视图切换无残留状态
3. 文件视图双击文件进编辑器 Tab
4. ExplorerActions 全部生效（含资源管理器集成）
5. 多工作区切换：pull/commit/push 作用于当前工作区
6. 重启后：视图、宽度、工作区全部恢复
7. F11 全屏切换仍能正确隐藏/恢复 Sidebar
8. TitleBar 不再出现旧的 ☰ / 📁 按钮
9. SSH 会话下文件视图仍走 RemoteFileTree（不破坏现有功能）

---

## 后续 agent 切入点提示

- 现状基线：`App.tsx` 布局 / `ConfigNav.tsx` / `FileNav.tsx`（含 GitNavBar）/ `appStore.ts` 的 panel 状态
- 复用基线：`GitNavBar.tsx` 接受 `currentDirectory` prop，内部拉 git status
- 编辑器入口：`useAppStore.openEditorSession(path)` 已经是文本编辑的标准入口
- 多工作区数据：决定存进现有 `settings.json`，沿用 `client_data_service` 同步路径即可
