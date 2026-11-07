import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleStop, CornerDownLeft, Send, Trash2, Zap } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { ModelSwitcher } from './ModelSwitcher';
import { UsagePanel, cacheHitRate, compact } from './UsagePanel';
import {
  AI_SESSION_REMOVED_EVENT,
  AI_SESSION_UPDATE_EVENT,
  aiSessionAnswer,
  aiSessionDelete,
  aiSessionFlush,
  aiSessionGet,
  aiSessionList,
  aiSessionPendingDelete,
  aiSessionSend,
  aiSessionStop,
  aiSessionSwitchModel,
  aiCatalog,
  listenTauri,
  type AiMessage,
  type AiSession,
  type AiSessionUpdateFrame,
  type AiModelSwitch,
  type AnswerAiApproval,
  type SlashCatalog,
} from '../../services/tauri';
import { useAppStore, type NativeAgentTab } from '../../stores/appStore';
import { ChatMarkdown } from './ChatMarkdown';
import { SkillEntry } from './SkillEntry';
import { ApprovalCard } from './ApprovalCard';
import { filterSlashCommands, SlashCompletions } from './SlashCompletions';
import './AgentChat.css';

const STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  approval: '等待确认',
  background: '后台任务执行中',
  stopping: '正在中断',
  idle: '已完成',
  interrupted: '已中断',
  error: '出错',
};

function mergeSession(previous: AiSession | null, frame: AiSessionUpdateFrame): AiSession {
  if (!previous || frame.session.revision >= previous.revision) {
    const messages = previous ? [...previous.messages] : [];
    for (const message of frame.messages) {
      const index = messages.findIndex(item => item.id === message.id);
      if (index >= 0) messages[index] = message;
      else messages.push(message);
    }
    return { ...frame.session, messages };
  }
  return previous;
}

/**
 * 斜杠命令清单缓存：新会话要等第一次发送启动 CLI 后才有 system/init，
 * 这段时间先借用同一客户端最近一次拿到的清单，避免输入 / 没有补全。
 */
const SLASH_CATALOG_CACHE_KEY = 'agent-slash-catalog';

function readCachedCatalog(provider: string): SlashCatalog | null {
  try {
    const raw = localStorage.getItem(SLASH_CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, SlashCatalog | undefined>;
    return parsed[provider] ?? null;
  } catch {
    return null;
  }
}

function writeCachedCatalog(provider: string, catalog: SlashCatalog): void {
  try {
    const raw = localStorage.getItem(SLASH_CATALOG_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, SlashCatalog> : {};
    parsed[provider] = catalog;
    localStorage.setItem(SLASH_CATALOG_CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // 缓存失败不影响补全：会话自有 init 到达后仍会更新。
  }
}

function toolTitle(message: AiMessage): string {
  const newline = message.text.indexOf('\n');
  return (newline >= 0 ? message.text.slice(0, newline) : message.text).trim();
}

function ToolMessage({ message }: { message: AiMessage }) {
  const [open, setOpen] = useState(false);
  const newline = message.text.indexOf('\n');
  const title = message.text.slice(0, newline >= 0 ? newline : undefined);
  const body = newline >= 0 ? message.text.slice(newline + 1) : '';
  return (
    <div className={`agent-tool-entry${open ? ' open' : ''}`}>
      <button className="agent-tool-header" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <CornerDownLeft aria-hidden="true" />
        <span className="agent-tool-title">{title || '工具调用'}</span>
      </button>
      {open && body && <pre className="agent-tool-body">{body}</pre>}
    </div>
  );
}

/**
 * 连续的工具调用合并成一个可展开条目：多轮命令不再把对话刷成一长串工具名。
 * 单项工具仍直接展示命令，方便快速确认执行内容。
 */
function ToolGroup({ messages }: { messages: AiMessage[] }) {
  const [open, setOpen] = useState(false);
  const names = Array.from(new Set(messages.map(toolTitle).filter(Boolean)));
  const summary = names.slice(0, 3).join('、');
  return (
    <div className={`agent-tool-entry agent-tool-group${open ? ' open' : ''}`}>
      <button className="agent-tool-header" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <CornerDownLeft aria-hidden="true" />
        <span className="agent-tool-title">
          {messages.length} 个工具调用
          {summary && <span className="agent-tool-summary"> · {summary}{names.length > 3 ? ' 等' : ''}</span>}
        </span>
      </button>
      {open && (
        <div className="agent-tool-group-body">
          {messages.map(message => <ToolMessage key={message.id} message={message} />)}
        </div>
      )}
    </div>
  );
}

function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 模型切换分隔线：明示从这一段开始会话换用了哪个供应商与模型，
 * 之前的消息由切换前的配置产生。
 */
function ModelSwitchDivider({ at, info }: { at: number; info: AiModelSwitch }) {
  const from = [info.fromModel, info.fromProvider].filter(Boolean).join(' · ') || '服务端默认';
  const to = [info.toModel, info.toProvider].filter(Boolean).join(' · ');
  return (
    <div className="agent-model-divider" role="separator">
      <span className="agent-model-divider-time">{formatClock(at)}</span>
      <span className="agent-model-divider-rule" />
      <span className="agent-model-divider-text" title={`${from} → ${to}`}>
        模型切换：{from} → {to}
      </span>
      <span className="agent-model-divider-rule" />
    </div>
  );
}

export function NativeChatPage({ tab }: { tab: NativeAgentTab }) {
  const updateAgentTab = useAppStore(state => state.updateAgentTab);
  const closeAgentTab = useAppStore(state => state.closeAgentTab);
  const [session, setSession] = useState<AiSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const composing = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousStatus = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setSession(null);
    setError(null);
    aiSessionGet(tab.sessionId)
      .then(value => { if (!disposed) setSession(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    const unlisten = listenTauri<AiSessionUpdateFrame>(AI_SESSION_UPDATE_EVENT, frame => {
      if (disposed || frame.session.id !== tab.sessionId) return;
      setSession(previous => mergeSession(previous, frame));
    });
    // 其他客户端删除会话时同步关闭标签。
    const unlistenRemoved = listenTauri<string>(AI_SESSION_REMOVED_EVENT, id => {
      if (id === tab.sessionId) closeAgentTab(tab.key);
    });
    return () => {
      disposed = true;
      void unlisten.then(off => off());
      void unlistenRemoved.then(off => off());
    };
  }, [tab.sessionId, tab.key, closeAgentTab]);

  // 标题与状态回写标签栏，标签始终反映会话当前状态。
  useEffect(() => {
    if (!session) return;
    updateAgentTab(tab.key, { title: session.title, status: session.status, model: session.model });
  }, [session?.title, session?.status, session?.model, tab.key, updateAgentTab]);

  // 回合结束后重新拉取全量快照：/clear、/compact、/model 等命令不产生正文，
  // 只靠增量帧会让本地消息或模型显示滞后。
  useEffect(() => {
    if (!session) return;
    const previous = previousStatus.current;
    previousStatus.current = session.status;
    if (previous && previous !== 'idle' && session.status === 'idle') {
      let cancelled = false;
      aiSessionGet(tab.sessionId).then(fresh => { if (!cancelled) setSession(fresh); }).catch(() => {});
      return () => { cancelled = true; };
    }
    return undefined;
  }, [session?.status, tab.sessionId]);

  const messages = session?.messages ?? [];

  // 新会话的 CLI 还没启动时没有 system/init：先用本地缓存或最近一次同 Agent 会话的清单补全。
  const [fallbackCatalog, setFallbackCatalog] = useState<SlashCatalog | null>(() => readCachedCatalog(tab.provider));
  const cachedCatalogJson = useRef<string | null>(null);
  useEffect(() => {
    const own = session?.slashCatalog;
    if (own) {
      const json = JSON.stringify(own);
      if (json !== cachedCatalogJson.current) {
        cachedCatalogJson.current = json;
        writeCachedCatalog(tab.provider, own);
      }
      setFallbackCatalog(previous => (previous === own ? previous : own));
      return;
    }
    if (fallbackCatalog) return;
    let disposed = false;
    aiSessionList()
      .then(list => {
        if (disposed) return;
        const recent = list
          .filter(item => item.provider === tab.provider && item.slashCatalog)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (recent?.slashCatalog) setFallbackCatalog(recent.slashCatalog);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [session?.slashCatalog, tab.provider, fallbackCatalog]);
  const slashCatalog = session?.slashCatalog ?? fallbackCatalog;

  // 连续工具调用合并为一个块；用户/助手消息保持原顺序。
  const blocks = useMemo(() => {
    const result: Array<
      { kind: 'message'; message: AiMessage } | { kind: 'tools'; messages: AiMessage[] }
    > = [];
    for (const message of messages) {
      if (message.role !== 'tool') {
        result.push({ kind: 'message', message });
        continue;
      }
      const last = result[result.length - 1];
      if (last?.kind === 'tools') last.messages.push(message);
      else result.push({ kind: 'tools', messages: [message] });
    }
    return result;
  }, [messages]);

  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    // 思考指示条出现/消失也会改变底部位置，需要一并跟随。
  }, [messages.length, messages[messages.length - 1]?.text, blocks.length, sending, session?.status]);

  const slashItems = useMemo(() => {
    if (!draft.startsWith('/') || /\s/.test(draft)) return [];
    return filterSlashCommands(slashCatalog, draft.slice(1)).slice(0, 12);
  }, [draft, slashCatalog]);

  useEffect(() => { setSlashIndex(0); }, [draft]);

  const pickSlash = useCallback((command: string) => {
    setDraft(`/${command} `);
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setDraft('');
    stickToBottom.current = true;
    try {
      const snapshot = await aiSessionSend(tab.sessionId, { text, requestId: crypto.randomUUID() });
      setSession(previous => (previous && previous.revision > snapshot.revision ? previous : snapshot));
    } catch (reason) {
      setError(String(reason));
      setDraft(text);
    } finally {
      setSending(false);
    }
  }, [draft, sending, tab.sessionId]);

  const answer = useCallback(async (approval: AnswerAiApproval) => {
    try {
      await aiSessionAnswer(tab.sessionId, approval);
      setSession(previous => previous
        ? { ...previous, approvals: previous.approvals.filter(item => item.id !== approval.approvalId) }
        : previous);
    } catch (reason) {
      setError(String(reason));
    }
  }, [tab.sessionId]);

  // 空闲时切换供应商与模型：后端结束常驻进程并写入切换分段，下一条消息以新配置 --resume 续接。
  const switchModel = useCallback(async (providerId: string, model: string) => {
    setError(null);
    try {
      const snapshot = await aiSessionSwitchModel(tab.sessionId, providerId, model);
      setSession(previous => (previous && previous.revision > snapshot.revision ? previous : snapshot));
    } catch (reason) {
      setError(String(reason));
    }
  }, [tab.sessionId]);

  const removeSession = useCallback(async () => {
    try {
      await aiSessionDelete(tab.sessionId);
      closeAgentTab(tab.key);
    } catch (reason) {
      setError(String(reason));
    }
  }, [closeAgentTab, tab.key, tab.sessionId]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    if (slashItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex(index => (index + 1) % slashItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex(index => (index - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        pickSlash(slashItems[slashIndex]?.name ?? slashItems[0].name);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDraft('');
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }, [pickSlash, send, slashIndex, slashItems]);

  const pending = session?.pendingInputs ?? [];
  const running = session != null && ['running', 'approval', 'background', 'stopping'].includes(session.status);
  // 发送中或 Agent 正在执行且不在等用户确认：显示「AI 正在思考中」，长时间无正文时也能看出进程仍在跑。
  const busy = sending || (running && session?.status !== 'approval');
  const [thinkingSince, setThinkingSince] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    setThinkingSince(previous => busy ? (previous ?? Date.now()) : null);
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  // 事件通道丢帧时兜底拉一次快照：避免界面长期停在“思考中”而实际已结束。
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      aiSessionGet(tab.sessionId)
        .then(fresh => setSession(previous => (!previous || fresh.revision >= previous.revision ? fresh : previous)))
        .catch(() => {});
    }, 6000);
    return () => window.clearInterval(timer);
  }, [busy, tab.sessionId]);
  const thinkingSeconds = thinkingSince ? Math.max(0, Math.floor((clock - thinkingSince) / 1000)) : 0;
  const context = session?.usage?.context;
  const lastTurn = session?.usage?.lastTurn;
  const usage = session?.usage;
  const contextPercent = context?.usedTokens != null && context.windowTokens
    ? Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))
    : null;
  // 上下文摘要点击后打开与手机端同源的用量明细（输入/输出/缓存/命中率）。
  const [usageOpen, setUsageOpen] = useState(false);
  // 思考强度：会话本身不返回 effort，按 providerId + model 到目录里匹配（与手机端同一数据源）。
  const [effortLabel, setEffortLabel] = useState('跟随服务端');
  useEffect(() => {
    if (!usageOpen) return;
    const providerId = session?.providerId;
    const model = session?.model;
    if (!providerId || !model) { setEffortLabel('跟随服务端'); return; }
    let disposed = false;
    aiCatalog()
      .then(catalog => {
        if (disposed) return;
        const effort = catalog.providers.find(item => item.id === providerId)
          ?.models.find(item => item.id === model)?.effort;
        setEffortLabel(effort?.trim() ? effort : '跟随服务端');
      })
      .catch(() => { if (!disposed) setEffortLabel('跟随服务端'); });
    return () => { disposed = true; };
  }, [usageOpen, session?.providerId, session?.model]);

  return (
    <div className="agent-chat-page">
      <header className="agent-chat-header">
        <div className="agent-chat-heading">
          <AgentIcon provider={tab.provider} className="agent-chat-icon" />
          <div className="agent-chat-titles">
            <div className="agent-chat-title">{session?.title ?? tab.title}</div>
            <div className="agent-chat-subtitle">
              <span className={`agent-status-badge ${session?.status ?? 'idle'}`}>
                {STATUS_LABEL[session?.status ?? 'idle'] ?? session?.status}
              </span>
              {tab.provider === 'claude' ? (
                <ModelSwitcher
                  agent="claude"
                  providerId={session?.providerId}
                  providerName={session?.providerName}
                  model={session?.model}
                  disabled={busy || (session?.pendingInputs?.length ?? 0) > 0 || session == null}
                  disabledReason={busy ? '执行中无法切换模型，请等待完成或先中断' : '有排队消息，请等待发出后再切换'}
                  onPick={(providerId, model) => { void switchModel(providerId, model); }}
                />
              ) : (
                session?.model && <span className="agent-chat-meta">{session.model}</span>
              )}
              <span className="agent-chat-meta agent-chat-path" title={tab.projectPath}>{tab.projectPath}</span>
            </div>
          </div>
        </div>
        <div className="agent-chat-header-actions">
          {running && (
            <button className="agent-btn" onClick={() => { void aiSessionStop(tab.sessionId).catch(reason => setError(String(reason))); }}>
              <CircleStop aria-hidden="true" />中断
            </button>
          )}
          <button className="agent-btn danger" onClick={() => { void removeSession(); }}>
            <Trash2 aria-hidden="true" />删除会话
          </button>
        </div>
      </header>

      <div className="agent-chat-messages" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 && !error && (
          <div className="agent-chat-empty">
            <AgentIcon provider={tab.provider} className="agent-chat-empty-logo" />
            <div>在下方输入消息开始对话。</div>
            <div className="agent-chat-empty-hint">输入 / 可查看命令与 Skill 补全。</div>
          </div>
        )}
        {blocks.map(block => {
          if (block.kind === 'tools') {
            return block.messages.length > 1
              ? <ToolGroup key={`tools-${block.messages[0].id}`} messages={block.messages} />
              : <ToolMessage key={block.messages[0].id} message={block.messages[0]} />;
          }
          const message = block.message;
          if (message.modelSwitch) {
            return <ModelSwitchDivider key={message.id} at={message.createdAt} info={message.modelSwitch} />;
          }
          if (message.role === 'user') {
            if (message.skillName) {
              return <SkillEntry key={message.id} name={message.skillName} text={message.text} />;
            }
            return (
              <div key={message.id} className="agent-bubble-row user">
                <div className="agent-bubble user">{message.text}</div>
              </div>
            );
          }
          if (message.role === 'assistant') {
            return (
              <div key={message.id} className="agent-bubble-row assistant">
                <div className="agent-bubble assistant"><ChatMarkdown text={message.text} /></div>
              </div>
            );
          }
          return <ToolMessage key={message.id} message={message} />;
        })}
        {session?.approvals.map(approval => (
          <ApprovalCard key={approval.id} approval={approval} onAnswer={answer} />
        ))}
        {busy && (
          <div className="agent-bubble-row assistant agent-thinking-row" role="status" aria-live="polite">
            <div className="agent-bubble assistant agent-thinking-bubble">
              <span className="agent-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
              <span>
                {session?.status === 'stopping'
                  ? '正在中断'
                  : session?.status === 'background' ? '后台任务执行中' : 'AI 正在思考中'}…
                {thinkingSeconds >= 8 && <span className="agent-thinking-elapsed"> 已等待 {thinkingSeconds} 秒</span>}
              </span>
            </div>
          </div>
        )}
        {session?.error && <div className="agent-chat-error">{session.error}</div>}
        {error && <div className="agent-chat-error">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <footer className="agent-chat-composer">
        {pending.length > 0 && (
          <div className="agent-pending-list">
            <div className="agent-pending-title">{pending.length} 条排队中</div>
            {pending.map(item => (
              <div key={item.requestId} className="agent-pending-item">
                <span className="agent-pending-text" title={item.text}>{item.text}</span>
                <button className="agent-btn small" title="立即插话"
                  onClick={() => { void aiSessionFlush(tab.sessionId, item.requestId).catch(reason => setError(String(reason))); }}>
                  <Zap aria-hidden="true" />插话
                </button>
                <button className="agent-btn small" title="移出队列"
                  onClick={() => { void aiSessionPendingDelete(tab.sessionId, item.requestId).catch(reason => setError(String(reason))); }}>
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="agent-input-wrap">
          {slashItems.length > 0 && (
            <SlashCompletions items={slashItems} activeIndex={slashIndex} onPick={pickSlash} />
          )}
          <textarea
            className="agent-input"
            value={draft}
            rows={3}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
          />
          <div className="agent-input-bar">
            {/* 桌面端底部空间宽裕：直接平铺上下文与本轮 Token 统计，明细仍可点开 */}
            <button
              type="button"
              className="agent-usage-inline"
              onClick={() => setUsageOpen(true)}
              title="点击查看完整的上下文与 Token 明细"
            >
              <span className="agent-usage-group">
                <span className="agent-usage-label">上下文</span>
                <span className="agent-usage-value">
                  {context?.updating && context.usedTokens == null
                    ? '待更新'
                    : contextPercent != null
                      ? `${contextPercent}%`
                      : compact(context?.usedTokens)}
                </span>
                {contextPercent != null && (
                  <span className="agent-context-bar"><span style={{ width: `${contextPercent}%` }} /></span>
                )}
                <span className="agent-usage-sub">
                  {compact(context?.usedTokens)} / {compact(context?.windowTokens)}
                </span>
              </span>
              <span className="agent-usage-sep" />
              <span className="agent-usage-group">
                <span className="agent-usage-label">本轮</span>
                <span className="agent-usage-value">↑{compact(lastTurn?.inputTokens)}</span>
                <span className="agent-usage-value">↓{compact(lastTurn?.outputTokens)}</span>
                <span className="agent-usage-sub">缓存命中 {cacheHitRate(lastTurn)}</span>
              </span>
              <span className="agent-usage-sep" />
              <span className="agent-usage-group">
                <span className="agent-usage-label">累计</span>
                <span className="agent-usage-value">↑{compact(usage?.sessionTotal.inputTokens)}</span>
                <span className="agent-usage-value">↓{compact(usage?.sessionTotal.outputTokens)}</span>
                <span className="agent-usage-sub">缓存命中 {cacheHitRate(usage?.sessionTotal)}</span>
              </span>
            </button>
            <button className="agent-btn primary" disabled={sending || !draft.trim()} onClick={() => { void send(); }}>
              <Send aria-hidden="true" />发送
            </button>
          </div>
        </div>
      </footer>
      {usageOpen && (
        <UsagePanel
          usage={session?.usage}
          modelLabel={session?.model || '服务端默认模型'}
          effortLabel={effortLabel}
          running={running}
          onClose={() => setUsageOpen(false)}
        />
      )}
    </div>
  );
}
