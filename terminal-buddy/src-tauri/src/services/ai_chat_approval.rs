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
