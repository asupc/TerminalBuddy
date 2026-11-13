//! Codex 模型目录（model_catalog_json）自动生成与修复。
//! 目录会整体替换 Codex 内置的模型元数据，为每个条目声明全部推理等级，
//! 可避免 `model_reasoning_effort` 被 Codex 就近降级（如 ultra 被降成 high/medium）。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use toml_edit::{value, DocumentMut, Item};

use super::codex_provider_service::read_optional;
use crate::models::codex_provider::CodexProvider;

/// config.toml 未配置 model_catalog_json 时使用的目录文件名（放在 Codex 配置目录）。
pub const CATALOG_FILENAME: &str = "terminal-buddy-codex-models.json";
/// provider.context_window 为 0（跟随默认）时，新生成条目写入的上下文窗口。
/// Codex 会再按 `effective_context_window_percent` 预留 5%，因此这里写入的是
/// 原始窗口而不是 95% 后的可用窗口；272000 对应 Codex 内置回退模型的 258400 可用窗口。
pub const DEFAULT_MODEL_CONTEXT_WINDOW: u64 = 272_000;
/// 全部推理等级与缺失档位的默认描述（与前端 CODEX_EFFORT_OPTIONS 文案对齐）。
pub const CODEX_CATALOG_REASONING_LEVELS: &[(&str, &str)] = &[
    ("none", "关闭推理，直接回答"),
    ("minimal", "最低推理，几乎不展开思考"),
    ("low", "快速响应，推理较轻"),
    ("medium", "速度与推理深度平衡"),
    ("high", "更强的推理深度，适合复杂问题"),
    ("xhigh", "极高推理深度，适合高难度问题"),
    ("max", "最高推理深度，适合最难的问题"),
    ("ultra", "最高推理并可自动委派任务"),
];

/// 读取 doc 的 `model_catalog_json`（缺失或无效时写入默认文件名），就地合并目录：
/// 所有已有条目补齐全档推理等级，为 provider 配置的模型追加模板条目。
/// 返回 (目录路径, 合并后内容, 内容是否有变化)；目录损坏时返回 Err 且调用方不写任何文件。
pub fn sync_catalog(
    doc: &mut DocumentMut,
    config_dir: &Path,
    provider: &CodexProvider,
) -> Result<(PathBuf, Vec<u8>, bool), String> {
    let setting = doc
        .get("model_catalog_json")
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let filename = match setting {
        // 已配置（含手工维护的目录）原样使用、就地更新；未配置时指向应用管理的默认文件。
        Some(name) => name,
        None => {
            doc["model_catalog_json"] = value(CATALOG_FILENAME);
            CATALOG_FILENAME.to_string()
        }
    };
    let path = resolve_catalog_path(config_dir, &filename);
    let mut catalog = load_catalog(&path)?;
    let changed = merge_models(&mut catalog, provider)?;
    let bytes = serde_json::to_vec_pretty(&catalog)
        .map_err(|_| "编码 Codex 模型目录失败".to_string())?;
    Ok((path, bytes, changed))
}

/// 与 Codex 一致：相对路径按 CODEX_HOME（即 config_dir）解析，绝对路径直接使用。
fn resolve_catalog_path(config_dir: &Path, filename: &str) -> PathBuf {
    let path = PathBuf::from(filename);
    if path.is_absolute() { path } else { config_dir.join(path) }
}

fn load_catalog(path: &Path) -> Result<Value, String> {
    match read_optional(path)? {
        None => Ok(json!({"models": []})),
        // 错误信息不回传文件内容，目录里可能包含用户自定义的提示词。
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            format!(
                "Codex 模型目录 {} 不是有效的 JSON，请修复后重试；原文件未更改",
                path.display()
            )
        }),
    }
}

/// 合并语义：绝不删除已有条目或字段；所有条目补齐 8 档推理等级
/// （已有档位的描述保留）；provider 配置了上下文窗口时同步其模型的窗口上限，
/// 避免旧的 258400 上限继续把 600K 等显式配置截断；目录没有的模型追加模板条目。
fn merge_models(catalog: &mut Value, provider: &CodexProvider) -> Result<bool, String> {
    let invalid = || {
        "Codex 模型目录结构无效（顶层必须是含 models 数组的 JSON 对象），请修复后重试；原文件未更改".to_string()
    };
    let object = catalog.as_object_mut().ok_or_else(invalid)?;
    match object.get("models") {
        Some(Value::Array(_)) => {}
        Some(_) => return Err(invalid()),
        None => {
            object.insert("models".to_string(), Value::Array(Vec::new()));
        }
    }
    let models = object
        .get_mut("models")
        .and_then(Value::as_array_mut)
        .ok_or_else(invalid)?;
    let mut changed = false;
    let mut slugs = Vec::new();
    let provider_models = provider.model_ids();
    for entry in models.iter_mut() {
        let fields = entry.as_object_mut().ok_or_else(invalid)?;
        if let Some(slug) = fields.get("slug").and_then(Value::as_str).map(str::to_string) {
            if provider.context_window > 0 && provider_models.iter().any(|id| id == &slug) {
                changed |= sync_context_window(fields, u64::from(provider.context_window));
            }
            slugs.push(slug);
        }
        changed |= ensure_full_reasoning_levels(fields)?;
    }
    for id in provider_models {
        if slugs.iter().any(|slug| slug == &id) { continue; }
        models.push(template_entry(&id, provider.context_window));
        changed = true;
    }
    Ok(changed)
}

/// 显式配置的窗口必须同时覆盖 `context_window` 与 `max_context_window`。
/// Codex 会用 `min(model_context_window, max_context_window)` 计算最终窗口，
/// 只改 config.toml 而不改目录上限时，界面和实际用量都会继续停在旧上限。
fn sync_context_window(fields: &mut Map<String, Value>, window: u64) -> bool {
    let mut changed = false;
    for key in ["context_window", "max_context_window"] {
        if fields.get(key).and_then(Value::as_u64) != Some(window) {
            fields.insert(key.to_string(), json!(window));
            changed = true;
        }
    }
    changed
}

/// 补齐单条目录条目：缺失档位追加默认描述（已有档位顺序与描述原样保留），
/// 缺失 default_reasoning_level 时补默认值。返回是否有改动。
fn ensure_full_reasoning_levels(fields: &mut Map<String, Value>) -> Result<bool, String> {
    let invalid = || {
        "Codex 模型目录结构无效（supported_reasoning_levels 必须是含 effort 的对象数组），请修复后重试；原文件未更改".to_string()
    };
    let mut levels = match fields.remove("supported_reasoning_levels") {
        Some(Value::Array(items)) => items,
        Some(_) => return Err(invalid()),
        None => Vec::new(),
    };
    let mut seen = Vec::new();
    for item in &levels {
        let Some(effort) = item.get("effort").and_then(Value::as_str) else {
            return Err(invalid());
        };
        seen.push(effort.to_string());
    }
    let mut changed = false;
    for (effort, description) in CODEX_CATALOG_REASONING_LEVELS {
        if seen.iter().any(|value| value == effort) { continue; }
        levels.push(json!({"effort": effort, "description": description}));
        changed = true;
    }
    if !fields.contains_key("default_reasoning_level") {
        fields.insert("default_reasoning_level".to_string(), json!("high"));
        changed = true;
    }
    // 无改动时也原样放回，保留已有档位的顺序与描述。
    fields.insert("supported_reasoning_levels".to_string(), Value::Array(levels));
    Ok(changed)
}

/// 新模型的目录条目模板：字段集与实测可用的手工条目一致，通用 Codex 提示词 +
/// shell_command 编辑方式（原生 Responses 网关不收自由形态 apply_patch）。
fn template_entry(slug: &str, context_window: u32) -> Value {
    let window = if context_window == 0 {
        DEFAULT_MODEL_CONTEXT_WINDOW
    } else {
        u64::from(context_window)
    };
    json!({
        "slug": slug,
        "display_name": slug,
        "description": format!("{}（由 Terminal Buddy 添加）", slug),
        "base_instructions": "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
        "default_reasoning_level": "high",
        "supported_reasoning_levels": CODEX_CATALOG_REASONING_LEVELS.iter()
            .map(|(effort, description)| json!({"effort": effort, "description": description}))
            .collect::<Vec<_>>(),
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 1,
        "supports_reasoning_summaries": true,
        "default_reasoning_summary": "none",
        "support_verbosity": false,
        "truncation_policy": {"mode": "bytes", "limit": 10000},
        "supports_parallel_tool_calls": true,
        "supports_image_detail_original": false,
        "context_window": window,
        "max_context_window": window,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text"],
        "supports_search_tool": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::codex_provider::CODEX_REASONING_EFFORTS;

    #[test]
    fn reasoning_levels_cover_all_efforts_without_duplicates() {
        assert_eq!(CODEX_CATALOG_REASONING_LEVELS.len(), 8);
        let mut seen = std::collections::HashSet::new();
        for (effort, description) in CODEX_CATALOG_REASONING_LEVELS {
            assert!(!description.is_empty(), "{} 缺少描述", effort);
            assert!(seen.insert(*effort), "推理等级重复：{}", effort);
            assert!(
                CODEX_REASONING_EFFORTS.contains(effort),
                "{} 不在 CODEX_REASONING_EFFORTS 内",
                effort
            );
        }
    }

    #[test]
    fn template_keeps_raw_window_before_effective_percent() {
        let entry = template_entry("test-model", 600_000);
        assert_eq!(entry["context_window"].as_u64(), Some(600_000));
        assert_eq!(entry["max_context_window"].as_u64(), Some(600_000));
        // Codex 目录里的 effective 百分比会再折算可用窗口；600K × 95% = 570K。
        assert_eq!(entry["effective_context_window_percent"].as_u64(), Some(95));
    }
}
