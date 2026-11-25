import { invoke } from './../remoteWorkspace/core';

/** 原生 AI 会话：与后端 `models/ai_chat.rs` 对应（camelCase 序列化）。 */
/** 会话消息里的图片附件：服务端已落盘，客户端只拿路径与元数据。 */
export interface AiChatImage {
  path: string;
  mediaType: string;
  name: string;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | string;
  text: string;
  createdAt: number;
  /** Skill 展开的消息：Skill 名称。普通消息不携带该字段。 */
  skillName?: string;
  /** 子代理（Task 工具）产生的消息：subagent 类型名（如 "Explore"）。主线程消息不携带。 */
  subagent?: string;
  /** 子代理分组键（turn + parent_tool_use_id）：同一子代理的全部消息共享，
   * 前端据此精确分组（V-5）——名称仅作显示，同名代理不误并组。 */
  subagentKey?: string;
  /** 模型切换分段（role = system）：切换前后的供应商与模型，前端渲染为分隔线。 */
  modelSwitch?: AiModelSwitch;
  /** 用户消息附带的图片：输入框上方与消息气泡内都据此显示缩略图。 */
  images?: AiChatImage[];
  /** TodoWrite 的工具调用/结果：正文保留原始 input 供历史回填，
   * 前端分组时连同其结果一起跳过渲染（清单由底部清单卡呈现）。 */
  todo?: boolean;
}

/** 会话当前任务清单：TodoWrite 全量快照的直接投影。 */
export interface AiTodo {
  /** 命令式文案，如「修复登录跳转」。 */
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  /** 进行中文案；只用于折叠态摘要，展开列表一律显示 content。 */
  activeForm?: string | null;
}

/** 本轮派发过的子代理：运行态由 task_* 事件维护，结束后保留供回看。 */
export interface AiAgent {
  taskId: string;
  /** 关联的 Task tool_use id；与消息的 subagentKey（`{turn}:{parent}`）同源。 */
  toolUseId?: string | null;
  name: string;
  /** 子代理实际使用的模型（CLI 提供时显示）。 */
  model?: string | null;
  description?: string | null;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'killed' | 'paused' | string;
  /** CLI 任务类型：`local_agent`（子代理）、`local_bash`（后台命令）等。
   * 只有代理类任务才会产生子代理消息，chip 带与抽屉据此过滤。 */
  taskType?: string | null;
  background: boolean;
  parentTaskId?: string | null;
  depth: number;
  startedAt: number;
  endedAt?: number | null;
  summary?: string | null;
  durationMs?: number | null;
  toolUses?: number | null;
}

/** 主线程当前思考的实时快照（Claude thinking 块）。不落盘、不进聊天记录：
 * 长回合里模型可能思考几十分钟才输出一句正文，界面靠它证明模型仍在推进。 */
export interface AiThinking {
  /** 思考正文（服务端只保留尾部若干字符）。 */
  text: string;
  startedAt: number;
  updatedAt: number;
  /** 是否仍在输出：思考块结束后为 false。 */
  active: boolean;
  /** 本回合已开始的思考段数。 */
  blocks: number;
  /** 本回合思考累计字符数（截断前统计）。 */
  totalChars: number;
}

/** 会话中途切换模型的记录；分段位置即切换发生的时间点。 */
export interface AiModelSwitch {
  fromProvider?: string | null;
  fromModel?: string | null;
  toProvider?: string | null;
  toModel?: string | null;
}

export interface AiApproval {
  id: string;
  method: string;
  details: unknown;
}

export interface PendingInput {
  text: string;
  requestId: string;
  /** 排队消息附带的图片：出队时随文本一起交给 CLI。 */
  images?: AiChatImage[];
}

export interface AiTokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  reasoningOutputTokens?: number | null;
}

export interface AiContextUsage {
  usedTokens?: number | null;
  windowTokens?: number | null;
  basis: string;
  usedSource?: string | null;
  windowSource?: string | null;
  updating: boolean;
}

export interface AiUsage {
  context: AiContextUsage;
  lastTurn?: (AiTokenUsage & { state: string; startedAt?: number | null; endedAt?: number | null }) | null;
  sessionTotal: AiTokenUsage & { coverage: string };
}

/** `system/init` 提供的命令清单，随会话启动刷新。Codex 无此机制。 */
/** ACP 动态配置项的可选值（模型、模式、推理强度等）。 */
export interface AiConfigOptionChoice {
  value: string;
  name: string;
  description?: string | null;
}

/** ACP 会话下发的动态配置项，前端据此渲染热切换下拉。 */
export interface AiConfigOption {
  id: string;
  name: string;
  category?: string | null;
  currentValue: string;
  options: AiConfigOptionChoice[];
}

export interface SlashCatalog {
  skills: string[];
  slashCommands: string[];
  terminalSlashCommands: string[];
}

export interface AiSession {
  id: string;
  title: string;
  provider: 'claude' | 'codex' | 'antigravity';
  providerId?: string | null;
  providerName?: string | null;
  projectPath: string;
  model?: string | null;
  status: 'idle' | 'running' | 'approval' | 'background' | 'stopping' | 'interrupted' | 'error' | string;
  messages: AiMessage[];
  approvals: AiApproval[];
  error?: string | null;
  /** 会话创建时刻（毫秒）：底部状态栏据此显示运行时长。旧会话为 0。 */
  createdAt?: number;
  updatedAt: number;
  revision: number;
  resultRevision: number;
  usage?: AiUsage | null;
  pendingInputs?: PendingInput[];
  slashCatalog?: SlashCatalog | null;
  /** 会话当前任务清单（TodoWrite 全量快照的直接投影）。 */
  todos?: AiTodo[];
  /** 本轮派发过的子代理状态。 */
  agents?: AiAgent[];
  /** 主线程当前思考的实时快照；无思考或回合结束时为 null。 */
  thinking?: AiThinking | null;
  /** 本会话发生过的上下文压缩次数。 */
  compactions?: number;
  /** 桌面端是否正打开着该会话（服务端运行时标记，不落盘）；手机端「已打开」据此展示。 */
  desktopOpen?: boolean;
  /** ACP 动态配置项（模型、模式、推理强度等）。 */
  configOptions?: AiConfigOption[];
}

export interface AiProviderOption {
  id: string;
  agent: 'claude' | 'codex' | 'antigravity' | string;
  name: string;
  isDefault: boolean;
  models: { id: string; label: string; effort: string }[];
}

export interface AiCatalog {
  providers: AiProviderOption[];
}

export interface CreateAiSession {
  provider: 'claude' | 'codex' | 'antigravity';
  providerId?: string | null;
  projectPath: string;
  model?: string | null;
  /** 从 CLI 历史会话恢复：绑定历史线程并预填最近消息。 */
  resumeSessionId?: string | null;
}

export interface SendAiMessage {
  text: string;
  requestId: string;
  /** 原生插话：直接把消息交给运行中的 CLI 进程，由它选择合适节点接收。 */
  steer?: boolean;
  /** 随消息发送的图片（base64）：服务端落盘后转为消息里的 AiChatImage。 */
  images?: SendAiChatImage[];
}

/** 发送时的图片：只传 base64 正文，服务端负责校验、落盘与格式转换。 */
export interface SendAiChatImage {
  data: string;
  mediaType: string;
  name: string;
}

export interface AnswerAiApproval {
  approvalId: string;
  decision: string;
  answers?: unknown;
}

/** CLI 历史会话条目（与手机、PC 历史面板共用）。 */
export interface AgentHistoryItem {
  sessionId: string;
  projectDir: string;
  filePath: string;
  title: string;
  customTitle: string | null;
  startedAt: number | null;
  updatedAt: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  starred: boolean;
  archived: boolean;
}

/** 实时推送帧：与 HTTP WS 的 `update` 帧同构。 */
export interface AiSessionUpdateFrame {
  type: 'update';
  session: AiSession;
  messages: AiMessage[];
}

/** 新建/恢复会话推送帧：桌面端据此在标签栏补开聊天标签（不抢焦点）。 */
export interface AiSessionCreatedFrame {
  type: 'created';
  session: AiSession;
}

export const AI_SESSION_UPDATE_EVENT = 'ai-session-update';
/** 新建或从历史恢复了一个原生会话（可能来自手机 App / 其他客户端）。 */
export const AI_SESSION_CREATED_EVENT = 'ai-session-created';
/** 会话被删除（可能来自其他客户端），payload 为会话 ID。 */
export const AI_SESSION_REMOVED_EVENT = 'ai-session-removed';

export const aiSessionList = () => invoke<AiSession[]>('ai_session_list');
/** 桌面端上报当前打开着的原生会话标签（整体替换）；手机「已打开」据此同步服务端。 */
export const setDesktopOpenSessions = (ids: string[]) =>
  invoke<void>('set_desktop_open_sessions', { ids });
export const aiSessionGet = (id: string) => invoke<AiSession>('ai_session_get', { id });
export const aiSessionCreate = (input: CreateAiSession) => invoke<AiSession>('ai_session_create', { input });
export const aiSessionSend = (id: string, input: SendAiMessage) => invoke<AiSession>('ai_session_send', { id, input });
export const aiSessionStop = (id: string) => invoke<void>('ai_session_stop', { id });
export const aiSessionForceStop = (id: string) => invoke<AiSession>('ai_session_force_stop', { id });
/** 空闲时切换供应商与模型（仅 Claude）；下一条消息以新配置 --resume 续接。 */
export const aiSessionSwitchModel = (id: string, providerId: string, model: string) =>
  invoke<AiSession>('ai_session_switch_model', { id, providerId, model });
/** ACP 会话内动态切换配置项（模型、模式、推理强度等），不重启进程。 */
export const aiSessionSetConfigOption = (id: string, configId: string, value: string) =>
  invoke<AiSession>('ai_session_set_config_option', { id, configId, value });
export const aiSessionAnswer = (id: string, input: AnswerAiApproval) => invoke<void>('ai_session_answer', { id, input });
export const aiSessionDelete = (id: string) => invoke<void>('ai_session_delete', { id });
export const aiSessionPendingUpdate = (id: string, requestId: string, text: string) =>
  invoke<AiSession>('ai_session_pending_update', { id, requestId, text });
export const aiSessionPendingDelete = (id: string, requestId: string) =>
  invoke<AiSession>('ai_session_pending_delete', { id, requestId });
export const aiSessionFlush = (id: string, requestId?: string) =>
  invoke<void>('ai_session_flush', { id, requestId: requestId ?? null });
export const aiCatalog = () => invoke<AiCatalog>('ai_catalog');
export const aiSessionHistory = (agent: 'claude' | 'codex', includeArchived = false, projectDir?: string) =>
  invoke<AgentHistoryItem[]>('ai_session_history', { agent, includeArchived, projectDir: projectDir ?? null });
export const aiSessionResumeHistory = (
  agent: 'claude' | 'codex',
  sessionId: string,
  providerId?: string | null,
  model?: string | null,
) => invoke<AiSession>('ai_session_resume_history', { agent, sessionId, providerId: providerId ?? null, model: model ?? null });
