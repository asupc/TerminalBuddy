//! 原生客户端消费的 AI 会话消息，与 PTY/ANSI 输出协议分离。
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApproval {
    pub id: String,
    pub method: String,
    pub details: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    pub id: String,
    pub title: String,
    pub provider: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
    pub project_path: String,
    pub model: Option<String>,
    pub status: String,
    pub messages: Vec<AiMessage>,
    pub approvals: Vec<AiApproval>,
    pub error: Option<String>,
    pub updated_at: i64,
    pub revision: u64,
    // 不向客户端暴露内部线程、账户归属和请求去重信息。
    #[serde(default, skip_serializing)]
    pub owner: String,
    #[serde(default, skip_serializing)]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing)]
    pub request_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiSession {
    pub provider: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    pub project_path: String,
    pub model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAiMessage {
    pub text: String,
    pub request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerAiApproval {
    pub approval_id: String,
    pub decision: String,
    #[serde(default)]
    pub answers: serde_json::Value,
}

/// 手机首页可用的供应商/模型目录，绝不包含密钥与 API 凭据。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCatalog { pub providers: Vec<AiProviderOption> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderOption {
    pub id: String,
    pub agent: String,
    pub name: String,
    pub is_default: bool,
    pub models: Vec<AiModelOption>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelOption {
    pub id: String,
    pub label: String,
    pub effort: String,
}
