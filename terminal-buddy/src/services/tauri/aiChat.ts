import { invoke } from '@tauri-apps/api/core';

/** 原生 AI 会话：与后端 `models/ai_chat.rs` 对应（camelCase 序列化）。 */
export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | string;
  text: string;
  createdAt: number;
  /** Skill 展开的消息：Skill 名称。普通消息不携带该字段。 */
  skillName?: string;
}

export interface AiApproval {
  id: string;
  method: string;
  details: unknown;
}

export interface PendingInput {
  text: string;
  requestId: string;
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
  lastTurn?: (AiTokenUsage & { state: string }) | null;
  sessionTotal: AiTokenUsage & { coverage: string };
}

/** `system/init` 提供的命令清单，随会话启动刷新。Codex 无此机制。 */
export interface SlashCatalog {
  skills: string[];
  slashCommands: string[];
  terminalSlashCommands: string[];
}

export interface AiSession {
  id: string;
  title: string;
  provider: 'claude' | 'codex';
  providerId?: string | null;
  providerName?: string | null;
  projectPath: string;
  model?: string | null;
  status: 'idle' | 'running' | 'approval' | 'background' | 'stopping' | 'interrupted' | 'error' | string;
  messages: AiMessage[];
  approvals: AiApproval[];
  error?: string | null;
  updatedAt: number;
  revision: number;
  resultRevision: number;
  usage?: AiUsage | null;
  pendingInputs?: PendingInput[];
  slashCatalog?: SlashCatalog | null;
}

export interface AiProviderOption {
  id: string;
  agent: 'claude' | 'codex' | string;
  name: string;
  isDefault: boolean;
  models: { id: string; label: string; effort: string }[];
}

export interface AiCatalog {
  providers: AiProviderOption[];
}

export interface CreateAiSession {
  provider: 'claude' | 'codex';
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

export const AI_SESSION_UPDATE_EVENT = 'ai-session-update';
/** 会话被删除（可能来自其他客户端），payload 为会话 ID。 */
export const AI_SESSION_REMOVED_EVENT = 'ai-session-removed';

export const aiSessionList = () => invoke<AiSession[]>('ai_session_list');
export const aiSessionGet = (id: string) => invoke<AiSession>('ai_session_get', { id });
export const aiSessionCreate = (input: CreateAiSession) => invoke<AiSession>('ai_session_create', { input });
export const aiSessionSend = (id: string, input: SendAiMessage) => invoke<AiSession>('ai_session_send', { id, input });
export const aiSessionStop = (id: string) => invoke<void>('ai_session_stop', { id });
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
