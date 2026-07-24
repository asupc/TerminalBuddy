# 版本检查更新 + 仓库地址迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在应用启动时静默拉取仓库根 `version.json`，发现新版本后在 TitleBar 显示徽标 + 弹出 changelog 面板，引导用户跳转 Gitee releases 手动下载。同时把项目仓库地址迁移到 `https://gitee.com/updateme/terminal-buddy`。

**Architecture:** 后端 Rust 新增 `update_service`（fetch + 静默错误）+ `commands/update::check_app_update` 命令；前端通过 `invoke` 拿到 `UpdateInfo`，用本地 `compareVersions` 决定是否提示。仓库根 `version.json` 作为版本清单；用户偏好（启动检查开关）写入后端 `AppSettings`（同步前端 `DEFAULT_SETTINGS`）。

**Tech Stack:** Tauri 2, Rust (`reqwest`, `serde_json`), React 18, Zustand (existing), `markdown-it` (existing), `dompurify` (existing), Gitee Raw (manifest source).

## Global Constraints

- 应用当前版本号 `1.3.0`，维护于 `terminal-buddy/package.json` / `terminal-buddy/src-tauri/Cargo.toml` / `terminal-buddy/src/version.ts`（手动同步）。
- 后端 `AppSettings` 用 `#[serde(default = "...")]` 兼容旧 `settings.json`；前端 `getAppSettings()` 用 `{ ...DEFAULT_SETTINGS, ..._cachedSettings }` 合并。
- 后端命令返回 `Result<(), String>`；前端 `invoke` 失败一律静默吞错。
- 所有 Rust↔TS 序列化使用 `#[serde(rename_all = "camelCase")]`。
- 前端 UI 文案用中文（简体）。
- 主题色用 CSS 变量（`--accent` 等），不写死颜色。
- `TerminalBuddy/src-tauri/Cargo.toml` 已有 `reqwest = { version = "0.12", features = ["json", "multipart"] }`，**不新增依赖**。
- Tauri 2 命令在 `commands/mod.rs` 加 `pub mod update; pub use update::*;`，在 `lib.rs` 的 `use commands::{...}` 列表添加新函数名。
- 前端"通用设置"组件是 `terminal-buddy/src/components/settings/BehaviorSettings.tsx`（中文 label "行为设置"），新 toggle 加在合适位置。
- 现有 TitleBar 已有 `<AiUsagePanel>` 鼠标悬浮气泡（CSS class `ai-usage-tooltip`），新通知 popover 复用 `ai-usage-tooltip` 视觉风格。
- localStorage key：`appUpdate.dismissedVersion`。

---

## File Structure

新建：
- `version.json` — 仓库根版本清单
- `terminal-buddy/src-tauri/src/models/update.rs` — `UpdateInfo` 结构
- `terminal-buddy/src-tauri/src/services/update_service.rs` — fetch + compare_versions + 单测
- `terminal-buddy/src-tauri/src/commands/update.rs` — `check_app_update` 命令
- `terminal-buddy/src/utils/version.ts` — 前端 `compareVersions`
- `terminal-buddy/src/components/UpdatePopover.tsx` — 新版本 popover 组件

修改：
- `terminal-buddy/src-tauri/src/models/settings.rs` — AppSettings 加 `update_check_enabled`
- `terminal-buddy/src-tauri/src/commands/mod.rs` — 加 `update` 模块
- `terminal-buddy/src-tauri/src/commands/settings.rs` — 加 `save_update_check_enabled`
- `terminal-buddy/src-tauri/src/lib.rs` — `invoke_handler!` 加 2 个命令
- `terminal-buddy/src/utils/settings.ts` — AppSettings + DEFAULT_SETTINGS 加 `updateCheckEnabled`
- `terminal-buddy/src/services/tauri.ts` — 加 `checkAppUpdate` / `saveUpdateCheckEnabled`
- `terminal-buddy/src/components/settings/BehaviorSettings.tsx` — 加 toggle
- `terminal-buddy/src/components/TitleBar.tsx` — 加徽标 + popover
- `terminal-buddy/src/App.tsx` — 启动后调用 `checkAppUpdate()`
- `.git/config` — origin 改新地址
- `README.md` / `docs/使用技巧.md`（如含旧地址）— 替换

---

## Task 1: 仓库地址迁移（git remote + 文档链接）

**Files:**
- Modify: `.git/config`（自动随 `git remote set-url`）
- Modify: 仓库根 `README.md`（如含旧仓库地址）
- Modify: `docs/使用技巧.md`（如含旧仓库地址）
- Create: 仓库根 `docs/REPO_URL.md` 不需要——直接在 README 改

**Interfaces:**
- N/A

- [ ] **Step 1: 查找旧仓库地址**

```bash
cd "D:/gitee/TerminalBuddy" && grep -rn "github.com\|gitee.com" README.md docs/使用技巧.md 2>/dev/null | head -50
```

记录所有匹配行（每条都包含旧地址），后续步骤逐一替换。

- [ ] **Step 2: 替换 README.md 内的旧仓库地址为新地址**

```bash
cd "D:/gitee/TerminalBuddy" && \
  powershell -NoProfile -Command "(Get-Content README.md) -replace 'https://github.com/[A-Za-z0-9_.-]+/terminal-buddy', 'https://gitee.com/updateme/terminal-buddy' -replace 'https://gitee.com/[A-Za-z0-9_.-]+/terminal-buddy', 'https://gitee.com/updateme/terminal-buddy' | Set-Content README.md"
```

- [ ] **Step 3: 替换 `docs/使用技巧.md` 内的旧仓库地址**

```bash
cd "D:/gitee/TerminalBuddy" && \
  powershell -NoProfile -Command "(Get-Content 'docs/使用技巧.md') -replace 'https://github.com/[A-Za-z0-9_.-]+/terminal-buddy', 'https://gitee.com/updateme/terminal-buddy' -replace 'https://gitee.com/[A-Za-z0-9_.-]+/terminal-buddy', 'https://gitee.com/updateme/terminal-buddy' | Set-Content 'docs/使用技巧.md'"
```

- [ ] **Step 4: 替换 git remote**

```bash
cd "D:/gitee/TerminalBuddy" && git remote set-url origin https://gitee.com/updateme/terminal-buddy
```

如 origin 不存在：
```bash
cd "D:/gitee/TerminalBuddy" && git remote add origin https://gitee.com/updateme/terminal-buddy
```

- [ ] **Step 5: 校验**

```bash
cd "D:/gitee/TerminalBuddy" && git remote -v
```

预期输出：
```
origin  https://gitee.com/updateme/terminal-buddy (fetch)
origin  https://gitee.com/updateme/terminal-buddy (push)
```

再扫一遍仓库内残留：
```bash
cd "D:/gitee/TerminalBuddy" && grep -rn "github.com/[A-Za-z0-9_.-]\+/terminal-buddy\|gitee.com/[A-Za-z0-9_.-]\+/terminal-buddy" --include="*.md" --include="*.toml" --include="*.json" --include="*.ts" --include="*.tsx" --include="*.rs" . 2>/dev/null
```

预期输出：除 `.git/config`、本设计文档、本计划文档以外无残留。

- [ ] **Step 6: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add . && git -c commit.gpgsign=false commit -m "迁移仓库地址为 https://gitee.com/updateme/terminal-buddy"
```

---

## Task 2: 创建仓库根 `version.json`

**Files:**
- Create: `version.json`（仓库根）

**Interfaces:**
- N/A（仓库外部 manifest，不被本仓库代码读取）

- [ ] **Step 1: 写入 `version.json`**

文件 `version.json`（仓库根，与 `terminal-buddy/` 同级）：

```json
{
  "version": "1.3.0",
  "releaseDate": "2026-07-24",
  "mandatory": false,
  "changelog": "## 1.3.0\n\n- 当前在用版本占位\n- 下一版起启用自动检查更新",
  "downloadUrl": "https://gitee.com/updateme/terminal-buddy/releases/tag/v1.4.0"
}
```

- [ ] **Step 2: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add version.json && git -c commit.gpgsign=false commit -m "新增仓库根 version.json 作为版本检查清单"
```

---

## Task 3: 后端 `UpdateInfo` 数据模型

**Files:**
- Create: `terminal-buddy/src-tauri/src/models/update.rs`

**Interfaces:**
- Produces: `pub struct UpdateInfo` (camelCase) — fields: `version: String, releaseDate: String, changelogMd: String, downloadUrl: String, mandatory: bool`

- [ ] **Step 1: 写入 `models/update.rs`**

```rust
use serde::{Deserialize, Serialize};

/// 远端 version.json 解析后的结果（驼峰字段供前端使用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub release_date: String,
    pub changelog_md: String,
    pub download_url: String,
    pub mandatory: bool,
}
```

- [ ] **Step 2: 校验编译**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：`Finished ...` 无错误（仅 warnings）。

- [ ] **Step 3: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src-tauri/src/models/update.rs && git -c commit.gpgsign=false commit -m "新增 UpdateInfo 数据模型"
```

---

## Task 4: 后端 AppSettings 加 `update_check_enabled`

**Files:**
- Modify: `terminal-buddy/src-tauri/src/models/settings.rs`

**Interfaces:**
- Mutates: `AppSettings` struct — adds `pub update_check_enabled: bool` (default `true`)

- [ ] **Step 1: 在 `models/settings.rs` 加 default 函数**

在 `default_single_instance` 函数（行 52 附近）后追加：

```rust
fn default_update_check_enabled() -> bool {
    true
}
```

- [ ] **Step 2: 在 `AppSettings` 加字段**

在 `pub enable_tab_navigation: bool,` 之后（约行 74）插入：

```rust
    #[serde(default = "default_update_check_enabled")]
    pub update_check_enabled: bool,
```

- [ ] **Step 3: 在 `Default for AppSettings` 实现里加初始化**

在 `impl Default for AppSettings` 块（行 97-120）的初始化列表加一行（`single_instance: true,` 之后）：

```rust
            update_check_enabled: true,
```

- [ ] **Step 4: 校验编译**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：`Finished ...` 无错误。

- [ ] **Step 5: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src-tauri/src/models/settings.rs && git -c commit.gpgsign=false commit -m "AppSettings 新增 update_check_enabled 字段"
```

---

## Task 5: TDD - Rust `compare_versions` 纯函数

**Files:**
- Create: `terminal-buddy/src-tauri/src/services/update_service.rs`

**Interfaces:**
- Produces: `pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering` — same logic on both sides (Rust + frontend)

- [ ] **Step 1: 写入带失败测试的骨架 `update_service.rs`**

```rust
use std::cmp::Ordering;

use crate::models::UpdateInfo;

/// 仓库根 version.json 的 Gitee Raw 地址。
pub const MANIFEST_URL: &str =
    "https://gitee.com/updateme/terminal-buddy/raw/main/version.json";

/// 比较两个 semver 字符串（点分三段）。
///
/// - 支持可选 `v` 前缀（`v1.4.0` 等价 `1.4.0`）。
/// - 任一版本解析失败 → 返回 `Equal`（保守不提示）。
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |s: &str| -> Option<Vec<u32>> {
        s.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse::<u32>().ok())
            .collect::<Option<_>>()
    };
    match (parse(a), parse(b)) {
        (Some(va), Some(vb)) => va.cmp(&vb),
        _ => Ordering::Equal,
    }
}

/// 拉取并解析远端 version.json；任何错误静默返回 None。
/// 调用方负责决定要不要提示用户（不在此比较版本）。
pub async fn fetch_update_info() -> Option<UpdateInfo> {
    // 此任务先放空，仅写测试用 compare_versions。
    // 实现见下一个任务（Task 6）。
    unimplemented!("see Task 6")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal() {
        assert_eq!(compare_versions("1.3.0", "1.3.0"), Ordering::Equal);
    }

    #[test]
    fn upgrade_major() {
        assert_eq!(compare_versions("2.0.0", "1.9.9"), Ordering::Greater);
    }

    #[test]
    fn upgrade_minor() {
        assert_eq!(compare_versions("1.4.0", "1.3.9"), Ordering::Greater);
    }

    #[test]
    fn downgrade() {
        assert_eq!(compare_versions("1.3.0", "1.4.0"), Ordering::Less);
    }

    #[test]
    fn with_v_prefix() {
        assert_eq!(compare_versions("v1.4.0", "1.3.0"), Ordering::Greater);
    }

    #[test]
    fn malformed() {
        assert_eq!(compare_versions("bad", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
    }
}
```

- [ ] **Step 2: 跑测试（应全部通过）**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo test --lib services::update_service
```

预期：6 个 `compare_versions` 测试全部通过；`fetch_update_info` 标记 `unimplemented!`，但因测试模块未调用，编译和运行都成功。

- [ ] **Step 3: 确认实现与设计一致**

复读上面代码块，规则与设计 §4.3 一致（`v` 前缀、段数 ≠ 3 视为 Equal、字典序比较）。

- [ ] **Step 4: 提交（仅骨架与测试）**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src-tauri/src/services/update_service.rs && git -c commit.gpgsign=false commit -m "新增 update_service 骨架与 compare_versions 单测"
```

---

## Task 6: 实现 `fetch_update_info`（HTTP + 静默错误）

**Files:**
- Modify: `terminal-buddy/src-tauri/src/services/update_service.rs`

**Interfaces:**
- Replaces `fetch_update_info` skeleton with real implementation.
- Signature: `pub async fn fetch_update_info() -> Option<UpdateInfo>` — 5s timeout, all errors → None.

- [ ] **Step 1: 替换 `fetch_update_info` 函数体**

把 `update_service.rs` 中 `fetch_update_info` 函数替换为：

```rust
/// 拉取并解析远端 version.json；任何错误静默返回 None。
/// 调用方负责决定要不要提示用户（不在此比较版本）。
pub async fn fetch_update_info() -> Option<UpdateInfo> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client.get(MANIFEST_URL).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: UpdateInfo = resp.json().await.ok()?;
    Some(UpdateInfo {
        // 远端字段名 `changelog` 兼容映射成 `changelogMd`
        changelog_md: body.changelog_md,
        ..body
    })
}
```

- [ ] **Step 2: 校验编译**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：`Finished ...` 无错误。

- [ ] **Step 3: 再跑一遍单测，确保 compare_versions 没被破坏**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo test --lib services::update_service
```

预期：6 个测试全部通过。

- [ ] **Step 4: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src-tauri/src/services/update_service.rs && git -c commit.gpgsign=false commit -m "update_service: 实现 fetch_update_info（5s 超时，静默错误）"
```

---

## Task 7: 后端 `check_app_update` 命令 + `save_update_check_enabled` + 注册

**Files:**
- Create: `terminal-buddy/src-tauri/src/commands/update.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/mod.rs`
- Modify: `terminal-buddy/src-tauri/src/commands/settings.rs`
- Modify: `terminal-buddy/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `#[tauri::command] pub async fn check_app_update() -> Option<UpdateInfo>`
- Produces: `#[tauri::command] pub fn save_update_check_enabled(enabled: bool) -> Result<(), String>`

- [ ] **Step 1: 写入 `commands/update.rs`**

```rust
use crate::models::UpdateInfo;
use crate::services::{update_service, SettingsService};

/// 启动时调用：拉取远端 version.json；开关关闭或拉取失败 → 返回 None。
#[tauri::command]
pub async fn check_app_update() -> Option<UpdateInfo> {
    let settings = SettingsService::get_settings();
    if !settings.update_check_enabled {
        return None;
    }
    update_service::fetch_update_info().await
}
```

- [ ] **Step 2: 在 `commands/mod.rs` 加模块**

在 `pub mod terminal;` 之后追加：

```rust
pub mod update;
```

并在 `pub use terminal::*;` 之后追加：

```rust
pub use update::*;
```

最终 `commands/mod.rs` 末尾段看起来像：

```rust
pub mod terminal;
pub mod update;
pub mod web;
pub mod window;
pub mod workspace;
pub use terminal::*;
pub use update::*;
pub use web::*;
pub use window::*;
pub use workspace::*;
```

- [ ] **Step 3: 在 `commands/settings.rs` 加 `save_update_check_enabled`**

在 `save_single_instance` 函数（行 207 附近）后追加：

```rust
#[tauri::command]
pub fn save_update_check_enabled(enabled: bool) -> Result<(), String> {
    SettingsService::mutate_settings(|s| s.update_check_enabled = enabled)
}
```

- [ ] **Step 4: 在 `lib.rs` 的 `use commands::{...}` 列表加 2 个命令**

修改 `terminal-buddy/src-tauri/src/lib.rs` 第 7 行末尾（`show_claude_code_notification` 后），在该 use 列表中追加两个新命令：

```rust
use commands::{get_all_profiles, ..., show_claude_code_notification, check_app_update, save_update_check_enabled};
```

- [ ] **Step 5: 校验编译**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：`Finished ...` 无错误。

- [ ] **Step 6: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src-tauri/src/commands/update.rs terminal-buddy/src-tauri/src/commands/mod.rs terminal-buddy/src-tauri/src/commands/settings.rs terminal-buddy/src-tauri/src/lib.rs && git -c commit.gpgsign=false commit -m "后端新增 check_app_update 命令与 save_update_check_enabled"
```

---

## Task 8: 前端 `AppSettings` + `services/tauri.ts` + `utils/version.ts`

**Files:**
- Modify: `terminal-buddy/src/utils/settings.ts`
- Create: `terminal-buddy/src/utils/version.ts`
- Modify: `terminal-buddy/src/services/tauri.ts`

**Interfaces:**
- Produces: `src/utils/settings.ts::AppSettings.updateCheckEnabled: boolean`
- Produces: `src/utils/version.ts::compareVersions(a: string, b: string): number` — same rules as Rust
- Produces: `src/services/tauri.ts::checkAppUpdate(): Promise<UpdateInfo | null>`
- Produces: `src/services/tauri.ts::saveUpdateCheckEnabled(enabled: boolean): Promise<void>`

- [ ] **Step 1: 在 `utils/settings.ts` 加字段与默认值**

在 `AppSettings` 接口（约行 17 `enableTabNavigation: boolean;` 之后）追加：

```ts
  updateCheckEnabled: boolean;
```

在 `DEFAULT_SETTINGS` 对象（约行 62 `enableTabNavigation: true,` 之后）追加：

```ts
  updateCheckEnabled: true,
```

- [ ] **Step 2: 创建 `utils/version.ts`**

新文件 `terminal-buddy/src/utils/version.ts`：

```ts
/**
 * 与 Rust 端 update_service::compare_versions 规则一致。
 * - 支持可选 `v` 前缀（`v1.4.0` 等价 `1.4.0`）。
 * - 必须点分三段全数字，否则视为解析失败 → 返回 0（保守不提示）。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (s: string): number[] | null => {
    const trimmed = s.replace(/^v/, '');
    const parts = trimmed.split('.');
    if (parts.length !== 3) return null;
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      nums.push(Number(p));
    }
    return nums;
  };
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}
```

- [ ] **Step 3: 在 `services/tauri.ts` 加 2 个包装**

在 `services/tauri.ts` 末尾追加：

```ts
export interface UpdateInfo {
  version: string;
  releaseDate: string;
  changelogMd: string;
  downloadUrl: string;
  mandatory: boolean;
}

export async function checkAppUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>('check_app_update');
}

export async function saveUpdateCheckEnabled(enabled: boolean): Promise<void> {
  await invoke('save_update_check_enabled', { enabled });
}
```

- [ ] **Step 4: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 5: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/utils/settings.ts terminal-buddy/src/utils/version.ts terminal-buddy/src/services/tauri.ts && git -c commit.gpgsign=false commit -m "前端 AppSettings/tauri.ts 加 updateCheckEnabled；新增 compareVersions"
```

---

## Task 9: 前端通用设置加 toggle

**Files:**
- Modify: `terminal-buddy/src/components/settings/BehaviorSettings.tsx`

**Interfaces:**
- N/A（仅 UI 绑定 `settings.updateCheckEnabled`）

- [ ] **Step 1: 引入 `saveUpdateCheckEnabled`**

修改 `BehaviorSettings.tsx` 顶部 import，把 `saveEnableTabNavigation` 一起的引入加上 `saveUpdateCheckEnabled`。当前文件没引入，但 `SshSettings.tsx` 中可见引入样式类似。在 `BehaviorSettings.tsx` 顶部 `import` 段（约行 1-8）加：

```tsx
import { saveUpdateCheckEnabled } from '../../services/tauri';
```

（如 `services/tauri` 还没被引入，加在最末；如果已经引入，按现有风格合并。）

- [ ] **Step 2: 加 toggle UI 区块**

在 BehaviorSettings 现有的 toggle 区块（如 "纵向选项卡" toggle 之后、`"右键粘贴"` toggle 之前）插入新 toggle：

```tsx
<div className="settings-section">
  <label className="settings-toggle">
    <input
      type="checkbox"
      checked={settings.updateCheckEnabled}
      onChange={(e) => {
        const value = e.target.checked;
        updateSetting('updateCheckEnabled', value);
        saveUpdateCheckEnabled(value).catch(console.error);
      }}
    />
    <span>启动时检查更新</span>
  </label>
  <p className="settings-desc">
    启动时静默检查 Gitee 上的版本清单；发现新版本时在标题栏显示提示，不自动升级
  </p>
</div>
```

- [ ] **Step 3: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 4: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/components/settings/BehaviorSettings.tsx && git -c commit.gpgsign=false commit -m "行为设置新增「启动时检查更新」开关"
```

---

## Task 10: 前端 `UpdatePopover` 组件

**Files:**
- Create: `terminal-buddy/src/components/UpdatePopover.tsx`
- Create: `terminal-buddy/src/components/UpdatePopover.css`

**Interfaces:**
- Produces: `<UpdatePopover info={UpdateInfo} onClose={() => void} />` — 渲染版本号 / 发布日期 / markdown changelog / [去下载] [忽略本次] 按钮

- [ ] **Step 1: 写入 `UpdatePopover.tsx`**

```tsx
import { FC, useMemo } from 'react';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { Download, X } from 'lucide-react';
import type { UpdateInfo } from '../services/tauri';
import './UpdatePopover.css';

interface UpdatePopoverProps {
  info: UpdateInfo;
  onDismiss: () => void;
}

const md = new MarkdownIt({ html: false, linkify: true });

export const UpdatePopover: FC<UpdatePopoverProps> = ({ info, onDismiss }) => {
  const html = useMemo(() => {
    const rendered = md.render(info.changelogMd || '');
    return DOMPurify.sanitize(rendered);
  }, [info.changelogMd]);

  const handleDownload = () => {
    window.open(info.downloadUrl, '_blank', 'noopener,noreferrer');
  };

  const handleIgnore = () => {
    localStorage.setItem('appUpdate.dismissedVersion', info.version);
    onDismiss();
  };

  return (
    <div className="update-popover" role="dialog" aria-label="新版本提示">
      <div className="update-popover-header">
        <div className="update-popover-title">
          <Download size={14} aria-hidden="true" />
          <span>发现新版本 v{info.version}</span>
        </div>
        <button
          type="button"
          className="update-popover-close"
          onClick={onDismiss}
          title="关闭"
          aria-label="关闭新版本提示"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="update-popover-meta">发布于 {info.releaseDate}</div>
      <div
        className="update-popover-changelog"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className="update-popover-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={handleDownload}
        >
          前往 Gitee 下载
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleIgnore}
          title="本次启动不再提示此版本"
        >
          忽略本次
        </button>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: 写入 `UpdatePopover.css`**

```css
.update-popover {
  width: 320px;
  max-height: 360px;
  overflow: auto;
  padding: 12px;
  background: var(--bg-elevated, #252526);
  border: 1px solid var(--border, #3a3a3a);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  color: var(--text-primary, #e0e0e0);
  font-size: 13px;
  line-height: 1.5;
}

.update-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.update-popover-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.update-popover-close {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
}

.update-popover-close:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.08));
}

.update-popover-meta {
  font-size: 11px;
  color: var(--text-secondary, #999);
  margin-bottom: 8px;
}

.update-popover-changelog {
  font-size: 12px;
  color: var(--text-secondary, #ccc);
}

.update-popover-changelog h1,
.update-popover-changelog h2,
.update-popover-changelog h3 {
  margin: 6px 0 4px;
  font-size: 13px;
  color: var(--text-primary, #e0e0e0);
}

.update-popover-changelog ul,
.update-popover-changelog ol {
  padding-left: 18px;
  margin: 4px 0;
}

.update-popover-changelog p {
  margin: 4px 0;
}

.update-popover-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.update-popover-actions button {
  flex: 1;
}
```

- [ ] **Step 3: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 4: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/components/UpdatePopover.tsx terminal-buddy/src/components/UpdatePopover.css && git -c commit.gpgsign=false commit -m "新增 UpdatePopover 组件"
```

---

## Task 11: TitleBar 接入徽标 + popover

**Files:**
- Modify: `terminal-buddy/src/components/TitleBar.tsx`

**Interfaces:**
- Consumes: `updateInfo: UpdateInfo | null`, `onUpdateDismiss: () => void` 由 `App.tsx` 传入。
- 在 TitleBar 中渲染 `<button>`（无更新时）/`<button>` + 红点 + `<UpdatePopover>`（有更新时），沿用 `ai-usage-trigger` 的 hover 模式。

- [ ] **Step 1: 修改 `TitleBar.tsx` props 接口**

找到 `TitleBarProps` 接口（约行 30-36）加两个字段：

```tsx
  updateInfo: UpdateInfo | null;
  onUpdateDismiss: () => void;
```

并在文件顶部 import 段（约行 1-30）加：

```tsx
import { Bell } from 'lucide-react';
import { UpdatePopover } from './UpdatePopover';
import type { UpdateInfo } from '../services/tauri';
```

（保留现有 `lucide-react` import 的扩展写法——按现有项目风格在 `lucide-react` 导入行追加 `Bell` 即可。）

- [ ] **Step 2: 解构新 props**

在 `TitleBar` 函数签名解构处（约行 38-45）追加：

```tsx
  updateInfo,
  onUpdateDismiss,
```

- [ ] **Step 3: 加 hover state + 处理函数**

在现有 `useState` 群（约行 46-50）后追加：

```tsx
  const [updateHover, setUpdateHover] = useState(false);
  const updateHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleUpdateEnter = () => {
    if (updateHoverTimer.current) clearTimeout(updateHoverTimer.current);
    setUpdateHover(true);
  };
  const handleUpdateLeave = () => {
    updateHoverTimer.current = setTimeout(() => setUpdateHover(false), 200);
  };
```

并在 `useEffect` 清理函数（约行 52-61）追加：

```tsx
    if (updateHoverTimer.current) clearTimeout(updateHoverTimer.current);
```

- [ ] **Step 4: 在 TitleBar 渲染新按钮**

在 `<div className="ai-usage-trigger">` 区块（约行 158-167）后插入：

```tsx
          {updateInfo && (
            <div
              className="ai-usage-trigger"
              onMouseEnter={handleUpdateEnter}
              onMouseLeave={handleUpdateLeave}
            >
              <button
                className="titlebar-nav-btn"
                title={`发现新版本 v${updateInfo.version}`}
                aria-label={`发现新版本 v${updateInfo.version}，点击查看更新说明`}
              >
                <Bell aria-hidden="true" />
                <span className="titlebar-status-dot online" aria-hidden="true" />
              </button>
              {updateHover && (
                <UpdatePopover info={updateInfo} onDismiss={onUpdateDismiss} />
              )}
            </div>
          )}
```

- [ ] **Step 5: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误（会报 `updateInfo` 未传入 TS 错误吗？不会，因为这是接口扩展；调用方未传时再处理——见 Task 12）。

- [ ] **Step 6: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/components/TitleBar.tsx && git -c commit.gpgsign=false commit -m "TitleBar 接入新版本徽标与 popover"
```

---

## Task 12: App.tsx 启动钩子调用 `checkAppUpdate`

**Files:**
- Modify: `terminal-buddy/src/App.tsx`

**Interfaces:**
- Consumes: `checkAppUpdate(): Promise<UpdateInfo | null>`, `getAppSettings()`, `compareVersions`, `APP_VERSION`, localStorage `appUpdate.dismissedVersion`
- Produces: 维护一个 state `updateInfo` 并通过 props 传给 TitleBar；点"忽略本次"时调 `onUpdateDismiss` 清空 state。

- [ ] **Step 1: 加 import**

在 `App.tsx` 顶部 `import` 段加：

```tsx
import { useEffect, useState } from 'react';
import { checkAppUpdate, type UpdateInfo } from './services/tauri';
import { compareVersions } from './utils/version';
import { getAppSettings } from './utils/settings';
import { APP_VERSION } from './version';
```

（如已有 `useEffect`、`useState`，按现有风格合并，不重复导入。）

- [ ] **Step 2: 在 `App` 函数体加 state**

```tsx
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    const settings = getAppSettings();
    if (!settings.updateCheckEnabled) return;
    checkAppUpdate()
      .then(info => {
        if (!info) return;
        const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
        if (info.version === dismissed) return;
        if (compareVersions(info.version, APP_VERSION) <= 0) return;
        setUpdateInfo(info);
      })
      .catch(() => {});
  }, []);
```

- [ ] **Step 3: 把 `updateInfo` 与 `onUpdateDismiss` 传给 TitleBar**

在 `<TitleBar ... />` 处（约文件靠下）追加：

```tsx
        updateInfo={updateInfo}
        onUpdateDismiss={() => setUpdateInfo(null)}
```

- [ ] **Step 4: 类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 5: Rust 后端复检**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：0 错误（虽然本次未改 Rust，确认未退化）。

- [ ] **Step 6: 提交**

```bash
cd "D:/gitee/TerminalBuddy" && git add terminal-buddy/src/App.tsx && git -c commit.gpgsign=false commit -m "App 启动钩子调用 checkAppUpdate 并把结果传给 TitleBar"
```

---

## Task 13: 端到端验证

**Files:** 无

- [ ] **Step 1: 跑 Rust 全量单测**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo test --lib
```

预期：6 个 `compare_versions` 测试 + 现有测试（如有）全部通过。

- [ ] **Step 2: 跑前端类型检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npx tsc --noEmit
```

预期：0 错误。

- [ ] **Step 3: 跑 Rust 编译检查**

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy/src-tauri" && cargo check
```

预期：`Finished ...` 无错误。

- [ ] **Step 4: 手工冒烟 - 静态确认未升级场景**

不启动应用，仅 grep 关键文本：

```bash
cd "D:/gitee/TerminalBuddy" && \
  grep -n "checkAppUpdate\|UpdatePopover\|update_check_enabled\|fetch_update_info" terminal-buddy/src/App.tsx terminal-buddy/src/components/TitleBar.tsx terminal-buddy/src/components/UpdatePopover.tsx terminal-buddy/src-tauri/src/services/update_service.rs terminal-buddy/src-tauri/src/commands/update.rs
```

预期：每条匹配命中至少 1 次。

- [ ] **Step 5: 手工冒烟 - 应用启动场景（可选）**

如本机已安装 `tauri-cli`，可：

```bash
cd "D:/gitee/TerminalBuddy/terminal-buddy" && npm run tauri dev
```

启动后肉眼确认：
1. 标题栏正常渲染，无新徽标（因为 `version.json` 当前 `1.3.0` 等于本地版本，`compareVersions` 返回 0，不提示）。
2. 打开 设置 → 行为设置 → 看到新增「启动时检查更新」开关，默认勾选。
3. 取消勾选开关 → 设置会被写盘（看 `getAppSettings()` 后值变更）。

- [ ] **Step 6: 手工冒烟 - 模拟升级场景（可选）**

临时把仓库根 `version.json` 改成 `"version": "1.4.0"`，再次启动应用：

预期：标题栏出现红色 Bell 徽标，鼠标悬停弹出 UpdatePopover，包含版本号 / 发布日期 / markdown 渲染的 changelog / [前往 Gitee 下载] / [忽略本次]。

测完恢复 `version.json` 为 `1.3.0`：

```bash
cd "D:/gitee/TerminalBuddy" && git checkout -- version.json
```

- [ ] **Step 7: 提交（如有遗留改动）**

如有修复需要提交：

```bash
cd "D:/gitee/TerminalBuddy" && git add -A && git -c commit.gpgsign=false commit -m "端到端验证：修复合并残留"
```

否则跳过。