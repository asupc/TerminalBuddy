import { invoke } from '@tauri-apps/api/core';

/** 终端 Agent 接力的对外协议（与后端 `services/terminal_agent_relay.rs` 对应）。 */
export interface MirrorStatus {
  available: boolean;
  reason?: string;
}

export interface TerminalAgentSession {
  terminalId: string;
  profileName: string;
  terminalType: string;
  directory?: string;
  provider: 'claude' | 'codex' | string;
  sessionId: string;
  title?: string;
  model?: string;
  /** attention / running / idle / completed / failed / ended / unknown */
  phase: string;
  phaseAt?: number;
  lastActivityAt?: number;
  pendingDecisionId?: string;
  pendingDecisionCount: number;
  canReply: boolean;
  replyBlockedReason?: string;
  revision: number;
  mirror: MirrorStatus;
}

export interface RelayReplayTool {
  name: string;
  summary: string;
}

export interface RelayReplayMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  timestamp: number | null;
  text: string;
  tools: RelayReplayTool[];
  toolName: string | null;
  /** Skill 展开条目：正文为技能全文，值为技能名。普通消息为 null / 缺省。 */
  skillName?: string | null;
}

export interface TerminalAgentPage {
  session: TerminalAgentSession;
  messages: RelayReplayMessage[];
  cursor: number;
  total: number;
  truncated: boolean;
  hasMore: boolean;
  nextCursor: number;
  oldestRetainedSeq?: number;
  resetRequired: boolean;
}

/** 推送帧：mirror / append / status / rotated / unavailable / error。 */
export interface TerminalAgentFrame {
  type: string;
  terminalId: string;
  session?: TerminalAgentSession;
  messages?: RelayReplayMessage[];
  revision?: number;
  cursor?: number;
  total?: number;
  truncated?: boolean;
  hasMore?: boolean;
  nextCursor?: number;
  oldestRetainedSeq?: number;
  reason?: string;
  code?: string;
  message?: string;
  /** 事件通道附带：本帧发往的仍有效的租约，客户端按句柄过滤。 */
  subscriptionIds?: string[];
}

export interface SubscribeOutcome {
  subscriptionId: string;
  initialFrame: TerminalAgentFrame;
}

export interface ReplyOutcome {
  accepted: boolean;
  duplicated: boolean;
  phase: string;
  at: number;
}

export interface HeartbeatLease {
  terminalId: string;
  subscriptionId: string;
}

/** 桌面 React / 浏览器事件通道的事件名。 */
export const AGENT_UPDATE_EVENT = 'terminal-agent-update';

export const terminalAgentList = () => invoke<TerminalAgentSession[]>('terminal_agent_list');
export const terminalAgentMessages = (terminalId: string, afterSeq?: number, limit?: number, revision?: number) =>
  invoke<TerminalAgentPage>('terminal_agent_messages', {
    terminalId,
    afterSeq: afterSeq ?? null,
    limit: limit ?? null,
    revision: revision ?? null,
  });
export const terminalAgentReply = (terminalId: string, text: string, requestId: string) =>
  invoke<ReplyOutcome>('terminal_agent_reply', { terminalId, text, requestId });
export const terminalAgentSubscribe = (terminalId: string) =>
  invoke<SubscribeOutcome>('terminal_agent_subscribe', { terminalId });
export const terminalAgentUnsubscribe = (terminalId: string, subscriptionId: string) =>
  invoke<void>('terminal_agent_unsubscribe', { terminalId, subscriptionId });
export const terminalAgentHeartbeat = (subscriptions: HeartbeatLease[]) =>
  invoke<{ alive: HeartbeatLease[] }>('terminal_agent_heartbeat', { subscriptions });
