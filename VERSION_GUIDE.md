# 版本管理指南

本文档说明如何管理 TerminalBuddy 的版本号。

---

## 📍 版本号位置

TerminalBuddy 的版本号需要在以下三个位置保持同步：

### 1. 前端版本配置
**文件**: `src/version.ts`

```typescript
export const APP_VERSION = '1.0.0';
```

这是前端代码中使用的版本号，用于：
- 标题栏版本显示
- 关于对话框版本信息

### 2. npm 包配置
**文件**: `package.json`

```json
{
  "name": "terminal-buddy",
  "version": "1.0.0",
  ...
}
```

这是 Node.js/npm 的版本标识。

### 3. Tauri 应用配置
**文件**: `src-tauri/tauri.conf.json`

```json
{
  "version": "1.0.0"
}
```

**注意**: 这个字段通常需要手动添加或更新。

### 4. Rust 后端配置
**文件**: `src-tauri/Cargo.toml`

```toml
[package]
name = "terminal-buddy"
version = "1.0.0"
```

---

## 🔄 版本更新步骤

当准备发布新版本时，请按以下步骤操作：

### 步骤 1: 确定版本号

遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范：
- **Major (主版本)**: 不兼容的 API 修改 (例如: 1.0.0 → 2.0.0)
- **Minor (次版本)**: 向下兼容的功能性新增 (例如: 1.0.0 → 1.1.0)
- **Patch (修订号)**: 向下兼容的问题修正 (例如: 1.0.0 → 1.0.1)

### 步骤 2: 更新所有版本文件

```bash
# 假设新版本号为 1.1.0

# 1. 更新前端版本配置
# 编辑 src/version.ts
export const APP_VERSION = '1.1.0';

# 2. 更新 package.json
npm version 1.1.0 --no-git-tag-version

# 3. 更新 Cargo.toml
# 编辑 src-tauri/Cargo.toml
version = "1.1.0"

# 4. 更新 tauri.conf.json（如果存在 version 字段）
# 编辑 src-tauri/tauri.conf.json
```

### 步骤 3: 更新更新日志

编辑 `CHANGELOG.md`，添加新版本的更新说明：

```markdown
## [1.1.0] - 2026-XX-XX

### ✨ 新增功能
- 功能描述 1
- 功能描述 2

### 🐛 问题修复
- 修复描述 1

### ⚡ 性能优化
- 优化描述 1
```

### 步骤 4: 提交更改

```bash
git add .
git commit -m "chore: bump version to 1.1.0"
```

### 步骤 5: 创建 Git 标签

```bash
git tag v1.1.0
```

### 步骤 6: 构建发布版本

```bash
npm run tauri build
```

构建完成后，在 `src-tauri/target/release/bundle/` 目录下会生成安装包。

---

## 🚀 自动化版本更新（可选）

可以使用以下脚本自动更新所有版本文件：

### 创建版本更新脚本

**文件**: `scripts/bump-version.js`

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const newVersion = process.argv[2];

if (!newVersion) {
  console.error('请提供新版本号: node scripts/bump-version.js 1.1.0');
  process.exit(1);
}

// 验证版本号格式
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('版本号格式无效，应为: x.y.z (例如: 1.1.0)');
  process.exit(1);
}

const files = [
  {
    path: 'src/version.ts',
    pattern: /export const APP_VERSION = '.*?';/,
    replacement: `export const APP_VERSION = '${newVersion}';`
  },
  {
    path: 'package.json',
    pattern: /"version": ".*?"/,
    replacement: `"version": "${newVersion}"`
  },
  {
    path: 'src-tauri/Cargo.toml',
    pattern: /^version = ".*?"/m,
    replacement: `version = "${newVersion}"`
  }
];

files.forEach(({ path: filePath, pattern, replacement }) => {
  const fullPath = path.resolve(__dirname, '..', filePath);

  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠️  文件不存在: ${filePath}`);
    return;
  }

  let content = fs.readFileSync(fullPath, 'utf8');

  if (!pattern.test(content)) {
    console.warn(`⚠️  未找到版本号模式: ${filePath}`);
    return;
  }

  content = content.replace(pattern, replacement);
  fs.writeFileSync(fullPath, content, 'utf8');

  console.log(`✅ 已更新: ${filePath}`);
});

console.log(`\n🎉 版本已更新为 ${newVersion}`);
console.log('\n下一步操作:');
console.log('1. 更新 CHANGELOG.md');
console.log('2. 提交更改: git add . && git commit -m "chore: bump version to ' + newVersion + '"');
console.log('3. 创建标签: git tag v' + newVersion);
console.log('4. 构建: npm run tauri build');
```

### 使用脚本

```bash
# 添加执行权限（Linux/Mac）
chmod +x scripts/bump-version.js

# 更新版本
node scripts/bump-version.js 1.1.0
```

---

## 📦 版本信息验证

构建完成后，可以验证版本信息：

### 1. 检查前端版本
打开应用，查看标题栏或关于对话框中的版本号。

### 2. 检查安装包版本
```bash
# Windows: 右键查看安装包属性
# 或使用 PowerShell
(Get-Item "TerminalBuddy_1.0.0_x64-setup.exe").VersionInfo.ProductVersion
```

### 3. 检查 Tauri 应用信息
```bash
# 构建后检查 tauri.conf.json
cat src-tauri/tauri.conf.json | grep version
```

---

## 🐛 常见问题

### Q: 版本号不一致会有什么问题？
A: 可能导致：
- 前端显示的版本号与实际安装包版本不符
- 自动更新检查失败
- 用户混淆版本信息

### Q: 什么时候应该更新版本号？
A:
- 准备发布新版本时
- 添加新功能时（Minor 或 Major）
- 修复 bug 时（Patch）
- 重大重构或不兼容修改时（Major）

### Q: 开发阶段应该使用什么版本号？
A: 可以使用预发布版本号，例如：
- `1.1.0-beta.1`
- `1.1.0-rc.1`
- `1.1.0-dev`

### Q: 如何回滚版本？
A:
```bash
# 删除标签
git tag -d v1.1.0

# 重置版本文件
git checkout HEAD -- src/version.ts package.json src-tauri/Cargo.toml

# 重新提交
git commit -m "chore: revert version to 1.0.0"
```

---

## 📚 相关文档

- [语义化版本规范](https://semver.org/lang/zh-CN/)
- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)
- [Tauri 发布指南](https://tauri.app/distribute/publishing/)
- [npm 版本管理](https://docs.npmjs.com/cli/v9/commands/npm-version)

---

## ✅ 版本检查清单

在发布新版本前，请确认：

- [ ] 所有版本文件已同步更新
  - [ ] `src/version.ts`
  - [ ] `package.json`
  - [ ] `src-tauri/Cargo.toml`
  - [ ] `src-tauri/tauri.conf.json`（如有）

- [ ] `CHANGELOG.md` 已更新

- [ ] 代码已通过测试
  ```bash
  npm run build
  cd src-tauri && cargo check
  ```

- [ ] 所有更改已提交
  ```bash
  git status  # 确认无未提交更改
  ```

- [ ] 版本标签已创建
  ```bash
  git tag v1.x.x
  ```

- [ ] 发布包已构建
  ```bash
  npm run tauri build
  ```

- [ ] 安装包已验证
  - [ ] 安装测试
  - [ ] 版本号显示正确
  - [ ] 功能正常

---

## 🤝 贡献指南

如果您要提交 PR，请确保：
1. 不要随意修改版本号
2. 版本号更新由维护者在发布时统一处理
3. 在 PR 描述中说明是否需要版本更新及建议的版本号类型

---

## 📞 联系方式

如有版本管理相关问题，请：
- 提交 Issue: https://gitee.com/updateme/terminal-buddy/issues
- 查看文档: https://gitee.com/updateme/terminal-buddy/blob/master/README.md
