---
title: 补全本地文件导航功能
slug: complete-file-navigation
date: 2026-06-28
---

# 补全本地文件导航功能

## 目标

为本地文件树 (`FileTree.tsx`) 补全三个导航维度：**后退/前进历史**、**目录内搜索过滤**、**排序能力**。仅作用于本地文件树，SSH 远程文件树维持现状。

## 现状摘要

- `FileTree.tsx`（779 行）：树形展开、书签、路径编辑、拖拽、右键菜单、F2 重命名、Ctrl+C 复制路径、宽度可调、排除规则、上一级/刷新
- `RemoteFileTree.tsx`（856 行）：本次不修改
- 后端 `list_directory` 仅返回 `FileNode { name, path, is_directory }`，无 size/modified
- 前端 store 用 zustand，持久化用 `writeClientData(key, JSON.stringify(...))`

## 设计原则

- **最小代码**：仅补三件缺失功能，不顺手重构既有代码
- **复用既有模式**：状态写入 `appStore`，持久化调用 `writeClientData`，CSS 沿用现有 token
- **渐进披露**：UI 控件尽量收敛到现有 titlebar，不引入新面板

## 子任务（原子提交）

### Task 1 — 后端扩展 `FileNode` 元数据

**文件**：`terminal-buddy/src-tauri/src/commands/fs.rs`

`FileNode` 新增 `size: u64` 和 `last_modified: u64`（Unix 毫秒），`list_directory` 在遍历时填充。`0` 表示元数据不可用。前端 `services/tauri.ts` 的 `FileNode` 接口同步增加 `size: number; lastModified: number;`。

这一步是后续排序能力的前置 — 不补元数据就排不了大小/时间。

### Task 2 — store 增加导航历史状态与持久化

**文件**：`terminal-buddy/src/stores/appStore.ts`

新增字段：
- `navBackStack: string[]`
- `navForwardStack: string[]`
- `fileSortBy: 'name' | 'size' | 'modified'`（默认 `'name'`）
- `fileSortDir: 'asc' | 'desc'`（默认 `'asc'`）

新增方法：
- `navigateWithHistory(path: string)` — 把当前 `currentDirectory` 入 back 栈、清空 forward 栈、设置新路径
- `navBack()` — 把当前入 forward 栈、pop back 栈并导航
- `navForward()` — 把当前入 back 栈、pop forward 栈并导航
- `setFileSort(by, dir)` — 设置排序并持久化

持久化：导航历史 + 排序偏好写入 `writeClientData('file_nav', ...)`，初始加载时读回。

back/forward 栈上限 50 项，避免无界增长。

### Task 3 — `FileTree.tsx` 接入后退/前进 + 排序 + 过滤

**文件**：`terminal-buddy/src/components/FileTree.tsx`、`terminal-buddy/src/components/FileTree.css`

具体改动：

1. **后退/前进按钮**：titlebar 现只有 ↻，在前面加 ⬅ ➡；stack 为空时按钮 disabled。点击调用 store 的 `navBack()` / `navForward()`，再用 `navigateTo(path)` 触发实际的列表加载。

2. **键盘快捷键**：当 `.file-tree` 内有焦点时，`Alt+ArrowLeft` → back，`Alt+ArrowRight` → forward。避免和终端内的输入冲突：用 `useEffect` 监听 `keydown`，判断 `e.target` 在 `.file-tree` 内或 `e.altKey` 且当前没有终端焦点。

3. **导航历史接入点**：替换 `navigateTo(path)` 为 `navigateWithHistory(path)`；以下三处触发入栈：
   - 树节点双击/键盘 Enter 进入子目录（`handleNavigate`）
   - 上一级按钮（`handleGoUp`）
   - 路径栏编辑提交（`handlePathSubmit`）
   - 书签点击

   而 `handleRefresh`、`setCurrentDirectory` 用于恢复时不应该入栈 — 加 `_skipHistory` 标志在 back/forward 跳转时短暂为真。

4. **排序能力**：将现有的 `const sorted = ...` 替换为基于 `fileSortBy` + `fileSortDir` 的比较。titlebar 加排序下拉/按钮（按当前值显示「名称↑」/「大小↓」等），点击切换方向，长按或右键切字段。简化方案：单个按钮循环切换 name→size→modified→name，配 ↕ 翻转方向的小箭头 — 8 种状态通过两个按钮组合表达，避免下拉菜单复杂度。

5. **目录内过滤**：路径栏下方加一行搜索框（受控 `filterQuery` 状态），实时过滤当前可见的 TreeNode 名字（不区分大小写、子串匹配）。仅过滤 *当前目录的根级* + 已展开子目录，未展开的不递归过滤（保持简单）。无匹配时显示 "无匹配" 提示。

6. **目录内排序展示**：排序生效后，目录排列更整齐；为文件添加 size 列（与 RemoteFileTree 风格对齐：右侧小字）。修改时间列先不加进 UI（数据已就绪，留作扩展）。

### Task 4 — CSS 新增样式

**文件**：`terminal-buddy/src/components/FileTree.css`

- `.file-tree-actions button:disabled` — 透明度 0.3、cursor default
- `.filter-input` — 全宽、紧凑、无边框、背景 bg-primary
- `.tree-size` — 右对齐小字、灰色
- `.sort-toggle` — 同其他 titlebar 按钮
- `.empty-hint` — 居中、字号 11、颜色 text-secondary

不重写既有样式。

## 不在范围

- 多标签页浏览不同目录（与终端 tab 概念重叠，复杂度高）
- 最近访问目录列表（用户没选）
- 监视目录自动刷新（可能干扰手动操作）
- SSH 远程文件树（用户指定仅本地）
- 拖拽到 back/forward 按钮上做手势操作（过度设计）

## 验证

完成后人工核对：

1. 启动应用，进入文件树
2. 双击子目录进入 A、再进入 B — 此时后退按钮变可点
3. 点后退 → 回到 A；再点后退 → 回到根目录
4. 点前进 → 回到 A → 回到 B
5. 路径栏输入 `D:\xxx` 回车 — 应入历史栈
6. 标题栏排序按钮点击 — 目录排序应改变
7. 搜索框输入关键词 — 当前目录应被过滤
8. 重启应用 — 排序偏好与历史栈（最后位置）应保留

类型检查：`npx tsc --noEmit` 通过。

## 提交粒度

每个 Task 一次原子提交，commit message 用中文模块前缀 `[file-tree]`。
