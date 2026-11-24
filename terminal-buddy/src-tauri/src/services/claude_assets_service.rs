//! Claude 资产库（skills / agents / commands）：库 + 部署模型。
//!
//! 库 = `<dataPath>/ClaudeAssets/{skills,agents,commands}/`，唯一编辑处；
//! 启用 = 复制到 `~/.claude/<kind>/`（用户级）或 `<proj>/.claude/<kind>/`（项目级）；
//! 停用 = 目标移入回收目录；漂移 = 部署副本 hash ≠ 库（可覆盖部署 / 回库同步）。

use crate::services::claude_config_service::{is_safe_name, parse_frontmatter};
use crate::services::PathService;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Skills,
    Agents,
    Commands,
}

impl AssetKind {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "skills" => Some(Self::Skills),
            "agents" => Some(Self::Agents),
            "commands" => Some(Self::Commands),
            _ => None,
        }
    }

    pub fn dir_name(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Agents => "agents",
            Self::Commands => "commands",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Skills => "技能",
            Self::Agents => "子代理",
            Self::Commands => "命令",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDeployment {
    /// "user" | "project"
    pub scope: String,
    pub project_dir: Option<String>,
    pub drifted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub kind: String,
    pub kind_label: String,
    pub name: String,
    pub description: Option<String>,
    pub deployments: Vec<AssetDeployment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportableAsset {
    pub kind: String,
    pub kind_label: String,
    pub name: String,
    pub description: Option<String>,
}

// ---------------------------------------------------------------------------
// 路径与内容辅助
// ---------------------------------------------------------------------------

fn library_root() -> Result<PathBuf, String> {
    Ok(PathService::require_data_dir()?.join("ClaudeAssets"))
}

fn user_claude_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".claude"))
        .ok_or_else(|| "无法获取用户主目录".to_string())
}

/// 资产在某基目录下的路径：skills=目录，agents/commands=单个 .md 文件
fn asset_path_at(base: &Path, kind: AssetKind, name: &str) -> PathBuf {
    match kind {
        AssetKind::Skills => base.join(kind.dir_name()).join(name),
        _ => base.join(kind.dir_name()).join(format!("{}.md", name)),
    }
}

fn target_root(scope: &str, project_dir: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "user" => user_claude_root(),
        "project" => {
            let dir = project_dir.ok_or("项目级操作缺少项目路径")?;
            if !PathBuf::from(dir).is_absolute() {
                return Err("非法项目路径".to_string());
            }
            Ok(PathBuf::from(dir).join(".claude"))
        }
        other => Err(format!("未知作用域: {}", other)),
    }
}

/// 内容 hash（漂移检测用，非密码学）：目录按排序后的相对路径+内容聚合
fn hash_path(path: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    fn hash_walk(hasher: &mut DefaultHasher, base: &Path, current: &Path) {
        let Ok(meta) = fs::symlink_metadata(current) else {
            return;
        };
        if meta.file_type().is_symlink() {
            return;
        }
        if meta.is_file() {
            current
                .strip_prefix(base)
                .map(|rel| rel.to_string_lossy().hash(hasher))
                .ok();
            if let Ok(content) = fs::read(current) {
                content.hash(hasher);
            }
        } else if meta.is_dir() {
            if let Ok(entries) = fs::read_dir(current) {
                let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
                children.sort();
                for child in children {
                    hash_walk(hasher, base, &child);
                }
            }
        }
    }
    hash_walk(&mut hasher, path, path);
    hasher.finish()
}

fn main_file_of(path: &Path, kind: AssetKind) -> PathBuf {
    match kind {
        AssetKind::Skills => path.join("SKILL.md"),
        _ => path.to_path_buf(),
    }
}

fn read_description(path: &Path, kind: AssetKind) -> Option<String> {
    let content = fs::read_to_string(main_file_of(path, kind)).ok()?;
    let (_, description) = parse_frontmatter(&content);
    description
}

fn validate_name(name: &str) -> Result<(), String> {
    let stem = name.trim().trim_end_matches(".md");
    if !is_safe_name(stem) {
        return Err("名称只能包含字母、数字、下划线、连字符".to_string());
    }
    Ok(())
}

fn trash_dir() -> Result<PathBuf, String> {
    let dir = PathService::require_data_dir()?
        .join("Trash")
        .join("claude-assets");
    fs::create_dir_all(&dir).map_err(|error| format!("创建回收目录失败: {}", error))?;
    Ok(dir)
}

fn move_to_trash(path: &Path, trash: &Path, prefix: &str) -> Result<(), String> {
    let target = trash.join(format!(
        "{}-{}",
        prefix,
        chrono::Utc::now().timestamp_millis()
    ));
    fs::rename(path, &target)
        .or_else(|_| {
            if path.is_dir() {
                crate::services::copy_dir_recursive(&path.to_path_buf(), &target)
                    .map_err(|error| std::io::Error::other(error))
                    .and_then(|_| fs::remove_dir_all(path))
            } else {
                fs::copy(path, &target)
                    .map(|_| ())
                    .and_then(|_| fs::remove_file(path))
            }
        })
        .map_err(|error| format!("移入回收目录失败: {}", error))
}

fn copy_asset(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        crate::services::copy_dir_recursive(&src.to_path_buf(), &dst.to_path_buf())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {}", error))?;
        }
        fs::copy(src, dst)
            .map(|_| ())
            .map_err(|error| format!("复制文件失败: {}", error))
    }
}

fn remove_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("移除目录失败: {}", error))
    } else if path.exists() {
        fs::remove_file(path).map_err(|error| format!("移除文件失败: {}", error))
    } else {
        Ok(())
    }
}

fn normalize_name(kind: AssetKind, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let stem = name.trim().trim_end_matches(".md").to_string();
    match kind {
        AssetKind::Skills if stem == "SKILL" => Err("技能名称不能是 SKILL".to_string()),
        _ => Ok(stem),
    }
}

// ---------------------------------------------------------------------------
// 库列表（含部署状态）
// ---------------------------------------------------------------------------

/// 扫描库并计算部署状态（路径可注入，测试用）
fn scan_library(
    lib_root: &Path,
    user_root: &Path,
    projects: &[String],
) -> Vec<AssetEntry> {
    let mut result = Vec::new();
    for kind in [AssetKind::Skills, AssetKind::Agents, AssetKind::Commands] {
        let kind_dir = lib_root.join(kind.dir_name());
        let Ok(entries) = fs::read_dir(&kind_dir) else {
            continue;
        };
        let mut names: Vec<(String, PathBuf)> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| match kind {
                AssetKind::Skills => path.is_dir(),
                _ => path.extension().and_then(|value| value.to_str()) == Some("md"),
            })
            .filter_map(|path| {
                let raw = match kind {
                    AssetKind::Skills => path.file_name()?.to_string_lossy().to_string(),
                    _ => path.file_stem()?.to_string_lossy().to_string(),
                };
                is_safe_name(&raw).then(|| (raw, path))
            })
            .collect();
        names.sort();
        for (name, lib_path) in names {
            let lib_hash = hash_path(&lib_path);
            let mut deployments = Vec::new();
            // 用户级
            let user_target = asset_path_at(user_root, kind, &name);
            if user_target.exists() {
                deployments.push(AssetDeployment {
                    scope: "user".to_string(),
                    project_dir: None,
                    drifted: hash_path(&user_target) != lib_hash,
                });
            }
            // 项目级
            for project in projects {
                let target = asset_path_at(&PathBuf::from(project).join(".claude"), kind, &name);
                if target.exists() {
                    deployments.push(AssetDeployment {
                        scope: "project".to_string(),
                        project_dir: Some(project.clone()),
                        drifted: hash_path(&target) != lib_hash,
                    });
                }
            }
            result.push(AssetEntry {
                kind: kind.dir_name().to_string(),
                kind_label: kind.label().to_string(),
                name,
                description: read_description(&lib_path, kind),
                deployments,
            });
        }
    }
    result
}

/// 列出资产库及其部署状态。`project_dir` 为 Some 时只探测该项目下的部署
/// （用户级部署始终显示，它不属于任何项目）。
pub fn list_assets(project_dir: Option<&str>) -> Result<Vec<AssetEntry>, String> {
    let lib_root = library_root()?;
    let user_root = user_claude_root()?;
    let mut projects: Vec<String> = crate::services::claude_config_service::list_projects()
        .into_iter()
        .map(|project| project.dir)
        .collect();
    if let Some(target) = project_dir {
        use crate::services::claude_config_service::dir_key;
        let key = dir_key(target);
        projects.retain(|project| dir_key(project) == key);
    }
    fs::create_dir_all(&lib_root).map_err(|error| format!("创建资产库目录失败: {}", error))?;
    Ok(scan_library(&lib_root, &user_root, &projects))
}

// ---------------------------------------------------------------------------
// 部署 / 停用 / 同步 / 导入 / 增删改
// ---------------------------------------------------------------------------

fn resolve_library_path(kind: AssetKind, name: &str) -> Result<(String, PathBuf), String> {
    let name = normalize_name(kind, name)?;
    let path = asset_path_at(&library_root()?, kind, &name);
    if !path.exists() {
        return Err("资产库里没有这一项（可能已被删除，请刷新列表）".to_string());
    }
    Ok((name, path))
}

/// 启用（部署）：库 → 目标（目标已存在则覆盖）
pub fn deploy(kind: AssetKind, name: &str, scope: &str, project_dir: Option<&str>) -> Result<(), String> {
    let (name, lib_path) = resolve_library_path(kind, name)?;
    let target = asset_path_at(&target_root(scope, project_dir)?, kind, &name);
    remove_path(&target)?;
    copy_asset(&lib_path, &target)
}

/// 停用（取消部署）：目标 → 回收目录
pub fn undeploy(kind: AssetKind, name: &str, scope: &str, project_dir: Option<&str>) -> Result<(), String> {
    let name = normalize_name(kind, name)?;
    let target = asset_path_at(&target_root(scope, project_dir)?, kind, &name);
    if !target.exists() {
        return Err("该作用域下没有部署这一项".to_string());
    }
    move_to_trash(&target, &trash_dir()?, &format!("{}-{}", kind.dir_name(), name))
}

/// 同步漂移：overwrite=库→目标（等价覆盖部署）；pull_back=目标→库
pub fn sync(
    kind: AssetKind,
    name: &str,
    direction: &str,
    scope: &str,
    project_dir: Option<&str>,
) -> Result<(), String> {
    let (name, lib_path) = resolve_library_path(kind, name)?;
    let target = asset_path_at(&target_root(scope, project_dir)?, kind, &name);
    if !target.exists() {
        return Err("目标处没有部署，无法同步".to_string());
    }
    match direction {
        "overwrite" => {
            remove_path(&target)?;
            copy_asset(&lib_path, &target)
        }
        "pull_back" => {
            remove_path(&lib_path)?;
            copy_asset(&target, &lib_path)
        }
        other => Err(format!("未知同步方向: {}", other)),
    }
}

/// 收编导入：目标 → 库（库里已存在同名则报错）
pub fn import_asset(kind: AssetKind, scope: &str, project_dir: Option<&str>, name: &str) -> Result<(), String> {
    let name = normalize_name(kind, name)?;
    let source = asset_path_at(&target_root(scope, project_dir)?, kind, &name);
    if !source.exists() {
        return Err("来源处没有这一项".to_string());
    }
    let lib_path = asset_path_at(&library_root()?, kind, &name);
    if lib_path.exists() {
        return Err("资产库里已存在同名项".to_string());
    }
    copy_asset(&source, &lib_path)
}

/// 列出某来源处可收编（库里还没有）的资产
pub fn list_importable(scope: &str, project_dir: Option<&str>) -> Result<Vec<ImportableAsset>, String> {
    let root = target_root(scope, project_dir)?;
    let lib_root = library_root()?;
    let mut result = Vec::new();
    for kind in [AssetKind::Skills, AssetKind::Agents, AssetKind::Commands] {
        let kind_dir = root.join(kind.dir_name());
        let Ok(entries) = fs::read_dir(&kind_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let valid = match kind {
                AssetKind::Skills => path.is_dir(),
                _ => path.extension().and_then(|value| value.to_str()) == Some("md"),
            };
            if !valid {
                continue;
            }
            let raw = match kind {
                AssetKind::Skills => entry.file_name().to_string_lossy().to_string(),
                _ => path.file_stem().unwrap_or_default().to_string_lossy().to_string(),
            };
            if !is_safe_name(&raw) || asset_path_at(&lib_root, kind, &raw).exists() {
                continue;
            }
            result.push(ImportableAsset {
                kind: kind.dir_name().to_string(),
                kind_label: kind.label().to_string(),
                name: raw,
                description: read_description(&path, kind),
            });
        }
    }
    Ok(result)
}

pub fn delete_library_asset(kind: AssetKind, name: &str) -> Result<(), String> {
    let (_, lib_path) = resolve_library_path(kind, name)?;
    move_to_trash(&lib_path, &trash_dir()?, kind.dir_name())
}

/// 新建库项（模板）
pub fn create_asset(kind: AssetKind, name: &str, description: &str) -> Result<String, String> {
    let name = normalize_name(kind, name)?;
    if description.trim().is_empty() {
        return Err("描述不能为空（frontmatter 的 description 用于触发匹配）".to_string());
    }
    let lib_root = library_root()?;
    let path = asset_path_at(&lib_root, kind, &name);
    if path.exists() {
        return Err("库里已存在同名项".to_string());
    }
    let content = match kind {
        AssetKind::Skills => {
            fs::create_dir_all(&path).map_err(|error| format!("创建目录失败: {}", error))?;
            format!(
                "---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\n（在这里编写技能指令）\n"
            )
        }
        _ => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {}", error))?;
            }
            match kind {
                AssetKind::Agents => format!(
                    "---\nname: {name}\ndescription: {description}\ntools: *\nmodel: sonnet\n---\n\n（在这里编写子代理系统提示）\n"
                ),
                _ => format!("---\ndescription: {description}\n---\n\n（在这里编写命令内容，可用 $ARGUMENTS 占位）\n"),
            }
        }
    };
    crate::services::atomic_file::atomic_write(&main_file_of(&path, kind), content.as_bytes())
        .map_err(|error| format!("创建资产失败: {}", error))?;
    Ok(name)
}

pub fn read_asset(kind: AssetKind, name: &str) -> Result<String, String> {
    let (_, lib_path) = resolve_library_path(kind, name)?;
    fs::read_to_string(main_file_of(&lib_path, kind)).map_err(|error| format!("读取资产失败: {}", error))
}

pub fn write_asset(kind: AssetKind, name: &str, content: &str) -> Result<(), String> {
    let (_, lib_path) = resolve_library_path(kind, name)?;
    crate::services::atomic_file::atomic_write(&main_file_of(&lib_path, kind), content.as_bytes())
        .map_err(|error| format!("写入资产失败: {}", error))
}

// ---------------------------------------------------------------------------
// 单元测试（临时目录注入）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tb-assets-{}-{}", tag, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_skill(base: &Path, name: &str, body: &str) -> PathBuf {
        let dir = asset_path_at(base, AssetKind::Skills, name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: 测试技能 {name}\n---\n\n{body}"),
        )
        .unwrap();
        dir
    }

    #[test]
    fn scan_reports_deployments_and_drift() {
        let lib = temp_root("lib");
        let user = temp_root("user");
        make_skill(&lib, "alpha", "v1");
        // 未部署：只有库
        let entries = scan_library(&lib, &user, &[]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "alpha");
        assert!(entries[0].deployments.is_empty());
        assert_eq!(entries[0].description.as_deref(), Some("测试技能 alpha"));

        // 部署到用户级（内容一致 → 未漂移）
        let target = asset_path_at(&user, AssetKind::Skills, "alpha");
        copy_asset(&asset_path_at(&lib, AssetKind::Skills, "alpha"), &target).unwrap();
        let entries = scan_library(&lib, &user, &[]);
        assert_eq!(entries[0].deployments.len(), 1);
        assert_eq!(entries[0].deployments[0].scope, "user");
        assert!(!entries[0].deployments[0].drifted);

        // 直接改部署副本 → 漂移
        fs::write(target.join("SKILL.md"), "被直接改过").unwrap();
        let entries = scan_library(&lib, &user, &[]);
        assert!(entries[0].deployments[0].drifted);

        let _ = fs::remove_dir_all(&lib);
        let _ = fs::remove_dir_all(&user);
    }

    #[test]
    fn agents_are_single_md_files() {
        let lib = temp_root("lib2");
        let user = temp_root("user2");
        let path = asset_path_at(&lib, AssetKind::Agents, "reviewer");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "---\nname: reviewer\ndescription: 审查代理\n---\n\n提示词").unwrap();

        let target = asset_path_at(&user, AssetKind::Agents, "reviewer");
        copy_asset(&path, &target).unwrap();
        let entries = scan_library(&lib, &user, &[]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "agents");
        assert_eq!(entries[0].deployments.len(), 1);
        assert!(!entries[0].deployments[0].drifted);

        let _ = fs::remove_dir_all(&lib);
        let _ = fs::remove_dir_all(&user);
    }

    #[test]
    fn hash_changes_with_content() {
        let lib = temp_root("hash");
        let dir = make_skill(&lib, "h", "body-a");
        let h1 = hash_path(&dir);
        fs::write(dir.join("SKILL.md"), "---\ndescription: d\n---\n\nbody-b").unwrap();
        assert_ne!(hash_path(&dir), h1);
        let _ = fs::remove_dir_all(&lib);
    }
}
