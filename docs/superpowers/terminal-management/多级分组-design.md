# 多级分组设计文档

## 概述

将 Profile 的 `group` 字段从单层字符串扩展为支持多级层级路径，使用 `/` 分隔符。涉及连接导航（ConfigPanel）、标签导航（TabSidebar）以及编辑对话框（ConfigEditDialog）的分组展示与交互改造。

后端零改动，`group` 仍为纯字符串字段。所有多级逻辑在前端解析。

## 需求确认

- **层级深度**：不限，用 `/` 分隔（如 `开发/前端/React`）
- **数据模型**：纯字符串，无需后端改动
- **编辑方式**：级联选择器（GroupCascader）
- **空父节点**：始终显示（即使没有直接属于它的连接）
- **重命名行为**：连接导航右键重命名→级联更新所有子路径；编辑单个连接→仅改自身
- **已有数据**：无需迁移，现有单层分组作为顶层分组
- **TabSidebar**：同步多级展示

---

## 1. 数据结构与工具函数

### 分组路径约定

- 分隔符：`/`，如 `"开发/前端/React"`
- 不含 `/` 的 group 值视为顶层分组，如 `"开发"`
- 空字符串等同于 `"默认"`

### 树节点类型

新增文件 `src/utils/groupTree.ts`：

```ts
interface GroupNode {
  name: string;          // 当前层级名称，如 "前端"
  path: string;          // 完整路径，如 "开发/前端"
  children: GroupNode[]; // 子分组
  profiles: Profile[];   // 直接属于该节点的 profile
}
```

### `buildGroupTree(profiles)` 逻辑

1. 按 `profile.group || '默认'` 取路径
2. 用 `/` 分割路径，逐层构建嵌套 Map
3. 同级按中文 `localeCompare('zh')` 排序
4. 返回顶层 `GroupNode[]`

所有需要分组展示的地方都调用此函数，保证逻辑一致。

### `extractGroupPaths(profiles)` 辅助函数

返回所有去重的完整分组路径字符串数组，供 GroupCascader 构建选项列表。

---

## 2. 连接导航 ConfigPanel

### `treeItems` memo 改造

替换现有扁平 Map 逻辑（`ConfigPanel.tsx` lines 58-102），改为调用 `buildGroupTree(profiles)` 获取嵌套结构，然后递归渲染为 `TreeItem`。

现有 `TreeView` + `TreeItem` 组件已支持 `children`，只需递归生成嵌套节点。每个 `GroupNode` 渲染为一个可展开的 `TreeItem`，其子节点为：
- `children`（子分组 TreeItem）
- `profiles`（直接连接 TreeItem）

### 分组右键菜单增强

- **重命名**：解析选中节点的 `path`，遍历所有 profile，将 `group` 中以 `oldPath` 开头的替换为 `newPath`。级联更新所有子路径。
- **新增子分组**：右键菜单添加"添加子分组"选项，创建新 profile 时预设 `group` 为当前节点 path + `/` + 新名称。
- **添加连接**：保留，新建 profile 的 group 默认为当前节点的 path。

### 空白区域右键

保持现有"添加连接"功能，新连接 group 默认为 `"默认"`。

---

## 3. 标签导航 TabSidebar

### `sessionTree`（活跃会话树）

替换现有扁平分组逻辑（`TabSidebar.tsx` lines 61-101），改为 `buildGroupTree`。会话按其 profile 的 group 路径分组，递归渲染为嵌套 `TreeItem`。

每个分组节点：
- 显示计数徽标（含所有子级的会话总数）
- 显示关闭全部按钮（递归关闭该节点及所有子级中的会话）

### `submenuTree`（添加连接子菜单）

同样用 `buildGroupTree` 替换扁平逻辑（`TabSidebar.tsx` lines 104-126）。
- PowerShell/CMD 保持为顶层独立项
- profile 分组以嵌套树展示
- 子菜单分组默认折叠

### 分组级操作

"关闭全部分组"功能适配为递归关闭——关闭一个分组时，同时关闭其所有子分组中的会话。

---

## 4. ConfigEditDialog 级联选择器

### 新增组件 `GroupCascader`

新增文件 `src/components/GroupCascader.tsx`。

### 交互流程

1. 点击输入框弹出第一列：显示所有现有的顶层分组名 + "新建分组" 选项
2. 选择一个分组后，如该分组有子分组，右侧展开第二列显示子分组 + "新建子分组" 选项
3. 可继续逐级选择，到达目标层级后点击确认
4. 选择"新建分组/子分组"时弹出文本输入，输入名称后加入对应层级
5. 顶部显示当前已选的完整路径（如 `开发 / 前端`），可点击任意段跳回

### 数据源

从现有 profiles 中提取所有 group 路径，通过 `extractGroupPaths()` 解析为树形结构供选择器使用。

### 默认值

- 编辑时：预填当前 profile 的 group 路径
- 新建时：默认为 `"默认"`

### 集成

替换 `ConfigEditDialog.tsx` 中现有的 `<input {...register('group')}>` 为 `<GroupCascader>`。

---

## 5. 重命名分组的级联更新

### 场景 A — 连接导航右键"重命名分组"

1. 用户右键点击分组节点 → 选择"重命名分组"
2. 进入行内编辑模式，显示文本输入框，当前值为节点名称（非完整路径）
3. 用户修改后确认，新路径 = `parentPath + '/' + newName`（顶层则直接为 `newName`）
4. 遍历所有 profile，将 `group` 字段中前缀匹配 `oldPath + '/'` 或精确匹配 `oldPath` 的替换为对应新路径
5. 逐个调用 `updateProfile` 更新

### 场景 B — 编辑单个连接的 group 字段

1. 在 ConfigEditDialog 中通过 GroupCascader 选择新分组
2. 保存时只更新该 profile 的 group 字段
3. 不影响其他 profile

### 边界处理

- 重命名后与其他已有分组同名 → 按同名分组合并处理（path 相同即同组）
- 重命名为空字符串 → 视为 `"默认"`

---

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/utils/groupTree.ts` | 新增 | `buildGroupTree`、`extractGroupPaths`、`GroupNode` 类型 |
| `src/components/GroupCascader.tsx` | 新增 | 级联选择器组件 |
| `src/components/ConfigPanel.tsx` | 修改 | 用 `buildGroupTree` 替换扁平分组逻辑，增加子分组菜单项 |
| `src/components/TabSidebar.tsx` | 修改 | `sessionTree`、`submenuTree` 用 `buildGroupTree` 替换，递归关闭 |
| `src/components/ConfigEditDialog.tsx` | 修改 | group 文本输入替换为 `GroupCascader` |
| 后端 | 无改动 | `group` 仍为纯字符串 |
