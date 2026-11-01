// terminalAgentProtocol.mjs 的类型声明：协议模块本身是纯 JS（node 直跑测试 / 浏览器与
// 桌面两种构建共用），tsc 通过本声明文件获得严格类型，不需要 allowJs。
export type AgentFrameType = 'mirror' | 'append' | 'status' | 'rotated' | 'unavailable' | 'error';

export interface AgentReplayTool {
  name: string;
  summary?: string | null;
}

export interface AgentReplayMessage {
  seq: number;
  role: string;
  timestamp?: number | null;
  text: string;
  tools: AgentReplayTool[];
  toolName?: string | null;
}

export interface AgentMirrorStatus {
  available: boolean;
  reason?: string | null;
}

export interface AgentSessionMeta {
  terminalId: string;
  profileName: string;
  terminalType: string;
  directory?: string | null;
  provider: string;
  sessionId: string;
  title?: string | null;
  model?: string | null;
  phase: string;
  phaseAt?: number | null;
  lastActivityAt?: number | null;
  pendingDecisionId?: string | null;
  pendingDecisionCount: number;
  canReply: boolean;
  replyBlockedReason?: string | null;
  revision: number;
  mirror: AgentMirrorStatus;
}

export interface AgentSnapshotCore {
  messages?: AgentReplayMessage[];
  revision?: number;
  cursor?: number;
  total?: number;
  truncated?: boolean;
  hasMore?: boolean;
  nextCursor?: number;
  oldestRetainedSeq?: number | null;
}

export interface AgentFrame extends AgentSnapshotCore {
  type: AgentFrameType;
  terminalId: string;
  session?: AgentSessionMeta;
  reason?: string;
  code?: string;
  message?: string;
  subscriptionIds?: string[];
}

export interface AgentPage extends AgentSnapshotCore {
  session: AgentSessionMeta;
  messages: AgentReplayMessage[];
  cursor: number;
  total: number;
  truncated: boolean;
  hasMore: boolean;
  nextCursor: number;
  resetRequired: boolean;
}

export interface AgentSyncState {
  terminalId: string | null;
  session: AgentSessionMeta | null;
  revision: number | null;
  mirrorAvailable: boolean;
  unavailableReason: string | null;
  messages: AgentReplayMessage[];
  cursor: number;
  total: number;
  truncated: boolean;
  oldestRetainedSeq: number | null;
  generation: number;
  lastError: { code: string; message: string } | null;
}

export interface ApplyOptions {
  expectedTerminalId?: string;
}

export interface ApplyPageOptions extends ApplyOptions {
  mode?: 'snapshot' | 'incremental';
}

export declare function createSyncState(): AgentSyncState;
export declare function applyFrame(state: AgentSyncState, frame: AgentFrame, options?: ApplyOptions): AgentSyncState;
export declare function applyPage(state: AgentSyncState, page: AgentPage, options?: ApplyPageOptions): AgentSyncState;
