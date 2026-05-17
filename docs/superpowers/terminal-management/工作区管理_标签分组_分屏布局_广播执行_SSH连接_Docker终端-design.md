# 工作区管理_标签分组_分屏布局_广播执行_SSH连接_Docker终端

> **文档状态**：6 个阶段中阶段 1 部分实现，其余未实现。标注各功能当前状态。

## 概述

为 TerminalBuddy 新增多终端多环境管理能力。以「工作区」为核心概念，统一终端分组、分屏布局、工作区保存恢复、广播执行、SSH 远程连接、Docker/K8s 终端等功能。统一规划，分 6 个阶段逐步实现。

## 用户场景

用户需要同时管理多个终端会话——本地开发（PowerShell/CMD）、远程服务器（SSH）、容器环境（Docker/K8s）。当前扁平标签模式在终端数量增多后难以管理，缺乏分组、分屏查看、一键恢复工作区、批量执行命令等能力。

## 数据模型

### Workspace ✅ 已实现（后端 + 前端类型）

```typescript
interface Workspace {
  id: string;
  name: string;
  icon?: string;
  groups: WorkspaceGroup[];
  createdAt: string;
  lastUsedAt: string;
}
```

存储位置：`%APPDATA%/TerminalBuddy/Workspaces/{id}.json`

### WorkspaceGroup ✅ 已实现（后端 + 前端类型）

```typescript
interface WorkspaceGroup {
  id: string;
  name: string;
  color?: string;
  terminals: WorkspaceTerminal[];
  layout: LayoutConfig;  // 每组独立布局
  collapsed: boolean;
}
```

### WorkspaceTerminal ✅ 已实现（后端 + 前端类型）

```typescript
interface WorkspaceTerminal {
  profileId?: string;
  terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s';
  // 本地终端
  startupPath?: string;
  startupCommands?: string[];
  environmentVariables?: Record<string, string>;
  // SSH
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshKeyPath?: string;
  // Docker
  dockerContainerId?: string;
  dockerContainerName?: string;
  // K8s
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
  // 通用
  colorTheme?: string;
  tabColor?: string;
}
```

### LayoutConfig ⚠️ 类型已定义，但未在渲染中使用

```typescript
interface LayoutConfig {
  type: 'tabs' | 'split';
  splits?: SplitNode;
}

interface SplitNode {
  direction: 'horizontal' | 'vertical';
  ratio: number;              // 0-1 分割比例
  first: SplitNode | string;  // string = terminal session id
  second: SplitNode | string;
}
```

### Profile 扩展 ✅ 已实现

现有 Profile 的 `terminalType` 已从 `'powershell' | 'cmd'` 扩展为 `'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s'`，新增 SSH/Docker/K8s 连接字段。SSH 密码不保存明文，仅保存密钥路径，密码运行时输入。

---

## 功能设计

### 1. 标签分组 ⚠️ 部分实现

**已实现**：
- 标签侧栏（TabSidebar）按配置的 `group` 字段分组显示
- 组可折叠/展开
- 中键点击关闭标签
- 右键菜单：添加连接、关闭所有
- 搜索过滤标签

**未实现**：
- 拖拽标签在组间移动
- 组名双击编辑
- 右键菜单重命名/改颜色/删除组
- 组颜色作为标签下划线色
- TabGroup（Zustand store 中的分组模型）与 TabSidebar 的分组逻辑未完全对齐——TabSidebar 按 profile.group 分组，而 store 中的 TabGroup 是独立的分组概念

**原设计**：
- 标签栏改造：从扁平列表改为分组折叠模式
- 每个组是可折叠的标签组，组名显示在标签左侧
- 组名可双击编辑，右键菜单可重命名、改颜色、删除组
- 未分组终端归入"默认"组
- 拖拽标签可在组间移动
- 组颜色作为标签下划线色，视觉区分

**分组操作入口**：
- 右键标签 → "移动到组" → 选择已有组或"新建组"
- 工具栏下拉 → "新建终端" → 选择组
- 拖拽标签到另一组标签区域

### 2. 分屏/分格布局 ❌ 未实现

**当前状态**：TerminalPanel 仅渲染活跃终端，所有终端共享同一空间，同一时间只显示一个。`SplitPane.tsx` 组件曾在 git 历史中存在但已被删除（git status 显示 `D terminal-buddy/src/components/SplitPane.tsx`）。

**原设计**：
- 布局模型：二叉分割树。每个容器要么是叶子节点（终端实例），要么是分割节点（水平/垂直分割两个子容器）。
- 交互：
  - 右键终端标签 → "分屏到右侧/下方" → 创建分割
  - 分割线可拖拽调整比例
  - 当前激活终端高亮边框
  - `Ctrl+Tab` 在可见终端间切换
  - 双击分割线 = 均分
  - 右键分割线 → "取消分割"（终端回归标签模式）
- 与分组的关系：分屏在同一组内操作，跨组分屏暂不支持。工作区保存时每个组的布局配置独立保存。
- 渲染：终端内容区使用 CSS Flexbox 递归渲染 SplitNode，分割线用 mousedown/mousemove 实现拖拽，xterm.js 实例在 resize 时调用 fitAddon.fit()。

### 3. 工作区保存/恢复 ⚠️ 后端已实现，前端 UI 未实现

**已实现**：
- 后端 WorkspaceService：完整的 CRUD，JSON 文件持久化
- 前端类型定义：Workspace/WorkspaceGroup/WorkspaceTerminal
- Zustand store：currentWorkspaceId、workspaceModified 状态字段

**未实现**：
- 工作区选择器下拉 UI
- 保存/管理工作区界面
- 一键恢复工作区（关闭当前终端 → 按配置重建）
- 自动更新已关联工作区

**原设计**：
- 工具栏新增：工作区选择器下拉 + 保存/管理工作区按钮
- 操作流程：
  - 点击工作区选择器 → 列出所有已保存的工作区
  - 选择工作区 → 关闭当前所有终端（提示确认）→ 按配置重新创建所有终端和布局
  - 修改终端配置后 → 点击"保存工作区"更新当前工作区
  - 首次保存 → 弹出命名对话框
- 保存内容：所有终端的连接信息（Profile ID 或内联配置）、分组结构、每个组的布局配置、colorTheme 和 tabColor
- 自动保存：终端增删、布局变更时自动更新已关联的工作区，不自动创建新工作区

### 4. 广播/批量执行 ❌ 未实现

**原设计**：

**广播模式**：
- `Ctrl+Shift+B` 进入/退出广播模式
- 广播模式下当前终端输入同步发送到同组所有终端
- 标题栏显示"广播中"标识，所有广播目标终端边框高亮
- 可自定义广播范围：当前组 / 所有组 / 手动选择

**命令面板**：
- `Ctrl+Shift+P` 打开命令面板
- 搜索命令并发送到指定终端（多选）
- 复用现有 commandTemplates

**安全考虑**：
- 广播模式下 `Ctrl+C` 也会广播
- 危险命令（rm、format、shutdown 等）发送前弹出确认
- 广播模式下显示醒目视觉提示

### 5. SSH 连接 ⚠️ 数据模型和配置 UI 已实现，直连未实现

**已实现**：
- Profile 数据模型中 SSH 字段（sshHost、sshPort、sshUser、sshAuthType、sshKeyPath）
- ConfigEditDialog 中 SSH 配置 UI（终端类型选 SSH 时显示对应字段）
- 终端启动时通过 PTY 注入 `ssh` 命令连接

**未实现**：
- Rust `ssh2` crate 实现的原生 SSH 客户端
- SshService（连接池、重连、超时）
- 密码输入对话框（连接时弹窗输入密码）
- SSH Agent 认证
- 连接状态管理（连接中/已连接/断开 + UI 状态）

**原设计**：
- 后端：使用 Rust `ssh2` crate 实现 SSH 客户端
- 新增 `SshService` 管理所有 SSH 连接
- 每个连接创建独立 SSH channel，映射为 PTY session
- 通过 Tauri event 将 SSH 输出转发到前端
- 连接生命周期与终端标签一致——关闭标签则断开连接

**认证方式**：
- 密钥认证（推荐）：Profile 保存 sshKeyPath，连接时自动读取
- 密码认证：Profile 不保存密码，连接时弹出密码输入对话框
- SSH Agent：自动尝试系统 SSH Agent

### 6. Docker / K8s 终端 ⚠️ 数据模型和配置 UI 已实现，容器列表未实现

**已实现**：
- Profile 数据模型中 Docker/K8s 字段
- ConfigEditDialog 中 Docker/K8s 配置 UI
- 终端启动时通过 PTY 注入 `docker exec` / `kubectl exec` 命令

**未实现**：
- `docker ps` 容器列表拉取和选择 UI
- `kubectl get pods` Pod 列表拉取和选择 UI
- Docker Compose 服务名支持

**原设计**：
- Docker：通过本地 Docker CLI 执行 `docker exec -it <container> <shell>`，通过 ConPTY 包装，复用现有终端架构
- K8s：通过 `kubectl exec -it -n <ns> <pod> -c <container> -- <shell>`，同样通过 ConPTY 包装
- 配置 UI：Profile 编辑对话框根据 terminalType 动态显示对应字段。Docker 类型可从 `docker ps` 拉取容器列表，K8s 类型可从 kubectl 获取资源列表

---

## 后端架构

### 新增 Tauri 命令

**工作区命令** ✅ 已实现：
- `get_all_workspaces` — 列出所有工作区
- `get_workspace(id)` — 获取单个工作区
- `create_workspace(name)` — 创建工作区
- `update_workspace(workspace)` — 更新工作区
- `delete_workspace(id)` — 删除工作区

**SSH 命令** ❌ 未实现：
- `start_ssh_terminal(profile_id)` — 建立 SSH 连接并创建终端
- `start_ssh_terminal_direct(host, port, user, auth_type, key_path)` — 直接连接（无 Profile）

**Docker/K8s 命令** ❌ 未实现：
- `list_docker_containers` — 列出运行中的 Docker 容器
- `start_docker_terminal(container_id_or_name, shell)` — docker exec 终端
- `list_k8s_pods(namespace)` — 列出 K8s Pod
- `start_k8s_terminal(namespace, pod, container, shell)` — kubectl exec 终端

### 新增服务层

- `WorkspaceService` ✅ 已实现 — 工作区 CRUD（JSON 文件持久化，同 Profile 模式）
- `SshService` ❌ 未实现 — SSH 连接管理（连接池、重连、超时）

---

## UI 状态行为

### SSH 连接状态 ❌ 未实现

| UI 元素 | 连接中 | 已连接 | 连接断开 |
|---|---|---|---|
| 标签标题 | 显示 "连接中..." + loading 动画 | 正常显示名称 | 显示名称 + 灰色 |
| 标签关闭按钮 | 可用 | 可用 | 可用 |
| 终端输入 | 禁用 | 可用 | 禁用 |
| 终端输出 | 显示连接日志 | 正常显示 | 显示断开原因 |
| 重新连接按钮 | 隐藏 | 隐藏 | 可见 |
| 右键菜单 | 可用 | 可用 | 可用 |

### 广播模式状态 ❌ 未实现

| UI 元素 | 广播关闭 | 广播开启（当前组） | 广播开启（所有组） |
|---|---|---|---|
| 工具栏广播指示器 | 隐藏 | 显示 "广播中（组名）" | 显示 "广播中（全部）" |
| 当前终端边框 | 默认 | 高亮黄色 | 高亮黄色 |
| 目标终端边框 | 默认 | 高亮黄色 | 高亮黄色 |
| 终端输入 | 仅发送到当前终端 | 同步到组内所有终端 | 同步到所有终端 |
| 广播目标终端标签下划线 | 默认色 | 黄色 | 黄色 |

### 工作区关联状态 ⚠️ 后端已就绪，UI 未实现

| UI 元素 | 未关联工作区 | 已关联工作区 | 工作区有变更 |
|---|---|---|---|
| 工具栏工作区名 | 显示 "未保存" | 显示工作区名 | 工作区名后显示 "●" |
| 保存按钮文字 | "保存为新工作区" | "保存工作区" | "保存工作区" |
| 关闭窗口提示 | 提示保存 | 无提示 | 提示保存 |
| 自动保存 | 不触发 | 触发 | 触发 |

---

## 实现阶段与状态

### 阶段 1：标签分组 + 数据模型基础 ⚠️ 部分实现
- ✅ 扩展 Profile 和 TerminalType 枚举（已支持 ssh/docker/k8s）
- ✅ 实现 Workspace/WorkspaceGroup 数据模型和后端持久化
- ✅ 标签侧栏按配置分组展示，支持折叠/展开
- ❌ 拖拽标签在组间移动
- ❌ 组名编辑/重命名/改颜色/删除
- **交付**：标签可分组管理（基础版），数据模型就位

### 阶段 2：分屏布局 ❌ 未实现
- ❌ 实现 SplitNode 渲染和拖拽调整
- ❌ 右键分屏、布局保存到工作区
- ❌ Ctrl+Tab 切换
- **交付**：同组终端可分屏查看

### 阶段 3：工作区保存/恢复 ⚠️ 后端已就绪
- ✅ 后端工作区 CRUD 命令和服务
- ❌ 工具栏工作区选择器 UI
- ❌ 保存/加载/管理工作区界面
- ❌ 自动更新已关联工作区
- **交付**：一键恢复完整工作区

### 阶段 4：SSH 连接 ⚠️ 配置已就绪，直连未实现
- ✅ Profile SSH 配置 UI（ConfigEditDialog）
- ✅ PTY 注入 ssh 命令方式连接
- ❌ 后端 SshService + ssh2 crate
- ❌ 密钥/密码认证对话框
- ❌ 连接状态管理
- **交付**：可连接远程 SSH 服务器

### 阶段 5：广播执行 ❌ 未实现
- ❌ 广播模式（同组/所有/手动选择）
- ❌ 命令面板
- ❌ 危险命令确认
- **交付**：可向多个终端同时发送命令

### 阶段 6：Docker / K8s 终端 ⚠️ 配置已就绪，列表功能未实现
- ✅ Profile Docker/K8s 配置 UI（ConfigEditDialog）
- ✅ PTY 注入 docker exec / kubectl exec 命令
- ❌ Docker 容器列表拉取（docker ps）
- ❌ K8s Pod 列表拉取（kubectl get pods）
- **交付**：可连接 Docker 容器和 K8s Pod

---

## 实现状态总结

| 阶段 | 功能 | 状态 | 说明 |
|------|------|------|------|
| 1 | 标签分组 + 数据模型 | ⚠️ 部分实现 | 后端完整，前端基础分组已实现，拖拽和组管理未实现 |
| 2 | 分屏布局 | ❌ 未实现 | SplitPane 曾开发但已删除 |
| 3 | 工作区保存/恢复 | ⚠️ 后端已就绪 | CRUD 服务完整，前端 UI 未实现 |
| 4 | SSH 连接 | ⚠️ 配置已就绪 | Profile SSH 字段和 UI 已有，原生 SSH 客户端未实现 |
| 5 | 广播执行 | ❌ 未实现 | 无任何代码实现 |
| 6 | Docker/K8s 终端 | ⚠️ 配置已就绪 | Profile 字段和 UI 已有，容器列表拉取未实现 |
