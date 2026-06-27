# TerminalBuddy v1.0.0 发布说明

🎉 **首个正式版本发布！**

TerminalBuddy 是一个基于 Tauri 2 + React 18 + Rust 构建的现代化 Windows 桌面终端模拟器，专为开发者和系统管理员设计，提供强大的终端管理、远程服务器访问和开发辅助功能。

---

## ✨ 核心特性

### 🔧 多终端类型支持
- **PowerShell** - 现代化的 PowerShell 7+ 终端
- **CMD** - 经典 Windows 命令提示符
- **SSH** - 安全远程终端连接
- **Docker** - 容器化环境管理
- **Kubernetes** - K8s 集群操作
- **远程桌面 (MSTSC)** - Windows 远程桌面连接

### 📁 智能配置文件管理
- 创建、编辑、复制、删除终端配置文件
- 支持自定义启动路径、启动命令、环境变量
- 配置专属颜色标签和图标
- **层级分组系统** - 使用多级级联选择器组织配置文件

### 🗂️ 灵活的标签页界面
- **双模式导航** - 垂直侧边栏或水平标签栏
- 标签页分组与递归折叠
- 颜色标签与呼吸灯效果
- 拖拽排序支持
- 保存和恢复标签页布局

### 🖥️ 分屏布局
- 支持终端面板分割
- 灵活调整面板大小
- 工作区保存与恢复

---

## 🌐 远程访问能力

### 🔌 SSH 远程文件管理器
- 面包屑导航，快速定位文件
- 右键菜单操作：
  - 上传/下载文件
  - 重命名、复制、移动
  - 修改文件权限 (chmod)
  - 删除文件/目录
- 传输进度实时显示

### 📊 服务器监控面板
实时监控 SSH 连接的服务器状态：
- **CPU 使用率** - 实时 CPU 负载
- **内存使用** - 物理内存和交换分区
- **磁盘使用** - 各分区空间占用
- **网络流量** - 上传/下载速度
- **运行时间** - 系统 uptime
- 可配置刷新间隔（默认 5 秒）

### 🌍 Web 远程访问
内置 HTTP/WebSocket 服务器，支持浏览器远程终端访问：
- **JWT 认证** - 安全的身份验证机制
- **WebSocket 实时通信** - 低延迟终端 I/O
- **移动端友好** - 专为手机浏览器优化的输入栏
- **会话隔离** - 可配置的终端访问权限控制

---

## 📝 开发辅助工具

### 💡 智能命令补全
- 基于命令模板的自动建议
- 基于历史记录的智能推荐
- **模糊匹配算法** - 快速找到所需命令
- 实时输入提示

### 📚 命令模板库
10 个分类的预定义模板，共 100+ 常用命令：
- **网络** - ping, curl, netstat, nslookup 等
- **进程** - tasklist, taskkill, get-process 等
- **文件** - dir, copy, move, del, xcopy 等
- **系统** - systeminfo, shutdown, restart 等
- **Git** - clone, commit, push, pull 等
- **Docker** - build, run, ps, exec 等
- **Python** - pip, venv, python 等
- **Node.js** - npm, yarn, node 等
- **.NET** - dotnet, nuget 等
- **PowerShell** - Get-*, Set-*, Invoke-* 等

支持自定义模板和模板描述编辑。

### 📜 命令历史
- 自动记录所有执行的命令
- 全文搜索历史记录
- **备注功能** - 为命令添加说明
- 导入/导出历史数据

### ✂️ 剪贴板集成
- **文件路径粘贴** - 从资源管理器直接 Ctrl+V 粘贴文件路径
- 右键粘贴支持
- 智能检测粘贴内容类型

---

## 🎨 界面与主题

### 🌙 主题系统
- **8 款内置主题** - 包括暗色、亮色和彩色主题
- **自定义主题编辑器** - 16 色 ANSI 调色板完全自定义
- **主题模式** - 深色模式 / 浅色模式 / 跟随系统
- 实时预览效果

### 📂 文件树浏览器
- 本地文件系统浏览
- **书签功能** - 常用目录快速访问
- **排除规则** - 支持精确匹配、通配符、递归匹配
  - 示例: `node_modules`, `*.log`, `**/*.tmp`
- 拖拽文件到终端自动粘贴路径
- 内联重命名

### 📝 文本编辑器
集成 **Monaco Editor**（VS Code 同款编辑器核心）：
- 语法高亮支持
- 查找与替换
- 格式化文档
- 双击文件树中的文件直接打开编辑器标签页

### 🔍 终端搜索
- **Ctrl+F** 快速搜索终端输出
- 高亮显示匹配结果
- 上一个/下一个导航

### 🖱️ 交互增强
- **CJK 输入法支持** - 中文/日文/韩文输入法组合窗口位置锁定
- **Web 链接检测** - Ctrl+点击自动打开浏览器
- **拖拽支持** - 文件拖拽到终端

---

## 🔐 安全与隐私

### 🛡️ 会话隔离
- Web 远程访问和桌面终端默认隔离
- 可配置终端会话共享策略
- JWT Token 安全认证

### 🔒 数据安全
- 密码使用 bcrypt 哈希存储
- 所有通信加密

---

## 💾 数据管理

### 📦 数据可移植性
所有用户数据以 JSON 文件存储在 `%APPDATA%/TerminalBuddy/`：
- `Profiles/` - 终端配置文件
- `Themes/` - 自定义主题
- `Workspaces/` - 工作区配置
- `command_history.json` - 命令历史
- `command_templates.json` - 命令模板
- `settings.json` - 应用设置

支持完整的数据导入/导出，轻松迁移配置。

### ⚙️ 设置面板
8 个设置分区：
1. **通用** - 启动恢复、关闭行为、主题模式、数据路径
2. **连接管理** - 配置文件 CRUD 和分组
3. **命令模板** - 模板管理与自定义
4. **主题管理** - 主题编辑与切换
5. **命令历史** - 历史记录管理
6. **文件排除** - 排除规则配置
7. **AI 用量** - API 密钥管理
8. **Web 远程管理** - 服务器配置与控制

---

## 🤖 AI 集成

### 📈 AI 用量监控
支持监控多个 AI 服务的 API 使用情况：
- **智谱 GLM** - ChatGLM 系列模型
- **百度千帆** - 文心一言系列模型
- **Deepseek** - Deepseek 系列模型
- **Minimax** - Minimax 系列模型

实时查看 API 调用次数和 Token 使用量。

---

## 🚀 系统特性

### 💻 系统托盘
- 最小化到系统托盘
- 托盘菜单快速操作
- **单实例模式** - 防止重复启动

### 🪟 自定义标题栏
- 无边框窗口设计
- 自定义窗口控制按钮
- 导航按钮集成

### ⚡ 性能优化
- Rust 后端确保高性能
- 响应式 UI 设计
- 懒加载与虚拟滚动

---

## 📋 系统要求

- **操作系统** - Windows 10 (1903+) / Windows 11
- **处理器** - 64-bit x86 或 ARM
- **内存** - 4 GB RAM（推荐 8 GB）
- **磁盘空间** - 200 MB 可用空间
- **显示** - 1280 x 720 分辨率（推荐 1920 x 1080）

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 桌面前端 | React 18, TypeScript, Zustand 5, xterm.js 6, Monaco Editor |
| 后端 | Rust (edition 2021), Tauri 2, portable-pty (ConPTY) |
| Web API | axum 0.8, tower-http, JWT (jsonwebtoken), bcrypt |
| Web 前端 | React 18, Zustand 5, xterm.js, axios |
| 构建 | Vite 8, NSIS 安装包 |

---

## 📦 安装方式

### 下载安装包
从 [Releases 页面](https://gitee.com/updateme/terminal-buddy/releases) 下载最新版本：
- `TerminalBuddy_1.0.0_x64-setup.exe` - NSIS 安装包（推荐）

### 便携版
- `TerminalBuddy_1.0.0_x64.zip` - 免安装压缩包

---

## 🐛 已知问题

- 分屏模式下的终端 resize 同步可能存在偶发问题
- 某些CJK输入法在特殊场景下候选窗位置可能偏移

---

## 🗺️ 后续规划

- [ ] 多语言界面支持（英文、日文）
- [ ] 更多终端类型支持（Git Bash, WSL）
- [ ] 终端录制与回放
- [ ] 团队协作功能
- [ ] 插件系统
- [ ] macOS 和 Linux 支持

---

## 🙏 致谢

感谢以下开源项目：
- [Tauri](https://tauri.app/) - 构建框架
- [xterm.js](https://xtermjs.org/) - 终端渲染
- [React](https://react.dev/) - UI 框架
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - 代码编辑器
- [portable-pty](https://github.com/wez/portable-pty) - PTY 管理

---

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。

---

## 🔗 相关链接

- **项目主页**: https://gitee.com/updateme/terminal-buddy
- **问题反馈**: https://gitee.com/updateme/terminal-buddy/issues
- **文档**: https://gitee.com/updateme/terminal-buddy/blob/master/README.md

---

**TerminalBuddy** - 让终端管理更简单、更高效！🚀

发布日期: 2026-06-23
