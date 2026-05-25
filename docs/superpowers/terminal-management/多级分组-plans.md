# 多级分组实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Profile 的 `group` 字段从单层字符串扩展为支持多级层级路径（`/` 分隔），并更新连接导航、标签导航、编辑对话框三处 UI。

**Architecture:** 前端-only 改造。新增 `groupTree.ts` 工具函数将扁平 group 字符串解析为嵌套树结构，供 ConfigPanel 和 TabSidebar 复用。新增 `GroupCascader` 级联选择器组件替换 ConfigEditDialog 中的文本输入。后端零改动。

**Tech Stack:** React 18, TypeScript, Zustand, react-hook-form, 已有 TreeView/TreeItem 组件

**Design Doc:** `docs/superpowers/terminal-management/多级分组-design.md` — source of truth for business requirements

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/utils/groupTree.ts` | 新增 | `GroupNode` 类型、`buildGroupTree`、`extractGroupPaths`、`renameGroupInPath` |
| `src/components/GroupCascader.tsx` | 新增 | 级联选择器组件，供 ConfigEditDialog 使用 |
| `src/components/ConfigPanel.tsx` | 修改 | `treeItems` 用 `buildGroupTree` 替换扁平逻辑，重命名级联更新，添加子分组菜单 |
| `src/components/TabSidebar.tsx` | 修改 | `sessionTree`、`submenuTree` 用 `buildGroupTree` 替换，递归关闭 |
| `src/components/ConfigEditDialog.tsx` | 修改 | group 文本输入替换为 `GroupCascader` |

---

### Task 1: 创建 `groupTree.ts` 工具函数

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/utils/groupTree.ts`

**Acceptance Criteria:**

- [ ] `GroupNode` 类型定义正确：name（当前层名称）、path（完整路径）、children（子分组）、items（直接属于该节点的条目）
- [ ] `buildGroupTree(items, getGroup)` 正确解析 `/` 分隔的 group 路径，生成嵌套树，每级按中文排序
- [ ] `extractGroupPaths(items, getGroup)` 返回所有去重的完整分组路径
- [ ] `renameGroupInPath(groupPath, oldPath, newPath)` 正确替换路径前缀，处理精确匹配和子路径两种情况
- [ ] TypeScript 编译无错误

- [ ] **Step 1: 创建 `groupTree.ts` 文件**

```ts
import type { Profile } from '../types';

export interface GroupNode<T = unknown> {
  name: string;       // 当前层级名称，如 "前端"
  path: string;       // 完整路径，如 "开发/前端"
  children: GroupNode<T>[];
  items: T[];         // 直接属于该节点的条目
}

const DEFAULT_GROUP = '默认';
const SEPARATOR = '/';

/** 将扁平 group 字符串解析为嵌套树结构 */
export function buildGroupTree<T>(
  items: T[],
  getGroup: (item: T) => string,
  sortItems?: (items: T[]) => T[],
): GroupNode<T>[] {
  // 根 Map：path → GroupNode（用 Map 保证插入序，后续排序）
  const nodeMap = new Map<string, GroupNode<T>>();

  const getOrCreateNode = (path: string): GroupNode<T> => {
    if (nodeMap.has(path)) return nodeMap.get(path)!;
    const segments = path.split(SEPARATOR);
    const name = segments[segments.length - 1];
    const node: GroupNode<T> = { name, path, children: [], items: [] };
    nodeMap.set(path, node);
    // 确保父节点也存在
    if (segments.length > 1) {
      const parentPath = segments.slice(0, -1).join(SEPARATOR);
      const parent = getOrCreateNode(parentPath);
      if (!parent.children.find(c => c.path === path)) {
        parent.children.push(node);
      }
    }
    return node;
  };

  // 分配 items 到对应节点
  for (const item of items) {
    const rawGroup = getGroup(item) || DEFAULT_GROUP;
    const node = getOrCreateNode(rawGroup);
    node.items.push(item);
  }

  // 对每个节点的 items 排序
  if (sortItems) {
    for (const node of nodeMap.values()) {
      if (node.items.length > 0) {
        node.items = sortItems(node.items);
      }
    }
  }

  // 对每个节点的 children 排序（按中文名）
  const sortChildren = (nodes: GroupNode<T>[]): GroupNode<T>[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const node of nodes) {
      sortChildren(node.children);
    }
    return nodes;
  };

  // 收集根节点（path 不含 '/' 或是第一段）
  const roots: GroupNode<T>[] = [];
  for (const node of nodeMap.values()) {
    if (!node.path.includes(SEPARATOR)) {
      roots.push(node);
    }
  }

  return sortChildren(roots);
}

/** 提取所有去重的完整分组路径 */
export function extractGroupPaths<T>(
  items: T[],
  getGroup: (item: T) => string,
): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    const rawGroup = getGroup(item) || DEFAULT_GROUP;
    // 同时添加所有中间路径
    const segments = rawGroup.split(SEPARATOR);
    for (let i = 1; i <= segments.length; i++) {
      paths.add(segments.slice(0, i).join(SEPARATOR));
    }
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b, 'zh'));
}

/** 重命名分组路径：将 groupPath 中 oldPath 前缀替换为 newPath */
export function renameGroupInPath(
  groupPath: string,
  oldPath: string,
  newPath: string,
): string {
  if (groupPath === oldPath) return newPath;
  if (groupPath.startsWith(oldPath + SEPARATOR)) {
    return newPath + groupPath.slice(oldPath.length);
  }
  return groupPath; // 不匹配，不变
}
```

- [ ] **Step 2: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add terminal-buddy/src/utils/groupTree.ts
git commit -m "feat: 添加多级分组工具函数 buildGroupTree / extractGroupPaths / renameGroupInPath"
```

---

### Task 2: 改造 ConfigPanel 使用多级分组

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/ConfigPanel.tsx` — `treeItems` memo (lines 58-102)、`handleFinishRename` (lines 172-193)、group context menu (lines 333-342)、新增 `handleAddSubgroup`、新增 `renderGroupNode` 递归函数

**Acceptance Criteria:**

- [ ] `treeItems` memo 使用 `buildGroupTree` 替换扁平 Map 逻辑，生成嵌套 TreeItem
- [ ] 分组节点在 TreeView 中显示为可展开的嵌套结构（子分组 + 连接）
- [ ] 右键分组菜单新增"添加子分组"选项，创建新 profile 时预设 group 为当前节点 path + `/` + 名称
- [ ] "添加连接"保留，新建 profile 的 group 默认为当前节点的 path
- [ ] 重命名分组时级联更新所有子路径中的 profile group 字段
- [ ] TypeScript 编译无错误

- [ ] **Step 1: 添加 import**

在 `ConfigPanel.tsx` 顶部添加：

```ts
import { buildGroupTree, renameGroupInPath } from '../utils/groupTree';
```

- [ ] **Step 2: 替换 `treeItems` memo**

将现有 `treeItems` memo（lines 58-102）替换为使用 `buildGroupTree` 的递归版本：

```ts
const treeItems = useMemo(() => {
    let filtered = profiles;

    if (configSearchQuery.trim()) {
      const query = configSearchQuery.toLowerCase();
      filtered = profiles.filter(p => p.name.toLowerCase().includes(query));
    }

    const sortProfiles = (items: Profile[]): Profile[] => {
      return items.sort((a, b) => {
        switch (configSortBy) {
          case 'name-asc': return a.name.localeCompare(b.name, 'zh');
          case 'name-desc': return b.name.localeCompare(a.name, 'zh');
          case 'recent': return (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '');
          case 'oldest': return (a.lastUsedAt || '').localeCompare(b.lastUsedAt || '');
          case 'created-new': return b.createdAt.localeCompare(a.createdAt);
          case 'created-old': return a.createdAt.localeCompare(b.createdAt);
          default: return 0;
        }
      });
    };

    const tree = buildGroupTree<Profile>(filtered, p => p.group || '默认', sortProfiles);

    // 将 GroupNode 递归转换为 TreeItem
    const toTreeItems = (nodes: GroupNode<Profile>[]): TreeItem[] =>
      nodes.map((node): TreeItem => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        children: [
          ...toTreeItems(node.children),
          ...node.items.map((p): TreeItem => ({
            id: p.id,
            label: p.name,
            icon: <span className="config-icon-type">{TYPE_ICONS[p.terminalType] || p.terminalType.toUpperCase()}</span>,
            color: p.tabColor || undefined,
            data: p,
          })),
        ],
      }));

    return toTreeItems(tree);
  }, [profiles, configSearchQuery, configSortBy]);
```

注意：需在文件顶部 import 中加入 `GroupNode` 类型：`import { buildGroupTree, renameGroupInPath, type GroupNode } from '../utils/groupTree';`

- [ ] **Step 3: 更新 `handleFinishRename` 为级联更新**

替换现有 `handleFinishRename`（约 line 179）：

```ts
const handleFinishRename = async (oldPath: string) => {
    const trimmed = newGroupName.trim() || '默认';
    setRenamingGroup(null);
    if (trimmed === oldPath) return;
    // 计算新路径
    const segments = oldPath.split('/');
    const newPath = segments.length > 1
      ? segments.slice(0, -1).join('/') + '/' + trimmed
      : trimmed;
    try {
      for (const p of profiles) {
        const group = p.group || '默认';
        const newGroup = renameGroupInPath(group, oldPath, newPath);
        if (newGroup !== group) {
          await updateProfile({ ...p, group: newGroup });
        }
      }
      const data = await getAllProfiles();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to rename group:', err);
    }
  };
```

同时更新 `handleStartRename` 以显示节点名称而非完整路径：

```ts
const handleStartRename = (groupPath: string) => {
    const name = groupPath.includes('/') ? groupPath.split('/').pop()! : groupPath;
    setRenamingGroup(groupPath);
    setNewGroupName(name);
    setGroupContextMenu(null);
  };
```

- [ ] **Step 4: 更新 group context menu，添加"添加子分组"**

找到 group context menu 的渲染（约 lines 333-342），在"重命名分组"之前添加"添加子分组"：

```tsx
{groupContextMenu && (
  <div className="context-menu" style={{ left: groupContextMenu.x, top: groupContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
    <div className="context-menu-item" onClick={() => { onAddProfile(groupContextMenu.group); closeContextMenu(); }}>
      添加连接
    </div>
    <div className="context-menu-item" onClick={() => { onAddProfile(groupContextMenu.group); closeContextMenu(); }}>
      添加子分组
    </div>
    <div className="context-menu-item" onClick={() => handleStartRename(groupContextMenu.group)}>
      重命名分组
    </div>
  </div>
)}
```

注意：`onAddProfile` 需要接受可选的 group 参数。查看当前 `onAddProfile` 的签名和 ConfigPanel 的 props，确认如何传递预设 group。如果 `onAddProfile` 不支持参数，则需要修改 props 传递。查看 `ConfigPanel` 的 props 定义来确定。

**Step 4a: 确认 onAddProfile 签名**

检查 `ConfigPanel` 的 props 接口中 `onAddProfile` 的签名。如果它不接受参数，需要：
1. 修改 props 接口：`onAddProfile: (defaultGroup?: string) => void`
2. 修改父组件 `App.tsx` 中传递给 ConfigPanel 的 `onAddProfile` 实现，支持预设 group
3. 修改 `ConfigEditDialog` 的 props 以接受 `defaultGroup`

- [ ] **Step 5: 更新 inline rename 输入**

查找 inline rename 的渲染位置（搜索 `renamingGroup`）。确保它使用 `groupContextMenu.group` 或从 item 中获取的正确 path。

现有 inline rename 应该类似于：
```tsx
{renamingGroup === item.id && (
  <input ... />
)}
```
因为现在 item.id 已从 groupName 变为 groupPath，逻辑应保持一致。

- [ ] **Step 6: 更新"添加连接"的默认 group**

空白区域右键菜单中的"添加连接"应传递 `'默认'` 作为默认 group：
```tsx
<div className="context-menu-item" onClick={() => { onAddProfile('默认'); closeContextMenu(); }}>
  添加连接
</div>
```

- [ ] **Step 7: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无错误（可能需要先处理 Task 3 的 onAddProfile 签名变更）

- [ ] **Step 8: Commit**

```bash
git add terminal-buddy/src/components/ConfigPanel.tsx
git commit -m "feat: ConfigPanel 多级分组树形展示与级联重命名"
```

---

### Task 3: 更新 onAddProfile 支持 defaultGroup 参数

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/ConfigPanel.tsx` — props 接口
- Modify: `terminal-buddy/src/App.tsx` — 传递给 ConfigPanel 的 `onAddProfile` 实现
- Modify: `terminal-buddy/src/components/ConfigEditDialog.tsx` — props 接口和 defaultValues

**Acceptance Criteria:**

- [ ] `ConfigEditDialog` 接受 `defaultGroup` prop，新建 profile 时使用该值作为 group 默认值
- [ ] `ConfigPanel` 的 `onAddProfile` 可接受 `defaultGroup` 参数
- [ ] TypeScript 编译无错误

- [ ] **Step 1: 更新 ConfigEditDialog props**

在 `ConfigEditDialog.tsx` 中修改 props 接口：

```ts
interface ConfigEditDialogProps {
  profile: Profile | null;
  onClose: () => void;
  onSave: () => void;
  defaultGroup?: string;
}
```

更新 `defaultValues` 中的 group：

```ts
defaultValues: {
  name: profile?.name || '',
  group: defaultGroup || profile?.group || '默认',
  // ... 其余不变
},
```

解构 props：`const { profile, onClose, onSave, defaultGroup } = ...;`

- [ ] **Step 2: 更新 App.tsx 中 ConfigEditDialog 的调用**

找到 App.tsx 中渲染 `ConfigEditDialog` 的位置，添加 `defaultGroup` prop：

```tsx
<ConfigEditDialog
  profile={editingProfile}
  onClose={...}
  onSave={...}
  defaultGroup={defaultGroupForNewProfile}
/>
```

需要在 App.tsx 中添加状态来存储 `defaultGroupForNewProfile`，当 `onAddProfile(group)` 被调用时设置该值。

- [ ] **Step 3: 更新 ConfigPanel props 接口**

```ts
// ConfigPanel 的 props 中
onAddProfile: (defaultGroup?: string) => void;
```

- [ ] **Step 4: 更新 App.tsx 中的 onAddProfile 实现**

```ts
const [defaultGroupForNewProfile, setDefaultGroupForNewProfile] = useState<string | undefined>();

// 传递给 ConfigPanel:
onAddProfile={(group) => {
  setDefaultGroupForNewProfile(group);
  setEditingProfile(null); // null 表示新建
}}
```

- [ ] **Step 5: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add terminal-buddy/src/components/ConfigEditDialog.tsx terminal-buddy/src/components/ConfigPanel.tsx terminal-buddy/src/App.tsx
git commit -m "feat: onAddProfile 支持 defaultGroup 参数传递"
```

---

### Task 4: 创建 GroupCascader 级联选择器组件

**Skills:** _none_

**Files:**
- Create: `terminal-buddy/src/components/GroupCascader.tsx`

**Acceptance Criteria:**

- [ ] 点击输入框弹出级联面板，显示现有分组层级
- [ ] 每级列显示该级分组名 + ">" 箭头表示可展开 + "新建分组"选项
- [ ] 选择分组后自动展开下一级（如有子分组）
- [ ] "新建分组"选项显示内联文本输入
- [ ] 顶部显示面包屑路径，点击任意段可跳回
- [ ] 点击外部区域关闭面板
- [ ] 选中后通过 onChange 回调返回完整 group 路径字符串
- [ ] 支持 value prop 设置初始值
- [ ] TypeScript 编译无错误

- [ ] **Step 1: 创建 GroupCascader 组件**

```tsx
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { extractGroupPaths } from '../utils/groupTree';
import type { Profile } from '../types';

interface GroupCascaderProps {
  value: string;
  onChange: (value: string) => void;
  profiles: Profile[];
}

interface CascaderLevel {
  parentPath: string; // 空字符串表示根级
  options: string[];  // 该级可选的名称列表
}

export const GroupCascader: React.FC<GroupCascaderProps> = ({ value, onChange, profiles }) => {
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<CascaderLevel[]>([]);
  const [selectedSegments, setSelectedSegments] = useState<string[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [addingAtLevel, setAddingAtLevel] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 从 profiles 提取分组树结构
  const groupPaths = useMemo(() => extractGroupPaths(profiles, p => p.group || '默认'), [profiles]);

  // 将 groupPaths 组织为层级结构：path → children names
  const levelMap = useMemo(() => {
    const map = new Map<string, string[]>(); // parentPath → childNames
    map.set('', []); // 根级
    for (const path of groupPaths) {
      const segments = path.split('/');
      const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : '';
      if (!map.has(parentPath)) map.set(parentPath, []);
      const names = map.get(parentPath)!;
      const name = segments[segments.length - 1];
      if (!names.includes(name)) names.push(name);
    }
    // 排序
    for (const names of map.values()) {
      names.sort((a, b) => a.localeCompare(b, 'zh'));
    }
    return map;
  }, [groupPaths]);

  // 初始化：打开时根据 value 设置 levels
  useEffect(() => {
    if (open) {
      const segs = value ? value.split('/') : [];
      const newLevels: CascaderLevel[] = [{ parentPath: '', options: levelMap.get('') || [] }];
      const newSelected: string[] = [];
      for (const seg of segs) {
        const parentPath = newSelected.join('/');
        newSelected.push(seg);
        const childPath = newSelected.join('/');
        const children = levelMap.get(childPath);
        if (children && children.length > 0) {
          newLevels.push({ parentPath: childPath, options: children });
        }
      }
      setLevels(newLevels);
      setSelectedSegments(segs);
      setAddingAtLevel(null);
    }
  }, [open]); // 故意不依赖 value/levelMap，只在 open 变化时初始化

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelectLevel = (levelIndex: number, name: string) => {
    const newSelected = selectedSegments.slice(0, levelIndex);
    newSelected.push(name);
    setSelectedSegments(newSelected);

    const path = newSelected.join('/');
    onChange(path);

    const children = levelMap.get(path);
    if (children && children.length > 0) {
      const newLevels = levels.slice(0, levelIndex + 1);
      newLevels.push({ parentPath: path, options: children });
      setLevels(newLevels);
    } else {
      setLevels(levels.slice(0, levelIndex + 1));
    }
    setAddingAtLevel(null);
  };

  const handleBreadcrumb = (index: number) => {
    const newSelected = selectedSegments.slice(0, index);
    setSelectedSegments(newSelected);
    onChange(newSelected.join('/') || '默认');
    setLevels(levels.slice(0, index + 1));
    setAddingAtLevel(null);
  };

  const handleAddGroup = (levelIndex: number) => {
    if (!newGroupName.trim()) return;
    handleSelectLevel(levelIndex, newGroupName.trim());
    setNewGroupName('');
    setAddingAtLevel(null);
  };

  const displayValue = value || '默认';

  return (
    <div className="group-cascader" ref={ref}>
      <div className="group-cascader-input" onClick={() => setOpen(!open)}>
        <span>{displayValue}</span>
        <span className="group-cascader-arrow">{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="group-cascader-panel">
          {/* 面包屑 */}
          <div className="group-cascader-breadcrumb">
            <span className={selectedSegments.length === 0 ? 'active' : ''} onClick={() => handleBreadcrumb(0)}>
              根
            </span>
            {selectedSegments.map((seg, i) => (
              <React.Fragment key={i}>
                <span className="separator">/</span>
                <span className={i === selectedSegments.length - 1 ? 'active' : ''} onClick={() => handleBreadcrumb(i + 1)}>
                  {seg}
                </span>
              </React.Fragment>
            ))}
          </div>

          {/* 级联列 */}
          <div className="group-cascader-columns">
            {levels.map((level, li) => (
              <div key={li} className="group-cascader-column">
                {level.options.map(name => {
                  const segs = selectedSegments.slice(0, li);
                  segs.push(name);
                  const path = segs.join('/');
                  const hasChildren = levelMap.has(path) && (levelMap.get(path)?.length || 0) > 0;
                  const isSelected = selectedSegments[li] === name;
                  return (
                    <div
                      key={name}
                      className={`group-cascader-option ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleSelectLevel(li, name)}
                    >
                      <span>{name}</span>
                      {hasChildren && <span className="group-cascader-expand">›</span>}
                    </div>
                  );
                })}
                {addingAtLevel === li ? (
                  <div className="group-cascader-new-input">
                    <input
                      autoFocus
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAddGroup(li);
                        if (e.key === 'Escape') setAddingAtLevel(null);
                      }}
                      onBlur={() => { if (!newGroupName.trim()) setAddingAtLevel(null); }}
                      placeholder="分组名称"
                    />
                  </div>
                ) : (
                  <div
                    className="group-cascader-option new"
                    onClick={() => { setAddingAtLevel(li); setNewGroupName(''); }}
                  >
                    + 新建分组
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 确认按钮 */}
          <div className="group-cascader-footer">
            <button onClick={() => setOpen(false)}>确定</button>
          </div>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: 添加 GroupCascader 样式**

在 `terminal-buddy/src/components/GroupCascader.css` 中创建样式（或者在现有全局 CSS 中添加）。使用与项目现有下拉菜单一致的样式风格。

查找项目中现有的 `.css` 文件命名约定（`ConfigPanel.css`、`TabSidebar.css` 等），在 `terminal-buddy/src/components/GroupCascader.css` 创建对应样式文件。

关键样式要点：
- `.group-cascader` — position: relative
- `.group-cascader-input` — 与现有 input 样式一致，display: flex, cursor: pointer
- `.group-cascader-panel` — position: absolute, top: 100%, left: 0, z-index, background, border, border-radius, min-width
- `.group-cascader-breadcrumb` — flex row, 各 segment 可点击
- `.group-cascader-columns` — flex row, 各列固定宽度 ~160px, overflow-y auto, max-height
- `.group-cascader-column` — border-right 分隔
- `.group-cascader-option` — padding, hover 效果, flex row, justify-between
- `.group-cascader-option.selected` — 背景色高亮
- `.group-cascader-option.new` — 虚线或斜体，区分现有和新建
- `.group-cascader-new-input input` — 全宽
- `.group-cascader-footer` — 底部确定按钮

具体样式参考项目中 `ConfigEditDialog` 或 `TabSidebar` 的 context-menu 样式。

- [ ] **Step 3: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src/components/GroupCascader.tsx terminal-buddy/src/components/GroupCascader.css
git commit -m "feat: 新增 GroupCascader 级联选择器组件"
```

---

### Task 5: 集成 GroupCascader 到 ConfigEditDialog

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/ConfigEditDialog.tsx` — 替换 group 文本输入为 GroupCascader

**Acceptance Criteria:**

- [ ] 分组字段显示为 GroupCascader 级联选择器，不再显示为文本输入
- [ ] 编辑现有 profile 时，GroupCascader 预填当前 group 路径
- [ ] 新建 profile 时，GroupCascader 使用 `defaultGroup` prop 或 `'默认'`
- [ ] 选中分组后，表单的 `group` 字段值正确更新
- [ ] TypeScript 编译无错误

- [ ] **Step 1: 替换 group 输入字段**

在 `ConfigEditDialog.tsx` 中：

添加 import：
```ts
import { GroupCascader } from './GroupCascader';
```

需要从 store 或 props 获取 profiles 列表。查看 ConfigEditDialog 当前如何获取 profiles（可能需要添加 prop 或从 store 读取）。

查看文件确认 profiles 的来源。如果 ConfigEditDialog 没有直接访问 profiles，需要：
- 在 props 中添加 `profiles: Profile[]`
- 从父组件（App.tsx）传递

将 group 输入字段（约 lines 249-252）替换为：

```tsx
<div className="form-group">
  <label>分组</label>
  <GroupCascader
    value={watch('group')}
    onChange={(val) => setValue('group', val)}
    profiles={profiles}
  />
</div>
```

注意：`watch('group')` 用于获取当前表单值，`setValue('group', val)` 用于更新。

- [ ] **Step 2: 更新 App.tsx 传递 profiles 到 ConfigEditDialog**

如果 ConfigEditDialog 没有 profiles prop，需要在 App.tsx 中传递：

```tsx
<ConfigEditDialog
  profile={editingProfile}
  onClose={...}
  onSave={...}
  defaultGroup={defaultGroupForNewProfile}
  profiles={profiles}
/>
```

- [ ] **Step 3: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add terminal-buddy/src/components/ConfigEditDialog.tsx terminal-buddy/src/App.tsx
git commit -m "feat: ConfigEditDialog 集成 GroupCascader 级联选择器"
```

---

### Task 6: 改造 TabSidebar 使用多级分组

**Skills:** _none_

**Files:**
- Modify: `terminal-buddy/src/components/TabSidebar.tsx` — `sessionTree` memo、`submenuTree` memo、`handleCloseGroup`

**Acceptance Criteria:**

- [ ] `sessionTree` 使用 `buildGroupTree` 生成嵌套分组，会话按 profile group 路径分组
- [ ] "文本编辑"组保持在顶层，不参与多级分组
- [ ] 分组节点显示递归计数徽标（含所有子级的会话总数）
- [ ] "关闭全部分组"递归关闭该节点及所有子级中的会话
- [ ] `submenuTree` 使用 `buildGroupTree` 生成嵌套分组，PowerShell/CMD 保持为顶层独立项
- [ ] TypeScript 编译无错误

- [ ] **Step 1: 添加 import**

在 `TabSidebar.tsx` 顶部添加：

```ts
import { buildGroupTree, type GroupNode } from '../utils/groupTree';
```

- [ ] **Step 2: 替换 `sessionTree` memo**

将 `sessionTree`（约 lines 61-101）替换为：

```ts
const sessionTree = useMemo(() => {
    // 分离编辑器会话和终端会话
    const editorSessions = sessions.filter(s => s.sessionType === 'editor');
    const terminalSessions = sessions.filter(s => s.sessionType !== 'editor');

    // 终端会话按 profile group 分组
    const tree = buildGroupTree(terminalSessions, s => {
      const profile = profiles.find(p => p.id === s.profileId);
      return profile?.group || '默认';
    });

    // 递归收集节点下所有 items（含子级）
    const collectAllItems = <T,>(node: GroupNode<T>): T[] => {
      const result = [...node.items];
      for (const child of node.children) {
        result.push(...collectAllItems(child));
      }
      return result;
    };

    // GroupNode → TreeItem
    const toTreeItems = (nodes: GroupNode<typeof sessions[0]>[]): TreeItem[] =>
      nodes.map(node => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        data: { type: 'group' as const, sessions: collectAllItems(node) },
        children: [
          ...toTreeItems(node.children),
          ...node.items.map(session => {
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
        ],
      }));

    const items = toTreeItems(tree);

    // 编辑器组作为独立顶层项
    if (editorSessions.length > 0) {
      items.unshift({
        id: '文本编辑',
        label: '文本编辑',
        isGroup: true,
        children: editorSessions.map(session => ({
          id: session.id,
          label: session.profileName,
          icon: (
            <span className="tab-sidebar-file-icon">
              {session.isDirty && <span className="tab-sidebar-dirty-dot" />}
              📄
            </span>
          ),
          data: session,
        })),
      });
    }

    return items;
  }, [sessions, profiles, workingSessions, settingsVersion]);
```

注意：`collectAllItems` 辅助函数用于递归收集节点下所有会话（含子级），供 `handleCloseGroup` 使用。

- [ ] **Step 3: 更新 `handleCloseGroup`**

需要更新 `handleCloseGroup` 以适配新的数据结构。由于分组 data 中已包含所有子级会话，`handleCloseGroup` 可以直接使用：

```ts
const handleCloseGroup = async (groupName: string, groupSessions: typeof sessions) => {
    setConfirmDialog({
      title: '确认关闭分组',
      message: `确定要关闭分组「${groupName}」中的所有 ${groupSessions.length} 个终端吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        for (const session of groupSessions) {
          try { await closeTerminalCmd(session.id); } catch (err) { console.error(err); }
          removeSession(session.id);
        }
      },
    });
  };
```

逻辑不变，但需要确认调用 `handleCloseGroup` 的位置传递的 groupSessions 来自 `data.sessions`（递归收集的结果）。搜索代码中调用 `handleCloseGroup` 的位置（可能在 `renderEnd` 回调或 context menu 中），确保传递的 sessions 列表包含所有子级。

- [ ] **Step 4: 替换 `submenuTree` memo**

将 `submenuTree`（约 lines 104-126）替换为：

```ts
const submenuTree = useMemo(() => {
    const tree = buildGroupTree(profiles, p => p.group || '默认');

    const toTreeItems = (nodes: GroupNode<Profile>[]): TreeItem[] =>
      nodes.map(node => ({
        id: node.path,
        label: node.name,
        isGroup: true,
        children: [
          ...toTreeItems(node.children),
          ...node.items.map(p => ({
            id: p.id,
            label: p.name,
            data: p,
          })),
        ],
      }));

    return toTreeItems(tree);
  }, [profiles]);
```

- [ ] **Step 5: 更新 collapsedGroups 为递归展开**

现有 `collapsedGroups` 是 `Set<string>` 存储折叠的 group ID。由于现在 group ID 是完整路径（如 `"开发/前端"`），无需额外处理。但建议在用户展开一个节点时，自动展开其所有父节点，确保可见。

查找 TreeView 的 `onToggle` 处理，确认逻辑是否需要调整。现有逻辑 toggle 单个 ID，这对嵌套结构仍然适用。

- [ ] **Step 6: 更新分组关闭按钮的 session 获取**

查找 TabSidebar 中渲染分组关闭按钮的位置（`renderGroupEnd` 或类似逻辑）。当前可能通过遍历 `sessionTree` 查找匹配的 group 来获取 sessions。更新为使用 `data.sessions`（已在 Step 2 的 data 中存储了递归收集的所有会话）。

搜索代码中所有使用 `handleCloseGroup` 的位置，确保参数传递正确。

- [ ] **Step 7: TypeScript 编译验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add terminal-buddy/src/components/TabSidebar.tsx
git commit -m "feat: TabSidebar 多级分组树形展示与递归关闭"
```

---

### Task 7: 最终集成验证

**Skills:** _none_

**Acceptance Criteria:**

- [ ] 前端构建通过
- [ ] 手动验证：创建多级分组 profile，在连接导航和标签导航中正确显示嵌套结构
- [ ] 手动验证：重命名中间层级分组，子路径自动更新
- [ ] 手动验证：GroupCascader 级联选择器正常工作
- [ ] 手动验证：TabSidebar 右键添加连接子菜单正确显示多级分组

- [ ] **Step 1: 前端构建验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npm run build`
Expected: 构建成功

- [ ] **Step 2: 运行 dev 模式手动验证**
  **Skills:** _none_

Run: `cd terminal-buddy && npm run tauri dev`

手动测试清单：
1. 创建一个 profile，group 设为 "开发/前端"
2. 创建另一个 profile，group 设为 "开发/后端"
3. 在 ConfigPanel 中确认显示为嵌套：开发 → 前端 → profile1, 后端 → profile2
4. 在 ConfigPanel 中右键 "开发" → 重命名为 "Dev"，确认子路径自动更新
5. 在 ConfigEditDialog 中打开 GroupCascader，确认级联选择正常
6. 在 TabSidebar 中确认会话按多级分组显示
7. 在 TabSidebar 右键菜单中确认分组正确嵌套显示

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: 多级分组集成修复"
```
