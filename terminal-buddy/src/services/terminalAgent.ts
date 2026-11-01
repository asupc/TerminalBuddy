// 终端 Agent 会话接力 · 前端服务层（设计文档 §4.10 / §5.5）。
// - 6 个 Tauri 命令的 typed wrapper：桌面构建直连 Pc，浏览器构建经
//   /api/desktop/invoke 以 Web 身份执行（后端显式分支，前端无需关心身份）；
// - onAgentUpdate：terminal-agent-update 事件订阅（payload 是完整帧 + subscriptionIds）；
// - TerminalAgentMirrorController：租约 + 15 秒心跳 + 事件桥保活 + 断线/ web-resync 重建，
//   以 subscribe 返回的 initialFrame 为原子基准做协议归并（见 terminalAgentProtocol.mjs）。
import { invoke } from '@tauri-apps/api/core';
import { listenTauri } from './tauri/events';
import { pingEventBridge } from './browser/connection';
import {
  applyFrame,
  createSyncState,
  type AgentFrame,
  type AgentPage,
  type AgentReplayMessage,
  type AgentSessionMeta,
  type AgentSyncState,
} from './terminalAgentProtocol.mjs';

export { createSyncState };
export type { AgentFrame, AgentPage, AgentReplayMessage, AgentSessionMeta, AgentSyncState };

// ───────────────────────── 线上模型（camelCase，与后端 serde 对齐） ─────────────────────────

export type TerminalAgentProvider = 'claude' | 'codex' | 'pi';
export type TerminalAgentPhase = 'attention' | 'running' | 'idle' | 'completed' | 'failed' | 'ended' | 'unknown';

export interface TerminalAgentMirrorStatus {
  available: boolean;
  reason?: string | null;
}

export interface TerminalAgentSession {
  terminalId: string;
  profileName: string;
  terminalType: string;
  directory?: string | null;
  provider: TerminalAgentProvider;
  sessionId: string;
  title?: string | null;
  model?: string | null;
  phase: TerminalAgentPhase;
  phaseAt?: number | null;
  lastActivityAt?: number | null;
  pendingDecisionId?: string | null;
  pendingDecisionCount: number;
  canReply: boolean;
  replyBlockedReason?: string | null;
  /** 镜像重建代次：客户端只比较相等，不比较大小。 */
  revision: number;
  mirror: TerminalAgentMirrorStatus;
}

export interface TerminalAgentPage {
  session: TerminalAgentSession;
  messages: AgentReplayMessage[];
  cursor: number;
  total: number;
  truncated: boolean;
  hasMore: boolean;
  nextCursor: number;
  oldestRetainedSeq?: number | null;
  resetRequired: boolean;
}

export interface TerminalAgentReplyOutcome {
  accepted: boolean;
  duplicated: boolean;
  phase: string;
  at: number;
}

export interface TerminalAgentSubscribeOutcome {
  subscriptionId: string;
  initialFrame: AgentFrame;
}

export interface TerminalAgentHeartbeatLease {
  terminalId: string;
  subscriptionId: string;
}

export interface TerminalAgentHeartbeatOutcome {
  alive: TerminalAgentHeartbeatLease[];
}

/** 推送帧（事件 payload 与 initialFrame 同构；session 字段按宽松元数据处理）。 */
export type TerminalAgentUpdateFrame = AgentFrame;

// ───────────────────────── 结构化错误（§4.8 / §5.2） ─────────────────────────

export interface TerminalAgentCommandError {
  code: 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'too_many_requests' | 'internal' | string;
  message: string;
  decisionId?: string;
  retryAfter?: number;
  replyBlockedReason?: string;
}

/**
 * 把 invoke 抛出的错误规整为结构化命令错误。
 * 桌面构建：Tauri 直接 reject 序列化后的 {code, message, decisionId?, retryAfter?}；
 * 浏览器构建：shim 抛出的 InvokeError 实例（connection.ts）带同名字段。
 * 两者都不是时返回 null，调用方回退到 String(error)。
 */
export function asTerminalAgentError(error: unknown): TerminalAgentCommandError | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return {
    code: candidate.code,
    message: candidate.message,
    ...(typeof candidate.decisionId === 'string' ? { decisionId: candidate.decisionId } : {}),
    ...(typeof candidate.retryAfter === 'number' ? { retryAfter: candidate.retryAfter } : {}),
    ...(typeof candidate.replyBlockedReason === 'string' ? { replyBlockedReason: candidate.replyBlockedReason } : {}),
  };
}

export function describeTerminalAgentError(error: unknown): string {
  const structured = asTerminalAgentError(error);
  if (structured) {
    if (structured.retryAfter !== undefined) return `${structured.message}（${structured.retryAfter} 秒后可重试）`;
    return structured.message;
  }
  return String(error);
}

// ───────────────────────── 命令 wrapper ─────────────────────────

/** 可接力的终端会话列表（§4.2），按调用端身份过滤。 */
export function listTerminalAgents(): Promise<TerminalAgentSession[]> {
  return invoke<TerminalAgentSession[]>('terminal_agent_list');
}

export interface TerminalAgentMessagesArgs {
  terminalId: string;
  afterSeq?: number;
  limit?: number;
  revision?: number;
}

/** 消息页（§4.4）：不带 afterSeq 为首屏快照页。 */
export function fetchTerminalAgentMessages(args: TerminalAgentMessagesArgs): Promise<TerminalAgentPage> {
  return invoke<TerminalAgentPage>('terminal_agent_messages', { ...args });
}

/** 受限回复（§4.6）。失败时 reject 结构化错误（见 asTerminalAgentError）。 */
export function replyTerminalAgent(args: { terminalId: string; text: string; requestId: string }): Promise<TerminalAgentReplyOutcome> {
  return invoke<TerminalAgentReplyOutcome>('terminal_agent_reply', { ...args });
}

/** 建立带调用端身份的事件租约；首帧同步返回。 */
export function subscribeTerminalAgent(terminalId: string): Promise<TerminalAgentSubscribeOutcome> {
  return invoke<TerminalAgentSubscribeOutcome>('terminal_agent_subscribe', { terminalId });
}

/** 释放指定租约；重复释放幂等。 */
export function unsubscribeTerminalAgent(terminalId: string, subscriptionId: string): Promise<null> {
  return invoke<null>('terminal_agent_unsubscribe', { terminalId, subscriptionId });
}

/** 批量续租（30 秒）；返回仍然存活的租约。 */
export function heartbeatTerminalAgents(subscriptions: TerminalAgentHeartbeatLease[]): Promise<TerminalAgentHeartbeatOutcome> {
  return invoke<TerminalAgentHeartbeatOutcome>('terminal_agent_heartbeat', { subscriptions });
}

/** terminal-agent-update 事件：payload 是完整帧 + subscriptionIds（本帧发往的仍有效租约）。 */
export function onAgentUpdate(handler: (frame: TerminalAgentUpdateFrame) => void): Promise<() => void> {
  return listenTauri<TerminalAgentUpdateFrame>('terminal-agent-update', handler);
}

// ───────────────────────── 回复文本规则（§4.6 客户端预检） ─────────────────────────

/** requestId：8–64 位 [A-Za-z0-9_-]，每次发送新生成。 */
export function generateRequestId(length = 16): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const clamped = Math.min(Math.max(length, 8), 64);
  const bytes = new Uint8Array(clamped);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  let value = '';
  for (let index = 0; index < bytes.length; index += 1) value += alphabet[bytes[index] % alphabet.length];
  return value;
}

/** 与后端 §4.6 第 5 条对齐的本地预检：返回中文原因，null 表示可发送。 */
export function validateReplyText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return '回复内容不能为空';
  if ([...text].length > 2000) return '回复内容过长（最多 2000 个字符）';
  // 后端对 trim 后的首字符判 / ! @ #，这里保持一致（前导空格的 "/foo" 同样拦截）。
  if (/^[!#@/]/.test(trimmed)) return '回复不能以 / ! @ # 开头；斜杠命令等请在终端中使用';
  // Rust char::is_control 等价（C0 + DEL + C1 控制区），整体拒绝而非只拦 \r\n ESC
  if (/[\x00-\x1F\x7F-\x9F]/.test(text)) return '回复不能包含控制字符（换行、Tab、Ctrl 组合键等）';
  return null;
}

/** 送达判定的文本归一：压缩空白后比较（保留原文发送，不改动内容）。 */
export function normalizeReplyText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// ───────────────────────── 租约 / 心跳 / 重建管理 ─────────────────────────

export type AgentMirrorStatusKind = 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface AgentMirrorCallbacks {
  /** 归并状态变化（引用相等表示无变化，不会重复回调）。 */
  onState: (state: AgentSyncState) => void;
  onStatus?: (status: AgentMirrorStatusKind, detail?: string) => void;
}

/** 心跳间隔：续租 30 秒 TTL 的一半；同时给浏览器事件桥（30 秒空闲断开）保活。 */
const HEARTBEAT_INTERVAL_MS = 15000;
/** subscribe 瞬时失败（网络抖动等）后的重试退避；not_found / forbidden 不重试。 */
const RECONNECT_DELAY_MS = 5000;

/**
 * 单个终端的镜像租约管理器。
 *
 * 生命周期（§5.5 硬要求）：
 * - start()/stop() 幂等；stop 会作废所有在飞回调（generation 递增）并退还租约，
 *   React StrictMode 的 mount→unmount→remount 与快速切换终端都不会泄漏订阅；
 * - 页面隐藏（visibilitychange hidden）立即退订，重新可见时重新 subscribe，
 *   以 initialFrame 原子替换，不依赖旧 socket 续传；
 * - 事件桥断线（web-connected 重连）/ web-resync 一律重建租约；
 * - 心跳失败或 alive 不含当前句柄 → 先退订旧句柄再重新 subscribe。
 */
export class TerminalAgentMirrorController {
  private readonly terminalId: string;
  private readonly callbacks: AgentMirrorCallbacks;
  /** 每次 stop / 重建递增；所有异步回调先核对 generation 再生效。 */
  private generation = 0;
  private started = false;
  private subscriptionId: string | null = null;
  private state: AgentSyncState = createSyncState();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanups: Array<() => void> = [];
  private readonly handleVisibilityChange = () => {
    if (document.hidden) {
      // 页面隐藏：立即清理（退订 + 停心跳），保留 started 以便回来时重建。
      this.teardownConnection();
    } else if (this.started && !this.subscriptionId) {
      void this.connect();
    }
  };

  constructor(terminalId: string, callbacks: AgentMirrorCallbacks) {
    this.terminalId = terminalId;
    this.callbacks = callbacks;
  }

  /** 开始（或继续）维持租约；已启动时为 no-op。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.attachListeners();
    void this.connect();
  }

  /** 停止并清理：作废在飞回调、退还租约、移除监听。可重复调用。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.teardownConnection();
    this.detachListeners();
  }

  /** 手动刷新：退订旧句柄并重新 subscribe，以 initialFrame 原子替换。 */
  refresh(): void {
    if (!this.started) return;
    this.teardownConnection();
    void this.connect();
  }

  /** 当前归并状态（只读快照）。 */
  getSnapshot(): AgentSyncState {
    return this.state;
  }

  private attachListeners(): void {
    let disposed = false;
    let frameUnlisten: (() => void) | null = null;
    const frameHandler = (frame: TerminalAgentUpdateFrame) => {
      if (!this.started || !this.subscriptionId) return;
      // 只消费发给自己租约的帧；其他租约 / 失权帧立即忽略。
      if (frame.subscriptionIds && !frame.subscriptionIds.includes(this.subscriptionId)) return;
      this.applyToState(frame);
    };
    void onAgentUpdate(frameHandler).then(unlisten => {
      if (disposed) unlisten();
      else frameUnlisten = unlisten;
    }).catch(error => console.error('订阅 terminal-agent-update 失败:', error));

    const resyncHandler = () => {
      // 事件桥重连 / 容器对账后不假定旧租约仍有效：一律重建。
      if (this.started) this.refresh();
    };
    const resyncPromises = [
      listenTauri<void>('web-resync', resyncHandler),
      listenTauri<void>('web-connected', resyncHandler),
    ];
    const resyncUnlistens: Array<() => void> = [];
    for (const promise of resyncPromises) {
      void promise.then(unlisten => {
        if (disposed) unlisten();
        else resyncUnlistens.push(unlisten);
      }).catch(() => {});
    }

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.cleanups.push(() => {
      disposed = true;
      frameUnlisten?.();
      for (const unlisten of resyncUnlistens) unlisten();
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    });
  }

  private detachListeners(): void {
    while (this.cleanups.length > 0) this.cleanups.pop()?.();
  }

  private applyToState(frame: TerminalAgentUpdateFrame): void {
    const next = applyFrame(this.state, frame, { expectedTerminalId: this.terminalId });
    if (next === this.state) return;
    this.state = next;
    this.callbacks.onState(next);
  }

  /** 作废在飞回调并退还租约（不动 started / 监听器）。 */
  private teardownConnection(): void {
    this.generation += 1;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.releaseSubscription();
  }

  private releaseSubscription(): void {
    const subscriptionId = this.subscriptionId;
    this.subscriptionId = null;
    if (subscriptionId) {
      void unsubscribeTerminalAgent(this.terminalId, subscriptionId).catch(() => {});
    }
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    this.callbacks.onStatus?.(this.subscriptionId ? 'reconnecting' : 'connecting');
    try {
      const outcome = await subscribeTerminalAgent(this.terminalId);
      if (generation !== this.generation) {
        // stop / 重建已经发生：迟到租约立即退还，不投递任何状态。
        void unsubscribeTerminalAgent(this.terminalId, outcome.subscriptionId).catch(() => {});
        return;
      }
      this.subscriptionId = outcome.subscriptionId;
      this.applyToState(outcome.initialFrame);
      this.callbacks.onStatus?.('live');
      this.scheduleHeartbeat();
    } catch (error) {
      if (generation !== this.generation) return;
      const detail = describeTerminalAgentError(error);
      this.callbacks.onStatus?.('failed', detail);
      // 终端不存在 / 无运行中 Agent / 无权限：重试不会好转，等待用户操作（手动刷新 / 列表轮询）。
      const structured = asTerminalAgentError(error);
      if (structured?.code === 'not_found' || structured?.code === 'forbidden') return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.started && !this.subscriptionId) void this.connect();
      }, RECONNECT_DELAY_MS);
    }
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, HEARTBEAT_INTERVAL_MS);
  }

  private async heartbeat(): Promise<void> {
    const generation = this.generation;
    const subscriptionId = this.subscriptionId;
    if (!subscriptionId) return;
    // 事件桥（浏览器构建）30 秒无客户端消息即断开：心跳同时发 {type:"ping"} 保活，
    // 服务端把任何客户端帧当 activity；桌面构建里 eventSocket 恒为空，等价 no-op。
    pingEventBridge();
    try {
      const outcome = await heartbeatTerminalAgents([{ terminalId: this.terminalId, subscriptionId }]);
      if (generation !== this.generation) return;
      const alive = outcome.alive.some(
        lease => lease.terminalId === this.terminalId && lease.subscriptionId === subscriptionId,
      );
      if (!alive && this.started) {
        // 租约被回收 / 失权：先退订旧句柄再重新 subscribe，以 initialFrame 原子替换。
        this.refresh();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      console.error('终端 Agent 租约心跳失败，正在重建:', error);
      if (this.started) this.refresh();
    }
  }
}
