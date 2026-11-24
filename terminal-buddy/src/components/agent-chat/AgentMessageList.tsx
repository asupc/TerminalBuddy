import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Bot, ChevronUp, CornerDownLeft } from 'lucide-react';
import { convertFileSrc } from './../../services/remoteWorkspace/core';
import { AgentIcon } from './AgentIcon';
import { ChatMarkdown } from './ChatMarkdown';
import { SkillEntry } from './SkillEntry';
import { ApprovalCard } from './ApprovalCard';
import { ThinkingPanel } from './ThinkingPanel';
import { ImageLightbox } from './ImageLightbox';
import type { AiApproval, AiChatImage, AiMessage, AiModelSwitch, AiThinking, AnswerAiApproval } from '../../services/tauri';

/**
 * 虚拟化消息列表：长会话（数千条消息、超大工具输出）全量常驻 DOM 是内存暴涨的主因，
 * 这里只渲染视口附近的消息块，窗口外的块用上次测得的高度做占位。
 * 占位/真身共用同一个 wrapper div，块顺序 append-only，高度由 ResizeObserver 实测缓存。
 */

/** 视口外上下各多渲染的块数：滚动时窗口提前扩展，减少占位闪烁。 */
const ITEM_OVERSCAN = 24;
/** 初次加载锚定尾部的块数：恢复长会话时先渲染最后一屏，更早的消息滚动到时再渲染。 */
const INITIAL_TAIL = 40;
/** 未测量块的估算高度（px），测量缓存就位后自动校正。 */
const ESTIMATED_HEIGHT = 120;

export type ChatBlock =
  | { kind: 'message'; message: AiMessage }
  | { kind: 'tools'; messages: AiMessage[] }
  | { kind: 'subagent'; name: string; messages: AiMessage[] };

export interface AgentMessageListHandle {
  /** 滚动定位到指定消息并高亮（右侧输入节点导航使用）。 */
  jumpTo: (messageId: string) => void;
}

interface Props {
  provider: string;
  blocks: ChatBlock[];
  approvals: AiApproval[];
  sessionError: string | null;
  localError: string | null;
  busy: boolean;
  busyText: string;
  /** 思考开始时刻（毫秒）：已等待秒数由内部 ElapsedBadge 自行计时渲染，
   * 避免 clock 状态住在父组件、busy 期间每秒整页重渲染（审查 V-16）。 */
  thinkingSince: number | null;
  /** 主线程当前思考的实时快照：长回合里唯一能说明「模型在推进」的信息。 */
  thinking?: AiThinking | null;
  /** 会话项目根目录：工具组标题里的绝对路径按它缩成相对路径。 */
  projectPath?: string;
  /** 是否粘住底部：由父组件持有，用户上滚后置 false。 */
  stickRef: { current: boolean };
  onAnswer: (approval: AnswerAiApproval) => void;
  /** 视口内第一个用户消息变化时上报，驱动右侧导航的当前节点高亮。 */
  onActiveUserChange: (id: string | null) => void;
  /** 正文 Task 组头点击：按 tool_use_id 打开子代理抽屉（与 chip 指向同一分组）。 */
  onOpenTask?: (toolUseId: string) => void;
}

export function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 工具标题的渲染上限：单行巨型输出（如 base64/长命令）整段进常驻 DOM
 * 会绕过正文截断（审查 V-8）。 */
const TOOL_TITLE_LIMIT = 200;

/** 思考等待计时：内部每秒 tick，只重渲染这一个徽标（审查 V-16）。 */
const ElapsedBadge = memo(function ElapsedBadge({ since }: { since: number }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((clock - since) / 1000));
  if (seconds < 8) return null;
  return <span className="agent-thinking-elapsed"> 已等待 {seconds} 秒</span>;
});

function toolTitle(message: AiMessage): string {
  const newline = message.text.indexOf('\n');
  const raw = (newline >= 0 ? message.text.slice(0, newline) : message.text).trim();
  return raw.length > TOOL_TITLE_LIMIT ? `${raw.slice(0, TOOL_TITLE_LIMIT)}…` : raw;
}

/** 工具调用的「动作描述」：命令 / 文件路径等，用来回答「它现在在干什么」。
 * 工具的 input 是 JSON，`description` 是最贴近人话的字段；没有时依次回落
 * 到命令、文件路径、查询串。解析失败就返回空串（标题只显示工具名）。 */
function toolAction(message: AiMessage): string {
  const newline = message.text.indexOf('\n');
  if (newline < 0) return '';
  const json = message.text.slice(newline + 1).trim();
  if (!json.startsWith('{')) return '';
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return '';
  }
  const pick = (key: string) => {
    const value = input[key];
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  };
  const action = pick('description') || pick('command') || pick('file_path')
    || pick('path') || pick('pattern') || pick('query') || pick('url') || pick('prompt');
  return action.length > TOOL_TITLE_LIMIT ? `${action.slice(0, TOOL_TITLE_LIMIT)}…` : action;
}

/** 库里常见的绝对路径：折叠态只保留仓库内相对路径，省一半宽度。 */
function shortenPath(action: string, projectPath?: string): string {
  if (!projectPath) return action;
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return action.includes(prefix) ? action.split(prefix).join('') : action;
}

/** 工具输出的渲染上限：巨型日志整段进 DOM 同样会撑爆内存，默认截断、可手动展开。 */
const TOOL_BODY_LIMIT = 20000;

/** 展开/全文状态跨虚拟化卸载保留（审查 V-9）：块滚出渲染窗口后组件卸载，
 * 本地 state 会丢；模块级记录在重新挂载时恢复。 */
const toolOpenState = new Map<string, boolean>();
const toolFullState = new Map<string, boolean>();
/** 模块级 Map 不能无界增长：超过上限时按插入顺序淘汰最旧条目（复核 #8）。 */
const TOOL_STATE_LIMIT = 2000;
function rememberToggle(map: Map<string, boolean>, key: string, value: boolean) {
  if (!map.has(key) && map.size >= TOOL_STATE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** 展开内容底部的收起入口：输出很长时不必再滚回条目顶部去点标题。
 * 只留箭头图标，不写文字——展开区域已经很长，底部再加一行字反而多占高度。 */
const CollapseRow = memo(function CollapseRow({ label = '收起', onCollapse }: {
  /** 无障碍名称：按钮没有可见文字，读屏仍需要知道它做什么。 */
  label?: string;
  onCollapse: () => void;
}) {
  return (
    <button type="button" className="agent-tool-collapse" onClick={onCollapse} title={label} aria-label={label}>
      <ChevronUp aria-hidden="true" />
    </button>
  );
});

const ToolMessage = memo(function ToolMessage({ message }: { message: AiMessage }) {
  const [open, setOpen] = useState(() => toolOpenState.get(message.id) ?? false);
  const [full, setFull] = useState(() => toolFullState.get(message.id) ?? false);
  const newline = message.text.indexOf('\n');
  const rawTitle = message.text.slice(0, newline >= 0 ? newline : undefined);
  const title = rawTitle.length > TOOL_TITLE_LIMIT ? `${rawTitle.slice(0, TOOL_TITLE_LIMIT)}…` : rawTitle;
  const body = newline >= 0 ? message.text.slice(newline + 1) : '';
  const truncated = !full && body.length > TOOL_BODY_LIMIT;
  const toggle = (next: boolean) => {
    setOpen(next);
    rememberToggle(toolOpenState, message.id, next);
  };
  return (
    <div className={`agent-tool-entry${open ? ' open' : ''}`}>
      <button className="agent-tool-header" onClick={() => toggle(!open)} aria-expanded={open}>
        <span className="agent-tool-title">{title || '工具调用'}</span>
        <CornerDownLeft aria-hidden="true" />
      </button>
      {open && body && (
        truncated ? (
          <div className="agent-tool-body-wrap">
            <pre className="agent-tool-body">{body.slice(0, TOOL_BODY_LIMIT)}</pre>
            <button className="agent-btn small agent-expand-full" onClick={() => {
              setFull(true);
              rememberToggle(toolFullState, message.id, true);
            }}>
              展开全部（{body.length} 字符）
            </button>
          </div>
        ) : <pre className="agent-tool-body">{body}</pre>
      )}
      {open && body && <CollapseRow onCollapse={() => toggle(false)} />}
    </div>
  );
});

/**
 * 连续的工具调用合并成一个可展开条目：多轮命令不再把对话刷成一长串工具名。
 * 比较器按消息对象引用判断：流式更新未触及的消息引用稳定，可整组跳过重渲染。
 *
 * 折叠态标题不只要有「多少次」，还要有「此刻在干什么」——长回合里用户扫一眼
 * 消息列表就能知道模型在读哪个文件、跑什么命令，而不必点开或滚进抽屉。
 * 展示的是**最后一次**调用：它代表当前正在推进的动作。
 */
const ToolGroup = memo(function ToolGroup({ messages, projectPath }: {
  messages: AiMessage[];
  projectPath?: string;
}) {
  const [open, setOpen] = useState(() => toolOpenState.get(`group-${messages[0]?.id}`) ?? false);
  const names = Array.from(new Set(messages.map(toolTitle).filter(Boolean)));
  const summary = names.slice(0, 3).join('、');
  const toggle = (next: boolean) => {
    setOpen(next);
    if (messages[0]) rememberToggle(toolOpenState, `group-${messages[0].id}`, next);
  };
  // 倒序找最近一次带动作描述的调用：最后几条往往是 TodoWrite 之类的状态同步，
  // 没有可读的动作，直接跳过它们就能对上用户看到的「正在做什么」。
  const latest = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const action = toolAction(messages[index]);
      if (action) return { name: toolTitle(messages[index]), action: shortenPath(action, projectPath) };
    }
    return null;
  }, [messages, projectPath]);
  return (
    <div className={`agent-tool-entry agent-tool-group${open ? ' open' : ''}`}>
      <button className="agent-tool-header" onClick={() => toggle(!open)} aria-expanded={open}>
        <span className="agent-tool-title">
          {messages.length} 个工具调用
          {latest
            ? <span className="agent-tool-summary"> · {latest.name} {latest.action}</span>
            : summary && <span className="agent-tool-summary"> · {summary}{names.length > 3 ? ' 等' : ''}</span>}
        </span>
        <CornerDownLeft aria-hidden="true" />
      </button>
      {open && (
        <div className="agent-tool-group-body">
          {messages.map(message => <ToolMessage key={message.id} message={message} />)}
        </div>
      )}
      {open && <CollapseRow label="收起本组" onCollapse={() => toggle(false)} />}
    </div>
  );
}, (prev, next) => prev.messages.length === next.messages.length
  && prev.projectPath === next.projectPath
  && prev.messages.every((message, index) => message === next.messages[index]));

/** 模型切换分隔线：明示从这一段开始会话换用了哪个供应商与模型。 */
const ModelSwitchDivider = memo(function ModelSwitchDivider({ at, info }: { at: number; info: AiModelSwitch }) {
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
});

const UserBubble = memo(function UserBubble({ text, skillName, images, onPreview }: {
  text: string;
  skillName?: string;
  images?: AiChatImage[];
  /** 点击缩略图：交给上层打开预览弹窗（不再新开浏览器标签页）。 */
  onPreview?: (images: AiChatImage[], index: number) => void;
}) {
  if (skillName) return <SkillEntry name={skillName} text={text} />;
  return (
    <div className="agent-bubble-row user">
      <div className="agent-bubble user">
        {images && images.length > 0 && (
          <div className="agent-message-images">
            {images.map((image, index) => (
              <button
                key={`${image.path}-${index}`}
                type="button"
                className="agent-message-image"
                title={image.name || `图片 ${index + 1}`}
                onClick={() => onPreview?.(images, index)}
              >
                <img src={convertFileSrc(image.path)} alt={image.name || `图片 ${index + 1}`} loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {text && <div className="agent-bubble-text">{text}</div>}
      </div>
    </div>
  );
});

/**
 * 子代理（Task 工具启动）消息组：连续的同名子代理消息合并为一个可折叠条目，
 * 默认折叠只显示概要，展开后按原顺序显示文本回复与工具调用。
 */
const SubagentGroup = memo(function SubagentGroup({ name, messages }: { name: string; messages: AiMessage[] }) {
  const [open, setOpen] = useState(() => toolOpenState.get(`sub-${messages[0]?.id}`) ?? false);
  const toolCount = messages.filter(message => message.role === 'tool').length;
  const textCount = messages.length - toolCount;
  const toggle = (next: boolean) => {
    setOpen(next);
    if (messages[0]) rememberToggle(toolOpenState, `sub-${messages[0].id}`, next);
  };
  return (
    <div className={`agent-tool-entry agent-subagent-entry${open ? ' open' : ''}`}>
      <button className="agent-tool-header" onClick={() => toggle(!open)} aria-expanded={open}>
        <Bot aria-hidden="true" />
        <span className="agent-tool-title">
          子代理 {name}
          <span className="agent-tool-summary"> · {textCount} 段回复 · {toolCount} 次工具</span>
        </span>
      </button>
      {open && (
        <div className="agent-subagent-body">
          {messages.map(message => message.role === 'tool'
            ? <ToolMessage key={message.id} message={message} />
            : (
              <div key={message.id} className="agent-bubble-row assistant agent-subagent-row">
                <div className="agent-bubble assistant agent-subagent-bubble"><ChatMarkdown text={message.text} /></div>
              </div>
            ))}
        </div>
      )}
      {open && <CollapseRow label="收起子代理" onCollapse={() => toggle(false)} />}
    </div>
  );
}, (prev, next) => prev.name === next.name
  && prev.messages.length === next.messages.length
  && prev.messages.every((message, index) => message === next.messages[index]));

/**
 * 主线程 Task 工具调用的组头：不再显示 `Task\n{json}` 原文，改为
 * 「代理名 — 描述」，点击打开同一个子代理抽屉（规格见实施计划 6.4）。
 * 新版 CLI 把该工具改名为 `Agent`，旧会话里仍是 `Task`，两者都要识别。
 */
function isSubagentToolMessage(text: string): boolean {
  return text.startsWith('Task\n') || text.startsWith('Agent\n');
}

const TaskHead = memo(function TaskHead({ message, onOpen }: {
  message: AiMessage;
  onOpen?: (toolUseId: string) => void;
}) {
  const parsed = useMemo(() => {
    const newline = message.text.indexOf('\n');
    if (newline < 0) return { name: '', description: '' };
    try {
      const input = JSON.parse(message.text.slice(newline + 1)) as { subagent_type?: string; description?: string };
      return { name: input.subagent_type ?? '', description: input.description ?? '' };
    } catch {
      return { name: '', description: '' };
    }
  }, [message.text]);
  // 工具消息 id 形如 `{turn}-tool-{tool_use_id}`，后半段即子代理关联键。
  // turn 本身是 UUID，可能含 `-tool-` 片段，因此取最后一段才稳妥。
  const toolUseId = message.id.split('-tool-').pop() ?? '';
  const name = parsed.name || '子代理';
  return (
    <button
      type="button"
      className="agent-task-head"
      onClick={() => toolUseId && onOpen?.(toolUseId)}
      title={parsed.description || name}
      aria-label={`查看子代理 ${name} 的工作过程`}
    >
      <span className="agent-task-glyph" aria-hidden="true">◈</span>
      <span className="agent-task-name">{name}</span>
      {parsed.description && <span className="agent-task-desc">— {parsed.description}</span>}
    </button>
  );
});

const AssistantBubble = memo(function AssistantBubble({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="agent-bubble-row assistant">
      <div className="agent-bubble assistant"><ChatMarkdown text={text} streaming={streaming} /></div>
    </div>
  );
});

/** 折叠态工具条目的实测高度约 33px（含边距），估算值取 36 以贴近真实，
 * 减少未测量区占位虚增与滚动条跳动（审查 V-10）。 */
const TOOL_ROW_ESTIMATE = 36;

function estimateBlockHeight(block: ChatBlock): number {
  if (block.kind === 'tools') return Math.max(TOOL_ROW_ESTIMATE, TOOL_ROW_ESTIMATE * block.messages.length);
  if (block.kind === 'subagent') return TOOL_ROW_ESTIMATE;
  const message = block.message;
  if (message.modelSwitch) return 32;
  if (message.role === 'user') return 64;
  if (message.role === 'assistant') return ESTIMATED_HEIGHT;
  return TOOL_ROW_ESTIMATE;
}

function blockKey(block: ChatBlock): string {
  if (block.kind === 'tools') return `tools-${block.messages[0].id}`;
  if (block.kind === 'subagent') return `sub-${block.messages[0].id}`;
  return block.message.id;
}

export const AgentMessageList = memo(function AgentMessageList({
  ref,
  provider,
  blocks,
  approvals,
  sessionError,
  localError,
  busy,
  busyText,
  thinkingSince,
  thinking,
  projectPath,
  stickRef,
  onAnswer,
  onActiveUserChange,
  onOpenTask,
}: Props & { ref?: React.Ref<AgentMessageListHandle> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | undefined)[]>([]);
  const heights = useRef(new Map<string, number>());
  const heightObserverRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [highlight, setHighlight] = useState<string | null>(null);
  // 图片预览：记录被点击的那组图片与下标，点击缩略图时打开弹窗而不是新开标签页。
  const [preview, setPreview] = useState<{ images: AiChatImage[]; index: number } | null>(null);
  const openPreview = useCallback((images: AiChatImage[], index: number) => setPreview({ images, index }), []);
  const previewImages = useMemo(
    () => preview?.images.map(image => ({ url: convertFileSrc(image.path), name: image.name })) ?? [],
    [preview],
  );

  // 块高实测：占位与真身共用 wrapper，观察 wrapper 即可拿到两种状态的真实高度。
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vkey;
        if (!key) continue;
        heights.current.set(key, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      }
    });
    heightObserverRef.current = observer;
    return () => { observer.disconnect(); heightObserverRef.current = null; };
  }, []);

  // React 19 ref cleanup：卸载时 unobserve 并清理引用（审查 V-7）——
  // 此前对 null 早退，滚出窗口的块不 unobserve，ResizeObserver 强引用
  // 让 DOM 子树无法回收。
  const attachItem = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const index = Number(el.dataset.vindex);
    if (!Number.isFinite(index)) return;
    const previous = itemRefs.current[index];
    if (previous && previous !== el) {
      heightObserverRef.current?.unobserve(previous);
    }
    itemRefs.current[index] = el;
    heightObserverRef.current?.observe(el);
    return () => {
      heightObserverRef.current?.unobserve(el);
      if (itemRefs.current[index] === el) {
        itemRefs.current[index] = undefined;
      }
    };
  }, []);

  /** 计算视口覆盖的块区间 → 渲染窗口 + 当前视口内的用户节点（scroll spy）。 */
  const recompute = useCallback(() => {
    const container = scrollRef.current;
    if (!container || blocks.length === 0) return;
    const containerTop = container.getBoundingClientRect().top;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    const positionOf = (index: number): { top: number; height: number } | null => {
      const node = itemRefs.current[index];
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: rect.top - containerTop + container.scrollTop, height: rect.height };
    };
    // 文档流内块位置单调递增，二分定位第一个进入视口的块。
    let lo = 0, hi = blocks.length - 1, first = blocks.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const position = positionOf(mid);
      if (position && position.top + position.height >= viewTop) { first = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    let last = Math.max(0, first - 1);
    for (let index = first; index < blocks.length; index++) {
      const position = positionOf(index);
      if (!position || position.top > viewBottom) break;
      last = index;
    }
    const start = Math.max(0, first - ITEM_OVERSCAN);
    const end = stickRef.current ? blocks.length : Math.min(blocks.length, last + 1 + ITEM_OVERSCAN);
    setRange(previous => (previous[0] === start && previous[1] === end ? previous : [start, end]));
    let activeId: string | null = null;
    for (let index = first; index <= last && index < blocks.length; index++) {
      const block = blocks[index];
      if (block.kind === 'message' && block.message.role === 'user') { activeId = block.message.id; break; }
    }
    onActiveUserChange(activeId);
  }, [blocks, onActiveUserChange, stickRef]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => { frameRef.current = 0; recompute(); });
  }, [recompute]);

  // 初次加载（或 /clear 后重来）锚定尾部：恢复长会话直接看到最新消息，更早的滚动到时再渲染。
  const seededRef = useRef(false);
  const previousLengthRef = useRef(0);
  useEffect(() => {
    const previous = previousLengthRef.current;
    previousLengthRef.current = blocks.length;
    if (blocks.length < previous) {
      // 历史被整段替换（/clear、resume）：高度缓存全部作效。
      heights.current.clear();
      itemRefs.current.length = blocks.length;
    }
    if (seededRef.current || blocks.length === 0) return;
    seededRef.current = true;
    setRange([Math.max(0, blocks.length - INITIAL_TAIL), blocks.length]);
    // 尾部真身渲染完成后校准一次滚动位置：占位高度是估算值，直接落底可能差一截。
    requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element && stickRef.current) element.scrollTop = element.scrollHeight;
      recompute();
    });
  }, [blocks.length]);

  // 流式追加时贴底跟随。两阶段校准：新块先以估算高度占位，第一帧把渲染窗口扩到尾部，
  // 第二帧真身进 DOM、总高度稳定后再贴底——使用持久 rAF 调度避免高频流式 chunk 持续取消重排。
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;
  const stickRafRef = useRef<{ raf1: number; raf2: number }>({ raf1: 0, raf2: 0 });
  const stickPendingRef = useRef(false);
  useEffect(() => () => {
    cancelAnimationFrame(stickRafRef.current.raf1);
    cancelAnimationFrame(stickRafRef.current.raf2);
  }, []);
  useEffect(() => {
    if (!stickRef.current) return;
    stickPendingRef.current = true;
    if (stickRafRef.current.raf1 || stickRafRef.current.raf2) return;
    const schedule = () => {
      stickPendingRef.current = false;
      stickRafRef.current.raf1 = requestAnimationFrame(() => {
        stickRafRef.current.raf1 = 0;
        recomputeRef.current();
        stickRafRef.current.raf2 = requestAnimationFrame(() => {
          stickRafRef.current.raf2 = 0;
          const element = scrollRef.current;
          if (element && stickRef.current) element.scrollTop = element.scrollHeight;
          if (stickPendingRef.current && stickRef.current) schedule();
        });
      });
    };
    schedule();
  }, [blocks, busy, recompute, stickRef]);

  // 容器尺寸变化（窗口缩放、侧栏开合）后重算窗口。recompute 的 identity 随
  // blocks 每帧变化（流式期间），通过 ref 引用最新实现，观察器只建一次（审查 V-13）。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => recomputeRef.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 高亮定位用最新 blocks 的只读视图（不进 effect 依赖，审查 V-2）。
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const jumpTo = useCallback((messageId: string) => {
    const index = blocksRef.current.findIndex(block => block.kind === 'message' && block.message.id === messageId);
    if (index < 0) return;
    // 用户主动跳离底部：解除贴底跟随，否则流式贴底 effect 会立刻把视口
    // 拽回底部（审查 N-8）。
    stickRef.current = false;
    // 以目标为中心开窗（审查 V-1）：旧实现用新旧窗口并集，长会话一次跳转
    // 会把两点之间全部块挂载，直接击穿虚拟化。
    setRange([Math.max(0, index - ITEM_OVERSCAN), Math.min(blocksRef.current.length, index + 1 + ITEM_OVERSCAN)]);
    setHighlight(messageId);
  }, [stickRef]);

  useImperativeHandle(ref, () => ({ jumpTo }), [jumpTo]);

  // 目标块渲染出来后再滚动 + 高亮，几秒后自动熄灭。不依赖 blocks（审查 V-2）：
  // 依赖含 blocks 时流式期间每帧重发 scrollIntoView 并重置熄灭定时器，用户被
  // 钉死在目标消息上。
  useEffect(() => {
    if (!highlight) return;
    let attempts = 0;
    let raf = 0;
    const tryScroll = () => {
      const index = blocksRef.current.findIndex(block => block.kind === 'message' && block.message.id === highlight);
      const node = index >= 0 ? itemRefs.current[index] : undefined;
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      // 目标块尚未挂载（渲染窗口刚扩展），最多再等 ~500ms。
      if (attempts++ < 30) raf = requestAnimationFrame(tryScroll);
    };
    raf = requestAnimationFrame(tryScroll);
    const timer = window.setTimeout(() => setHighlight(null), 1800);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [highlight]);

  // 流式尾块豁免截断（审查 V-3）：正在增长的最后一条 assistant 消息若也被
  // 字符上限截断，贴底观看时正文冻结、只剩计数在跳。
  const streamingTailId = useMemo(() => {
    if (!busy) return null;
    // 只有「最后一个块本身是 assistant 消息」才可能是正在增长的文字。
    // 若最后是 tools/subagent，说明上方 assistant 已完成、当前在跑工具，
    // 旧实现跳过工具块继续向上找，会把已完成的长回复误判为流式尾块而绕过截断。
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'message' && last.message.role === 'assistant') return last.message.id;
    return null;
  }, [blocks, busy]);

  return (
    <div className="agent-chat-messages" ref={scrollRef} onScroll={onScroll}>
      {blocks.length === 0 && !localError && (
        <div className="agent-chat-empty">
          <AgentIcon provider={provider} className="agent-chat-empty-logo" />
          <div>在下方输入消息开始对话。</div>
          <div className="agent-chat-empty-hint">输入 / 可查看命令与 Skill 补全。</div>
        </div>
      )}
      {blocks.map((block, index) => {
        // 直接在 JSX map 中渲染（审查 V-15）：不再为全部 n 块分配中间包装对象，
        // 流式期间的重渲染少一层 O(n) 对象分配。
        const key = blockKey(block);
        const visible = index >= range[0] && index < range[1];
        const height = visible ? undefined : heights.current.get(key) ?? estimateBlockHeight(block);
        return (
          <div
            key={key}
            data-vindex={index}
            data-vkey={key}
            ref={attachItem}
            className={highlight === key ? 'agent-chat-item agent-chat-item-highlight' : 'agent-chat-item'}
            style={height == null ? undefined : { height }}
          >
            {visible ? (
              block.kind === 'tools'
                ? (block.messages.length > 1
                  ? <ToolGroup messages={block.messages} projectPath={projectPath} />
                  : (isSubagentToolMessage(block.messages[0].text)
                    ? <TaskHead message={block.messages[0]} onOpen={onOpenTask} />
                    : <ToolMessage message={block.messages[0]} />))
                : block.kind === 'subagent'
                  ? <SubagentGroup name={block.name} messages={block.messages} />
                  : (() => {
                  const message = block.message;
                  if (message.modelSwitch) {
                    return <ModelSwitchDivider at={message.createdAt} info={message.modelSwitch} />;
                  }
                  if (message.role === 'user') {
                    return <UserBubble text={message.text} skillName={message.skillName} images={message.images} onPreview={openPreview} />;
                  }
                  if (message.role === 'assistant') {
                    return <AssistantBubble text={message.text} streaming={message.id === streamingTailId} />;
                  }
                  return <ToolMessage message={message} />;
                })()
            ) : null}
          </div>
        );
      })}
      {approvals.map(approval => (
        <ApprovalCard key={approval.id} approval={approval} onAnswer={onAnswer} />
      ))}
      {busy && (
        <div className="agent-bubble-row assistant agent-thinking-row" role="status" aria-live="polite">
          {/* 带思考面板时固定宽度：折叠态那一行是 nowrap + 省略号，宽度若跟着内容走，
              思考文字每跳动一次气泡就伸缩一次，看起来像整页在抖。 */}
          <div className={`agent-bubble assistant agent-thinking-bubble${thinking ? ' has-thinking' : ''}`}>
            <span className="agent-thinking-head">
              <span>
                {busyText}…
                {thinkingSince != null && <ElapsedBadge since={thinkingSince} />}
              </span>
              <span className="agent-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
            </span>
            {/* 思考内容贴在状态行下方：折叠态一行跟随最新思考，展开可看尾部全文。
                没有思考（如纯工具执行）时面板自身返回 null，不影响原有观感。 */}
            {thinking && <ThinkingPanel thinking={thinking} running />}
          </div>
        </div>
      )}
      {sessionError && <div className="agent-chat-error">{sessionError}</div>}
      {localError && <div className="agent-chat-error">{localError}</div>}
      {/* 预览弹窗挂在滚动容器外层的末尾：不参与虚拟化窗口，也不会随消息块卸载。 */}
      {preview && previewImages.length > 0 && (
        <ImageLightbox
          images={previewImages}
          index={preview.index}
          onIndexChange={index => setPreview(current => (current ? { ...current, index } : current))}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
});
