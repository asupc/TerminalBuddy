# 第三方依赖升级与校验计划

日期：2026-11-13。状态：**P0–P3 已执行，P4 待启动**。

依据：2026-11-13 对前端 `terminal-buddy/package.json`、`terminal-buddy/package-lock.json`，Rust `terminal-buddy/src-tauri/Cargo.toml`、`Cargo.lock`（含本地 patch `portable-pty-patched`），以及仓库根 `android/` 构建配置的只读检查；npm registry、crates.io、RustSec、Google Maven、Gradle 官方版本信息。本文记录 2026-11-13 已实际执行并通过的构建 / 编译 / 单测 / 审计结果；“真机功能回归”仍需按 §6 单独完成。

相关文档：[项目说明](../../AGENTS.md)、[桌面端会话式聊天规格](./2026-11-07--desktop-conversational-chat.md)、[原生 AI 会话 API](../原生AI会话API.md)。

---

## 0. 执行摘要

本轮升级的目标不是把所有包刷到最新，而是按风险和收益分阶段完成：

1. **P0 安全修复**：前端 3 个直接依赖 + Monaco 传递依赖；Rust 锁文件安全刷新 + `rusqlite`、`zip` 主版本修复。
2. **P1 兼容升级**：React、Tauri JavaScript 2.x、其他同主版本前端包，以及 Rust 可兼容直接依赖。
3. **P2 终端栈**：xterm 6.1 beta 整组升级；`node-pty` 单独评估，不随 xterm 顺手升。
4. **P3 Android 应用库**：AndroidX、Kotlin 标准库、OkHttp 4.x 小步升级。
5. **P4 Android 构建链**：AGP / Gradle / Kotlin / Compose BOM 跨代升级，必须在 P3 与现有 lint 错误处理完之后单独进行。

**当前基线**（检查时）：

| 领域 | 基线 |
| --- | --- |
| 前端 | `npm audit` 7 项：1 critical、5 high、1 moderate |
| Rust | `cargo audit` 23 个漏洞、3 个 warning 分类 |
| Android | `compileReleaseKotlin` 可过；`lintRelease` 有 4 个既有错误、54 个 warning、1 个 hint |
| 工具链 | Node 24 / npm 11；Rust 1.99；Java 21；Gradle 8.13；Android compileSdk / targetSdk 36 |

**首轮验收目标**：

- 前端 `npm audit` 的已知可直接修复漏洞为 **0**（未被上游修复的项须在报告里单列）。
- Rust 在完成 P0 后 `cargo audit` 漏洞数为 **0**；剩余 warning 单独记录。
- 桌面、浏览器、独立服务端、Android 至少各完成一轮构建或编译验证；真机 / 桌面交互验证按 §6 执行。

---

## 1. 范围与原则

### 1.1 范围

- 前端：`terminal-buddy/package.json`、`terminal-buddy/package-lock.json`。
- Rust：`terminal-buddy/src-tauri/Cargo.toml`、`Cargo.lock`、`portable-pty-patched/Cargo.toml` 及其锁文件（仅检查，默认不升级 patch 依赖）。
- Android：仓库根 `android/build.gradle.kts`、`android/app/build.gradle.kts`、`android/gradle/wrapper/gradle-wrapper.properties`、相关源码与测试。
- 不修改 `terminal-buddy/web/`（已退役，历史参考保留）。
- 不在同一提交中混入业务功能改动；依赖升级与 lint 修复分开提交。

### 1.2 强制原则

- **不执行无边界全量升级**：禁止直接 `npm update`、`cargo update` 后不审计、不验证就提交。
- **每个阶段一个可回滚提交**：锁文件与 manifest 同提交；阶段失败时整体 revert，不在同一提交里“边修边换版本”。
- **先安全、后兼容、最后跨代**：P0 未通过不进入 P1；P1 未通过不进入 P2；P4 不允许提前合入。
- **锁文件必须提交**：`package-lock.json` / `Cargo.lock` 都要审查 diff，确认不是无意升级整个依赖树。
- **不升级本地 patch 的 `portable-pty`**：未经补丁验证，不从 crates.io 更新；只允许在独立任务里重新导入并验证。
- **不按 `npm outdated` 的 `latest` 盲升 beta 包**：xterm 的 `latest` 会显示旧稳定版 6.0.0，项目实际使用 6.1 beta 线，必须按 beta 版本对齐。
- **不顺手升级 `node-pty`**：其预编译 ConPTY、`plugins/vscode-terminal/plugin.json`、`scripts/prepare-vscode-terminal-plugin.mjs` 强耦合，需独立验证。
- **不提前跨 major**：`markdown-it 15`、TypeScript 7、Rust `reqwest 0.13` 等不再作为默认路径；除非对应阶段明确批准。

---

## 2. 基线与升级清单

### 2.1 前端：当前、目标与处置

#### P0 安全修复（立即做）

| 包 | 当前 | 目标 | 处置 | 原因 |
| --- | ---: | ---: | --- | --- |
| `dompurify` | 3.4.12 | 3.4.17 | 升级 | 直接 XSS 清洗防线；当前审计为 critical |
| `markdown-it` | 14.3.0 | 14.3.3 | 升级 | 修复多个二次复杂度 / DoS 路径；预览开启 HTML |
| `vite` | 8.0.14 | 8.3.8 | 升级 | 修复 high 风险，含 Windows 路径 / 命令问题 |
| `monaco-editor` | 0.55.1（传递） | 0.57.0 | 显式加入 `dependencies` | Monaco 自带旧 `dompurify` 3.2.7；避免隐式依赖漂移 |
| `postcss` | 8.5.15 | 8.5.32 | 由锁文件刷新 | 传递依赖，high 风险 |
| `nanoid` | 3.3.12 | 3.3.20 | 由锁文件刷新 | 传递依赖，high 风险 |
| `source-map-js` | 1.2.1 | 1.2.2 | 由锁文件刷新 | 传递依赖，high 风险 |

P0 前端推荐命令（在 `terminal-buddy/` 下）：

```bash
npm install dompurify@^3.4.17 markdown-it@^14.3.3
npm install -D vite@^8.3.8
npm install monaco-editor@^0.57.0
npm audit fix --no-fund
```

执行前先记录基线：

```bash
npm audit --json > /tmp/terminal-buddy-npm-audit-before.json || true
npm outdated --json > /tmp/terminal-buddy-npm-outdated-before.json || true
```

执行后检查：

```bash
npm audit
npm ls dompurify markdown-it monaco-editor vite postcss nanoid source-map-js --all
```

**P0 前端通过标准**：

- 顶层 `dompurify` 为 3.4.17 或更高；`markdown-it` 为 14.3.3 或更高；`vite` 为 8.3.8 或更高。
- `npm audit` 不再报告可直接修复的漏洞；如果仍有间接项，必须记录包名、路径、上游版本与不可修复原因。
- Monaco 仅保留一个可解释的 `dompurify` 版本；若仍存在嵌套旧版本，必须记录为“上游 Monaco 未升级导致”。


### 2.1.1 执行记录（2026-11-13）

截至本记录写入时，已按计划完成 **P0-A、P0-B、P1-A、P1-B、P2、P3**，P4 尚未开始。实际执行结论如下。

| 阶段 | 结果 | 说明 |
| --- | --- | --- |
| P0-A | 通过 | `dompurify 3.4.17`、`markdown-it 14.3.3`、`vite 8.3.8`、`monaco-editor 0.57.0`；`npx tsc --noEmit`、`npm run build`、`npm run build:web:desktop` 全部通过 |
| P0-B | 通过 | `rusqlite 0.42.0`、`zip 9.5.1`、`cargo update`；`cargo check`、`cargo test --lib`（407 passed）、`cargo audit`（0 vulnerabilities）通过 |
| P1-A | 通过 | React 19.3.1、Tauri JS/CLI 2.12.4、插件 2.8.4 / 2.4.1 等；双构建通过 |
| P1-B | 通过 | Tauri 2.12.5、tokio 1.54.1、hyper 1.12.0、serde 1.0.229 等；`rust-embed` 保持 8.13.0 三件套 |
| P2 | 通过 | xterm 6.1.0-beta.337 与 clipboard beta.335 / search beta.331 / unicode11 beta.331 / webgl beta.330；`node-pty` 保持 beta.13 |
| P3 | 通过（构建级） | Android `compileReleaseKotlin`、`testReleaseUnitTest`、`assembleRelease` 通过；APK 由 `apksigner` 验证 v2 签名；`lintRelease` 仍有原 4 个错误、51 warnings、1 hint |
| P4 | 未启动 | 需要 `compileSdk 37`、AGP >= 9.1 与 Kotlin 2.4 迁移，属于独立构建链改动 |

**执行中发现的计划修正：**

1. **Monaco 内联 sanitizer**：Monaco 0.57.0 将 DOMPurify 3.4.15 内联到 `esm/vs/base/browser/dompurify/dompurify.js`，npm `overrides` 无法替换。已在 `vite.config.ts` 增加最小 alias，将该模块映射到顶层 `dompurify@3.4.17`；桌面和浏览器产物构建后均不再包含旧版本标记。`npm audit` 仍会按 lockfile 静态报告 Monaco 的嵌套 3.4.15，这是已知审计盲区，不能据此声称 `npm audit` 完全清零。
2. **zip 9 API 变化**：`ZipFile::name()` 返回 `Result<Cow<str>, ZipError>`，已仅修改 ZIP 测试代码为 `.name().unwrap()`；生产写入路径未改。
3. **Android core / lifecycle 版本约束**：`androidx.core 1.19.1` 和 `lifecycle 2.11.0` 要求 `compileSdk 37 + AGP >= 9.1`，不能留在 P3。P3 实际保留 `core-ktx 1.18.0`、`lifecycle 2.10.0`；这两项升级移至 P4。
4. **Android serialization 约束**：`kotlinx-serialization-json 1.13.0` 使用 Kotlin 2.4 metadata，当前 Kotlin 2.2.21 不兼容；P3 保持 1.9.0，待 P4 与 Kotlin 2.4 一起升级。
5. **Gradle 并发限制**：`compileReleaseKotlin` / `testReleaseUnitTest` / `assembleRelease` 共享 `android/app/build`，不能并行运行；P3 已改为串行 `clean` + compile + test + assemble。

**P3 实际版本：**

| 依赖 | 实际版本 |
| --- | ---: |
| `androidx.core:core-ktx` | 1.18.0 |
| `androidx.activity:activity-compose` | 1.13.0 |
| `androidx.work:work-runtime-ktx` | 2.12.0 |
| `androidx.lifecycle:lifecycle-*-compose` | 2.10.0 |
| `kotlinx-coroutines-android` | 1.11.0 |
| `kotlinx-serialization-json` | 1.9.0 |
| OkHttp | 4.12.0（未升级） |
| Compose BOM | 2025.10.01（P4 前保持不变） |
| AGP / Gradle / Kotlin | 8.13.2 / 8.13 / 2.2.21（P4 前保持不变） |

**签名验证：**

```text
apksigner verify --verbose --print-certs android/app/build/outputs/apk/release/app-release.apk
Verified using v2 scheme (APK Signature Scheme v2): true
Signer #1 certificate DN: CN=TerminalBuddy Android, O=TerminalBuddy, C=CN
```

APK 产物：`android/app/build/outputs/apk/release/app-release.apk`。


#### P1 兼容升级（安全修复后再做）

以下均为同主版本或可兼容范围，建议单独提交：

| 包 | 当前 | 目标 | 备注 |
| --- | ---: | ---: | --- |
| `@tauri-apps/api` | 2.11.0 | 2.12.4 | 与 Tauri CLI / Rust 2.12 对齐 |
| `@tauri-apps/cli` | 2.11.2 | 2.12.4 | 构建链一并刷新 |
| `@tauri-apps/plugin-dialog` | 2.7.1 | 2.8.4 | 与 Rust plugin 2.8 对齐 |
| `@tauri-apps/plugin-global-shortcut` | 2.3.2 | 2.4.1 | 与 Rust plugin 2.4 对齐 |
| `react` / `react-dom` | 19.2.6 | 19.3.1 | 同主版本 |
| `@types/react` / `@types/react-dom` | 19.2.x | 19.3.0 | 跟随 React 类型 |
| `@xyflow/react` | 12.11.2 | 12.12.1 | 同主版本 |
| `react-hook-form` | 7.77.0 | 7.92.0 | 同主版本 |
| `zustand` | 5.0.14 | 5.1.0 | 同主版本 |
| `highlight.js` | 11.11.1 | 11.12.0 | 同主版本 |
| `lucide-react` | 1.24.0 | 1.72.0 | 体积会增大，按需打包；升级前检查图标 API |
| `@types/markdown-it` | 14.1.2 | 14.2.0 | 不跨到 markdown-it 15 |

执行：

```bash
cd terminal-buddy
npm install \
  @tauri-apps/api@^2.12.4 \
  @tauri-apps/plugin-dialog@^2.8.4 \
  @tauri-apps/plugin-global-shortcut@^2.4.1 \
  react@^19.3.1 react-dom@^19.3.1 \
  @xyflow/react@^12.12.1 \
  react-hook-form@^7.92.0 \
  zustand@^5.1.0 \
  highlight.js@^11.12.0 \
  lucide-react@^1.72.0
npm install -D @tauri-apps/cli@^2.12.4 @types/react@^19.3.0 @types/react-dom@^19.3.0 @types/markdown-it@^14.2.0
```

#### P2 终端栈

| 包 | 当前 | 目标 | 备注 |
| --- | ---: | ---: | --- |
| `@xterm/xterm` | 6.1.0-beta.285 | 6.1.0-beta.337 | 主包 |
| `@xterm/addon-clipboard` | 0.3.0-beta.285 | 0.3.0-beta.335 | 与 xterm beta 同组 |
| `@xterm/addon-search` | 0.17.0-beta.285 | 0.17.0-beta.331 | 同上 |
| `@xterm/addon-unicode11` | 0.10.0-beta.285 | 0.10.0-beta.331 | 同上 |
| `@xterm/addon-webgl` | 0.20.0-beta.284 | 0.20.0-beta.330 | 同上 |
| `@xterm/addon-fit` | 0.11.0 | 0.11.0 | 不涉及 |
| `@xterm/addon-web-links` | 0.12.0 | 0.12.0 | 不涉及 |
| `node-pty` | 1.2.0-beta.13 | 暂不升级 | 需重打包 ConPTY / 插件，见 §4.3 |

**禁止**把 xterm 回退到 `npm outdated` 的 `latest`（6.0.0 / 0.19.0）；必须整组保持 6.1 beta 的 peer 对齐。

#### 暂缓的前端跨代项

- `markdown-it` 15.0.3：与 `@types/markdown-it`、渲染规则、linkify 行为需单独验证，P1 先停 14.3.3。
- TypeScript 7.0.2：当前 `6.0.3` 满足构建；升 7 会改变类型检查行为，单独立项。
- `node-pty` 1.2.0-beta.18：见 §4.3。
- `@monaco-editor/react` 4.7.0：已是最新稳定线；只显式固定 `monaco-editor` 版本。

### 2.2 Rust：当前、目标与处置

#### P0 安全修复（立即做）

**步骤 A：兼容锁文件刷新，修复可修复的传递依赖。**

在 `terminal-buddy/src-tauri/` 下先记录：

```bash
cargo audit --json > /tmp/terminal-buddy-cargo-audit-before.json || true
cargo outdated --root-deps-only --format json > /tmp/terminal-buddy-cargo-outdated-before.json || true
cargo update --dry-run > /tmp/terminal-buddy-cargo-update-dry-run.txt 2>&1 || true
```

然后执行：

```bash
cargo update
```

这一步预期修复（以执行时锁文件实际结果为准）：

- `h2` 0.4.14 → 0.4.20（>= 0.4.16）
- `libz-sys` 1.1.29 → 1.1.33（>= 1.1.31）
- `quick-xml` 0.39.4 → 0.42.0（>= 0.41.0）
- `quinn-proto` 0.11.16 → 0.11.19（>= 0.11.18）
- `rustls` 0.23.40 → 0.23.46（>= 0.23.46）
- `rustls-webpki` 0.103.13 → 0.103.17（>= 0.103.16）
- `webpki-roots` 1.0.8 → 1.0.12（>= 1.0.10）
- `tokio` 1.52.3 → 1.54.1（修复 AsyncFd unsound 警告）
- `anyhow` 1.0.102 → 1.0.104（修复 unsound 警告）

**步骤 B：提升直接依赖，修复 `rusqlite` / `zip` / zstd 链。**

修改 `Cargo.toml`：

```toml
rusqlite = { version = "0.42", default-features = false, features = ["bundled", "cache"] }
zip = { version = "9.5.1", default-features = false, features = ["deflate-flate2-zlib-rs"] }
```

说明：

- `rusqlite` 0.42 拉入修复后的 bundled SQLite / `libsqlite3-sys`；项目使用 bundled 模式，不依赖系统 SQLite。
- `zip` 9.5.1 是当前修复 >= 9.0.0 的版本；关闭默认 features 可去掉未使用的 AES、bzip2、xz、zstd 等 codec。
- 项目当前 ZIP 用法是“写下载包 + 测试读取”，没有调用 `ZipArchive::extract`；仍建议升级，因为 9.x 是上游修复版本，且能消除 zstd 0.13 链。

然后：

```bash
cargo update -p rusqlite
cargo update -p zip
cargo audit
```

**P0 Rust 通过标准**：

- `cargo audit` 漏洞数 **0**。
- `cargo check` 通过。
- `cargo test --lib` 通过。
- 如果 `cargo audit` 仍有 warning，允许存在，但必须在 §8 报告里列出，并确认不是新增项。
- 若升级后 `zip` / `rusqlite` 编译失败，按 §7 回滚该阶段，不要在同一提交里改业务代码绕过。

#### P1 同代兼容直接依赖

在 P0 通过后单独提交，目标版本以执行时 registry 为准：

| 包 | 当前 | 兼容目标 | 说明 |
| --- | ---: | ---: | --- |
| `tauri` | 2.11.2 | 2.12.5 | 2.x 同代 |
| `tauri-build` | 2.6.2 | 2.7.4 | 与 tauri 同步 |
| `tauri-plugin-dialog` | 2.7.1 | 2.8.4 | 与前端 plugin 对齐 |
| `tauri-plugin-global-shortcut` | 2.3.2 | 2.4.1 | 与前端 plugin 对齐 |
| `tauri-plugin-single-instance` | 2.4.2 | 2.5.5 | 2.x 同代 |
| `chrono` | 0.4.44 | 0.4.45 | 补丁 |
| `clipboard-win` | 5.4.1 | 5.4.3 | Windows only |
| `encoding_rs` | 0.8.35 | 0.8.44 | 补丁 |
| `futures-util` | 0.3.32 | 0.3.34 | 补丁 |
| `hyper` | 1.10.1 | 1.12.0 | 补丁 |
| `hyper-util` | 0.1.20 | 0.1.21 | 补丁 |
| `rand` | 0.8.6 | 0.8.8 | 保持 0.8 major |
| `rust-embed` | 8.13.0 | **暂不升** | 8.14.0 带入 zstd 0.14.4，见 §4.2 |
| `serde` | 1.0.228 | 1.0.229 | 补丁 |
| `serde_json` | 1.0.150 | 1.0.154 | 补丁 |
| `ssh2` | 0.9.5 | 0.9.7 | 补丁 |
| `tokio-util` | 0.7.18 | 0.7.20 | 补丁 |
| `toml_edit` | 0.25.12 | 0.25.19 | 补丁 |
| `uuid` | 1.23.2 | 1.29.2 | 1.x 同代 |
| `zip` | 9.5.1 | 保持 9.5.1 | P0 已处理 |

执行示例（逐包更新，避免不同 cargo 版本对多 `-p` 参数解析不一致）：

```bash
cd terminal-buddy/src-tauri
for dep in tauri tauri-build tauri-plugin-dialog tauri-plugin-global-shortcut tauri-plugin-single-instance; do
  cargo update -p "$dep"
done
for dep in chrono clipboard-win encoding_rs futures-util hyper hyper-util; do
  cargo update -p "$dep"
done
for dep in rand serde serde_json ssh2 tokio-util toml_edit uuid; do
  cargo update -p "$dep"
done
```

不要因此改为无边界全量更新；每次 `cargo update -p` 后检查 `Cargo.lock` 是否只改变了目标包及其必要传递依赖。

#### 暂缓的 Rust 跨代项

以下不属于本轮默认路径，单独评估：

- `reqwest` 0.12 → 0.13：TLS 默认栈、feature 名称与 error 类型可能变化；需单独验证 Web API、更新检查、Lark 通道。
- `jsonwebtoken` 9 → 11：影响 JWT 编解码、错误类型、Web 登录；需安全回归。
- `bcrypt` 0.17 → 0.19：影响口令校验与登录限流链路。
- `tokio-tungstenite` 0.26 → 0.30：影响 WebSocket 客户端与 Lark / relay 链路。
- `tower-http` 0.6 → 0.7：需检查 CORS / timeout 行为。
- `dirs` 5 → 7：路径解析影响用户数据目录，必须做迁移验证。
- `base64` 0.22 → 0.23、`aes-gcm` 0.10 → 0.11：加密 / 编码 API 变化，需安全测试。
- `webview2-com` 0.38 → 0.39、`windows` 0.61 → 0.62、`windows-registry` 0.6 → 0.100：Windows 原生绑定跨代，必须 Windows 实机验证。
- `tauri-winrt-notification` 0.7.3 → 0.8.1：Windows 通知 API 跨代。
- `portable-pty` 0.9.0：**保持本地 patch**，不升 crates.io。

### 2.3 Android：当前、目标与处置

#### P3 应用库（可先做）

| 依赖 | 当前 | 目标 | 备注 |
| --- | ---: | ---: | --- |
| `androidx.core:core-ktx` | 1.17.0 | 1.19.1 | 先做 |
| `androidx.activity:activity-compose` | 1.11.0 | 1.13.0 | 先做 |
| `androidx.work:work-runtime-ktx` | 2.10.1 | 2.12.0 | 先做 |
| `androidx.lifecycle:*` | 2.9.4 | 2.11.0 | 两个 compose artifact 同步 |
| `kotlinx-coroutines-android` | 1.10.2 | 1.11.0 | 先做 |
| `kotlinx-serialization-json` | 1.9.0 | 1.13.0 | 先做 |
| `multiplatform-markdown-renderer-m3` | 0.38.0 | 0.46.0 | API / 渲染回归后再合 |
| `okhttp` | 4.12.0 | 5.5.1 | 5.x 跨代，暂缓；先保持 4.12.x，若确有 4.x 修复再升补丁 |
| Compose BOM | 2025.10.01 | 2026.09.00 | P4，不与应用库同批 |
| AGP | 8.13.2 | 9.5.1 | P4 |
| Gradle | 8.13 | 9.9.1 | P4 |
| Kotlin | 2.2.21 | 2.4.21 | P4 |

P3 命令：

```bash
cd android
./gradlew :app:compileReleaseKotlin
./gradlew :app:testReleaseUnitTest
./gradlew :app:assembleRelease
```

**P3 通过标准**：

- Kotlin 编译、单元测试、Release 打包通过。
- 至少真机验证登录、会话列表、AI 对话、Markdown、后台通知、更新下载。
- 现有 `lintRelease` 的 4 个错误必须单独记录；P3 不得用 baseline 或关闭规则“掩盖”它们。

#### P4 构建链（最后做，独立大版本）

目标版本仅作为“可评估目标”，不是默认一次性合入：

- AGP 8.13.2 → 9.5.1
- Gradle wrapper 8.13 → 9.9.1
- Kotlin 2.2.21 → 2.4.21（以 AGP 9.5.1 官方兼容矩阵与 Compose 编译器要求为准）
- Compose BOM 2025.10.01（Compose UI 1.9.4 / Material3 1.4.0）→ 2026.09.00（Compose UI 1.12.1 / Material3 1.4.0）
- compileSdk / targetSdk 36 保持不变，除非同步完成 Android SDK 36 / AGP 兼容验证

P4 的硬前置：

1. P3 已合入并稳定。
2. `lintRelease` 的 4 个既有错误已独立修复（见 §5.4）。
3. 有可回滚的 APK / 构建记录与签名校验方案。
4. 允许修改 `gradle-wrapper.jar` / `gradle-wrapper.properties`，但必须校验 wrapper SHA-256。

---

## 3. 分阶段执行顺序与提交拆分

### 3.1 总顺序

| 阶段 | 内容 | 预计改动 | 完成门槛 |
| --- | --- | --- | --- |
| P0-A | 前端安全依赖 | `package.json`、`package-lock.json` | 前端 audit 无直接修复项 |
| P0-B | Rust 锁文件 + rusqlite + zip | `Cargo.toml`、`Cargo.lock` | cargo audit 0、check/test 通过 |
| P1-A | 前端兼容升级 | `package.json`、`package-lock.json` | tsc、两套 build 通过 |
| P1-B | Rust 兼容直接依赖 | `Cargo.toml`、`Cargo.lock` | cargo check/test、三目标构建通过 |
| P2 | xterm 整组 beta | `package.json`、`package-lock.json` | 终端交互回归通过 |
| P3 | Android 应用库 | `android/app/build.gradle.kts` | Android 编译/单测/APK/真机通过 |
| P4 | Android 构建链 | Gradle / AGP / Kotlin / Compose | lint 0 error + APK + 真机通过 |

### 3.2 推荐提交粒度

```text
chore(frontend): 修复 npm 安全漏洞并固定 Monaco 版本
chore(rust): 刷新依赖锁并升级 rusqlite/zip 安全修复

chore(frontend): 升级 React/Tauri 与同版本工具链
chore(rust): 升级 Tauri 2.x 与兼容依赖

chore(xterm): 升级 6.1 beta 终端栈

chore(android): 升级 AndroidX 与序列化依赖
chore(android): 修复 lint 阻断并升级 Gradle/AGP/Kotlin
```

每个提交都应包含“升级前 / 升级后 audit 摘要”和“实际执行过的验证命令”在 PR 描述或提交说明中；不要把多个阶段的锁文件 diff 混在一起。

---

## 4. 高风险边界与禁止事项

### 4.1 `rust-embed` 8.14.0

- 当前锁文件 `rust-embed 8.13.0`，`cargo outdated` 显示 8.14.0 可兼容。
- 但 8.14.0 会通过 `include-flate-compress` 拉入 `zstd 0.14.4`，而 RustSec 对 zstd 有独立漏洞；`cargo audit` 在升级组合中可能重新出现 `zstd` 问题。
- **本轮不升级**。等上游发布不含该 zstd 版本的新补丁，或单独验证后以 `zstd` 补丁版本覆盖再评估。

### 4.2 `zip` 的修复版本选择

- RustSec 对当前 `zip 2.4.2` 报告多项问题，修复要求 `>= 9.0.0`。
- `zip 9.0.0` 仍默认启用 zstd 0.13，且 9.0.0 本身不是当前最新补丁；不要停在 9.0.0。
- 目标：`zip 9.5.1` + `default-features = false` + `deflate-flate2-zlib-rs`，避免引入未使用 codec 和旧 zstd 链。
- 项目没有运行时调用 `ZipArchive::extract`；但仍建议升级，因为未来下载 / 插件解包逻辑可能复用该 API，且安全扫描应保持零漏洞。

### 4.3 `node-pty`

- 当前固定 `1.2.0-beta.13`，`plugins/vscode-terminal/plugin.json` 的 `engine.nodePty` 也是该版本。
- `prepare-vscode-terminal-plugin.mjs` 直接复制 `node_modules/node-pty/prebuilds/<platform>/conpty` 与 `conpty.dll` / `OpenConsole.exe`；升级 beta.18 必须重新生成并校验这些二进制。
- 除非计划包含 Windows 实机 VS Code 终端插件回归，否则**不升级**。xterm 升级与 node-pty 升级不得合并。

### 4.4 本地 patch `portable-pty`

- `Cargo.toml` 有 `[patch.crates-io] portable-pty = { path = "portable-pty-patched" }`。
- 本轮不改 patch 版本、不从 crates.io 更新；只允许随主锁文件刷新其传递依赖（如 `anyhow`、`libc` 等）。
- 若 patch 内部依赖需要升级，单独建立验证任务，至少覆盖 Windows cmd / ConPTY、Unix PTY、resize、drop / 关闭。

### 4.5 xterm beta

- xterm 各 addon 与主包 peer 版本严格对齐；升级必须整组进行。
- `npm outdated` 的 `latest` 字段不是本项目的升级目标；本项目在 6.1 beta 线上。
- 验证重点：Unicode 宽字符、WebGL fallback、搜索、剪贴板、链接、resize、滚动、终端输入法。

### 4.6 不升级项

- `terminal-buddy/web/`：已退役，禁止重新引入构建或类型检查。
- `portable-pty` crates.io 新版。
- `node-pty` 之外的预编译二进制（ConPTY / OpenConsole）不得手工替换。
- 不使用 `npm audit fix --force` 或 `cargo update` 后直接覆盖所有跨 major 依赖。

---

## 5. 校验计划

### 5.1 通用前置检查

在仓库根 `/root/code/terminal-buddy` 执行：

```bash
git status --short --branch
git diff --stat
```

要求：

- 不含与本阶段无关的业务源码改动。
- `docs/` 变动只应包含本计划或对应报告。
- 记录升级前 audit 输出与锁文件 commit hash。

### 5.2 前端校验

在 `terminal-buddy/` 下：

```bash
npx tsc --noEmit
npm run build
npm run build:web:desktop
npm audit
```

如果 `npm audit` 仍有漏洞，要求：

```bash
npm audit --json > /tmp/terminal-buddy-npm-audit-after.json || true
npm ls <存在漏洞的包> --all
```

并在阶段报告中记录：

- 漏洞包名、严重级别、直接/传递路径；
- 是否有 fixAvailable；
- 未修复原因与上游 issue / 版本依据。

### 5.3 Rust 校验

在 `terminal-buddy/src-tauri/` 下：

```bash
cargo check
cargo test --lib
cargo audit
```

若涉及 Tauri 命令变化（本计划默认不改命令）：

```bash
cd ..
python3 scripts/check-invoke-coverage.py
```

> 项目 AGENTS 写的是 `python scripts/check-invoke-coverage.py`；当前环境只有 `python3`，两者等价。CI / 其他机器可按已有约定使用 `python`。

三目标构建验证（按可用环境和已有构建脚本选择）：

```bash
# 桌面默认（Linux / 当前平台）
cargo check

# 独立服务端
cargo check --no-default-features --features server --bin terminal-buddy-server

# Windows 交叉编译（若环境已有 cargo-xwin / SDK）
cargo check --target x86_64-pc-windows-msvc
```

如果 P1 涉及 Tauri 2.x 或 Windows 原生绑定，必须额外执行一次 Windows 产物构建：

```bash
cd /root/code/terminal-buddy
xcj/build-windows-exe.sh
```

要求：

- 产物 `dist/*.exe` 存在，`.sha256` 校验文件与二进制匹配；
- 构建结束后检查 `/mnt/fnos/code/` 或 `dist/` 的归档位置；
- 不把“交叉编译 check 通过”当成“Windows 实机运行通过”。

### 5.4 Android 校验

在仓库根 `android/` 下：

```bash
./gradlew :app:compileReleaseKotlin
./gradlew :app:testReleaseUnitTest
./gradlew :app:lintRelease
./gradlew :app:assembleRelease
```

当前基线（2026-11-13）已观察到：

- `compileReleaseKotlin`：通过；
- `testReleaseUnitTest`：需执行并记录；
- `lintRelease`：4 个既有错误，54 个 warning，1 个 hint；
- `assembleRelease`：需执行并记录。

`lintRelease` 的 4 个既有错误（升级前应独立修复或明确豁免）：

| 文件 | 规则 | 问题 |
| --- | --- | --- |
| `android/app/src/main/java/com/terminalbuddy/android/ui/AiSessionsScreen.kt:75` | `StateFlowValueCalledInComposition` | 在 composition 中读取 `terminalVm.state.value` |
| `android/app/src/main/java/com/terminalbuddy/android/ui/AiSessionsScreen.kt:78` | `StateFlowValueCalledInComposition` | 同上 |
| `android/app/src/main/java/com/terminalbuddy/android/ui/AiSimpleHome.kt:94` | `StateFlowValueCalledInComposition` | 同上 |
| `android/app/src/main/java/com/terminalbuddy/android/ui/TerminalAgentChatScreen.kt:166` | `UnusedBoxWithConstraintsScope` | `BoxWithConstraints` scope 未使用 |

建议单独提交“修复 Android lint 阻断”，不要把它们混入依赖升级。P3 的通过标准可暂时允许这 4 个既有错误（但必须记录），P4 必须先将它们清零。

### 5.5 功能回归清单

#### 桌面端

- 启动、关闭、托盘 / 单实例行为；
- 新建终端、在终端输入 `cmd.exe` 基座、PTY resize；
- 本地 shell / SSH / Docker / K8s / MSTSC；
- 终端 WebGL、fit、搜索、剪贴板、Unicode、web links；
- 文件树、文件编辑器、Markdown 预览、图片预览；
- 设置持久化、主题切换、标签 / 书签、命令模板 / 历史；
- 更新检查、Windows 通知、全局快捷键。

#### 浏览器 / Docker / 手机网页

- `npm run build:web:desktop` 产物可被 Rust `rust-embed` 内嵌；
- 登录、JWT、REST、WebSocket 终端；
- PC / Web 会话隔离与共享开关；
- 文件树 / Git 只读、项目启动、Claude 会话历史；
- 手机浏览器直连 Docker 服务端。

#### Android

- 简版 / 完整版界面切换；
- 登录、服务地址、重连、会话列表；
- AI 对话 / 流式 Markdown / 决策卡片；
- 后台通知、任务同步、更新下载与 APK 安装；
- 真机 Android 26+ 与至少一台现代 Android 版本。

### 5.6 安全与供应链校验

```bash
# 前端
cd terminal-buddy
npm audit --omit=dev
npm audit

# Rust
cd src-tauri
cargo audit
cargo tree -i <可疑包>
```

验收：

- P0 后 `npm audit` / `cargo audit` 不得有新增高危；
- 所有剩余项必须记录“是否直接依赖、是否有修复、是否实际走到该 API”；
- 不把测试命令中的临时审计文件提交进仓库。

---

## 6. 验收标准（Definition of Done）

### 6.1 P0 完成

- [ ] 前端 `dompurify` / `markdown-it` / `vite` 达到目标版本，Monaco 版本显式固定。
- [ ] `npm audit` 无当前可修复的直接漏洞。
- [ ] Rust `cargo audit` 漏洞数为 0。
- [ ] `cargo check`、`cargo test --lib` 通过。
- [ ] 前端 `npx tsc --noEmit`、`npm run build`、`npm run build:web:desktop` 通过。
- [ ] 桌面更新面板的 Markdown changelog 正常渲染，聊天 / 文件预览 Markdown 正常。
- [ ] 记录升级前后锁文件与 audit 摘要。

### 6.2 P1 完成

- [ ] 前端 React / Tauri JS / 同代包升级通过完整构建。
- [ ] Rust Tauri 2.x / 同代依赖升级通过 `cargo check`、`cargo test --lib`。
- [ ] `cargo check --no-default-features --features server --bin terminal-buddy-server` 通过。
- [ ] Windows 交叉编译 / 构建脚本按环境执行，产物校验通过。
- [ ] 无新增 audit 高危。

### 6.3 P2 完成

- [ ] xterm 主包与 4 个 beta addon 同组升级。
- [ ] 终端五类交互（输入、搜索、剪贴板、Unicode、WebGL fallback）通过。
- [ ] `node-pty` 未变；如果变更，必须有独立 ConPTY / 插件验证记录。

### 6.4 P3 / P4 完成

- [ ] Android `compileReleaseKotlin`、`testReleaseUnitTest`、`assembleRelease` 通过。
- [ ] P3 真机回归通过（登录、AI 对话、通知、更新下载）。
- [ ] P4 前 `lintRelease` 既有 4 个错误已清零；P4 后 `lintRelease` 0 error。
- [ ] APK 签名校验通过；版本号 / versionCode 变更符合 `xcj/build-android.sh` 规则。
- [ ] Gradle wrapper SHA-256 校验通过，构建机不再使用旧 Gradle 缓存误判。

---

## 7. 失败处理与回滚

### 7.1 回滚粒度

| 失败点 | 回滚方式 |
| --- | --- |
| 前端 P0 | `git revert <P0 commit>`，恢复上一版 `package.json` + lock |
| Rust P0 | `git revert <Rust P0 commit>`；不要手工编辑 Cargo.lock |
| 前端 P1 | 回滚该阶段 commit；保留 P0 |
| Rust P1 | 回滚该阶段 commit；保留 P0 |
| xterm | 回滚整个 xterm commit；不要只回退主包或单个 addon |
| Android P3 | 回滚 `android/app/build.gradle.kts` 与 lock / build 变更 |
| Android P4 | 回滚 Gradle wrapper + build.gradle.kts；恢复旧 APK 产物 |

### 7.2 升级失败时的处理顺序

1. 保留 `/tmp/*-audit-before.json`、`/tmp/*-audit-after.json` 和构建日志。
2. 用 `git diff` 判断是 manifest、lock、源码还是构建工具问题。
3. 先尝试还原为阶段起点，再单独缩小到单个包复现。
4. 不在失败的升级 commit 上继续堆叠无关修复。
5. 如果 audit 仍有漏洞，记录为“未修复项”，不要用删除检查、baseline、`--force` 或忽略规则掩盖。

---

## 8. 报告模板

执行每个阶段后，在 PR 描述或 `docs/` 的对应报告中填写：

```markdown
### <阶段> 升级报告

- 日期：
- 起点 commit：
- 变更文件：
- 升级前版本 / 漏洞：
- 升级后版本 / 漏洞：
- 执行命令与结果：
  - [ ] npx tsc --noEmit
  - [ ] npm run build
  - [ ] npm run build:web:desktop
  - [ ] cargo check
  - [ ] cargo test --lib
  - [ ] cargo check --no-default-features --features server
  - [ ] npm audit
  - [ ] cargo audit
- 未修复项与原因：
- 回滚点：
- 备注：
```

---

## 9. 附：本次检查的关键命令

以下命令只用于复核，不代表已全部在本次检查中执行；执行时应根据阶段勾选。

```bash
# 前端
cd /root/code/terminal-buddy/terminal-buddy
npm outdated --json
npm audit --json
npm audit fix --dry-run --json
npm ls dompurify markdown-it monaco-editor vite postcss nanoid source-map-js --all

# Rust
cd /root/code/terminal-buddy/terminal-buddy/src-tauri
cargo outdated --root-deps-only
cargo audit
cargo update --dry-run
cargo check
cargo test --lib

# Android
cd /root/code/terminal-buddy/android
./gradlew :app:compileReleaseKotlin
./gradlew :app:testReleaseUnitTest
./gradlew :app:lintRelease
./gradlew :app:assembleRelease
```

---

## 10. 构建脚本同步（2026-11-13）

依赖版本变化会影响 `xcj/` 与 `scripts/` 下的构建 / 更新入口，本轮已完成以下同步：

### 10.1 `xcj/`

| 脚本 | 改动 | 原因 |
| --- | --- | --- |
| `xcj/update.sh` | 用 `package-lock.json` 的 SHA-256 指纹判断是否需要 `npm ci`，指纹写入 `node_modules/.tb-package-lock.sha256` | 旧逻辑只在 `node_modules` 不存在时安装依赖；本轮大量升级后，已有依赖目录会继续使用旧版本，导致“源码已升级、构建仍旧包” |
| `xcj/build-android.sh` | 抽出 `ANDROID_COMPILE_SDK=36`、`ANDROID_BUILD_TOOLS=35.0.0`；SDK 检查、`sdkmanager` 与 `apksigner` 统一使用该配置 | 避免脚本内多处硬编码版本漂移；P4 升级 compileSdk / build-tools 时只需同步变量并复核 AGP |
| `xcj/build-windows-exe.sh` | `DEPLOY_DIR=` 时明确跳过产物移动，并补全 `DEPLOY_DIR` 帮助 | `remote-build.sh` 需要产物留在远端 `dist/` 后再回传；此前空值会被当作路径处理，边界语义不清晰 |
| `xcj/deploy-fnos.sh`、`xcj/deploy-centos.sh` | 恢复可执行位 `100755` | 文档使用 `./xcj/deploy-*.sh`，原 `100644` 会直接 `Permission denied` |

### 10.2 `scripts/`

`scripts/` 仍保留为历史兼容入口，但不再维护第二套构建实现：

| 脚本 | 处理 |
| --- | --- |
| `scripts/build-windows-exe.sh` | 转发到 `xcj/build-windows-exe.sh`；`--clean-cache` 原样转发，`--rebuild` 仅提示 Docker 已退役并正常构建，避免误清全部本机缓存 |
| `scripts/build-android.sh` | 同上，转发到 `xcj/build-android.sh` |
| `scripts/remote-build.sh` | 转发到 `xcj/remote-build.sh`，避免远程链路继续依赖旧 Docker 入口 |
| `scripts/README-remote-build.md` | 改写为构建主机本机工具链说明，删除构建镜像导入 / 命名卷迁移步骤 |
| `scripts/android-build/Dockerfile`、`scripts/windows-build/Dockerfile` | 仅保留历史参考，不参与当前构建；不要据此重新引入 Docker 构建链 |

### 10.3 文档同步

- `README.md`、`README_zh.md`：修正 Windows exe、Android APK 与 fnOS 部署说明。Windows 使用 cargo-xwin 本机交叉编译，Android 使用本机 JDK + SDK，fnOS 默认在开发机 `docker build` 后上传，不再声称“一次性 Docker 容器”或“部署机无需 Docker”。
- `xcj/README-remote-build.md`、`scripts/README-remote-build.md`：明确远端构建复用 `~/.cache/terminal-buddy/xwin`、`~/.android-sdk`、`~/.gradle` 等本机缓存，不再使用 Docker 命名卷。

### 10.4 脚本校验

本轮脚本改动需执行：

```bash
for f in xcj/*.sh scripts/*.sh; do bash -n "$f" || exit 1; done
bash xcj/update.sh --help
bash xcj/build-android.sh --help
bash xcj/build-windows-exe.sh --help
bash scripts/build-android.sh --help
bash scripts/build-windows-exe.sh --help
git diff --check
```

未执行真实远端构建 / 部署命令，避免在依赖升级验证阶段重复传输镜像或改动线上环境；这些命令按 §5.3、§5.4 的构建验收另行执行。本轮实际完成的脚本校验结果：`bash -n` 全部通过，`xcj/update.sh`、`xcj/build-android.sh`、`xcj/build-windows-exe.sh` 及 `scripts/` 兼容入口的 `--help` 均正常返回；`shellcheck -S warning` 对这些脚本无告警，`git diff --check` 通过。

---

## 11. 待确认事项

以下不阻塞 P0/P1，但需要在执行前由负责人拍板：

1. 是否允许修改 `package.json` 增加显式 `monaco-editor` 依赖？（本文建议允许，以避免隐式传递版本漂移。）
2. Android 是否仍在 Play Store 发布？若发行渠道只走自有 APK，`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 的 lint 警告可保留并记录；否则需单独评估策略。
3. P4 是否允许升级 Gradle wrapper 并重新生成 wrapper jar？需要确认构建机上的 JDK 17/21 与 AGP 9.5.1 兼容。
4. xterm 6.1 beta 是否接受继续停留在 beta 线，还是等待 6.1 正式版？本文默认按当前项目既有 beta 线升级，不主动切稳定线。

---

## 12. 变更记录

- 2026-11-13：创建本计划。基于当天 npm / crates.io / RustSec / Google Maven 只读检查与临时副本验证（`cargo check` + `cargo audit`）整理。
- 2026-11-13：同步 `xcj/` 与 `scripts/` 构建入口，修正依赖锁文件变更后的 `npm ci` 判定，并将远端构建文档迁移到本机工具链口径。
