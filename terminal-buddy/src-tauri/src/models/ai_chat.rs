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

/// 回合进行中收到的排队消息：当前回合结束后按序自动发送（与 PC 终端排队一致）。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInput {
    pub text: String,
    pub request_id: String,
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
    /// 最近一次任务结束的版本；客户端断线后仍能识别已经错过的完整回合。
    #[serde(default)]
    pub result_revision: u64,
    #[serde(default)]
    pub usage: Option<AiUsage>,
    /// Codex 累计快照的恢复基线，只在私有会话文件中保存。
    #[serde(default, skip_serializing)]
    pub usage_checkpoint: Option<AiTokenUsage>,
    // 不向客户端暴露内部线程、账户归属和请求去重信息。
    #[serde(default, skip_serializing)]
    pub owner: String,
    #[serde(default, skip_serializing)]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing)]
    pub request_ids: Vec<String>,
    /// 排队待发消息（非空时对客户端可见，手机端据此显示「N 条排队中」）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_inputs: Vec<PendingInput>,
}

impl AiSession {
    /// 通知连接只读取元数据，不复制或传输整段对话历史。
    pub fn metadata(&self) -> Self {
        Self {
            id: self.id.clone(), title: self.title.clone(), provider: self.provider.clone(),
            provider_id: self.provider_id.clone(), provider_name: self.provider_name.clone(),
            project_path: self.project_path.clone(), model: self.model.clone(), status: self.status.clone(),
            messages: Vec::new(), approvals: self.approvals.clone(), error: self.error.clone(),
            updated_at: self.updated_at, revision: self.revision, result_revision: self.result_revision,
            usage: self.usage.clone(), usage_checkpoint: None, owner: self.owner.clone(),
            thread_id: None, request_ids: Vec::new(), pending_inputs: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiSession {
    pub provider: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    pub project_path: String,
    pub model: Option<String>,
    /// 从 CLI 历史会话恢复：绑定历史线程并预填最近消息，项目以历史会话所在目录为准。
    #[serde(default)]
    pub resume_session_id: Option<String>,
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

/// 对外输入量统一包含缓存；缓存与推理是组成部分，不能再叠加到总数上。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiTokenUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiContextUsage {
    pub used_tokens: Option<u64>,
    pub window_tokens: Option<u64>,
    pub basis: String,
    pub used_source: Option<String>,
    pub window_source: Option<String>,
    pub updating: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiTurnUsage {
    #[serde(flatten)]
    pub tokens: AiTokenUsage,
    pub state: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSessionUsage {
    #[serde(flatten)]
    pub tokens: AiTokenUsage,
    pub coverage: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiUsage {
    pub context: AiContextUsage,
    pub last_turn: Option<AiTurnUsage>,
    pub session_total: AiSessionUsage,
}
