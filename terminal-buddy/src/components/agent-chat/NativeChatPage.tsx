import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleStop, ListTree, Send, Trash2, Zap } from 'lucide-react';
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
  type AiSession,
  type AiSessionUpdateFrame,
  type AnswerAiApproval,
  type SlashCatalog,
} from '../../services/tauri';
import { useAppStore, type NativeAgentTab } from '../../stores/appStore';
import { AgentMessageList, formatClock, type AgentMessageListHandle, type ChatBlock } from './AgentMessageList';
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

/** 增量帧合并：流式期间的帧几乎只更新/追加尾部消息，先在尾部小窗口内定位，
 * 命中不到再退回全量索引 Map，避免每帧 O(n) 重建 Map（审查 V-17）。 */
const MERGE_TAIL_SCAN = 8;
function mergeSession(previous: AiSession | null, frame: AiSessionUpdateFrame): AiSession {
  if (!previous || frame.session.revision >= previous.revision) {
    if (!previous) return { ...frame.session, messages: [...frame.messages] };
    const messages = previous.messages.slice();
    let indexMap: Map<string, number> | null = null;
    for (const message of frame.messages) {
      let at: number | undefined;
      for (let k = 1; k <= MERGE_TAIL_SCAN; k++) {
        const position = messages.length - k;
        if (position >= 0 && messages[position].id === message.id) { at = position; break; }
      }
      if (at == null) {
        indexMap ??= new Map(messages.map((item, position) => [item.id, position]));
        at = indexMap.get(message.id);
      }
      if (at != null) messages[at] = message;
      else {
        indexMap?.set(message.id, messages.length);
        messages.push(message);
      }
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
/** 右侧输入节点导航的展开状态持久化键。 */
const OUTLINE_VISIBLE_KEY = 'agent-outline-visible';

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

/** 导航条目摘要：取首个非空行的开头，过长截断。 */
function outlineLabel(text: string): string {
  const firstLine = text.split('\n').find(line => line.trim()) ?? '';
  return firstLine.trim().slice(0, 48);
}

interface OutlineNode {
  id: string;
  label: string;
  skillName?: string;
  at: number;
}

export function NativeChatPage({ tab }: { tab: NativeAgentTab }) {
  const updateAgentTab = useAppStore(state => state.updateAgentTab);
  const closeAgentTab = useAppStore(state => state.closeAgentTab);
  const [session, setSession] = useState<AiSession | null>(null);
  // 本地已作答的审批 id：answer() 乐观移除后，增量帧与六秒兜底快照会整壳
  // 替换 session 把卡片带回（后端已拒绝二次作答，复活只会误导），统一过滤
  // （审查 V-6 / N-7）。
  const answeredApprovalsRef = useRef<Set<string>>(new Set());
  const stripAnswered = useCallback((value: AiSession): AiSession => {
    const answered = answeredApprovalsRef.current;
    if (answered.size === 0 || !value.approvals?.length) return value;
    const approvals = value.approvals.filter(item => !answered.has(item.id));
    return approvals.length === value.approvals.length ? value : { ...value, approvals };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const composing = useRef(false);
  const stickToBottom = useRef(true);
  const previousStatus = useRef<string | null>(null);
  const listRef = useRef<AgentMessageListHandle>(null);
  // 右侧输入节点导航：默认展开，状态跨会话记住。
  const [outlineOpen, setOutlineOpen] = useState(() => localStorage.getItem(OUTLINE_VISIBLE_KEY) !== '0');
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const toggleOutline = useCallback(() => {
    setOutlineOpen(open => {
      localStorage.setItem(OUTLINE_VISIBLE_KEY, open ? '0' : '1');
      return !open;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    setSession(null);
    setError(null);
    aiSessionGet(tab.sessionId)
      .then(value => { if (!disposed) setSession(stripAnswered(value)); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    const unlisten = listenTauri<AiSessionUpdateFrame>(AI_SESSION_UPDATE_EVENT, frame => {
      if (disposed || frame.session.id !== tab.sessionId) return;
      setSession(previous => stripAnswered(mergeSession(previous, frame)));
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
      aiSessionGet(tab.sessionId).then(fresh => { if (!cancelled) setSession(stripAnswered(fresh)); }).catch(() => {});
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

  // 连续工具调用合并为一个块；子代理消息按 subagentKey（turn + parent_tool_use_id，
  // 审查 V-5）精确分组——同名代理不误并组、同一代理被主线程消息隔开也不拆组，
  // 组位置取首次出现处；用户/助手消息保持原顺序。旧会话无 subagentKey 时回落
  // 按名称相邻合并（兼容历史数据）。
  const blocks = useMemo<ChatBlock[]>(() => {
    const result: ChatBlock[] = [];
    const groupIndex = new Map<string, number>();
    for (const message of messages) {
      if (message.subagent) {
        const groupKey = message.subagentKey ?? `name:${message.subagent}`;
        const at = message.subagentKey ? groupIndex.get(groupKey) : undefined;
        if (at != null) {
          const block = result[at];
          if (block.kind === 'subagent') { block.messages.push(message); continue; }
        }
        const last = result[result.length - 1];
        if (!message.subagentKey && last?.kind === 'subagent' && last.name === message.subagent) {
          last.messages.push(message);
          continue;
        }
        groupIndex.set(groupKey, result.length);
        result.push({ kind: 'subagent', name: message.subagent, messages: [message] });
        continue;
      }
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

  // 右侧输入节点导航：列出全部用户输入（含 Skill 展开），点击即可定位。
  const outlineNodes = useMemo<OutlineNode[]>(() => {
    const nodes: OutlineNode[] = [];
    for (const block of blocks) {
      if (block.kind !== 'message') continue;
      const message = block.message;
      if (message.role !== 'user') continue;
      nodes.push({
        id: message.id,
        label: outlineLabel(message.text) || (message.skillName ? `skill:${message.skillName}` : '（空消息）'),
        skillName: message.skillName,
        at: message.createdAt,
      });
    }
    return nodes;
  }, [blocks]);

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
      setSession(previous => (previous && previous.revision > snapshot.revision ? previous : stripAnswered(snapshot)));
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
      answeredApprovalsRef.current.add(approval.approvalId);
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
      setSession(previous => (previous && previous.revision > snapshot.revision ? previous : stripAnswered(snapshot)));
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

  const stop = useCallback(() => {
    aiSessionStop(tab.sessionId).catch(reason => setError(String(reason)));
  }, [tab.sessionId]);

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
  useEffect(() => {
    setThinkingSince(previous => busy ? (previous ?? Date.now()) : null);
  }, [busy]);
  // 事件通道丢帧时兜底拉一次快照：避免界面长期停在“思考中”而实际已结束。
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      aiSessionGet(tab.sessionId)
        .then(fresh => setSession(previous => (!previous || fresh.revision >= previous.revision ? stripAnswered(fresh) : previous)))
        .catch(() => {});
    }, 6000);
    return () => window.clearInterval(timer);
  }, [busy, tab.sessionId]);
  // 已等待秒数由 AgentMessageList 内部的 ElapsedBadge 自行计时渲染（V-16）：
  // clock 状态住在父组件时，busy 期间每秒整页重渲染。
  const busyText = session?.status === 'stopping'
    ? '正在中断'
    : session?.status === 'background' ? '后台任务执行中' : 'AI 正在思考中';
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
          <button
            className={`agent-btn${outlineOpen ? ' active' : ''}`}
            title={outlineOpen ? '收起输入节点导航' : '展开输入节点导航'}
            onClick={toggleOutline}
          >
            <ListTree aria-hidden="true" />节点
          </button>
          <button className="agent-btn danger" onClick={() => { void removeSession(); }}>
            <Trash2 aria-hidden="true" />删除会话
          </button>
        </div>
      </header>

      <div className="agent-chat-body">
        <AgentMessageList
          ref={listRef}
          provider={tab.provider}
          blocks={blocks}
          approvals={session?.approvals ?? []}
          sessionError={session?.error ?? null}
          localError={error}
          busy={busy}
          busyText={busyText}
          thinkingSince={thinkingSince}
          stickRef={stickToBottom}
          onAnswer={answer}
          onActiveUserChange={setActiveNodeId}
        />
        {outlineOpen && (
          <aside className="agent-chat-outline">
            <div className="agent-outline-head">
              <span>输入节点 · {outlineNodes.length}</span>
            </div>
            <div className="agent-outline-list">
              {outlineNodes.length === 0 && (
                <div className="agent-outline-empty">发送消息后，这里会列出全部输入，点击可快速定位。</div>
              )}
              {outlineNodes.map((node, index) => (
                <button
                  key={node.id}
                  className={`agent-outline-item${activeNodeId === node.id ? ' active' : ''}`}
                  title={node.label}
                  onClick={() => listRef.current?.jumpTo(node.id)}
                >
                  <span className="agent-outline-index">{index + 1}</span>
                  <span className="agent-outline-text">
                    {node.skillName && <span className="agent-skill-badge">SKILL</span>}
                    {node.label}
                  </span>
                  <span className="agent-outline-time">{formatClock(node.at)}</span>
                </button>
              ))}
            </div>
          </aside>
        )}
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
            <div className="agent-input-actions">
              <button className="agent-btn primary" disabled={sending || !draft.trim()} onClick={() => { void send(); }}>
                <Send aria-hidden="true" />发送
              </button>
              {/* 运行中的停止按钮紧跟发送按钮，不用再去顶部找中断入口。 */}
              {running && (
                <button className="agent-btn danger agent-stop-btn" title="中断当前任务" onClick={stop}>
                  <CircleStop aria-hidden="true" />停止
                </button>
              )}
            </div>
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
