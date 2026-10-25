//! 原生聊天的交互适配：客户端统一按题目 ID 回答，Claude 按原始问题文本接收答案。
use crate::models::ai_chat::{AiApproval, AnswerAiApproval};
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
        let input = request["input"].as_object()?;
        let mut details = json!({
            "toolName": tool, "input": input, "title": request["title"],
            "reason": request["decision_reason"], "command": input.get("command"),
        });
        if tool == "AskUserQuestion" {
            let questions = input.get("questions")?.as_array()?;
            if questions.is_empty() { return None; }
            let mut normalized = Vec::new();
            for (index, question) in questions.iter().enumerate() {
                if question["question"].as_str()?.trim().is_empty() { return None; }
                let mut question = question.clone();
                question["id"] = json!(format!("question-{index}"));
                normalized.push(question);
            }
            details["questions"] = json!(normalized);
        }
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
            let mut input = self.input.clone();
            if let Some(questions) = self.approval.details["questions"].as_array() {
                let mut answers = serde_json::Map::new();
                for question in questions {
                    let id = question["id"].as_str().ok_or("问题缺少标识")?;
                    let text = question["question"].as_str().ok_or("问题内容为空")?;
                    let values = answer.answers[id]["answers"].as_array().ok_or("问题尚未回答")?;
                    let labels: Vec<_> = values.iter().filter_map(Value::as_str).collect();
                    answers.insert(text.into(), json!(labels.join(", ")));
                }
                input["answers"] = Value::Object(answers);
            }
            json!({"behavior":"allow","updatedInput":input})
        };
        Ok(json!({"type":"control_response","response":{
            "subtype":"success","request_id":self.request_id,"response":response,
        }}))
    }
}

const CODEX_DECISION_TOOL: &str = "request_user_input_async";

/// 在普通对话中提供客户端决策工具，避免模型只能输出文字选项。
/// 协议：https://developers.openai.com/codex/app-server/#dynamic-tool-calls-experimental
pub(super) fn codex_tools() -> Value {
    json!([{
        "type": "function", "name": CODEX_DECISION_TOOL,
        "description": "需要用户选择、确认方案或测试决策通知时调用此工具。它会在安卓聊天区、AI 上下文上方显示可点击的悬浮选择卡片，并等待用户提交答案。不要用纯文字选项或声称已发送通知来代替调用。",
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
    params["tool"].as_str() == Some(CODEX_DECISION_TOOL)
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
