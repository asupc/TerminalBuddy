import { memo, useEffect, useMemo, useRef } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { ChatMarkdown } from './ChatMarkdown';
import type { AiAgent, AiMessage } from '../../services/tauri';

/**
 * 子代理抽屉：展示单个子代理的完整工作过程。
 *
 * 按 `subagentKey` 过滤父组件已持有的 `messages`（旧会话无分组键时按子代理名回落），
 * 不触碰 AgentMessageList 的虚拟化窗口；
 * 无全屏遮罩，主列表保持可见可滚动。窄屏（< 640px）由 CSS 铺满宽度。
 * 规格见 docs/原生会话任务清单与子代理面板实施计划.md 第 6.3 节。
 */

const TOOL_BODY_LIMIT = 20000;
const TOOL_TITLE_LIMIT = 200;

function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${total}s`;
}

const STATUS_TEXT: Record<string, string> = {
  running: '执行中',
  pending: '等待中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  killed: '已停止',
};
function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

/** 抽屉内的工具条目：默认收起，长结果截断（与主列表一致）。 */
const DrawerTool = memo(function DrawerTool({ message }: { message: AiMessage }) {
  const newline = message.text.indexOf('\n');
  const rawTitle = message.text.slice(0, newline >= 0 ? newline : undefined);
  const title = rawTitle.length > TOOL_TITLE_LIMIT ? `${rawTitle.slice(0, TOOL_TITLE_LIMIT)}…` : rawTitle;
  const body = newline >= 0 ? message.text.slice(newline + 1) : '';
  return (
    <details className="agent-drawer-tool">
      <summary><CornerDownLeft aria-hidden="true" /><span>{title || '工具调用'}</span></summary>
      {body && <pre>{body.length > TOOL_BODY_LIMIT ? `${body.slice(0, TOOL_BODY_LIMIT)}…` : body}</pre>}
    </details>
  );
});

interface Props {
  agent: AiAgent;
  /** 该子代理的分组键（`{turn}:{parent}`）；为空时不筛选任何消息。 */
  subagentKey: string | null;
  messages: AiMessage[];
  onClose: () => void;
}

export const AgentDrawer = memo(function AgentDrawer({ agent, subagentKey, messages, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const own = useMemo(() => {
    // 有分组键时精确筛选（同名代理不误并组）；旧会话没有 subagentKey 时回落按名字，
    // 与主列表的分组回落规则保持一致，避免抽屉永远是空态。
    if (subagentKey) return messages.filter(message => message.subagentKey === subagentKey);
    return messages.filter(message => !message.subagentKey && message.subagent === agent.name);
  }, [messages, subagentKey, agent.name]);

  // 打开时聚焦关闭按钮：Esc 关闭后焦点回到触发它的 chip（父组件负责回焦）。
  useEffect(() => { closeRef.current?.focus(); }, [agent.taskId]);

  // Esc 关闭。监听挂在 document 上：焦点可能落在抽屉内的任意元素。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const endedAt = agent.endedAt ?? Date.now();
  const duration = agent.durationMs ?? (agent.status === 'running' ? null : endedAt - agent.startedAt);
  const meta = [
    agent.description,
    `开始 ${formatClock(agent.startedAt)}`,
    duration != null ? `耗时 ${durationText(duration)}` : null,
    agent.toolUses != null ? `${agent.toolUses} 次工具` : null,
    agent.depth > 1 ? `深度 ${agent.depth}` : null,
  ].filter((item): item is string => Boolean(item && item.trim()));

  return (
    <aside className="agent-drawer" aria-label={`${agent.name} 的工作过程`}>
      <div className="agent-drawer-head">
        <span className={`agent-drawer-dot ${agent.status}`} aria-hidden="true" />
        <span className="agent-drawer-name">{agent.name}</span>
        <span className={`agent-drawer-badge ${agent.status}`}>{statusText(agent.status)}</span>
        <span className="agent-drawer-spacer" />
        <button ref={closeRef} type="button" className="agent-btn small" onClick={onClose}>✕ 关闭</button>
      </div>
      {meta.length > 0 && (
        <div className="agent-drawer-meta">
          {meta.map(text => <span key={text}>{text}</span>)}
        </div>
      )}
      <div className="agent-drawer-body" ref={bodyRef}>
        {own.length === 0 && <div className="agent-drawer-empty">该子代理尚未产生输出</div>}
        {own.map(message => message.role === 'tool'
          ? <DrawerTool key={message.id} message={message} />
          : (
            <div key={message.id} className="agent-drawer-row">
              <div className={`agent-drawer-bubble ${message.role}`}>
                <ChatMarkdown text={message.text} />
              </div>
            </div>
          ))}
      </div>
    </aside>
  );
});
