# 分屏模式功能优化设计

日期：2026-07-03
状态：设计完成，待实现

## 概述

优化分屏模式的四项功能：
1. F11 全屏模式循环
2. 分屏后点击标签加载到分屏
3. 分屏满时启动新终端自动替换
4. 标签导航状态独立于分屏模式

## 1. F11 全屏循环

### 状态定义

新增 Zustand 状态：
```typescript
windowMode: 'normal' | 'panels-hidden' | 'fullscreen'
```

### 三种模式

| 模式 | TitleBar | ConfigPanel/FileTree | TabSidebar | 任务栏 |
|------|----------|---------------------|------------|--------|
| normal | 显示 | 显示 | 根据用户设置 | 显示 |
| panels-hidden | 显示 | 隐藏 | 隐藏 | 显示 |
| fullscreen | 隐藏 | 隐藏 | 隐藏 | 隐藏 |

### F11 循环顺序

```
normal → panels-hidden → fullscreen → normal
```

### 实现要点

- 在 `appStore.ts` 中新增 `windowMode` 状态和 `cycleWindowMode` action
- 进入 `panels-hidden` 前，保存当前面板状态到 `previousPanelState`：
  ```typescript
  previousPanelState: {
    showConfigPanel: boolean
    showFileTree: boolean
    showRemoteFileTree: boolean
    enableTabNavigation: boolean
  } | null
  ```
- 退出 `panels-hidden` 或 `fullscreen` 时，恢复 `previousPanelState`
- F11 键监听在 `App.tsx` 中处理
- `panels-hidden` 通过 CSS 类 `panels-hidden` 控制，挂载到根容器
- `fullscreen` 通过 Tauri `window.setFullscreen()` API 实现

### CSS 控制

```css
.panels-hidden .config-panel,
.panels-hidden .file-tree,
.panels-hidden .remote-file-tree,
.panels-hidden .tab-sidebar {
  display: none !important;
}
```

## 2. 分屏点击标签加载到分屏

### 数据结构变更

```typescript
// 现有
splitSlots: (string | null)[]

// 变更为
splitSlots: { sessionId: string | null; enteredAt: number }[]
```

### 点击行为

**场景 1：分屏有空位**
- 点击不在分屏中的终端 → 直接放入第一个空位
- 更新 `enteredAt` 为当前时间戳

**场景 2：分屏已满**
- 点击不在分屏中的终端 → 找 `enteredAt` 最小的 slot（最旧的）
- 将最旧 slot 的 sessionId 移出（会话保留在 sessions 列表）
- 新终端放入该 slot，更新 `enteredAt`

**场景 3：点击已在分屏中的终端**
- 直接激活该终端（setActiveSession）

### 点击来源

- TabSidebar 中的终端列表项
- 顶部 TerminalTabBar 中的标签

两种来源行为一致。

### 实现变更

- `placeSessionInSplitSlot`：修改为支持"满时替换最旧"
- 新增 `replaceOldestSplitSlot` action 或在 `placeSessionInSplitSlot` 中处理

## 3. 分屏满时启动新终端

### 流程

1. 用户从左侧 ConfigPanel 点击启动新终端
2. 检测 `splitMode !== 'off'` 且分屏已满
3. 找到 `enteredAt` 最小的 slot
4. 将该 slot 的 sessionId 清空（会话不关闭，只是移出分屏）
5. 新终端放入该 slot，更新 `enteredAt`

### 实现位置

在 `App.tsx` 的 `handleStartTerminal` 函数中添加检测逻辑。

### 与第 2 点的区别

- 第 2 点：点击**已存在**的终端标签 → 放入分屏
- 第 3 点：**新建**终端 → 如果分屏满，移出最旧的，放入新的

两者共享"替换最旧"的核心逻辑。

## 4. 标签导航状态独立

### 现状问题

进入分屏模式时，代码可能会自动修改 `enableTabNavigation` 状态，导致用户设置被覆盖。

### 改动

- 移除 `cycleSplitMode` 中对 `enableTabNavigation` 的任何修改
- 分屏模式下，TabSidebar 显示逻辑不变：由 `enableTabNavigation` 设置决定
- 分屏模式下，顶部 TerminalTabBar 显示逻辑不变：`!enableTabNavigation && sessions.length > 0`

### 效果

- 用户原来开着左侧标签导航 → 分屏后依然开着
- 用户原来关闭标签导航 → 分屏后顶部 tabs 依然显示
- 进入/退出分屏不改变标签导航状态

## 涉及文件

| 文件 | 改动内容 |
|------|---------|
| `src/stores/appStore.ts` | 新增 `windowMode`、`previousPanelState`；修改 `splitSlots` 类型；修改 `placeSessionInSplitSlot`；移除分屏对标签导航的影响 |
| `src/App.tsx` | 新增 F11 键监听；修改 `handleStartTerminal` 添加分屏满检测 |
| `src/components/TerminalPanel.tsx` | 适配 `splitSlots` 新结构 |
| `src/components/TabSidebar.tsx` | 分屏模式下点击终端放入分屏 |
| `src/components/TerminalTabBar.tsx` | 分屏模式下点击终端放入分屏 |
| `src/components/TitleBar.tsx` | `fullscreen` 模式下隐藏标题栏 |
| CSS 文件 | 新增 `.panels-hidden` 样式规则 |

## 注意事项

1. **会话保持**：从分屏中移出的会话不关闭，保留在 sessions 列表中
2. **无 remount**：分屏切换时保持现有的"不重新挂载终端实例"设计
3. **状态恢复**：`fullscreen` → `normal` 时，Tauri `setFullscreen(false)` 可能有延迟，需要监听事件
4. **向后兼容**：`splitSlots` 是运行时状态（不持久化），无需迁移处理。应用重启时分屏状态重置为 `off`
