# TerminalBuddy v1.5.0 功能更新清单

> 发布日期：2026-09-23

---

## 🔐 Web 安全与会话隔离

v1.5.0 的核心变更是 Web 远程访问的安全加固：会话隔离权限矩阵 + 登录防爆破。

### 会话隔离与权限矩阵

- **统一权限矩阵**：新增 `models/terminal_access.rs` 作为唯一权限来源（`TerminalActor` × `TerminalAction` × `TerminalOwner`），`TerminalService::authorize` 统一鉴权，业务代码不再散落硬编码的 owner 比较
- **默认隔离**（`webApiShareSessions=false`，默认值）：
  - Web 端只可见 / 可操作 Web 自建终端，PC 终端不出现在列表，WebSocket 握手直接 403
  - PC 端可只读查看 Web 终端，但不能输入 / 缩放 / 改名 / 关闭
- **共享模式**（`webApiShareSessions=true`）：双端可互相查看 / 输入 / 缩放 / 改名，但 **Web 永远不能关闭 PC 终端**（接管 ≠ 关闭）
- **运行时切换**：中途关闭共享开关后，在途的 Web → PC 连接约 5 秒内被切断
- **WS 鉴权前置**：WebSocket 在 `on_upgrade` 之前完成鉴权（未知终端 404、无权限 403），防止猜中终端 ID 后偷窥历史；每条消息及每 5 秒复检权限
- **Web SPA 适配**：Web 前端适配会话隔离设置与权限变更，无权限入口正确隐藏 / 置灰

### 登录暴力破解防护

- **按 IP 失败计数**：`web/rate_limit.rs` 实现 `LoginThrottle`，失败窗口计数 + 指数封禁退避（可注入时钟，含单元测试）
- **bcrypt 并发限流**：全局并发信号量限制密码校验，超出返回 429 + `Retry-After`
- **错误类型扩展**：`ApiError::TooManyRequests` 支持设置 `Retry-After` 头

---

## 🛡️ 终端修复

- **粘贴行尾统一为 CR**：ConPTY 会把 LF 当作 Ctrl+Enter，在 pi 等 kitty 协议 TUI 下导致多行粘贴乱码与逐行误提交；现统一以 CR 结尾，多行粘贴行为恢复正常
- **debug 日志增强**：日志增加日期与进程退出码，便于排查终端异常退出
- **VS Code 终端宿主专属进程名**：避免与其他 node.exe 混淆、被全机批量杀进程时误伤
- **启动 bug 修复**：修复特定路径下的启动失败问题

---

## ⚙️ 设置与参数预设

- **settingsVersion 落地**：补上设置版本号实现，修复设置变更时报错与标签栏不刷新的问题
- **参数预设启用 / 禁用开关**：预设可单独禁用，禁用后不再出现在右键启动菜单

---

## ⌨️ 快捷键

- **修复全局快捷键注册始终提示被占用**：修正注册判定逻辑，「后台唤起主窗口」等全局快捷键可正常注册

---

## 🎨 外观与 UI

- **应用图标焕新**：启用全新「双窗结伴」Logo（方案 B），桌面图标全尺寸与 PC / Web 两处 `app-icon.png` 同步更新
- **皮肤适配**：修复皮肤背景色色块问题，浅色 / 暗色皮肤下组件配色持续适配
- **弹窗闪烁修复**：修复弹窗打开时的闪烁（CSS 动画不连续 + `useEffect` 死循环）

---

## 📚 文档与工程

- 更新架构说明与完整使用指南
- 新增 BUG 审计清单（`docs/2026-09-04-全项目BUG审计清单.md`）与 invoke 覆盖校验脚本（`scripts/check-invoke-coverage.py`）
- 忽略 `.codex` 与 `.playwright-mcp` 目录
- 文本编辑器与设置面板细节改进

---

## 🔄 兼容性

- **数据存储**：沿用 v1.4.1 的 `%APPDATA%/TerminalBuddy/` 目录结构，`settings.json` / `Profiles/*.json` 直接兼容
- **Web API 行为变更**：升级后默认 `webApiShareSessions=false`，Web 端将看不到已有 PC 终端；如需跨端共享，在设置中手动开启「会话共享」
- **登录接口**：密码错误次数过多会触发按 IP 封禁（指数退避），属预期安全行为

---

## 📌 升级建议

- 从 v1.4.x 覆盖安装即可，无需先卸载
- 升级前建议确认 Web 端使用场景：若依赖查看 PC 终端，升级后需在设置中开启 `webApiShareSessions`
- 共享开关关闭后约 5 秒内会切断已连接的 Web 会话，属预期行为
