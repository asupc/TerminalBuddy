import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * 输入节点导轨，移植自 ZCode `packages/ui/src/v4/ConversationTurnNavigator.tsx`：
 * 每条用户输入一根短横线，悬停时形成「山峰」——中心横线最长，邻近两条依次
 * 变短，同时弹出该轮的输入与回复摘要，点击定位到对应消息。
 * ZCode 把导轨放在会话左侧，这里按需求放在右侧，所以所有伸缩都以右端为原点。
 */
export interface ChatNode {
  id: string;
  /** 首行摘要，供无障碍名称使用。 */
  label: string;
  /** 该轮用户输入原文，悬停时才按 ZCode 的规则生成摘要。 */
  userText: string;
  /** 该轮助手的文字回复原文；没有正文时省略。 */
  assistantText?: string;
}

/** 与 ZCode `buildPreviewText` 一致：最多 2 段、220 字。 */
const OUTLINE_PREVIEW_CHARS = 220;
const OUTLINE_PREVIEW_PARAGRAPHS = 2;

function outlinePreview(text: string): string {
  // 先截一段再规整：超长回复不必每帧对整段做替换和分行。
  const head = text.length > OUTLINE_PREVIEW_CHARS * 4 ? text.slice(0, OUTLINE_PREVIEW_CHARS * 4) : text;
  const normalized = head.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const paragraphs: string[] = [];
  for (const line of normalized.split('\n')) {
    const value = line.replace(/[ \t]+/g, ' ').trim();
    if (!value) continue;
    paragraphs.push(value);
    if (paragraphs.length >= OUTLINE_PREVIEW_PARAGRAPHS) break;
  }
  const merged = paragraphs.join('\n');
  return merged.length > OUTLINE_PREVIEW_CHARS
    ? `${merged.slice(0, OUTLINE_PREVIEW_CHARS - 3).trimEnd()}...`
    : merged;
}

interface ChatNodeRailProps {
  nodes: ChatNode[];
  /** 当前视口内的用户输入（scroll spy 上报），没有悬停时高亮对应横线。 */
  activeId: string | null;
  onJump: (id: string) => void;
}

/** 容器过窄时隐藏导轨（ZCode 的门槛是 864px 的左侧 48px 槽位，这里改为覆盖式，门槛更低）。 */
const MIN_RAIL_WIDTH = 640;
/** 浮层与容器上下边缘的最小留白。 */
const TIP_MARGIN = 10;
/** 与 ZCode HoverCard 一致的延迟：悬停 120ms 后再弹浮层，离开 80ms 后收起。 */
const TIP_OPEN_DELAY = 120;
const TIP_CLOSE_DELAY = 80;

/**
 * ZCode `resolveConversationTurnNavigatorBarVisualState` 的移植：
 * 以交互项为中心，0/1/2 格内依次为 peak/near/mid，更远为 idle；
 * 鼠标离开时恢复为「当前滚动位置」单条高亮。
 */
function barVisual(index: number, focusIndex: number | null, activeIndex: number) {
  if (focusIndex == null) {
    return index === activeIndex
      ? { opacity: 0.9, scale: 1, focus: true }
      : { opacity: 0.58, scale: 1, focus: false };
  }
  const distance = Math.min(3, Math.abs(index - focusIndex));
  if (distance === 0) return { opacity: 1, scale: 2.6, focus: true };
  if (distance === 1) return { opacity: 0.86, scale: 1.7, focus: false };
  if (distance === 2) return { opacity: 0.72, scale: 1.25, focus: false };
  return { opacity: 0.58, scale: 1, focus: false };
}

export const ChatNodeRail = memo(function ChatNodeRail({ nodes, activeId, onJump }: ChatNodeRailProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // 横线的「山峰」跟随指针立即变化，浮层则按 ZCode 的 120ms/80ms 延迟出现与收起。
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [tipIndex, setTipIndex] = useState<number | null>(null);
  const [tipTop, setTipTop] = useState<number | null>(null);
  const [narrow, setNarrow] = useState(false);
  const activeIndex = activeId ? nodes.findIndex(node => node.id === activeId) : -1;
  const tipNode = tipIndex != null ? nodes[tipIndex] ?? null : null;
  // 摘要只在浮层展示的那一条上计算，避免流式期间为整份历史反复规整正文。
  const tipPreview = useMemo(() => {
    if (!tipNode) return null;
    return {
      user: outlinePreview(tipNode.userText) || tipNode.label,
      assistant: tipNode.assistantText ? outlinePreview(tipNode.assistantText) : '',
    };
  }, [tipNode]);

  // 按 ZCode 的 pane 宽度门槛隐藏导轨；导轨是覆盖式，门槛比 ZCode 的 864px 低。
  useEffect(() => {
    const host = railRef.current?.parentElement;
    if (!host) return;
    const update = () => setNarrow(host.clientWidth < MIN_RAIL_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 节点被整段替换（/clear、resume）后，悬停索引可能越界。
  useEffect(() => {
    setFocusIndex(current => (current != null && current >= nodes.length ? null : current));
    setTipIndex(current => (current != null && current >= nodes.length ? null : current));
  }, [nodes.length]);

  // 浮层延迟：先立即收起旧卡片，再在 120ms 后展示新索引对应内容。
  useEffect(() => {
    if (focusIndex == null) {
      const timer = window.setTimeout(() => setTipIndex(null), TIP_CLOSE_DELAY);
      return () => window.clearTimeout(timer);
    }
    setTipIndex(current => (current === focusIndex ? current : null));
    const timer = window.setTimeout(() => setTipIndex(focusIndex), TIP_OPEN_DELAY);
    return () => window.clearTimeout(timer);
  }, [focusIndex]);

  // 浮层以悬停横线的垂直中心定位，并夹在导轨可视范围内：首尾节点不越界。
  useLayoutEffect(() => {
    if (tipIndex == null) { setTipTop(null); return; }
    const rail = railRef.current;
    const tip = tipRef.current;
    if (!rail || !tip) return;
    const bar = rail.querySelector<HTMLElement>(`[data-node-index="${tipIndex}"]`);
    if (!bar) return;
    const railRect = rail.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const center = barRect.top - railRect.top + barRect.height / 2;
    const half = tip.offsetHeight / 2;
    const min = half + TIP_MARGIN;
    const max = rail.clientHeight - half - TIP_MARGIN;
    setTipTop(max < min ? rail.clientHeight / 2 : Math.min(Math.max(center, min), max));
  }, [tipIndex, nodes.length]);

  // 与 ZCode 一致：滚动时把当前节点带回导轨可视范围（不打断正在悬停的浏览）。
  useEffect(() => {
    if (focusIndex != null || activeIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const bar = list.querySelector<HTMLElement>(`[data-node-index="${activeIndex}"]`);
    if (!bar) return;
    const listRect = list.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    if (barRect.top < listRect.top) list.scrollTop -= listRect.top - barRect.top;
    else if (barRect.bottom > listRect.bottom) list.scrollTop += barRect.bottom - listRect.bottom;
  }, [activeIndex, focusIndex]);

  // 数量不足或容器过窄时保留外壳（ResizeObserver 需要稳定的观察锚点），只隐藏内容。
  // ZCode 在少于 2 项时也隐藏导轨；这里按「几个对话就几根横线」保留单条。
  const hidden = narrow || nodes.length === 0;

  return (
    <nav
      className={`agent-node-rail${hidden ? ' hidden' : ''}`}
      ref={railRef}
      aria-label="输入节点导航"
    >
      <div
        className="agent-node-rail-list"
        ref={listRef}
        // 事件委托：指针在横线之间移动时不会先清空再设置，避免山峰闪断。
        onPointerOver={event => {
          const target = (event.target as HTMLElement).closest<HTMLElement>('[data-node-index]');
          setFocusIndex(target ? Number(target.dataset.nodeIndex) : null);
        }}
        onPointerLeave={() => setFocusIndex(null)}
        // 与 ZCode 一致：滚动导轨时收起浮层，避免内容与指针位置错位。
        onScroll={() => setFocusIndex(null)}
      >
        {nodes.map((node, index) => {
          const visual = barVisual(index, focusIndex, activeIndex);
          return (
            <button
              key={node.id}
              type="button"
              data-node-index={index}
              className={`agent-node-bar${visual.focus ? ' focus' : ''}`}
              aria-label={node.label}
              aria-current={index === activeIndex ? 'location' : undefined}
              aria-posinset={index + 1}
              aria-setsize={nodes.length}
              onFocus={() => setFocusIndex(index)}
              onBlur={() => setFocusIndex(current => (current === index ? null : current))}
              onClick={() => onJump(node.id)}
            >
              <span
                className="agent-node-bar-fill"
                style={{ opacity: visual.opacity, transform: `scaleX(${visual.scale})` }}
              />
            </button>
          );
        })}
      </div>
      {tipNode && tipPreview && (
        <div
          ref={tipRef}
          className={`agent-node-tip${tipTop == null ? ' pending' : ''}`}
          style={tipTop == null ? undefined : { top: tipTop }}
          role="tooltip"
        >
          <div className="agent-node-tip-user">{tipPreview.user}</div>
          {tipPreview.assistant && (
            <div className="agent-node-tip-reply">{tipPreview.assistant}</div>
          )}
        </div>
      )}
    </nav>
  );
});
