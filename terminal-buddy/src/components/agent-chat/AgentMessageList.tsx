import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Bot, CornerDownLeft } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { ChatMarkdown } from './ChatMarkdown';
import { SkillEntry } from './SkillEntry';
import { ApprovalCard } from './ApprovalCard';
import type { AiApproval, AiMessage, AiModelSwitch, AnswerAiApproval } from '../../services/tauri';

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
  /** 已等待秒数提示（busy 超过阈值时由父组件拼好文案）。 */
  elapsedText: string | null;
  /** 是否粘住底部：由父组件持有，用户上滚后置 false。 */
  stickRef: { current: boolean };
  onAnswer: (approval: AnswerAiApproval) => void;
  /** 视口内第一个用户消息变化时上报，驱动右侧导航的当前节点高亮。 */
  onActiveUserChange: (id: string | null) => void;
}

export function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toolTitle(message: AiMessage): string {
  const newline = message.text.indexOf('\n');
  return (newline >= 0 ? message.text.slice(0, newline) : message.text).trim();
}

/** 工具输出的渲染上限：巨型日志整段进 DOM 同样会撑爆内存，默认截断、可手动展开。 */
const TOOL_BODY_LIMIT = 20000;

const ToolMessage = memo(function ToolMessage({ message }: { message: AiMessage }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const newline = message.text.indexOf('\n');
  const title = message.text.slice(0, newline >= 0 ? newline : undefined);
  const body = newline >= 0 ? message.text.slice(newline + 1) : '';
  const truncated = !full && body.length > TOOL_BODY_LIMIT;
  return (
    <div className={`agent-tool-entry${open ? ' open' : ''}`}>
      <button className="agent-tool-header" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <CornerDownLeft aria-hidden="true" />
        <span className="agent-tool-title">{title || '工具调用'}</span>
      </button>
      {open && body && (
        truncated ? (
          <div className="agent-tool-body-wrap">
            <pre className="agent-tool-body">{body.slice(0, TOOL_BODY_LIMIT)}</pre>
            <button className="agent-btn small agent-expand-full" onClick={() => setFull(true)}>
              展开全部（{body.length} 字符）
            </button>
          </div>
        ) : <pre className="agent-tool-body">{body}</pre>
      )}
    </div>
  );
});

/**
 * 连续的工具调用合并成一个可展开条目：多轮命令不再把对话刷成一长串工具名。
 * 比较器按消息对象引用判断：流式更新未触及的消息引用稳定，可整组跳过重渲染。
 */
const ToolGroup = memo(function ToolGroup({ messages }: { messages: AiMessage[] }) {
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
}, (prev, next) => prev.messages.length === next.messages.length
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

const UserBubble = memo(function UserBubble({ text, skillName }: { text: string; skillName?: string }) {
  if (skillName) return <SkillEntry name={skillName} text={text} />;
  return (
    <div className="agent-bubble-row user">
      <div className="agent-bubble user">{text}</div>
    </div>
  );
});

/**
 * 子代理（Task 工具启动）消息组：连续的同名子代理消息合并为一个可折叠条目，
 * 默认折叠只显示概要，展开后按原顺序显示文本回复与工具调用。
 */
const SubagentGroup = memo(function SubagentGroup({ name, messages }: { name: string; messages: AiMessage[] }) {
  const [open, setOpen] = useState(false);
  const toolCount = messages.filter(message => message.role === 'tool').length;
  const textCount = messages.length - toolCount;
  return (
    <div className={`agent-tool-entry agent-subagent-entry${open ? ' open' : ''}`}>
      <button className="agent-tool-header" onClick={() => setOpen(value => !value)} aria-expanded={open}>
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
    </div>
  );
}, (prev, next) => prev.name === next.name
  && prev.messages.length === next.messages.length
  && prev.messages.every((message, index) => message === next.messages[index]));

const AssistantBubble = memo(function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="agent-bubble-row assistant">
      <div className="agent-bubble assistant"><ChatMarkdown text={text} /></div>
    </div>
  );
});

function estimateBlockHeight(block: ChatBlock): number {
  if (block.kind === 'tools') return Math.max(44, 44 * block.messages.length);
  if (block.kind === 'subagent') return 44;
  const message = block.message;
  if (message.modelSwitch) return 32;
  if (message.role === 'user') return 64;
  if (message.role === 'assistant') return ESTIMATED_HEIGHT;
  return 44;
}

function blockKey(block: ChatBlock): string {
  if (block.kind === 'tools') return `tools-${block.messages[0].id}`;
  if (block.kind === 'subagent') return `sub-${block.messages[0].id}`;
  return block.message.id;
}

export function AgentMessageList({
  ref,
  provider,
  blocks,
  approvals,
  sessionError,
  localError,
  busy,
  busyText,
  elapsedText,
  stickRef,
  onAnswer,
  onActiveUserChange,
}: Props & { ref?: React.Ref<AgentMessageListHandle> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const heights = useRef(new Map<string, number>());
  const heightObserverRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [highlight, setHighlight] = useState<string | null>(null);

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

  const attachItem = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const index = Number(el.dataset.vindex);
    if (!Number.isFinite(index)) return;
    itemRefs.current[index] = el;
    heightObserverRef.current?.observe(el);
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
  // 第二帧真身进 DOM、总高度稳定后再贴底——否则视口会停在占位时代的估算位置，
  // 底部的思考呼吸点看起来就像「消失了」。
  useEffect(() => {
    if (!stickRef.current) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      recompute();
      raf2 = requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (element && stickRef.current) element.scrollTop = element.scrollHeight;
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [blocks, busy, recompute, stickRef]);

  // 容器尺寸变化（窗口缩放、侧栏开合）后重算窗口。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => recompute());
    observer.observe(element);
    return () => observer.disconnect();
  }, [recompute]);

  const jumpTo = useCallback((messageId: string) => {
    const index = blocks.findIndex(block => block.kind === 'message' && block.message.id === messageId);
    if (index < 0) return;
    // 先把目标块纳入渲染窗口再滚动：即便前面的占位高度是估算值，
    // scrollIntoView 也会按元素真实位置把它带进视口。
    setRange(previous => [Math.min(previous[0], index), Math.max(previous[1], index + 1)]);
    setHighlight(messageId);
  }, [blocks]);

  useImperativeHandle(ref, () => ({ jumpTo }), [jumpTo]);

  // 目标块渲染出来后再滚动 + 高亮，几秒后自动熄灭。
  useEffect(() => {
    if (!highlight) return;
    const index = blocks.findIndex(block => block.kind === 'message' && block.message.id === highlight);
    if (index >= 0) itemRefs.current[index]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = window.setTimeout(() => setHighlight(null), 1800);
    return () => window.clearTimeout(timer);
  }, [highlight, blocks]);

  const rendered = useMemo(() => {
    const nodes: Array<{ key: string; index: number; visible: boolean; height: number | undefined; block: ChatBlock }> = [];
    blocks.forEach((block, index) => {
      const key = blockKey(block);
      const visible = index >= range[0] && index < range[1];
      const height = visible ? undefined : heights.current.get(key) ?? estimateBlockHeight(block);
      nodes.push({ key, index, visible, height, block });
    });
    return nodes;
  }, [blocks, range]);

  return (
    <div className="agent-chat-messages" ref={scrollRef} onScroll={onScroll}>
      {blocks.length === 0 && !localError && (
        <div className="agent-chat-empty">
          <AgentIcon provider={provider} className="agent-chat-empty-logo" />
          <div>在下方输入消息开始对话。</div>
          <div className="agent-chat-empty-hint">输入 / 可查看命令与 Skill 补全。</div>
        </div>
      )}
      {rendered.map(item => (
        <div
          key={item.key}
          data-vindex={item.index}
          data-vkey={item.key}
          ref={attachItem}
          className={highlight === item.key ? 'agent-chat-item agent-chat-item-highlight' : 'agent-chat-item'}
          style={item.height == null ? undefined : { height: item.height }}
        >
          {item.visible ? (
            item.block.kind === 'tools'
              ? (item.block.messages.length > 1
                ? <ToolGroup messages={item.block.messages} />
                : <ToolMessage message={item.block.messages[0]} />)
              : item.block.kind === 'subagent'
                ? <SubagentGroup name={item.block.name} messages={item.block.messages} />
                : (() => {
                const message = item.block.message;
                if (message.modelSwitch) {
                  return <ModelSwitchDivider at={message.createdAt} info={message.modelSwitch} />;
                }
                if (message.role === 'user') {
                  return <UserBubble text={message.text} skillName={message.skillName} />;
                }
                if (message.role === 'assistant') {
                  return <AssistantBubble text={message.text} />;
                }
                return <ToolMessage message={message} />;
              })()
          ) : null}
        </div>
      ))}
      {approvals.map(approval => (
        <ApprovalCard key={approval.id} approval={approval} onAnswer={onAnswer} />
      ))}
      {busy && (
        <div className="agent-bubble-row assistant agent-thinking-row" role="status" aria-live="polite">
          <div className="agent-bubble assistant agent-thinking-bubble">
            <span className="agent-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
            <span>
              {busyText}…
              {elapsedText && <span className="agent-thinking-elapsed"> {elapsedText}</span>}
            </span>
          </div>
        </div>
      )}
      {sessionError && <div className="agent-chat-error">{sessionError}</div>}
      {localError && <div className="agent-chat-error">{localError}</div>}
    </div>
  );
}
