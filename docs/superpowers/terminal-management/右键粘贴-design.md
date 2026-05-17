# 右键粘贴功能设计 ✅ 已实现

## 概述

新增"右键粘贴"设置项。开启后，在终端中右键时，若无选中文本且剪贴板有内容，直接粘贴到终端输入并恢复焦点；不弹出上下文菜单。

## 行为规则

| 条件 | 开启右键粘贴 | 关闭右键粘贴 |
|------|-------------|-------------|
| 有选中文本 | 弹出上下文菜单（复制/粘贴） | 弹出上下文菜单（复制/粘贴） |
| 无选中文本 | 直接粘贴剪贴板内容，不弹菜单 | 弹出上下文菜单（复制/粘贴） |
| 无选中文本且剪贴板为空 | 不粘贴，不弹菜单 | 弹出上下文菜单（复制/粘贴） |

## 实现状态

**已完成**。所有修改点均已实现：

### 1. 前端设置 — `src/utils/settings.ts` ✅

`AppSettings` 已包含 `rightClickPaste: boolean`，默认 `false`。

### 2. 设置页面 — `src/components/SettingsPage.tsx` ✅

通用设置区域已添加开关："右键粘贴 — 右键时若无选中文本，直接粘贴剪贴板内容"。

### 3. 终端实例 — `src/components/TerminalInstance.tsx` ✅

右键事件处理 `handleContextMenu` 已实现：
- 读取 `getAppSettings().rightClickPaste`
- 读取 `terminal.hasSelection()` 判断选中文本
- 读取剪贴板 `navigator.clipboard.readText()`
- 满足条件时：发送文本到终端 + `terminal.focus()` 恢复焦点
- 不满足条件时：保持原行为（弹出上下文菜单）
