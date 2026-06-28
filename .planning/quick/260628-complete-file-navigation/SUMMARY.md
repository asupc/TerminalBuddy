---
title: 补全本地文件导航功能
slug: complete-file-navigation
date: 2026-06-28
status: complete
commits:
  - ad223b4
  - 88f5372
  - 25a63d5
---

# 补全本地文件导航功能 — 完成

## 交付内容

按 PLAN.md 完成三个维度的导航能力补全，仅作用于本地文件树（`FileTree.tsx`）。SSH 远程文件树维持现状。

### 1. 后端元数据扩展
- `terminal-buddy/src-tauri/src/commands/fs.rs`：`FileNode` 新增 `size: u64` 与 `last_modified: u64`（Unix 毫秒），`list_directory` 在遍历时填充。元数据不可用时填 0，不影响排序降级。
- `terminal-buddy/src/services/tauri.ts`：`FileNode` 接口同步。

### 2. store 状态 + 持久化
- `terminal-buddy/src/stores/appStore.ts`：新增 `navBackStack`/`navForwardStack` + `navigateWithHistory`/`navBack`/`navForward`，新增 `fileSortBy`/`fileSortDir` + `setFileSort`。
- 栈上限 50 项；所有状态写入 `writeClientData('file_nav', ...)`。
- `App.tsx` 启动流程接入 `initFileTreeNav()`。

### 3. UI 接入
- `terminal-buddy/src/components/FileTree.tsx`：
  - titlebar 加 ←/→ 按钮，stack 为空时禁用。
  - Alt+←/→ 全局快捷键，焦点在终端/编辑器/输入控件时不触发。
  - 排序按钮组：单按钮循环切 名称→大小→修改；方向按钮 ↑/↓ 翻转。
  - 路径栏上方加过滤输入框，实时过滤当前根级目录（大小写不敏感、子串匹配）。
  - `useMemo` 应用排序+过滤；空匹配显示"无匹配项"。
- `terminal-buddy/src/components/FileTree.css`：补充 `button:disabled`、`filter-input`、`empty-hint` 样式。

## 验证

- TypeScript：`npx tsc --noEmit` 无错误
- Rust：`cargo check` 通过
- 人工核对清单见 PLAN.md「验证」节，启动应用按描述逐步验证即可

## 不在范围

多标签页浏览、最近访问列表、目录监视、SSH 远程、拖拽手势 — 已在 PLAN.md 中显式排除。

## 提交

- `ad223b4` 后端 FileNode 元数据扩展
- `88f5372` store 导航历史 + 排序状态
- `25a63d5` UI 接入后退/前进 + 排序 + 过滤
