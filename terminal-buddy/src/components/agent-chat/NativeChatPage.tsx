import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleStop, ImagePlus, Send, Trash2, X, Zap } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { ChatNodeRail, type ChatNode } from './ChatNodeRail';
import { ModelSwitcher } from './ModelSwitcher';
import { UsagePanel, cacheHitRate, compact } from './UsagePanel';
import {
  AI_SESSION_REMOVED_EVENT,
  AI_SESSION_UPDATE_EVENT,
  aiSessionAnswer,
  aiSessionFlush,
  aiSessionGet,
  aiSessionList,
  aiSessionPendingDelete,
  aiSessionSend,
  aiSessionStop,
  aiSessionSwitchModel,
  aiCatalog,
  listenTauri,
  type AiAgent,
  type AiMessage,
  type AiSession,
  type AiSessionUpdateFrame,
  type AnswerAiApproval,
  type SlashCatalog,
} from '../../services/tauri';
import { useAppStore, type AgentDraftImage, type NativeAgentTab } from '../../stores/appStore';
import { AgentMessageList, type AgentMessageListHandle, type ChatBlock } from './AgentMessageList';
import { TodoCard } from './TodoCard';
import { AgentChips } from './AgentChips';
import { AgentDrawer } from './AgentDrawer';
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

/** 由 Task 的 tool_use_id 找子代理分组键：消息的 subagentKey 是 `{turn}:{parent}`，
 * 后缀即 tool_use_id（与后端 `format!("{turn}:{parent}")` 同源）。 */
function subagentKeyFor(messages: { subagentKey?: string }[], toolUseId: string): string | null {
  const match = messages.find(message => message.subagentKey?.endsWith(`:${toolUseId}`));
  return match?.subagentKey ?? null;
}

/** 输入框上方待发送的图片：dataUrl 用于即时预览，data 是交给服务端的 base64。 */
const MAX_DRAFT_IMAGES = 8;
const MAX_DRAFT_IMAGE_BYTES = 10 * 1024 * 1024;
/** 无图片时复用同一空数组，避免每次取 store 都生成新引用触发重渲染。 */
const EMPTY_DRAFT_IMAGES: AgentDraftImage[] = [];

function readDraftImage(file: File): Promise<AgentDraftImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('仅支持图片文件')); return; }
    if (file.size > MAX_DRAFT_IMAGE_BYTES) { reject(new Error('单张图片不能超过 10MB')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) { reject(new Error('图片读取失败')); return; }
      resolve({
        id: crypto.randomUUID(),
        dataUrl,
        // 发送时只带 base64 正文，服务端会校验格式并落盘。
        data: dataUrl.slice(comma + 1),
        mediaType: file.type || 'image/png',
        name: file.name || '粘贴图片.png',
      });
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
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
  // 草稿存在 store 里：切换到其它会话/标签时本页会被卸载，组件内 state 会丢字。
  const draft = useAppStore(state => state.agentDrafts[tab.key] ?? '');
  const setAgentDraft = useAppStore(state => state.setAgentDraft);
  const setDraft = useCallback((text: string) => setAgentDraft(tab.key, text), [setAgentDraft, tab.key]);
  const [sending, setSending] = useState(false);
  // 待发送图片与文本草稿同存 store：切换标签导致本页重挂载时不丢图。
  const draftImages = useAppStore(state => state.agentDraftImages[tab.key] ?? EMPTY_DRAFT_IMAGES);
  const setAgentDraftImages = useAppStore(state => state.setAgentDraftImages);
  const setDraftImages = useCallback((images: AgentDraftImage[]) => setAgentDraftImages(tab.key, images), [setAgentDraftImages, tab.key]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const composing = useRef(false);
  const stickToBottom = useRef(true);
  const previousStatus = useRef<string | null>(null);
  const listRef = useRef<AgentMessageListHandle>(null);
  // 右侧输入节点导轨：当前视口内的用户输入（scroll spy 驱动高亮）。
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  // 子代理抽屉：记录选中的 (agent, subagentKey)。抽屉只读 messages，不影响主列表虚拟化。
  const [selected, setSelected] = useState<{ agent: AiAgent; key: string | null } | null>(null);
  // 关闭抽屉后把焦点还给触发它的 chip（按 taskId 找回；chip 可能已被淘汰，找不到就算了）。
  const restoreFocus = useRef<string | null>(null);
  // 回调里需要读到最新的消息与选中项，但又不能因此重新绑定回调。
  const messagesRef = useRef<AiMessage[]>([]);
  const selectedRef = useRef<typeof selected>(null);
  const sessionRef = useRef<AiSession | null>(null);

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
  const messageCount = messages.length;
  const running = session != null && ['running', 'approval', 'background', 'stopping'].includes(session.status);

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

  // 子代理 chip 与正文 Task 组头共用同一个抽屉：点击同一个已选中的 chip 关闭。
  const openAgent = useCallback((agent: AiAgent) => {
    const key = agent.toolUseId ? subagentKeyFor(messagesRef.current, agent.toolUseId) : null;
    setSelected(current => {
      if (current?.agent.taskId === agent.taskId) {
        restoreFocus.current = agent.taskId;
        return null;
      }
      return { agent, key };
    });
  }, []);
  const closeDrawer = useCallback(() => {
    restoreFocus.current = selectedRef.current?.agent.taskId ?? null;
    setSelected(null);
  }, []);
  // 正文 Task 组头：按 tool_use_id 找到对应 agent 并开同一个抽屉；agent 尚未登记时
  // （旧会话 / 事件缺失）也允许打开，抽屉按消息分组键筛选内容。
  const openAgentByToolUseId = useCallback((toolUseId: string) => {
    const agent = sessionRef.current?.agents?.find(item => item.toolUseId === toolUseId);
    if (agent) { openAgent(agent); return; }
    const key = subagentKeyFor(messagesRef.current, toolUseId);
    if (!key) return;
    // 没有 agent 记录时用该组消息里的子代理名，避免把分组键（turn:tool_use_id）当名字显示。
    const groupName = messagesRef.current.find(message => message.subagentKey === key)?.subagent ?? '子代理';
    setSelected(current => (current?.key === key ? null : {
      agent: {
        taskId: key, toolUseId, name: groupName, status: 'completed',
        background: false, depth: 1, startedAt: 0,
      },
      key,
    }));
  }, [openAgent]);
  // 会话切换、/clear 之后选中的子代理已不存在：自动收起，避免悬空抽屉。
  // 依赖只看消息条数：流式期间内容每帧变化，但组是否存在的结论不会变。
  useEffect(() => {
    if (!selected) return;
    const key = selected.key;
    const exists = messagesRef.current.some(message =>
      (key ? message.subagentKey === key : message.subagent === selected.agent.name));
    if (!exists && !running) setSelected(null);
  }, [messageCount, running, selected]);
  messagesRef.current = messages;
  selectedRef.current = selected;
  sessionRef.current = session;
  // 焦点回还：抽屉关闭且 chip 仍在 DOM 里时聚焦它。
  useEffect(() => {
    if (selected || !restoreFocus.current) return;
    const taskId = restoreFocus.current;
    restoreFocus.current = null;
    requestAnimationFrame(() => {
      const chip = document.querySelector<HTMLButtonElement>(`.agent-chip[data-task-id="${taskId}"]`);
      chip?.focus();
    });
  }, [selected]);

  // 连续工具调用合并为一个块；子代理消息按 subagentKey（turn + parent_tool_use_id，
  // 审查 V-5）精确分组——同名代理不误并组、同一代理被主线程消息隔开也不拆组，
  // 组位置取首次出现处；用户/助手消息保持原顺序。旧会话无 subagentKey 时回落
  // 按名称相邻合并（兼容历史数据）。
  const blocks = useMemo<ChatBlock[]>(() => {
    const result: ChatBlock[] = [];
    const groupIndex = new Map<string, number>();
    for (const message of messages) {
      // TodoWrite 的工具调用与结果由底部清单卡统一呈现，正文不重复显示。
      if (message.todo) continue;
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

  // 右侧输入节点导轨：每条用户输入一根横线（含 Skill 展开），悬停看输入与回复摘要、点击定位。
  const outlineNodes = useMemo<ChatNode[]>(() => {
    const nodes: ChatNode[] = [];
    for (const block of blocks) {
      if (block.kind !== 'message') continue;
      const message = block.message;
      if (message.role === 'user') {
        const label = outlineLabel(message.text)
          || (message.images?.length ? `[${message.images.length} 张图片]` : message.skillName ? `skill:${message.skillName}` : '（空消息）');
        nodes.push({
          id: message.id,
          label,
          userText: message.text,
        });
        continue;
      }
      // 浮层第二段展示该轮助手的文字回复（与 ZCode 一致，取本轮第一条有正文的助手消息）。
      if (message.role === 'assistant' && nodes.length > 0) {
        const current = nodes[nodes.length - 1];
        if (current.assistantText == null && message.text.trim()) {
          current.assistantText = message.text;
        }
      }
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
  }, [setDraft]);

  /** 粘贴 / 选择图片后先在输入框上方预览，发送时再随消息一起提交。 */
  const addImages = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    try {
      const images = await Promise.all(files.map(readDraftImage));
      const room = Math.max(0, MAX_DRAFT_IMAGES - draftImages.length);
      if (images.length > room) setError(`一次最多发送 ${MAX_DRAFT_IMAGES} 张图片`);
      if (room > 0) setDraftImages([...draftImages, ...images.slice(0, room)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [draftImages, setDraftImages]);

  const removeDraftImage = useCallback((id: string) => {
    setDraftImages(draftImages.filter(image => image.id !== id));
  }, [draftImages, setDraftImages]);

  const onPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => file != null);
    // 只有确实带图片时才拦截，普通文本粘贴保持浏览器默认行为。
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  }, [addImages]);

  const send = useCallback(async () => {
    const text = draft.trim();
    const images = draftImages;
    if ((!text && images.length === 0) || sending) return;
    setSending(true);
    setError(null);
    setDraft('');
    setDraftImages([]);
    stickToBottom.current = true;
    try {
      const snapshot = await aiSessionSend(tab.sessionId, {
        text,
        requestId: crypto.randomUUID(),
        images: images.map(image => ({ data: image.data, mediaType: image.mediaType, name: image.name })),
      });
      setSession(previous => (previous && previous.revision > snapshot.revision ? previous : stripAnswered(snapshot)));
    } catch (reason) {
      setError(String(reason));
      setDraft(text);
      setDraftImages(images);
    } finally {
      setSending(false);
    }
  }, [draft, draftImages, sending, tab.sessionId, setDraft, setDraftImages]);

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
  const contextPercent = context?.usedTokens && context.windowTokens
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

  // 抽屉里的 agent 用会话中的最新版本：实时帧更新状态/耗时时抽屉要跟着变，
  // 而不是停在打开那一刻的快照上。
  const drawerAgent = useMemo(() => {
    if (!selected) return null;
    const live = selected.agent.toolUseId
      ? session?.agents?.find(item => item.toolUseId === selected.agent.toolUseId)
      : session?.agents?.find(item => item.taskId === selected.agent.taskId);
    return live ?? selected.agent;
  }, [selected, session?.agents]);

  return (
    <div className="agent-chat-page">
      <header className="agent-chat-header">        <div className="agent-chat-heading">
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
          onOpenTask={openAgentByToolUseId}
        />
        <ChatNodeRail
          nodes={outlineNodes}
          activeId={activeNodeId}
          onJump={id => listRef.current?.jumpTo(id)}
        />
        {selected && drawerAgent && (
          <AgentDrawer
            agent={drawerAgent}
            subagentKey={selected.key}
            messages={messages}
            onClose={closeDrawer}
          />
        )}
      </div>

      <footer className="agent-chat-composer">
        <TodoCard todos={session?.todos ?? []} sessionId={tab.sessionId} running={running} />
        <AgentChips
          agents={session?.agents ?? []}
          selectedKey={selected?.agent.toolUseId ?? null}
          onSelect={openAgent}
          sessionId={tab.sessionId}
        />
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
          {/* 与 ZCode 一致的附件区：粘贴/选择后的图片缩略图排在输入框上方，可逐张移除。 */}
          {draftImages.length > 0 && (
            <div className="agent-attachments" aria-label="待发送图片">
              {draftImages.map(image => (
                <div className="agent-attachment" key={image.id}>
                  <img src={image.dataUrl} alt={image.name} title={image.name} />
                  <button
                    type="button"
                    className="agent-attachment-remove"
                    title="移除图片"
                    aria-label="移除图片"
                    onClick={() => removeDraftImage(image.id)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="agent-image-input"
            onChange={event => {
              const files = Array.from(event.target.files ?? []);
              // 清空值，连续选择同一文件也能再次触发 change。
              event.target.value = '';
              void addImages(files);
            }}
          />
          <textarea
            className="agent-input"
            value={draft}
            rows={3}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行；可直接粘贴或拖入图片"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onDragOver={event => {
              // 只有拖动文件时才接管，普通文本拖拽保持浏览器默认行为。
              if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
            }}
            onDrop={event => {
              const files = Array.from(event.dataTransfer?.files ?? [])
                .filter(file => file.type.startsWith('image/'));
              if (files.length === 0) return;
              event.preventDefault();
              void addImages(files);
            }}
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
                  {context?.updating && !context.usedTokens
                    ? '待更新'
                    : contextPercent != null
                      ? `${contextPercent}%`
                      : context?.usedTokens ? compact(context.usedTokens) : '—'}
                </span>
                {contextPercent != null && (
                  <span className="agent-context-bar"><span style={{ width: `${contextPercent}%` }} /></span>
                )}
                <span className="agent-usage-sub">
                  {context?.usedTokens ? compact(context.usedTokens) : '—'} / {compact(context?.windowTokens)}
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
              <button
                type="button"
                className="agent-btn"
                title="添加图片"
                aria-label="添加图片"
                disabled={sending}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus aria-hidden="true" />图片
              </button>
              <button
                className="agent-btn primary"
                disabled={sending || (!draft.trim() && draftImages.length === 0)}
                onClick={() => { void send(); }}
              >
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
