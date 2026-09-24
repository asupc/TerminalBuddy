//! Claude 配置浏览与编辑：Memory（~/.claude/projects/<enc>/memory/）与 CLAUDE.md。
//!
//! 项目编码目录 ↔ 真实路径的映射复用一期会话索引（claude_sessions 表：
//! file_path 落在 <projects>/<enc>/ 下、project_dir 是 JSONL 里的真实 cwd）。

use crate::services::{DatabaseService, PathService};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProjectInfo {
    pub dir: String,
    pub label: String,
    pub has_memory: bool,
    pub has_claude_md: bool,
    pub has_dot_claude: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMemoryFile {
    pub name: String,
    pub memory_type: Option<String>,
    pub description: Option<String>,
    pub links: Vec<String>,
    pub size: u64,
}

// ---------------------------------------------------------------------------
// 纯解析逻辑（可测）
// ---------------------------------------------------------------------------

/// 简易 frontmatter 解析：只取 type / description 两个字段（够徽章展示用）
pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut memory_type = None;
    let mut description = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            break;
        }
        let pick = |key: &str| -> Option<String> {
            let rest = trimmed.strip_prefix(key)?.strip_prefix(':')?.trim();
            let unquoted = rest
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .unwrap_or(rest);
            Some(unquoted.trim().to_string()).filter(|value| !value.is_empty())
        };
        if memory_type.is_none() {
            memory_type = pick("type");
        }
        if description.is_none() {
            description = pick("description");
        }
    }
    (memory_type, description)
}

/// 提取 [[wiki 链接]] 目标（不含 [[ ]]）
pub fn extract_wiki_links(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("]]") {
            let target = rest[..end].trim();
            if !target.is_empty() && !links.iter().any(|link| link == target) {
                links.push(target.to_string());
            }
            rest = &rest[end + 2..];
        } else {
            break;
        }
    }
    links
}

/// memory 文件名白名单：字母数字 _ - .，防路径穿越
pub fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && !name.starts_with('.')
        && !name.contains("..")
}

fn trash_dir() -> Result<PathBuf, String> {
    let dir = PathService::require_data_dir()?.join("Trash").join("claude-memory");
    fs::create_dir_all(&dir).map_err(|error| format!("创建回收目录失败: {}", error))?;
    Ok(dir)
}

fn move_to_trash(path: &Path, trash: &Path) -> Result<(), String> {
    let target = trash.join(format!(
        "{}-{}.md",
        path.file_stem().and_then(|value| value.to_str()).unwrap_or("file"),
        chrono::Utc::now().timestamp_millis()
    ));
    fs::rename(path, &target)
        .or_else(|_| fs::copy(path, &target).and_then(|_| fs::remove_file(path)))
        .map_err(|error| format!("移入回收目录失败: {}", error))
}

// ---------------------------------------------------------------------------
// 项目发现
// ---------------------------------------------------------------------------

fn claude_projects_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".claude").join("projects"))
        .ok_or_else(|| "无法获取用户主目录".to_string())
}

/// 项目目录的归一化 SQL 表达式。索引里存的 `project_dir` 是 transcript 上报的 `cwd`
/// 原样，调用方传来的常是前端推算的路径，大小写、分隔符与结尾斜杠都可能不同，
/// 因此两侧都归一后再比（列表只有数百行，表达式比较不走索引也无妨）。
pub(crate) fn normalized_dir_expr(input: &str) -> String {
    format!("rtrim(replace(lower({}), '\\', '/'), '/')", input)
}

/// `normalized_dir_expr` 的内存版，规则必须保持一致。
pub fn dir_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase().trim_end_matches('/').to_string()
}

/// 编码目录名 → 真实项目路径（借会话索引；找不到返回 None）
fn encoded_to_real_dir(conn: &rusqlite::Connection, projects_root: &Path, encoded: &str) -> Option<String> {
    let prefix = format!("{}{}", projects_root.join(encoded).to_string_lossy(), std::path::MAIN_SEPARATOR);
    conn.query_row(
        "SELECT project_dir FROM claude_sessions WHERE file_path LIKE ?1 AND project_dir != '' LIMIT 1",
        [format!("{}%", prefix)],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// 真实项目路径 → memory 目录（借会话索引反查编码目录）
fn memory_dir_of(conn: &rusqlite::Connection, project_dir: &str) -> Option<PathBuf> {
    let file_path: String = conn
        .query_row(
            &format!(
                "SELECT file_path FROM claude_sessions WHERE {indexed} = {wanted} LIMIT 1",
                indexed = normalized_dir_expr("project_dir"),
                wanted = normalized_dir_expr("?1"),
            ),
            [project_dir],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()?;
    // <projects>/<enc>/<id>.jsonl → <projects>/<enc> → memory
    let session_file = PathBuf::from(file_path);
    let encoded_dir = session_file.parent().and_then(Path::parent)?.to_path_buf();
    let memory = encoded_dir.join("memory");
    memory.is_dir().then_some(memory)
}

/// 已知 Claude 项目列表：会话索引 distinct project_dir ∪ 存在 memory 的编码目录
pub fn list_projects() -> Vec<ClaudeProjectInfo> {
    let conn = match DatabaseService::open() {
        Ok(conn) => conn,
        Err(_) => return Vec::new(),
    };
    let projects_root = match claude_projects_root() {
        Ok(root) => root,
        Err(_) => return Vec::new(),
    };

    let mut dirs: Vec<String> = Vec::new();
    if let Ok(mut statement) = conn.prepare(
        "SELECT DISTINCT project_dir FROM claude_sessions WHERE project_dir != ''",
    ) {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                if !dirs.iter().any(|dir| dir.eq_ignore_ascii_case(&row)) {
                    dirs.push(row);
                }
            }
        }
    }
    // 有 memory 但从未建过索引的编码目录（几乎不存在，兜底）
    if let Ok(entries) = fs::read_dir(&projects_root) {
        for entry in entries.flatten() {
            if !entry.path().join("memory").is_dir() {
                continue;
            }
            let encoded = entry.file_name().to_string_lossy().to_string();
            match encoded_to_real_dir(&conn, &projects_root, &encoded) {
                Some(real) => {
                    if !dirs.iter().any(|dir| dir.eq_ignore_ascii_case(&real)) {
                        dirs.push(real);
                    }
                }
                None => dirs.push(projects_root.join(encoded).to_string_lossy().to_string()),
            }
        }
    }

    let mut result: Vec<ClaudeProjectInfo> = Vec::new();
    for dir in dirs {
        let path = PathBuf::from(&dir);
        let has_memory = memory_dir_of(&conn, &dir)
            .or_else(|| {
                // 兜底：路径本身指向编码目录形态（无索引的 memory 项目）
                fs::read_dir(&path).ok().and_then(|entries| {
                    entries
                        .flatten()
                        .find(|entry| entry.file_name() == "memory" && entry.path().is_dir())
                        .map(|_| path.join("memory"))
                })
            })
            .is_some();
        result.push(ClaudeProjectInfo {
            label: path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| dir.clone()),
            has_claude_md: path.join("CLAUDE.md").is_file(),
            has_dot_claude: path.join(".claude").is_dir(),
            has_memory,
            dir,
        });
    }
    result.sort_by(|a, b| {
        b.has_claude_md
            .cmp(&a.has_claude_md)
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    result
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

fn resolve_memory_dir(project_dir: &str) -> Result<PathBuf, String> {
    let conn = DatabaseService::open()?;
    memory_dir_of(&conn, project_dir)
        .ok_or_else(|| "该项目没有 memory 目录（先在 Claude Code 里产生记忆，或等待会话历史索引）".to_string())
}

pub fn list_memory_files(project_dir: &str) -> Result<Vec<ClaudeMemoryFile>, String> {
    let memory_dir = resolve_memory_dir(project_dir)?;
    let entries = fs::read_dir(&memory_dir).map_err(|error| format!("读取 memory 目录失败: {}", error))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let (memory_type, description) = parse_frontmatter(&content);
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        files.push(ClaudeMemoryFile {
            name,
            memory_type,
            description,
            links: extract_wiki_links(&content),
            size,
        });
    }
    files.sort_by(|a, b| {
        let rank = |name: &str| if name == "MEMORY.md" { 0 } else { 1 };
        rank(&a.name).cmp(&rank(&b.name)).then(a.name.cmp(&b.name))
    });
    Ok(files)
}

pub fn read_memory_file(project_dir: &str, name: &str) -> Result<String, String> {
    if !is_safe_name(name) {
        return Err("非法文件名".to_string());
    }
    fs::read_to_string(resolve_memory_dir(project_dir)?.join(name))
        .map_err(|error| format!("读取记忆文件失败: {}", error))
}

pub fn write_memory_file(project_dir: &str, name: &str, content: &str) -> Result<(), String> {
    if !is_safe_name(name) {
        return Err("非法文件名".to_string());
    }
    let path = resolve_memory_dir(project_dir)?.join(name);
    fs::write(&path, content).map_err(|error| format!("写入记忆文件失败: {}", error))
}

/// 新建记忆条目：按项目记忆格式模板带 frontmatter
pub fn create_memory_file(
    project_dir: &str,
    name: &str,
    memory_type: &str,
    description: &str,
) -> Result<String, String> {
    let stem = name.trim().trim_end_matches(".md");
    if stem.is_empty() || !is_safe_name(stem) {
        return Err("名称只能包含字母、数字、下划线、连字符".to_string());
    }
    let file_name = format!("{}.md", stem);
    let path = resolve_memory_dir(project_dir)?.join(&file_name);
    if path.exists() {
        return Err("同名记忆文件已存在".to_string());
    }
    let content = format!(
        "---\nname: {stem}\ndescription: {description}\nmetadata:\n  type: {memory_type}\n---\n\n（在这里写下这条记忆的内容）\n"
    );
    fs::write(&path, content).map_err(|error| format!("创建记忆文件失败: {}", error))?;
    Ok(file_name)
}

pub fn delete_memory_file(project_dir: &str, name: &str) -> Result<(), String> {
    if !is_safe_name(name) {
        return Err("非法文件名".to_string());
    }
    let path = resolve_memory_dir(project_dir)?.join(name);
    if !path.exists() {
        return Ok(());
    }
    move_to_trash(&path, &trash_dir()?)
}

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

fn claude_md_path(kind: &str, project_dir: &str) -> Result<PathBuf, String> {
    match kind {
        "global" => dirs::home_dir()
            .map(|home| home.join(".claude").join("CLAUDE.md"))
            .ok_or_else(|| "无法获取用户主目录".to_string()),
        "project" => {
            if !is_safe_name(project_dir) && !PathBuf::from(project_dir).is_absolute() {
                return Err("非法项目路径".to_string());
            }
            Ok(PathBuf::from(project_dir).join("CLAUDE.md"))
        }
        other => Err(format!("未知作用域: {}", other)),
    }
}

pub fn read_claude_md(kind: &str, project_dir: &str) -> Result<Option<String>, String> {
    let path = claude_md_path(kind, project_dir)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("读取 CLAUDE.md 失败: {}", error))
}

pub fn write_claude_md(kind: &str, project_dir: &str, content: &str) -> Result<(), String> {
    let path = claude_md_path(kind, project_dir)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {}", error))?;
    }
    fs::write(&path, content).map_err(|error| format!("写入 CLAUDE.md 失败: {}", error))
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_parses_type_and_description() {
        let content = "---\nname: x\ndescription: \"一条记忆\"\nmetadata:\n  type: feedback\n---\n\n正文";
        let (memory_type, description) = parse_frontmatter(content);
        assert_eq!(memory_type.as_deref(), Some("feedback"));
        assert_eq!(description.as_deref(), Some("一条记忆"));
    }

    #[test]
    fn frontmatter_missing_or_unterminated() {
        assert_eq!(parse_frontmatter("无 frontmatter"), (None, None));
        assert_eq!(parse_frontmatter("---\ntype: user"), (Some("user".to_string()), None));
    }

    #[test]
    fn wiki_links_extracted_and_deduped() {
        let content = "见 [[alpha]] 与 [[beta]]，再见 [[alpha]]，空 [[]] 不算";
        assert_eq!(extract_wiki_links(content), vec!["alpha", "beta"]);
    }

    #[test]
    fn safe_name_rejects_traversal() {
        assert!(is_safe_name("paste-newline-must-be-cr.md"));
        assert!(!is_safe_name("../evil.md"));
        assert!(!is_safe_name("a/b.md"));
        assert!(!is_safe_name(""));
        assert!(!is_safe_name(".hidden"));
    }
}
