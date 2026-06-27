# 更新日志

本文档记录 TerminalBuddy 的所有重要更新。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.0.0] - 2026-06-23

### 🎉 首个正式版本发布

TerminalBuddy 是一个基于 Tauri 2 + React 18 + Rust 构建的现代化 Windows 桌面终端模拟器。

### ✨ 新增功能

#### 🔧 多终端类型支持
- PowerShell 终端
- CMD 命令提示符
- SSH 远程终端连接
- Docker 容器管理
- Kubernetes (K8s) 集群操作
- 远程桌面 (MSTSC) 连接

#### 📁 配置文件管理
- 创建、编辑、复制、删除终端配置文件
- 自定义启动路径、启动命令、环境变量
- 配置专属颜色标签和图标
- 层级分组系统，支持多级级联选择器

#### 🗂️ 标签页界面
- 垂直侧边栏或水平标签栏双模式
- 标签页分组与递归折叠
- 颜色标签与呼吸灯效果
- 拖拽排序支持
- 保存和恢复标签页布局

#### 🖥️ 分屏布局
- 终端面板分割支持
- 灵活调整面板大小
- 工作区保存与恢复

#### 🌐 远程访问能力
- **SSH 远程文件管理器**
  - 面包屑导航
  - 上传/下载文件
  - 重命名、复制、移动
  - 修改文件权限 (chmod)
  - 删除文件/目录
  - 传输进度实时显示

- **服务器监控面板**
  - CPU 使用率实时监控
  - 内存和交换分区使用情况
  - 磁盘空间占用
  - 网络上传/下载速度
  - 系统运行时间
  - 可配置刷新间隔

- **Web 远程访问**
  - 内置 HTTP/WebSocket 服务器
  - JWT 认证机制
  - 移动端友好输入栏
  - 会话隔离与权限控制

#### 📝 开发辅助工具
- **智能命令补全**
  - 基于命令模板的自动建议
  - 基于历史记录的智能推荐
  - 模糊匹配算法

- **命令模板库**
  - 10 个分类，100+ 常用命令
  - 网络、进程、文件、系统、Git、Docker、Python、Node.js、.NET、PowerShell
  - 支持自定义模板

- **命令历史**
  - 自动记录所有执行的命令
  - 全文搜索历史记录
  - 备注功能
  - 导入/导出历史数据

- **剪贴板集成**
  - 文件路径粘贴支持
  - 右键粘贴
  - 智能检测粘贴内容类型

#### 🎨 界面与主题
- **主题系统**
  - 8 款内置主题
  - 自定义 16 色 ANSI 调色板编辑器
  - 深色/浅色/跟随系统模式
  - 实时预览效果

- **文件树浏览器**
  - 本地文件系统浏览
  - 书签功能
  - 排除规则（精确匹配、通配符、递归匹配）
  - 拖拽文件到终端
  - 内联重命名

- **文本编辑器**
  - Monaco Editor 集成（VS Code 同款）
  - 语法高亮
  - 查找与替换
  - 格式化文档
  - 双击文件直接打开编辑器

- **终端搜索**
  - Ctrl+F 快速搜索
  - 高亮显示匹配结果
  - 上一个/下一个导航

#### 🔐 安全与隐私
- Web 远程访问和桌面终端会话隔离
- JWT Token 安全认证
- bcrypt 密码哈希存储
- 可配置终端会话共享策略

#### 💾 数据管理
- 所有数据以 JSON 文件存储在 `%APPDATA%/TerminalBuddy/`
- 支持完整数据导入/导出
- 8 个设置分区的完整设置面板

#### 🤖 AI 集成
- 多个 AI 服务 API 用量监控
  - 智谱 GLM
  - 百度千帆
  - Deepseek
  - Minimax
- 实时查看 API 调用次数和 Token 使用量

#### 🚀 系统特性
- 系统托盘支持（最小化到托盘）
- 托盘菜单快速操作
- 单实例模式（防止重复启动）
- 自定义无边框标题栏
- CJK 输入法支持
- Web 链接检测（Ctrl+点击打开）
- 拖拽支持

### 🛠️ 技术实现
- **后端**: Rust (edition 2021) + Tauri 2 + portable-pty (ConPTY)
- **桌面前端**: React 18 + TypeScript + Zustand 5 + xterm.js 6
- **Web API**: axum 0.8 + tower-http + JWT + bcrypt
- **Web 前端**: React 18 + Zustand 5 + xterm.js + axios
- **编辑器**: Monaco Editor
- **构建工具**: Vite 8 + NSIS 安装包

### 📦 安装包
- `TerminalBuddy_1.0.0_x64-setup.exe` - NSIS 安装包（推荐）
- `TerminalBuddy_1.0.0_x64.zip` - 便携版压缩包

### 📋 系统要求
- Windows 10 (1903+) / Windows 11
- 64-bit x86 或 ARM 处理器
- 4 GB RAM（推荐 8 GB）
- 200 MB 可用磁盘空间
- 1280 x 720 分辨率（推荐 1920 x 1080）

### 🙏 致谢
- [Tauri](https://tauri.app/) - 构建框架
- [xterm.js](https://xtermjs.org/) - 终端渲染
- [React](https://react.dev/) - UI 框架
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - 代码编辑器
- [portable-pty](https://github.com/wez/portable-pty) - PTY 管理

---

## 后续规划

### [1.1.0] - 计划中
- [ ] 多语言界面支持（英文、日文）
- [ ] 更多终端类型支持（Git Bash, WSL）
- [ ] 终端录制与回放

### [1.2.0] - 计划中
- [ ] 团队协作功能
- [ ] 插件系统

### [2.0.0] - 远期规划
- [ ] macOS 支持
- [ ] Linux 支持

---

## 版本说明

- **主版本号 (Major)**: 不兼容的 API 修改
- **次版本号 (Minor)**: 向下兼容的功能性新增
- **修订号 (Patch)**: 向下兼容的问题修正

---

## 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。
