//! ACP（Agent Client Protocol）v1 stdio JSON-RPC 2.0 协议适配层。
//!
//! 负责构造 ACP 请求、解析 `session/update` 通知与 `session/request_permission` 审批请求，
//! 将其统一投影回 `AiSession`（正文、思考流、任务清单、工具记录、斜杠命令、动态配置与用量），
//! 让桌面端、Web 端与 Android 端无需感知底层私有协议差异即可消费任意 ACP Agent（如 `agy acp`）。
use crate::models::ai_chat::{
    AiApproval, AiConfigOption, AiConfigOptionChoice, AiImage, AiTodo, AnswerAiApproval, SlashCatalog,
};
use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

pub(super) const ACP_PERMISSION_METHOD: &str = "acp/requestPermission";

pub(super) fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientInfo": {
                "name": "terminal_buddy_native",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "clientCapabilities": {},
        }
    })
}

pub(super) fn session_new_request(id: u64, cwd: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/new",
        "params": {
            "cwd": cwd,
            "mcpServers": [],
        }
    })
}

pub(super) fn session_load_request(id: u64, session_id: &str, cwd: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/load",
        "params": {
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": [],
        }
    })
}

pub(super) fn session_cancel_notification(session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": {
            "sessionId": session_id,
        }
    })
}

pub(super) fn session_set_config_option_request(
    id: u64,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/set_config_option",
        "params": {
            "sessionId": session_id,
            "configId": config_id,
            "value": value,
        }
    })
}

pub(super) fn session_prompt_request(
    id: u64,
    session_id: &str,
    text: &str,
    images: &[AiImage],
) -> Result<Value> {
    let mut prompt = Vec::new();
    let engine = base64::engine::general_purpose::STANDARD;
    for image in images {
        let bytes = fs::read(&image.path)
            .map_err(|error| format!("读取聊天图片失败（{}）：{error}", image.name))?;
        prompt.push(json!({
            "type": "image",
            "data": engine.encode(bytes),
            "mimeType": image.media_type,
        }));
    }
    if !text.is_empty() || prompt.is_empty() {
        prompt.push(json!({
            "type": "text",
            "text": text,
        }));
    }
    Ok(json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": prompt,
        }
    }))
}

pub(super) fn method_not_found_response(rpc_id: Value, method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "error": {
            "code": -32601,
            "message": format!("Unsupported client method: {method}"),
        }
    })
}

pub(super) fn supports_load_session(init_result: &Value) -> bool {
    init_result
        .pointer("/agentCapabilities/loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || init_result
            .pointer("/capabilities/session")
            .is_some_and(|v| !v.is_null())
}

#[derive(Clone, Debug)]
struct AcpPermissionOption {
    option_id: String,
    name: String,
    kind: String,
}

pub(super) struct AcpPermissionRequest {
    pub approval: AiApproval,
    rpc_id: Value,
    options: Vec<AcpPermissionOption>,
}

impl AcpPermissionRequest {
    pub fn from_request(rpc_id: Value, params: &Value) -> Option<Self> {
        let options: Vec<AcpPermissionOption> = params["options"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let option_id = item["optionId"].as_str()?.trim();
                        if option_id.is_empty() {
                            return None;
                        }
                        let name = item["name"]
                            .as_str()
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or(option_id)
                            .to_string();
                        let kind = item["kind"].as_str().unwrap_or_default().to_string();
                        Some(AcpPermissionOption {
                            option_id: option_id.to_string(),
                            name,
                            kind,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let tool_call = &params["toolCall"];
        let title = tool_call["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| tool_call["kind"].as_str().filter(|s| !s.trim().is_empty()))
            .unwrap_or("工具执行确认")
            .to_string();
        let tool_name = tool_call["kind"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&title)
            .to_string();
        let command = tool_call
            .pointer("/rawInput/command")
            .and_then(Value::as_str)
            .or_else(|| tool_call.pointer("/rawInput/cmd").and_then(Value::as_str))
            .map(str::to_string);

        let details = json!({
            "toolName": tool_name,
            "title": title,
            "command": command,
            "input": tool_call.get("rawInput").cloned().unwrap_or(Value::Null),
            "options": options.iter().map(|opt| json!({
                "optionId": opt.option_id,
                "name": opt.name,
                "kind": opt.kind,
            })).collect::<Vec<_>>(),
        });

        Some(Self {
            approval: AiApproval {
                id: Uuid::new_v4().to_string(),
                method: ACP_PERMISSION_METHOD.into(),
                details,
            },
            rpc_id,
            options,
        })
    }

    pub fn auto_allow_response(&self) -> Value {
        let chosen = self
            .options
            .iter()
            .find(|opt| opt.kind == "allow_once")
            .or_else(|| self.options.iter().find(|opt| opt.kind == "allow_always"))
            .or_else(|| self.options.iter().find(|opt| opt.kind.starts_with("allow")))
            .or_else(|| self.options.first());
        match chosen {
            Some(opt) => json!({
                "jsonrpc": "2.0",
                "id": self.rpc_id,
                "result": {
                    "outcome": {
                        "outcome": "selected",
                        "optionId": opt.option_id,
                    }
                }
            }),
            None => json!({
                "jsonrpc": "2.0",
                "id": self.rpc_id,
                "result": {
                    "outcome": { "outcome": "cancelled" }
                }
            }),
        }
    }

    pub fn response(&self, answer: &AnswerAiApproval) -> Value {
        if answer.decision == "accept" {
            // 客户端若显式指定了 optionId（例如多选项按钮），优先命中该 optionId。
            let explicit = answer
                .answers
                .get("optionId")
                .and_then(Value::as_str)
                .and_then(|id| self.options.iter().find(|opt| opt.option_id == id));
            let chosen = explicit
                .or_else(|| self.options.iter().find(|opt| opt.kind == "allow_once"))
                .or_else(|| self.options.iter().find(|opt| opt.kind == "allow_always"))
                .or_else(|| self.options.iter().find(|opt| opt.kind.starts_with("allow")))
                .or_else(|| self.options.first());
            if let Some(opt) = chosen {
                return json!({
                    "jsonrpc": "2.0",
                    "id": self.rpc_id,
                    "result": {
                        "outcome": {
                            "outcome": "selected",
                            "optionId": opt.option_id,
                        }
                    }
                });
            }
        } else if let Some(reject) = self
            .options
            .iter()
            .find(|opt| opt.kind == "reject_once")
            .or_else(|| self.options.iter().find(|opt| opt.kind.starts_with("reject")))
        {
            return json!({
                "jsonrpc": "2.0",
                "id": self.rpc_id,
                "result": {
                    "outcome": {
                        "outcome": "selected",
                        "optionId": reject.option_id,
                    }
                }
            });
        }
        json!({
            "jsonrpc": "2.0",
            "id": self.rpc_id,
            "result": {
                "outcome": { "outcome": "cancelled" }
            }
        })
    }
}

/// 解析 ACP `session/new`、`session/load` 或 `config_option_update` 里的动态配置项。
/// 兼容标准 `configOptions` 数组，以及部分 v1 Agent 的 `modes` / `models` 字段。
pub(super) fn parse_config_options(payload: &Value) -> Vec<AiConfigOption> {
    let mut result = Vec::new();
    if let Some(items) = payload["configOptions"].as_array() {
        for item in items {
            if let Some(option) = parse_single_config_option(item) {
                result.push(option);
            }
        }
    }
    // 若 Agent 未下发标准 configOptions，回落解析 v1 modes / models，保证模型与模式可切换。
    if !result.iter().any(|opt| opt.category.as_deref() == Some("model") || opt.id == "model") {
        if let Some(models) = payload.get("models").and_then(Value::as_object) {
            let current = models
                .get("currentModelId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let choices: Vec<AiConfigOptionChoice> = models
                .get("availableModels")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| {
                            let id = m["modelId"].as_str().or_else(|| m["id"].as_str())?;
                            let name = m["name"].as_str().unwrap_or(id);
                            Some(AiConfigOptionChoice {
                                value: id.to_string(),
                                name: name.to_string(),
                                description: m["description"].as_str().map(str::to_string),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !choices.is_empty() {
                result.push(AiConfigOption {
                    id: "model".into(),
                    name: "模型".into(),
                    category: Some("model".into()),
                    current_value: if current.is_empty() {
                        choices[0].value.clone()
                    } else {
                        current
                    },
                    options: choices,
                });
            }
        }
    }
    if !result.iter().any(|opt| opt.category.as_deref() == Some("mode") || opt.id == "mode") {
        if let Some(modes) = payload.get("modes").and_then(Value::as_object) {
            let current = modes
                .get("currentModeId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let choices: Vec<AiConfigOptionChoice> = modes
                .get("availableModes")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| {
                            let id = m["id"].as_str()?;
                            let name = m["name"].as_str().unwrap_or(id);
                            Some(AiConfigOptionChoice {
                                value: id.to_string(),
                                name: name.to_string(),
                                description: m["description"].as_str().map(str::to_string),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !choices.is_empty() {
                result.push(AiConfigOption {
                    id: "mode".into(),
                    name: "模式".into(),
                    category: Some("mode".into()),
                    current_value: if current.is_empty() {
                        choices[0].value.clone()
                    } else {
                        current
                    },
                    options: choices,
                });
            }
        }
    }
    result
}

fn parse_single_config_option(item: &Value) -> Option<AiConfigOption> {
    let id = item["id"].as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let name = item["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(id)
        .to_string();
    let category = item["category"].as_str().map(str::to_string);
    let current_value = item["currentValue"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let mut choices = Vec::new();
    if let Some(raw_options) = item["options"].as_array() {
        for entry in raw_options {
            if let Some(group_items) = entry["options"].as_array() {
                for sub in group_items {
                    if let Some(choice) = parse_config_choice(sub) {
                        choices.push(choice);
                    }
                }
            } else if let Some(choice) = parse_config_choice(entry) {
                choices.push(choice);
            }
        }
    }
    Some(AiConfigOption {
        id: id.to_string(),
        name,
        category,
        current_value,
        options: choices,
    })
}

fn parse_config_choice(entry: &Value) -> Option<AiConfigOptionChoice> {
    let value = entry["value"].as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    let name = entry["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(value)
        .to_string();
    let description = entry["description"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    Some(AiConfigOptionChoice {
        value: value.to_string(),
        name,
        description,
    })
}

/// 从动态配置列表中提取当前模型标识，同步到 `AiSession.model`。
pub(super) fn current_model_from_options(options: &[AiConfigOption]) -> Option<String> {
    options
        .iter()
        .find(|opt| opt.category.as_deref() == Some("model") || opt.id == "model")
        .map(|opt| opt.current_value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn parse_plan_entries(entries: &Value) -> Vec<AiTodo> {
    entries
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let content = item["content"].as_str()?.trim();
                    if content.is_empty() {
                        return None;
                    }
                    let status = match item["status"].as_str().unwrap_or("pending") {
                        "in_progress" | "inProgress" | "running" => "in_progress",
                        "completed" | "done" => "completed",
                        _ => "pending",
                    };
                    Some(AiTodo {
                        content: content.to_string(),
                        status: status.to_string(),
                        active_form: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_available_commands(commands: &Value) -> Option<SlashCatalog> {
    let items = commands.as_array()?;
    let mut slash_commands = Vec::new();
    for item in items {
        let Some(name) = item["name"].as_str().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let normalized = name.strip_prefix('/').unwrap_or(name).to_string();
        if !normalized.is_empty() && !slash_commands.contains(&normalized) {
            slash_commands.push(normalized);
        }
    }
    Some(SlashCatalog {
        skills: Vec::new(),
        slash_commands,
        terminal_slash_commands: Vec::new(),
    })
}

pub(super) fn extract_content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    match content["type"].as_str().unwrap_or_default() {
        "text" => content["text"].as_str().unwrap_or_default().to_string(),
        "resource_link" => {
            let name = content["name"]
                .as_str()
                .or_else(|| content["uri"].as_str())
                .unwrap_or("resource");
            format!("[资源] {name}")
        }
        "resource" => content
            .pointer("/resource/text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => content["text"].as_str().unwrap_or_default().to_string(),
    }
}

pub(super) fn format_tool_call_text(update: &Value) -> String {
    let title = update["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| update["kind"].as_str().filter(|s| !s.trim().is_empty()))
        .unwrap_or("工具调用");
    let status = match update["status"].as_str().unwrap_or_default() {
        "pending" => "（等待中）",
        "in_progress" => "（执行中）",
        "completed" => "（已完成）",
        "failed" => "（失败）",
        _ => "",
    };
    let mut lines = vec![format!("{title}{status}")];
    if let Some(cmd) = update
        .pointer("/rawInput/command")
        .and_then(Value::as_str)
        .or_else(|| update.pointer("/rawInput/cmd").and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
    {
        lines.push(format!("$ {cmd}"));
    }
    if let Some(locations) = update["locations"].as_array() {
        let paths: Vec<&str> = locations
            .iter()
            .filter_map(|loc| loc["path"].as_str().filter(|p| !p.trim().is_empty()))
            .collect();
        if !paths.is_empty() {
            lines.push(paths.join(", "));
        }
    }
    if let Some(contents) = update["content"].as_array() {
        for item in contents {
            match item["type"].as_str().unwrap_or_default() {
                "content" => {
                    let text = extract_content_text(&item["content"]);
                    if !text.trim().is_empty() {
                        lines.push(text);
                    }
                }
                "diff" => {
                    if let Some(path) = item["path"].as_str() {
                        lines.push(format!("修改文件：{path}"));
                    }
                }
                _ => {
                    let text = extract_content_text(item);
                    if !text.trim().is_empty() {
                        lines.push(text);
                    }
                }
            }
        }
    }
    if let Some(output) = update["rawOutput"].as_str().filter(|s| !s.trim().is_empty()) {
        if lines.len() == 1 {
            lines.push(output.to_string());
        }
    }
    lines.join("\n")
}

/// 从 ACP `usage_update` 提取上下文已用量与总窗口（若提供）。
pub(super) fn parse_usage_update(update: &Value) -> (Option<u64>, Option<u64>) {
    let used = update["used"].as_u64();
    let size = update["size"].as_u64().filter(|n| *n > 0);
    (used, size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_grouped_and_flat_config_options() {
        let payload = json!({
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "currentValue": "gemini-3.5-pro",
                    "options": [
                        {
                            "group": "Gemini",
                            "name": "Gemini",
                            "options": [
                                { "value": "gemini-3.5-pro", "name": "Gemini 3.5 Pro" },
                                { "value": "gemini-2.5-flash", "name": "Gemini 2.5 Flash" }
                            ]
                        }
                    ]
                },
                {
                    "id": "mode",
                    "name": "Mode",
                    "category": "mode",
                    "currentValue": "code",
                    "options": [
                        { "value": "code", "name": "Code" },
                        { "value": "plan", "name": "Plan" }
                    ]
                }
            ]
        });
        let parsed = parse_config_options(&payload);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].options.len(), 2);
        assert_eq!(
            current_model_from_options(&parsed).as_deref(),
            Some("gemini-3.5-pro")
        );
    }

    #[test]
    fn synthesizes_config_options_from_legacy_modes_and_models() {
        let payload = json!({
            "models": {
                "currentModelId": "gemini-4-neon",
                "availableModels": [
                    { "modelId": "gemini-4-neon", "name": "Gemini 4 Neon" }
                ]
            },
            "modes": {
                "currentModeId": "code",
                "availableModes": [
                    { "id": "code", "name": "Code" },
                    { "id": "ask", "name": "Ask" }
                ]
            }
        });
        let parsed = parse_config_options(&payload);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "model");
        assert_eq!(parsed[1].id, "mode");
    }

    #[test]
    fn permission_request_selects_allow_or_reject_option() {
        let req = AcpPermissionRequest::from_request(
            json!(42),
            &json!({
                "toolCall": {
                    "title": "Run tests",
                    "kind": "execute",
                    "rawInput": { "command": "cargo test" }
                },
                "options": [
                    { "optionId": "allow-1", "name": "Allow once", "kind": "allow_once" },
                    { "optionId": "deny-1", "name": "Reject once", "kind": "reject_once" }
                ]
            }),
        )
        .unwrap();
        assert_eq!(req.approval.method, ACP_PERMISSION_METHOD);
        let auto = req.auto_allow_response();
        assert_eq!(auto["result"]["outcome"]["optionId"], "allow-1");

        let declined = req.response(&AnswerAiApproval {
            approval_id: req.approval.id.clone(),
            decision: "decline".into(),
            answers: json!({}),
        });
        assert_eq!(declined["result"]["outcome"]["optionId"], "deny-1");
    }

    #[test]
    fn parses_plan_and_available_commands() {
        let todos = parse_plan_entries(&json!([
            { "content": "Inspect code", "status": "completed" },
            { "content": "Implement ACP", "status": "in_progress" },
            { "content": "Run tests", "status": "pending" }
        ]));
        assert_eq!(todos.len(), 3);
        assert_eq!(todos[0].status, "completed");
        assert_eq!(todos[1].status, "in_progress");
        assert_eq!(todos[2].status, "pending");

        let catalog = parse_available_commands(&json!([
            { "name": "/review", "description": "Review diff" },
            { "name": "compact", "description": "Compact context" }
        ]))
        .unwrap();
        assert_eq!(catalog.slash_commands, vec!["review", "compact"]);
    }
}
