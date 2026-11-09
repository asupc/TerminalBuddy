//! 原生客户端消费的 AI 会话消息，与 PTY/ANSI 输出协议分离。
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: i64,
    /// Skill 展开的消息：Skill 名称（如 "code-review"）。普通消息为 None。
    /// 前端据此渲染为可展开的 skill:名称 条目，而非普通气泡。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_name: Option<String>,
    /// 子代理（Task 工具启动）产生的消息：subagent 类型名（如 "Explore"）。
    /// 主线程消息为 None；前端据此把连续的同名子代理消息合并为一个可折叠条目。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<String>,
    /// 子代理分组键（turn + parent_tool_use_id 派生）：同一子代理的全部消息
    /// 共享同一键，前端据此精确分组——同名代理不误并组、同一代理被主线程
    /// 消息隔开也不拆组（审查 V-5；名称仅作显示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_key: Option<String>,
    /// 模型切换分段：role = "system" 时携带切换前后的配置，前端渲染为分隔线。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_switch: Option<ModelSwitch>,
    /// 用户消息附带的图片：客户端据此展示缩略图，CLI 侧转成多模态内容块。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<AiImage>,
    /// TodoWrite 工具消息标记：正文保留 `TodoWrite\n{完整 input}` 供历史恢复回填清单，
    /// 前端分组时连同其 tool_result 一起跳过渲染（清单由底部清单卡呈现）。
    #[serde(default, skip_serializing_if = "is_false")]
    pub todo: bool,
}

fn is_false(value: &bool) -> bool { !*value }

/// 主线程当前的思考内容（Claude 的 thinking 块）。
///
/// 长回合里模型可能连续思考几十分钟才输出第一句正文（实测一个会话里 164 段思考、
/// 42 万字，前 28 分钟一条正文都没有）。这段过程过去被后端直接丢弃，界面上只剩
/// 一个「已等待 N 秒」的呼吸灯，看起来像卡死；终端里反而能实时看到。
///
/// 这里只保留**当前一段**思考的尾部若干字符作为实时状态，不写进 `messages`：
/// 思考不是聊天记录（不该进历史回放、也不该让安卓端按消息渲染），
/// 前端在「AI 正在思考中」气泡里滚动显示最新一行，点开可看全文。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiThinking {
    /// 思考正文（只保留尾部，前端展开时显示这一段）。
    pub text: String,
    /// 本段思考开始的时刻。
    pub started_at: i64,
    pub updated_at: i64,
    /// 是否仍在输出：思考块结束后为 false，正文/工具开始后前端淡出。
    pub active: bool,
    /// 本回合已经开始的思考段数（过程量，折叠态展示「第 N 段思考」）。
    #[serde(default)]
    pub blocks: u32,
    /// 本回合思考累计字符数（截断前统计，用来说明模型在有效工作）。
    #[serde(default)]
    pub total_chars: u64,
}

/// 会话当前任务清单：`TodoWrite` 全量快照的直接投影。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTodo {
    /// 命令式文案，如「修复登录跳转」。
    pub content: String,
    /// pending | in_progress | completed
    pub status: String,
    /// 进行中文案，如「正在修复登录跳转」；只用于折叠态摘要。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

/// 本轮派发过的子代理：运行态由 `task_*` 系列事件维护，结束后保留供回看。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiAgent {
    pub task_id: String,
    /// 关联的 Task tool_use id；与消息的 subagentKey（`{turn}:{parent}`）同源。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// subagent_type，缺失时回落 description 或 "subagent"。
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// running | completed | failed | stopped | killed | paused
    pub status: String,
    /// CLI 的任务类型：`local_agent`（子代理）、`local_bash`（后台命令）等。
    /// 只有代理类任务才会产生子代理消息，前端据此区分 chip 与空抽屉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(default)]
    pub background: bool,
    /// 嵌套子代理的父任务 id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    #[serde(default)]
    pub depth: u32,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<i64>,
}

/// 已落盘的图片附件。消息与排队项只保存元数据，不内嵌 base64，
/// 避免会话 JSON 与实时推送帧被大图撑爆。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiImage {
    /// 服务端绝对路径（位于 dataPath/ClientData/ai-images）。
    pub path: String,
    /// MIME 类型（image/png、image/jpeg 等）。
    pub media_type: String,
    /// 原始文件名，仅用于展示。
    #[serde(default)]
    pub name: String,
}

/// 发送时客户端提交的图片：base64 正文，服务端解码落盘后替换为 [AiImage]。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAiImage {
    /// base64 编码的图片数据；兼容带 `data:<mime>;base64,` 前缀的写法。
    pub data: String,
    pub media_type: String,
    #[serde(default)]
    pub name: String,
}

/// 会话中途切换供应商或模型的记录：从哪一段开始由 `createdAt` 标定。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSwitch {
    pub from_provider: Option<String>,
    pub from_model: Option<String>,
    pub to_provider: Option<String>,
    pub to_model: Option<String>,
}

/// `system/init` 提供的命令清单，随会话启动刷新。Codex 无此机制，为 None。
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SlashCatalog {
    /// 已安装的 Skill（含插件带来的）；是 slash_commands 的子集。
    pub skills: Vec<String>,
    /// 内建命令 ∪ 全部 Skill。
    pub slash_commands: Vec<String>,
    /// 纯 TUI 命令（doctor / color / focus / reload-plugins），对话中不可用。
    pub terminal_slash_commands: Vec<String>,
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
    /// 排队期间保留图片附件，出队时与文本一起交给 CLI。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<AiImage>,
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
    /// `/` 补全清单，来自 `system/init`，随会话启动自动刷新。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slash_catalog: Option<SlashCatalog>,
    /// 会话当前任务清单（TodoWrite 全量快照的直接投影）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<AiTodo>,
    /// 本轮派发过的子代理状态（`task_started` / `task_updated` / `task_notification`）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AiAgent>,
    /// 主线程当前思考的实时快照（不落盘、不入聊天记录）：见 [`AiThinking`]。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<AiThinking>,
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
            thread_id: None, request_ids: Vec::new(),
            // 排队消息是客户端可见的元数据：实时帧需要它来刷新「N 条排队中」。
            pending_inputs: self.pending_inputs.clone(),
            slash_catalog: self.slash_catalog.clone(),
            // 任务清单与子代理状态是底部面板的实时数据源，必须随每一帧下发；
            // 思考快照同理（流式中每秒都在变，长回合靠它判断模型仍在推进）。
            todos: self.todos.clone(),
            agents: self.agents.clone(),
            thinking: self.thinking.clone(),
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
    /// 原生插话：直接把消息交给运行中的 CLI 进程，由它选择合适节点接收；
    /// 默认排队，等当前回合任务全部完成后由服务端写入同一个 CLI 进程。
    #[serde(default)]
    pub steer: bool,
    /// 随消息发送的图片（base64）：服务端落盘后转为 [AiImage]。
    #[serde(default)]
    pub images: Vec<SendAiImage>,
}

/// 把指定排队消息立即插话到当前回合（worker 已退出时按选中消息启动新回合）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FlushAiQueue {
    pub request_id: Option<String>,
}

/// 只修改尚未出队的消息，保留请求标识与排队顺序。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiPendingInput {
    pub text: String,
}

/// 历史来源由服务端索引决定，客户端只选择继续对话所用的供应商和模型。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCodexHistory {
    #[serde(default)]
    pub provider_id: Option<String>,
    pub model: Option<String>,
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
