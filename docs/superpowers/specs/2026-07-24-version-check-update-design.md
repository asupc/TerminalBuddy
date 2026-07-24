# 版本检查更新 + 仓库地址迁移

- 日期：2026-07-24
- 范围：`terminal-buddy/src-tauri/` 后端命令 / 服务 / 设置模型、`terminal-buddy/src/` 前端设置 / TitleBar / App 启动钩子、仓库根 `version.json`、`.git/config`、文档
- 关联：仓库地址由 `<原地址>` 改为 `https://gitee.com/updateme/terminal-buddy`

## 1. 背景与目标

### 1.1 现状

- 三个版本号当前都是 `1.3.0`，需要手工同步：
  - `terminal-buddy/package.json` → `1.3.0`
  - `terminal-buddy/src-tauri/Cargo.toml` → `1.3.0`
  - `terminal-buddy/src/version.ts` → `1.3.0`（注释明示「手动更新」）
- `tauri.conf.json` 不带 `version` 字段（Tauri 2 以 `Cargo.toml` 为准）。
- 项目无任何自动更新相关代码，无 `tauri-plugin-updater`，但已有 `reqwest = "0.12"`。
- 现有 HTTP 调用都走 Rust 后端（`fetch_qianfan_usage` / `fetch_deepseek_usage` / `fetch_ark_usage` 等），前端只通过 `invoke()` 取值。
- 设置持久化：`%APPDATA%/TerminalBuddy/settings.json`，由 `services/settings_service.rs` 管理。前端 `AppSettings`（`utils/settings.ts`）与后端 `models/settings.rs::AppSettings` 一一对应。
- TitleBar 右侧已有 AI 用量悬停面板 + Web API 开关，新增通知可沿用同样的 hover popover 样式。

### 1.2 目标

1. 应用启动后静默检查一次远端 `version.json`，发现新版本时在 TitleBar 出现可点击徽标，展开后展示 changelog 与「去下载」链接。**不做静默/强制升级**——点击下载即跳到 Gitee releases 页面，由用户手动下载 NSIS 安装包。
2. 在设置页「通用」加一个开关「启动时检查更新」（默认开启）。
3. 仓库 origin 由 `<原地址>` 改为 `https://gitee.com/updateme/terminal-buddy`，文档里出现的旧仓库地址同步替换。

### 1.3 非目标（YAGNI）

- 不引入 `tauri-plugin-updater`、不做应用内自动下载安装、不配 tuf 签名密钥。
- 不做周期定时检查，只在每次启动时查一次。
- 不做强制更新（manifest 中保留 `mandatory` 字段以备将来，但不强制执行）。
- 不暴露 manifest URL 自定义设置。

## 2. 数据模型

### 2.1 `AppSettings` 新增字段

**后端** `terminal-buddy/src-tauri/src/models/settings.rs::AppSettings`：

```rust
#[serde(default = "default_update_check_enabled")]
pub update_check_enabled: bool,   // 默认 true
```

旧 `settings.json` 缺字段时由 `#[serde(default)]` 自动回退到 `true`，无需迁移代码。

**前端** `terminal-buddy/src/utils/settings.ts::AppSettings`：

```ts
updateCheckEnabled: boolean;
```

同步在 `DEFAULT_SETTINGS` 中加 `updateCheckEnabled: true`。`getAppSettings()` 用 `{ ...DEFAULT_SETTINGS, ..._cachedSettings }` 合并旧数据缺字段自动回退。

### 2.2 后端新模型 `UpdateInfo`

`terminal-buddy/src-tauri/src/models/update.rs`：

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,         // 远端版本号（manifest 的 version 字段）
    pub release_date: String,    // "YYYY-MM-DD"
    pub changelog_md: String,    // markdown 原文
    pub download_url: String,    // Gitee release 页面 URL
    pub mandatory: bool,         // 保留字段，本次不强制执行
}
```

### 2.3 manifest 仓库根 `version.json`

```json
{
  "version": "1.3.0",
  "releaseDate": "2026-07-24",
  "mandatory": false,
  "changelog": "## 1.3.0\n- 当前在用版本占位\n- 下一版起启用自动检查更新",
  "downloadUrl": "https://gitee.com/updateme/terminal-buddy/releases/tag/v1.4.0"
}
```

> 注：首版 `version.json` 与本地版本同为 `1.3.0`，应用启动时不会触发更新提示；下次发布新版时同步修改即可。

### 2.4 前端 localStorage

- key：`appUpdate.dismissedVersion`
- value：被忽略的远端版本号字符串
- 用户在 popover 点击「忽略本次」时写入；下次启动比较远端版本号，相等则不提示。
- 用户卸载重装 → 该 key 丢失，符合「忽略只是这一次」语义。

## 3. 架构

### 3.1 模块划分

```
src-tauri/
  models/update.rs                       ← 新建
  services/update_service.rs             ← 新建（私有模块）
  commands/update.rs                     ← 新建（仅 1 个 #[tauri::command]）
  commands/mod.rs                        ← +1 行 re-export
  commands/settings.rs                   ← +1 行 save_update_check_enabled
  services/settings_service.rs           ← +1 个 setter
  models/settings.rs                     ← AppSettings +1 字段
  lib.rs                                 ← invoke_handler! +1 项

src/
  utils/settings.ts                      ← AppSettings +1 字段、DEFAULT_SETTINGS +1
  services/tauri.ts                      ← +2 个 invoke 包装
  components/settings/GeneralSettings.tsx（或最近似通用设置组件）
                                         ← +1 行开关 UI
  components/TitleBar.tsx                ← +1 个铃铛/下载图标 + 红点
  components/UpdatePopover.tsx           ← 新建（沿用 AiUsagePanel 视觉）
  App.tsx                                ← useEffect 内启动后异步调用

仓库根
  version.json                           ← 新建
  .git/config                            ← 修改 origin
  README.md / docs/使用技巧.md 等         ← 旧仓库地址统一替换
```

### 3.2 职责边界

- `update_service`：纯函数 + 一次 HTTP 调用，**不读** `AppSettings`、**不做版本比较**。负责：
  - 常量 `MANIFEST_URL`
  - `pub async fn fetch_update_info() -> Option<UpdateInfo>`：5s 超时、错误静默，返回**未经比较**的远端版本
- `commands/update::check_app_update`：薄壳——读 settings（开关是否启用）、调用 service、把 `Option<UpdateInfo>` 透给前端。**不在此比较版本**，因为当前版本号在前端常量里（后端拿不到，且无意义地同步会引入重复事实）。
- `compare_versions` 在前端实现为 `utils/version.ts` 导出函数，由 `App.tsx` 在拿到 `UpdateInfo` 后调用。Rust 端 `update_service::compare_versions` 同步实现并单测，**仅服务于 Rust 单测**（保持「同一规则、两侧实现」最小风险）。
- 前端 `App.tsx`：在主窗口挂载完成后 fire-and-forget 调用 `checkAppUpdate()`；结果保存到 React state；条件渲染 TitleBar 徽标。
- 前端 `UpdatePopover`：纯展示组件，传入 `updateInfo` 后渲染版本号、发布日期、changelog（DOMPurify + markdown-it 渲染）、[去下载] [忽略本次] 两个按钮。

## 4. 数据流

### 4.1 启动检查

```
[App.tsx mount]
   │
   │ useEffect(() => {
   │   if (!settings.updateCheckEnabled) return;
   │   invoke('check_app_update').then(info => {
   │     if (info && info.version !== localStorage.getItem('appUpdate.dismissedVersion')
   │         && compareVersions(info.version, APP_VERSION) > 0) {
   │       setUpdateInfo(info);
   │     }
   │   }).catch(() => {});   // 后端已静默吞错，这里再 catch 一次防 TS 报错
   │ }, [settings.updateCheckEnabled]);
   ▼
[invoke 'check_app_update']
   │
   ▼
[commands/update::check_app_update]
   │
   │ 1. settings_service.get_app_settings() → 若 !update_check_enabled return None
   │ 2. update_service::fetch_update_info() → 5s 超时、错误吞
   ▼
[Option<UpdateInfo>] 返回前端
   │
   │ 前端 compareVersions(info.version, APP_VERSION) > 0
   │ && info.version !== localStorage.getItem('appUpdate.dismissedVersion')
   ▼
[setUpdateInfo(info)]
```

### 4.2 用户交互

- 点 TitleBar 铃铛 → 展开 `<UpdatePopover>`。
- 点「去下载」→ `window.open(updateInfo.downloadUrl)`（Webview 默认走系统浏览器）；备用方案 `tauri-plugin-shell::open`，本次不引入该插件。
- 点「忽略本次」→ `localStorage.setItem('appUpdate.dismissedVersion', info.version)`，关闭 popover。

### 4.3 版本比较算法

内置实现，无外部 semver crate。规则在前端 / Rust **两侧各写一份**，保持一致：

```rust
// update_service.rs（仅用于 Rust 单测，不被命令调用）
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |s: &str| -> Option<Vec<u32>> {
        s.trim_start_matches('v').split('.')
            .map(|p| p.parse::<u32>().ok())
            .collect::<Option<_>>()
    };
    match (parse(a), parse(b)) {
        (Some(va), Some(vb)) => va.cmp(&vb),
        _ => Ordering::Equal,  // 解析失败时保守地视为相等，不提示
    }
}
```

前端 `utils/version.ts` 同步实现 `compareVersions(a: string, b: string): number`，逻辑相同。

## 5. 错误处理

| 场景 | 行为 |
|------|------|
| 网络断开 / DNS 失败 / 超时 | `fetch_update_info` 返回 `None`，命令返回 `None`，前端不显示徽标 |
| HTTP 4xx / 5xx | 同上 |
| 响应非 JSON / 字段缺失 | 同上 |
| `version` 段数 ≠ 3 或含非数字 | `compare_versions` 返回 `Equal`，不提示 |
| `mandatory: true` 但 URL 不可达 | 与普通失败相同；本次不强制执行 |
| 前端 `invoke` reject（理论上不应发生） | `.catch(() => {})` 吞掉 |

## 6. 测试

项目无自动化测试（项目 CLAUDE.md 已注明）。本设计加入 1 个轻量 Rust 单元测试覆盖 `compare_versions` 的纯函数行为：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn equal() { assert_eq!(compare_versions("1.3.0", "1.3.0"), Ordering::Equal); }
    #[test] fn upgrade_major() { assert_eq!(compare_versions("2.0.0", "1.9.9"), Ordering::Greater); }
    #[test] fn upgrade_minor() { assert_eq!(compare_versions("1.4.0", "1.3.9"), Ordering::Greater); }
    #[test] fn downgrade() { assert_eq!(compare_versions("1.3.0", "1.4.0"), Ordering::Less); }
    #[test] fn with_v_prefix() { assert_eq!(compare_versions("v1.4.0", "1.3.0"), Ordering::Greater); }
    #[test] fn malformed() { assert_eq!(compare_versions("bad", "1.0.0"), Ordering::Equal); }
}
```

## 7. 仓库地址迁移

### 7.1 git remote

```bash
git remote set-url origin https://gitee.com/updateme/terminal-buddy
```

如 `origin` 不存在或要新增：
```bash
git remote add origin https://gitee.com/updateme/terminal-buddy
```

### 7.2 文档同步

全文搜索 `https://github.com/` 与旧仓库地址，统一替换为新地址。已知涉及：
- `README.md`
- `docs/使用技巧.md`
- 其他散落的文档链接

### 7.3 应用内展示

- TitleBar 的「帮助/反馈」如有指向仓库的链接，更新到新地址。
- UpdatePopover 内 `downloadUrl` 默认指向新仓库的 releases 页面。

## 8. 文件改动清单（按提交顺序）

1. `terminal-buddy/src-tauri/src/models/settings.rs` — AppSettings 加 `update_check_enabled`。
2. `terminal-buddy/src-tauri/src/models/update.rs` — 新建 `UpdateInfo` 结构。
3. `terminal-buddy/src-tauri/src/services/update_service.rs` — 新建（manifest URL 常量、`fetch_update_info`、`compare_versions` + 单测）。
4. `terminal-buddy/src-tauri/src/commands/update.rs` — 新建 `check_app_update` 命令。
5. `terminal-buddy/src-tauri/src/commands/mod.rs` — re-export。
6. `terminal-buddy/src-tauri/src/commands/settings.rs` — 注册 `save_update_check_enabled`。
7. `terminal-buddy/src-tauri/src/services/settings_service.rs` — 加 setter。
8. `terminal-buddy/src-tauri/src/lib.rs` — `invoke_handler!` 添加 `check_app_update`。
9. `terminal-buddy/src/utils/settings.ts` — `AppSettings` + `DEFAULT_SETTINGS` 加 `updateCheckEnabled`。
10. `terminal-buddy/src/services/tauri.ts` — 加 `checkAppUpdate` / `saveUpdateCheckEnabled`。
11. `terminal-buddy/src/utils/version.ts` — 新建（前端 `compareVersions` 实现）。
12. `terminal-buddy/src/components/settings/GeneralSettings.tsx`（或最近似通用设置组件）— 加开关 UI。
13. `terminal-buddy/src/components/UpdatePopover.tsx` — 新建。
14. `terminal-buddy/src/components/TitleBar.tsx` — 加徽标 + popover 挂载。
15. `terminal-buddy/src/App.tsx` — 启动后 `useEffect` 调用 `checkAppUpdate()`。
16. 仓库根 `version.json` — 新建首版占位。
17. `.git/config` — origin 改新地址。
18. `README.md` / `docs/使用技巧.md` 等 — 旧仓库地址替换。