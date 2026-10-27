//! 原生聊天的交互适配：客户端统一按题目 ID 回答，Claude 按原始问题文本接收答案。
use crate::models::ai_chat::{AiApproval, AnswerAiApproval};
use super::ClaudeHookDecisionEvent;
use std::collections::HashMap;
use serde_json::{json, Value};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

pub(super) fn validate(approval: &AiApproval, answer: &AnswerAiApproval) -> Result<()> {
    if !matches!(answer.decision.as_str(), "accept" | "decline") { return Err("无效的确认操作".into()); }
    if answer.decision == "decline" { return Ok(()); }
    if let Some(questions) = approval.details["questions"].as_array() {
        for question in questions {
            let id = question["id"].as_str().ok_or("问题缺少标识，请更新服务端后重试")?;
            let values = answer.answers[id]["answers"].as_array().ok_or("请回答所有问题后再提交")?;
            if values.is_empty() || values.iter().any(|value| !value.as_str().is_some_and(|text| !text.trim().is_empty())) {
                return Err("请回答所有问题后再提交".into());
            }
            if question["multiSelect"] != true && values.len() > 1 { return Err("单选问题只能提交一个答案".into()); }
        }
    }
    Ok(())
}

pub(super) struct ClaudeApproval {
    pub approval: AiApproval,
    pub request_id: Value,
    input: Value,
}
impl ClaudeApproval {
    pub fn from_request(value: &Value) -> Option<Self> {
        let request = &value["request"];
        if request["subtype"] != "can_use_tool" || value["request_id"].as_str()?.is_empty() { return None; }
        let tool = request["tool_name"].as_str()?;
        // 用户提问统一由 PreToolUse HTTP Hook 接管，stdio 只保留普通工具授权。
        if tool == "AskUserQuestion" { return None; }
        let input = request["input"].as_object()?;
        let details = json!({
            "toolName": tool, "input": input, "title": request["title"],
            "reason": request["decision_reason"], "command": input.get("command"),
        });
        Some(Self {
            approval: AiApproval { id: Uuid::new_v4().to_string(), method: "claude/canUseTool".into(), details },
            request_id: value["request_id"].clone(), input: Value::Object(input.clone()),
        })
    }

    pub fn response(&self, answer: &AnswerAiApproval) -> Result<Value> {
        validate(&self.approval, answer)?;
        let response = if answer.decision == "decline" {
            json!({"behavior":"deny","message":"用户拒绝了本次请求，请根据用户的决定继续。"})
        } else {
            json!({"behavior":"allow","updatedInput":self.input})
        };
        Ok(json!({"type":"control_response","response":{
            "subtype":"success","request_id":self.request_id,"response":response,
        }}))
    }
}

pub(super) const CLAUDE_HOOK_METHOD: &str = "claude/preToolUse";

pub(super) fn claude_hook_approval(event: &ClaudeHookDecisionEvent) -> AiApproval {
    let questions: Vec<_> = event.questions.iter().enumerate().map(|(index, question)| json!({
        "id":format!("question-{index}"), "question":question.question, "header":question.header,
        "options":question.options, "multiSelect":question.multi_select,
    })).collect();
    AiApproval { id: event.decision_id.clone(), method: CLAUDE_HOOK_METHOD.into(), details: json!({
        "questions":questions, "expiresAt":event.expires_at,
    }) }
}

pub(super) fn claude_hook_answers(approval: &AiApproval, answer: &AnswerAiApproval) -> Result<HashMap<String, String>> {
    validate(approval, answer)?;
    let questions = approval.details["questions"].as_array().ok_or("决策问题格式不正确")?;
    let mut answers = HashMap::new();
    for question in questions {
        let id = question["id"].as_str().ok_or("问题缺少标识")?;
        let text = question["question"].as_str().ok_or("问题内容为空")?;
        let values = answer.answers[id]["answers"].as_array().ok_or("问题尚未回答")?;
        let labels: Vec<_> = values.iter().filter_map(Value::as_str).collect();
        answers.insert(text.into(), labels.join(", "));
    }
    Ok(answers)
}

// 使用应用专属名称，避免与 Codex 内置异步提问工具混淆。
const CODEX_DECISION_TOOL: &str = "terminal_buddy_request_decision";
const LEGACY_CODEX_DECISION_TOOL: &str = "request_user_input_async";

/// 追加原生聊天的决策约定，保留项目及用户配置中的开发者指令。
pub(super) fn codex_decision_instructions(configured: Option<&str>) -> String {
    let instructions = format!(r#"Terminal Buddy 原生聊天决策：
需要用户选择、确认方案或测试决策通知/卡片时，优先调用标准 request_user_input，等待用户提交答案。
标准工具不可用或确实需要多选时，若存在 {CODEX_DECISION_TOOL}，可调用该客户端工具；它会显示决策卡片并等待真实回答。
不要用 request_user_input_async 代替决策卡片请求，也不要用纯文字选项代替工具调用。
仅收到 accepted 表示请求已接收，不代表卡片已展示或用户已确认；此时应改用标准 request_user_input。收到真实答案前，不要声称决策已完成。"#);
    match configured.filter(|text| !text.trim().is_empty()) {
        Some(configured) => format!("{configured}\n\n{instructions}"),
        None => instructions,
    }
}

/// 在普通对话中提供客户端决策工具，避免模型只能输出文字选项。
/// 协议：https://developers.openai.com/codex/app-server/#dynamic-tool-calls-experimental
pub(super) fn codex_tools() -> Value {
    json!([{
        "type": "function", "name": CODEX_DECISION_TOOL,
        "description": "标准 request_user_input 不可用或需要多选时，使用此工具请求用户决策。它会在安卓聊天区、AI 上下文上方显示可点击的悬浮选择卡片，等待用户真实提交答案后才返回。优先使用标准 request_user_input；不要改用内置 request_user_input_async 或用文字声称已发送通知。",
        "inputSchema": {
            "type": "object", "properties": {
                "questions": {"type":"array", "minItems":1, "items":{
                    "type":"object", "properties":{
                        "title":{"type":"string","description":"向用户提出的问题"},
                        "options":{"type":"array","items":{"anyOf":[
                            {"type":"string"},
                            {"type":"object","properties":{"label":{"type":"string"},"description":{"type":"string"}},"required":["label"],"additionalProperties":false}
                        ]}},
                        "multiSelect":{"type":"boolean","description":"是否允许多选，默认为单选"}
                    },"required":["title"],"additionalProperties":false
                }}
            }, "required":["questions"], "additionalProperties":false
        }
    }])
}

pub(super) fn is_codex_decision_tool(params: &Value) -> bool {
    // 旧线程会从历史中恢复已注册的工具名，仍按阻塞式决策处理。
    matches!(params["tool"].as_str(), Some(CODEX_DECISION_TOOL | LEGACY_CODEX_DECISION_TOOL))
}

pub(super) fn codex_decision_details(params: &Value) -> Result<Value> {
    let arguments = if let Some(text) = params["arguments"].as_str() {
        serde_json::from_str(text).map_err(|_| "决策问题格式不正确")?
    } else { params["arguments"].clone() };
    let questions = arguments["questions"].as_array().filter(|items| !items.is_empty()).ok_or("决策请求缺少问题")?;
    let mut normalized = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let text = question["title"].as_str().or_else(|| question["question"].as_str())
            .filter(|text| !text.trim().is_empty()).ok_or("决策问题内容为空")?;
        let mut options = Vec::new();
        if let Some(items) = question["options"].as_array() {
            for option in items {
                let label = option.as_str().or_else(|| option["label"].as_str())
                    .filter(|text| !text.trim().is_empty()).ok_or("决策选项内容为空")?;
                options.push(json!({"label":label,"description":option.get("description")}));
            }
        }
        normalized.push(json!({
            "id":format!("question-{index}"), "question":text, "header":question["header"],
            "options":options, "multiSelect":question["multiSelect"] == true,
        }));
    }
    Ok(json!({"threadId":params["threadId"],"turnId":params["turnId"],"questions":normalized}))
}

pub(super) fn codex_tool_result(content: Value, success: bool) -> Value {
    json!({"contentItems":[{"type":"inputText","text":content.to_string()}],"success":success})
}

pub(super) fn codex_response(method: &str, answer: &AnswerAiApproval) -> Value {
    let accepted = answer.decision == "accept";
    let answers = if accepted { answer.answers.clone() } else { json!({}) };
    match method {
        "item/tool/call" => codex_tool_result(json!({
            "status":if accepted { "answered" } else { "declined" }, "answers":answers,
        }), true),
        "item/tool/requestUserInput" | "tool/requestUserInput" => json!({"answers":answers}),
        _ => json!({"decision":answer.decision}),
    }
}

/// Pi RPC 扩展交互：`extension_ui_request` → 手机审批卡，回答后回 `extension_ui_response`。
/// 通知类方法（notify/setStatus 等）不等待响应，由驱动直接忽略。
pub(super) fn pi_extension_approval(request: &Value) -> Option<AiApproval> {
    let method = request["method"].as_str()?;
    if !matches!(method, "select" | "confirm" | "input" | "editor") { return None; }
    let protocol_id = request["id"].as_str().filter(|id| !id.is_empty())?;
    let title = request["title"].as_str().unwrap_or("Pi 扩展请求");
    let message = request["message"].as_str().or_else(|| request["prefill"].as_str()).unwrap_or("");
    let heading = if message.is_empty() { title.to_string() } else { format!("{title}\n{message}") };
    // confirm 复用无题目卡片的「允许本次 / 拒绝」；select/input/editor 各映射为一道题。
    let questions = match method {
        "confirm" => Vec::new(),
        "select" => vec![json!({
            "id":"choice", "question":title, "header":"请选择",
            "options":request["options"].as_array().map(|options| options.iter()
                .map(|option| json!({"label":option})).collect::<Vec<_>>()).unwrap_or_default(),
        })],
        _ => vec![json!({
            "id":"value", "question":title, "header":"请输入",
            "placeholder":request["placeholder"],
        })],
    };
    Some(AiApproval {
        id: Uuid::new_v4().to_string(),
        method: format!("pi/{method}"),
        details: json!({ "protocolId":protocol_id, "method":method, "title":heading, "questions":questions }),
    })
}

pub(super) fn pi_extension_response(approval: &AiApproval, answer: &AnswerAiApproval) -> Result<Value> {
    validate(approval, answer)?;
    let id = approval.details["protocolId"].clone();
    if answer.decision == "decline" { return Ok(json!({"type":"extension_ui_response","id":id,"cancelled":true})); }
    let picked = ["choice", "value"].iter().find_map(|key| answer.answers[key]["answers"][0].as_str());
    Ok(match approval.details["method"].as_str().unwrap_or("") {
        "confirm" => json!({"type":"extension_ui_response","id":id,"confirmed":true}),
        _ => json!({"type":"extension_ui_response","id":id,"value":picked.unwrap_or_default()}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_extension_approval_maps_dialog_methods_only() {
        let confirm = pi_extension_approval(&json!({
            "type":"extension_ui_request","id":"req-1","method":"confirm","title":"继续执行？","message":"将运行测试",
        })).unwrap();
        assert_eq!(confirm.method, "pi/confirm");
        assert_eq!(confirm.details["protocolId"], "req-1");
        assert_eq!(confirm.details["title"], "继续执行？\n将运行测试");
        assert!(confirm.details["questions"].as_array().unwrap().is_empty());

        let select = pi_extension_approval(&json!({
            "type":"extension_ui_request","id":"req-2","method":"select","title":"选一个","options":["A","B"],
        })).unwrap();
        assert_eq!(select.method, "pi/select");
        assert_eq!(select.details["questions"][0]["options"][1]["label"], "B");

        let input = pi_extension_approval(&json!({
            "type":"extension_ui_request","id":"req-3","method":"input","title":"填写分支名","placeholder":"feature/",
        })).unwrap();
        assert_eq!(input.details["questions"][0]["id"], "value");
        assert_eq!(input.details["questions"][0]["placeholder"], "feature/");

        assert!(pi_extension_approval(&json!({"type":"extension_ui_request","id":"n1","method":"notify","message":"hi"})).is_none());
        assert!(pi_extension_approval(&json!({"type":"extension_ui_request","method":"confirm","title":"无协议 ID"})).is_none());
    }

    #[test]
    fn pi_extension_response_round_trips_answers() {
        let approval = pi_extension_approval(&json!({
            "type":"extension_ui_request","id":"req-9","method":"select","title":"选一个","options":["A","B"],
        })).unwrap();
        let accepted = pi_extension_response(&approval, &AnswerAiApproval {
            approval_id: approval.id.clone(), decision: "accept".into(),
            answers: json!({"choice":{"answers":["B"]}}),
        }).unwrap();
        assert_eq!(accepted, json!({"type":"extension_ui_response","id":"req-9","value":"B"}));

        let confirm = pi_extension_approval(&json!({
            "type":"extension_ui_request","id":"req-10","method":"confirm","title":"继续？",
        })).unwrap();
        let allowed = pi_extension_response(&confirm, &AnswerAiApproval {
            approval_id: confirm.id.clone(), decision: "accept".into(), answers: json!({}),
        }).unwrap();
        assert_eq!(allowed, json!({"type":"extension_ui_response","id":"req-10","confirmed":true}));

        let declined = pi_extension_response(&confirm, &AnswerAiApproval {
            approval_id: confirm.id.clone(), decision: "decline".into(), answers: json!({}),
        }).unwrap();
        assert_eq!(declined["cancelled"], json!(true));
    }
}
