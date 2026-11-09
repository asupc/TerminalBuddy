import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, SquareTerminal, TriangleAlert } from 'lucide-react';
import {
  AGENT_UPDATE_EVENT,
  listenTauri,
  terminalAgentHeartbeat,
  terminalAgentMessages,
  terminalAgentReply,
  terminalAgentSubscribe,
  terminalAgentUnsubscribe,
  type RelayReplayMessage,
  type TerminalAgentFrame,
  type TerminalAgentSession,
} from '../../services/tauri';
import { useAppStore, type RelayAgentTab } from '../../stores/appStore';
import { ChatMarkdown } from './ChatMarkdown';
import './AgentChat.css';

const REPLY_LIMIT = 2000;
const REPLY_COOLDOWN_MS = 3000;

const PHASE_LABEL: Record<string, string> = {
  attention: '等待确认',
  running: '执行中',
  idle: '空闲',
  completed: '已完成',
  failed: '失败',
  ended: '已结束',
  unknown: '未知',
};

/** 终端接力：只读镜像 + 受限回复；数据与手机端共用同一终端和 JSONL 转录。 */
export function RelayChatPage({ tab }: { tab: RelayAgentTab }) {
  const sessions = useAppStore(state => state.sessions);
  const setActiveSession = useAppStore(state => state.setActiveSession);
  const updateAgentTab = useAppStore(state => state.updateAgentTab);
  const closeAgentTab = useAppStore(state => state.closeAgentTab);
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [session, setSession] = useState<TerminalAgentSession | null>(null);
  const [messages, setMessages] = useState<RelayReplayMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 草稿存在 store 里：切换到其它会话/标签时本页会被卸载，组件内 state 会丢字。
  const draft = useAppStore(state => state.agentDrafts[tab.key] ?? '');
  const setAgentDraft = useAppStore(state => state.setAgentDraft);
  const setDraft = useCallback((text: string) => setAgentDraft(tab.key, text), [setAgentDraft, tab.key]);
  const [sending, setSending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const subscriptionRef = useRef<string | null>(null);
  const composing = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const terminalId = tab.terminalId;

  const applyFrame = useCallback((frame: TerminalAgentFrame) => {
    if (frame.terminalId !== terminalId) return;
    if (frame.session) setSession(frame.session);
    switch (frame.type) {
      case 'mirror':
      case 'rotated':
        setMessages(frame.messages ?? []);
        break;
      case 'append':
        setMessages(previous => {
          const seen = new Set(previous.map(message => message.seq));
          return [...previous, ...(frame.messages ?? []).filter(message => !seen.has(message.seq))];
        });
        break;
      case 'unavailable':
        setMessages([]);
        break;
      case 'error':
        // 终端真正关闭时标签自动关闭（§5.1）。
        if (frame.code === 'terminal_closed') { closeAgentTab(tab.key); return; }
        setError(frame.message ?? '终端会话不可用');
        break;
      default:
        break;
    }
  }, [terminalId]);

  const subscribe = useCallback(async () => {
    try {
      const outcome = await terminalAgentSubscribe(terminalId);
      subscriptionRef.current = outcome.subscriptionId;
      applyFrame(outcome.initialFrame);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [applyFrame, terminalId, closeAgentTab, tab.key]);

  useEffect(() => {
    let disposed = false;
    setError(null);
    terminalAgentMessages(terminalId).then(page => {
      if (disposed) return;
      setSession(page.session);
      setMessages(page.messages);
    }).catch(reason => { if (!disposed) setError(String(reason)); });
    void subscribe();
    const unlisten = listenTauri<TerminalAgentFrame>(AGENT_UPDATE_EVENT, frame => {
      if (disposed) return;
      // 事件通道全局广播：只处理发往本租约的帧。
      const lease = subscriptionRef.current;
      if (lease && frame.subscriptionIds && !frame.subscriptionIds.includes(lease)) return;
      applyFrame(frame);
    });
    return () => {
      disposed = true;
      void unlisten.then(off => off());
      const lease = subscriptionRef.current;
      subscriptionRef.current = null;
      if (lease) void terminalAgentUnsubscribe(terminalId, lease).catch(() => {});
    };
  }, [applyFrame, subscribe, terminalId]);

  // 事件租约 30 秒过期：每 15 秒续租，失效则重新订阅拿首帧。
  useEffect(() => {
    const timer = setInterval(async () => {
      const lease = subscriptionRef.current;
      if (!lease) return;
      try {
        const { alive } = await terminalAgentHeartbeat([{ terminalId, subscriptionId: lease }]);
        if (!alive.some(item => item.subscriptionId === lease)) await subscribe();
      } catch {
        // 心跳失败不打扰用户，下一轮重试。
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [subscribe, terminalId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session) return;
    updateAgentTab(tab.key, { title: session.title || session.profileName, provider: session.provider === 'codex' ? 'codex' : 'claude' });
  }, [session?.title, session?.provider, tab.key, updateAgentTab]);

  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, messages[messages.length - 1]?.text]);

  const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const canReply = session?.canReply === true && !sending && cooldownRemaining === 0;
  const terminalOpen = sessions.some(item => item.id === terminalId);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (text.length > REPLY_LIMIT) { setError(`回复不能超过 ${REPLY_LIMIT} 字`); return; }
    if (/^[/!@#]/.test(text)) { setError('接力回复不支持 /、!、@、# 开头的输入，请回到终端操作'); return; }
    if (!session?.canReply) { setError(session?.replyBlockedReason ?? '当前阶段不可回复'); return; }
    setSending(true);
    setError(null);
    try {
      await terminalAgentReply(terminalId, text, crypto.randomUUID());
      setDraft('');
      stickToBottom.current = true;
      setCooldownUntil(Date.now() + REPLY_COOLDOWN_MS);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSending(false);
    }
  }, [draft, sending, session?.canReply, session?.replyBlockedReason, terminalId, setDraft]);

  const onScroll = useCallback(() => {
    const element = bottomRef.current?.parentElement;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, []);

  const statusText = useMemo(() => {
    if (!session) return '正在读取会话…';
    return PHASE_LABEL[session.phase] ?? session.phase;
  }, [session]);

  const openTerminal = useCallback(() => {
    if (!terminalOpen) return;
    setActiveSession(terminalId);
    useAppStore.getState().setActiveSpecialTab(null);
  }, [setActiveSession, terminalId, terminalOpen]);

  return (
    <div className="agent-chat-page relay">
      <header className="agent-chat-header">
        <div className="agent-chat-heading">
          <SquareTerminal className="agent-chat-icon" aria-hidden="true" />
          <div className="agent-chat-titles">
            <div className="agent-chat-title">
              <span className="agent-relay-badge">AGENT</span>
              {session?.title || session?.profileName || tab.title}
            </div>
            <div className="agent-chat-subtitle">
              <span className={`agent-status-badge ${session?.phase ?? 'unknown'}`}>{statusText}</span>
              <span className="agent-chat-meta">{session?.provider === 'codex' ? 'Codex' : 'Claude Code'}</span>
              {session?.model && <span className="agent-chat-meta">{session.model}</span>}
              {session?.directory && <span className="agent-chat-meta agent-chat-path" title={session.directory}>{session.directory}</span>}
            </div>
          </div>
        </div>
        <div className="agent-chat-header-actions">
          <div className="agent-view-switch" role="tablist" aria-label="查看方式">
            <button role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>
              <MessageSquare aria-hidden="true" />对话
            </button>
            <button role="tab" aria-selected={view === 'terminal'} className={view === 'terminal' ? 'active' : ''} onClick={() => setView('terminal')}>
              <SquareTerminal aria-hidden="true" />终端
            </button>
          </div>
        </div>
      </header>

      {view === 'terminal' ? (
        <div className="agent-terminal-view">
          <TriangleAlert aria-hidden="true" />
          <div>接力标签与终端渲染的是同一个 PTY，为避免重复挂载 xterm，请在终端标签中查看。</div>
          <button className="agent-btn primary" disabled={!terminalOpen} onClick={openTerminal}>
            {terminalOpen ? '切换到终端标签' : '终端已关闭'}
          </button>
        </div>
      ) : (
        <>
          <div className="agent-chat-messages" onScroll={onScroll}>
            {session?.mirror.available === false && (
              <div className="agent-chat-error">
                镜像不可用：{session.mirror.reason ?? '无法读取转录'}
              </div>
            )}
            {messages.length === 0 && !error && <div className="agent-chat-empty">暂无对话内容</div>}
            {messages.map(message => (
              message.role === 'user' ? (
                <div key={message.seq} className="agent-bubble-row user">
                  <div className="agent-bubble user">{message.text}</div>
                </div>
              ) : message.role === 'assistant' ? (
                <div key={message.seq} className="agent-bubble-row assistant">
                  <div className="agent-bubble assistant"><ChatMarkdown text={message.text} /></div>
                </div>
              ) : (
                <div key={message.seq} className="agent-tool-entry"><div className="agent-tool-header"><span className="agent-tool-title">{message.toolName || '工具输出'}</span></div></div>
              )
            ))}
            {error && <div className="agent-chat-error">{error}</div>}
            <div ref={bottomRef} />
          </div>

          <footer className="agent-chat-composer">
            <div className="agent-input-wrap">
              <textarea
                className="agent-input"
                value={draft}
                rows={3}
                maxLength={REPLY_LIMIT}
                placeholder={session?.canReply === false
                  ? (session.replyBlockedReason ?? '当前阶段不可回复')
                  : `受限回复（最多 ${REPLY_LIMIT} 字，3 秒冷却，不支持 / ! @ #）`}
                onChange={event => setDraft(event.target.value)}
                onScroll={onScroll}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; }}
                onKeyDown={event => {
                  if (composing.current || event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
                }}
              />
              <div className="agent-input-bar">
                <span className="agent-context-usage">{draft.length} / {REPLY_LIMIT}</span>
                <button className="agent-btn primary" disabled={!canReply || !draft.trim()} onClick={() => { void send(); }}>
                  <Send aria-hidden="true" />
                  {cooldownRemaining > 0 ? `${cooldownRemaining}s` : '发送'}
                </button>
              </div>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
