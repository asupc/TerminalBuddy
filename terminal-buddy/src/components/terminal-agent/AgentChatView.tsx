// Agent 会话视图（§5.2 对话页 · 网页版对齐）：
// - 只读镜像气泡：user 右 / assistant 左（Markdown）/ tool 折叠 / system 灰色；
// - 顶部标题、模型、阶段与「最后活动 N 分钟前」；不显示 token 用量（终端会话没有 usage）；
// - Codex 固定只读标记；输入框默认开，canReply=false 禁用并显示 replyBlockedReason；
// - 待决策按钮把 pendingDecisionId 经 App 层回调转给根 ClaudeDecisionDialog，本面板不弹窗；
// - 回复发送后本地「已输入到终端」→ 同 revision 镜像出现匹配 user 消息变「已送达」，
//   10 秒未出现提示「可能未生效，请打开终端确认」，不自动重发。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, RefreshCw, Send } from 'lucide-react';
import {
  asTerminalAgentError,
  createSyncState,
  generateRequestId,
  normalizeReplyText,
  replyTerminalAgent,
  TerminalAgentMirrorController,
  validateReplyText,
  type AgentMirrorStatusKind,
  type AgentSyncState,
} from '../../services/terminalAgent';
import { useAppStore } from '../../stores/appStore';
import { AgentMarkdown } from './AgentMarkdown';
import { agentSessionTitle, formatRelativeTime, mirrorReasonText, phaseClass, phaseLabel, providerLabel } from './agentViewHelpers';

/** 镜像出现同文 user 消息的等待窗口；超时只提示，不自动重发。 */
const DELIVERY_TIMEOUT_MS = 10_000;

interface PendingReply {
  requestId: string;
  text: string;
  /** 发送时的镜像代次与sessionId：仅在相同 revision / 会话中匹配送达。 */
  revision: number | null;
  sessionId: string | null;
  /** 发送前已存在的同文 user 消息 seq：历史里的旧消息不算送达。 */
  knownSeqs: Set<number>;
  sentAt: number;
  /** sent＝已输入到终端（等待镜像确认）；timeout＝10 秒未送达提示。送达即整条移除。 */
  status: 'sent' | 'timeout';
}

interface SendError {
  message: string;
  decisionId?: string;
  retryAfter?: number;
}

interface AgentChatViewProps {
  terminalId: string;
  /** 面板当前可见且在最前：不可见时退订租约、停止心跳。 */
  isActive: boolean;
  onBack: () => void;
  onFocusDecision?: (decisionId: string) => void;
}

function formatClock(millis: number | null | undefined): string {
  if (typeof millis !== 'number' || !Number.isFinite(millis)) return '';
  return new Date(millis).toLocaleTimeString('zh-CN', { hour12: false });
}

const PENDING_STATUS_TEXT: Record<PendingReply['status'], string> = {
  sent: '已输入到终端',
  timeout: '可能未生效，请打开终端确认',
};

export function AgentChatView({ terminalId, isActive, onBack, onFocusDecision }: AgentChatViewProps) {
  const sessions = useAppStore(s => s.sessions);
  const [syncState, setSyncState] = useState<AgentSyncState>(() => createSyncState());
  const [connStatus, setConnStatus] = useState<AgentMirrorStatusKind>('connecting');
  const [connDetail, setConnDetail] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pendings, setPendings] = useState<PendingReply[]>([]);
  const [sendError, setSendError] = useState<SendError | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const controllerRef = useRef<TerminalAgentMirrorController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const session = syncState.session;
  const provider = session?.provider;
  const isCodex = provider === 'codex';
  const pendingDecisionCount = session?.pendingDecisionCount ?? 0;
  const pendingDecisionId = session?.pendingDecisionId ?? null;
  const canReply = Boolean(session?.canReply) && !isCodex && pendingDecisionCount === 0;
  const hasAttentionWithoutDecision = session?.phase === 'attention' && pendingDecisionCount === 0;
  const inputDisabled = !canReply || sending || !syncState.mirrorAvailable;
  const localTerminalExists = sessions.some(item => item.id === terminalId);

  // 租约生命周期：terminalId 变化重建控制器；isActive 控制 start/stop（StrictMode 安全）。
  useEffect(() => {
    const controller = new TerminalAgentMirrorController(terminalId, {
      onState: setSyncState,
      onStatus: (status, detail) => {
        setConnStatus(status);
        setConnDetail(detail ?? '');
      },
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.stop();
    };
  }, [terminalId]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (isActive) controller.start();
    else controller.stop();
  }, [isActive, terminalId]);

  // 相对时间每 30 秒刷新一次。
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [isActive]);

  // 超时判定：只翻状态，不重发。
  useEffect(() => {
    const timer = setInterval(() => {
      setPendings(previous => {
        let changed = false;
        const next = previous.map(pending => {
          if (pending.status === 'sent' && Date.now() - pending.sentAt >= DELIVERY_TIMEOUT_MS) {
            changed = true;
            return { ...pending, status: 'timeout' as const };
          }
          return pending;
        });
        return changed ? next : previous;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 送达判定：同 revision / sessionId 的镜像里出现新的同文 user 消息即视为送达。
  // 送达后立即移除本地 pending——镜像里已有这条 user 气泡，保留会双份同屏。
  useEffect(() => {
    setPendings(previous => {
      if (!previous.some(pending => pending.status === 'sent')) return previous;
      let changed = false;
      const next: PendingReply[] = [];
      for (const pending of previous) {
        if (pending.status !== 'sent') {
          next.push(pending);
          continue;
        }
        if (syncState.revision !== null && syncState.revision === pending.revision
          && (!session || pending.sessionId === null || session.sessionId === pending.sessionId)) {
          const normalized = normalizeReplyText(pending.text);
          const delivered = syncState.messages.some(message =>
            message.role === 'user'
            && !pending.knownSeqs.has(message.seq)
            && normalizeReplyText(message.text) === normalized);
          if (delivered) {
            changed = true;
            continue;
          }
        }
        next.push(pending);
      }
      return changed ? next : previous;
    });
  }, [syncState, session]);

  // 消息增长时若本就贴底则自动跟随滚动。
  const messageCount = syncState.messages.length + pendings.length;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !nearBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [messageCount]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    nearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }, []);

  const handleRefresh = useCallback(() => {
    controllerRef.current?.refresh();
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft;
    if (sending || inputDisabled) return;
    const invalid = validateReplyText(text);
    if (invalid) {
      setSendError({ message: invalid });
      return;
    }
    const requestId = generateRequestId();
    const currentRevision = syncState.revision;
    const normalized = normalizeReplyText(text);
    const knownSeqs = new Set(
      syncState.messages.filter(message => message.role === 'user' && normalizeReplyText(message.text) === normalized).map(message => message.seq),
    );
    setDraft('');
    setSendError(null);
    setSending(true);
    setPendings(previous => [...previous, {
      requestId,
      text,
      revision: currentRevision,
      sessionId: session?.sessionId ?? null,
      knownSeqs,
      sentAt: Date.now(),
      status: 'sent',
    }]);
    try {
      await replyTerminalAgent({ terminalId, text, requestId });
      // 不返回 delivered：送达由镜像判定（§4.6）。
    } catch (error) {
      const structured = asTerminalAgentError(error);
      setSendError({
        message: structured?.message ?? String(error),
        ...(structured?.decisionId ? { decisionId: structured.decisionId } : {}),
        ...(structured?.retryAfter !== undefined ? { retryAfter: structured.retryAfter } : {}),
      });
      // 写入结果未知时不自动重发：保留文本让用户确认后用新 requestId 手动重试。
      setPendings(previous => previous.filter(pending => pending.requestId !== requestId));
      setDraft(text);
    } finally {
      setSending(false);
    }
  }, [draft, sending, inputDisabled, syncState, session, terminalId]);

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSend();
    }
  };

  const handleFocusTerminal = useCallback(() => {
    const store = useAppStore.getState();
    if (!store.sessions.some(item => item.id === terminalId)) return;
    store.setActiveSession(terminalId);
  }, [terminalId]);

  const title = agentSessionTitle(session?.title, session?.sessionId);
  const lastActivityText = formatRelativeTime(session?.lastActivityAt, nowTick);
  const replyBlockedReason = session?.replyBlockedReason ?? null;

  const renderedMessages = useMemo(() => syncState.messages.map(message => {
    if (message.role === 'tool') {
      return (
        <div key={message.seq} className="ta-msg tool" data-seq={message.seq}>
          <details className="ta-tool">
            <summary>
              <span className="ta-tool-name">{message.toolName || '工具'}</span>
              <span className="ta-tool-summary">{message.tools.map(tool => `${tool.name}${tool.summary ? ` · ${tool.summary}` : ''}`).join('；') || '工具结果'}</span>
            </summary>
            <pre className="ta-tool-text">{message.text}</pre>
          </details>
        </div>
      );
    }
    if (message.role === 'system') {
      return (
        <div key={message.seq} className="ta-msg system" data-seq={message.seq}>
          <div className="ta-system-text">{message.text}</div>
        </div>
      );
    }
    const isUser = message.role === 'user';
    const long = message.text.length > 1200 || message.text.split('\n').length > 18;
    return (
      <div key={message.seq} className={`ta-msg ${isUser ? 'user' : 'assistant'}`} data-seq={message.seq}>
        <div className="ta-bubble" title={formatClock(message.timestamp) || undefined}>
          {long ? (
            <details className="ta-long-text">
              <summary>{message.text.slice(0, 160).replace(/\s+/g, ' ')}… <span>展开完整内容（{message.text.length} 字）</span></summary>
              {isUser ? <div className="ta-plain-text">{message.text}</div> : <AgentMarkdown text={message.text} />}
            </details>
          ) : (
            message.text
              ? (isUser ? <div className="ta-plain-text">{message.text}</div> : <AgentMarkdown text={message.text} />)
              : null
          )}
          {message.tools.length > 0 && (
            <div className="ta-tool-chips">
              {message.tools.map((tool, index) => (
                <span key={`${message.seq}-${index}`} className="ta-tool-chip" title={tool.summary ?? undefined}>
                  {tool.name}{tool.summary ? ` · ${tool.summary}` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }), [syncState.messages]);

  return (
    <div className="ta-chat">
      <div className="ta-chat-head">
        <button type="button" className="ta-back" onClick={onBack} title="返回 Agent 列表" aria-label="返回 Agent 列表">
          <ArrowLeft size={15} />
        </button>
        <div className="ta-chat-title-block">
          <div className="ta-chat-title" title={title}>{title}</div>
          <div className="ta-chat-sub">
            <span className={`ta-provider-badge ${(provider ?? 'unknown').toLowerCase()}`}>{providerLabel(provider)}</span>
            {session?.model && <span className="ta-chat-model">{session.model}</span>}
            {session?.directory && <span className="ta-chat-dir" title={session.directory}>{session.directory}</span>}
          </div>
        </div>
        <div className="ta-chat-status">
          <span className={`ta-phase ${phaseClass(session?.phase)}`}>{phaseLabel(session?.phase)}</span>
          {lastActivityText && <span className="ta-last-activity">最后活动 {lastActivityText}</span>}
          <span className={`ta-conn ${connStatus}`} title={connDetail || connStatusLabel(connStatus)}>
            {connStatusLabel(connStatus)}
          </span>
          <button type="button" className="ta-refresh" onClick={handleRefresh} title="重新同步（以最新快照重建）" aria-label="重新同步">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {(pendingDecisionCount > 0 || hasAttentionWithoutDecision) && (
        <div className="ta-decision-bar">
          {pendingDecisionId ? (
            <button
              type="button"
              className="ta-decision-button"
              onClick={() => onFocusDecision?.(pendingDecisionId)}
            >
              有 {pendingDecisionCount} 项待确认 · 点击处理
            </button>
          ) : (
            <span className="ta-decision-hint">Agent 正在等待终端内的确认，请打开终端处理</span>
          )}
        </div>
      )}

      <div className="ta-messages" ref={scrollRef} onScroll={handleScroll}>
        {connStatus === 'failed' && (
          <div className="ta-banner error" role="alert">
            {connDetail ? `同步失败：${connDetail}` : '同步失败'}
            {localTerminalExists && <button type="button" className="ta-banner-action" onClick={handleFocusTerminal}>在终端中查看</button>}
          </div>
        )}
        {!syncState.mirrorAvailable && (
          <div className="ta-banner warn" role="status">
            {mirrorReasonText(syncState.unavailableReason)}
            {localTerminalExists && <button type="button" className="ta-banner-action" onClick={handleFocusTerminal}>打开终端</button>}
          </div>
        )}
        {syncState.mirrorAvailable && syncState.messages.length === 0 && connStatus === 'live' && (
          <div className="ta-empty">会话内容为空，等待 Agent 输出…</div>
        )}
        {syncState.lastError && (
          <div className="ta-banner error" role="alert">{syncState.lastError.message}</div>
        )}
        {syncState.truncated && (
          <div className="ta-truncated">仅显示最近的消息（共 {syncState.total} 条）</div>
        )}
        {renderedMessages}
        {pendings.map(pending => (
          <div key={pending.requestId} className="ta-msg user">
            <div className="ta-bubble">
              <div className="ta-plain-text">{pending.text}</div>
              <div className={`ta-pending-status ${pending.status}`}>{PENDING_STATUS_TEXT[pending.status]}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="ta-composer">
        {isCodex && <div className="ta-readonly-note">Codex · 暂不支持在此确认与回复</div>}
        {!isCodex && !session?.canReply && replyBlockedReason && (
          <div className="ta-readonly-note">{replyBlockedReason}</div>
        )}
        {sendError && (
          <div className="ta-send-error" role="alert">
            <span>{sendError.message}</span>
            {sendError.decisionId && (
              <button type="button" className="ta-banner-action" onClick={() => onFocusDecision?.(sendError.decisionId!)}>
                去处理待确认
              </button>
            )}
          </div>
        )}
        <div className="ta-composer-row">
          <textarea
            className="ta-input"
            value={draft}
            rows={2}
            placeholder={inputPlaceholder(inputDisabled, isCodex, hasAttentionWithoutDecision, replyBlockedReason)}
            disabled={inputDisabled}
            onChange={event => {
              setDraft(event.target.value);
              setSendError(null);
            }}
            onKeyDown={handleDraftKeyDown}
          />
          <button
            type="button"
            className="ta-send"
            disabled={inputDisabled || !draft.trim()}
            onClick={() => void handleSend()}
            title="发送（Enter 换行用 Shift+Enter）"
          >
            <Send size={14} />
            发送
          </button>
        </div>
        <div className="ta-composer-hint">单行纯文本，直接注入终端；忙碌时可能排队，送达以镜像为准</div>
      </div>
    </div>
  );
}

function connStatusLabel(status: AgentMirrorStatusKind): string {
  if (status === 'connecting') return '连接中';
  if (status === 'live') return '实时同步';
  if (status === 'reconnecting') return '重新连接中';
  return '同步中断';
}

function inputPlaceholder(
  disabled: boolean,
  isCodex: boolean,
  attentionWithoutDecision: boolean,
  replyBlockedReason: string | null,
): string {
  if (!disabled) return '回复一句给终端里的 Agent…（Enter 发送）';
  if (isCodex) return 'Codex 暂不支持回复';
  if (attentionWithoutDecision) return 'Agent 正在等待终端内的确认，暂不能回复';
  if (replyBlockedReason) return replyBlockedReason;
  return '当前不可回复';
}
