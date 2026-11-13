import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Coins, Gauge } from 'lucide-react';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { cacheHitRate, compact, contextPercent } from '../agent-chat/UsagePanel';
import { AgentStatsPopover } from './AgentStatsPopover';
import { agentEffortLabel, contextLevel, type AgentStatusView } from './agentStatusView';
import './StatusBarAgent.css';

/**
 * 底部状态栏里的 Agent 信息条目：模型、思考强度、上下文占比与累计 Token 收在
 * 同一个可点击组件里；点击后向上弹出详情浮层，展示完整用量明细。
 */
export function StatusBarAgent({ view }: { view: AgentStatusView }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const percent = contextPercent(view.context);
  const level = contextLevel(percent);
  const effortLabel = agentEffortLabel(view.effort);
  const contextText = percent != null
    ? `${percent}%`
    : view.context?.usedTokens ? compact(view.context.usedTokens) : null;
  const total = view.sessionTotal;
  const tokenText = total && (total.inputTokens != null || total.outputTokens != null)
    ? `↑${compact(total.inputTokens)} ↓${compact(total.outputTokens)}`
    : null;
  const cacheRate = total ? cacheHitRate(total) : '—';

  const openPopover = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 浮层与详情面板同宽，靠近左边缘时贴边，避免超出视口。
    const width = Math.min(360, window.innerWidth - 16);
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - rect.top + 6,
    });
    setOpen(true);
  }, []);
  const closePopover = useCallback(() => setOpen(false), []);
  const togglePopover = useCallback(() => {
    if (open) setOpen(false);
    else openPopover();
  }, [open, openPopover]);

  // 只要确定这是 Agent 会话就保留条目：刚启动、transcript 尚未产生用量时
  // 先显示 Agent 名称，避免状态栏在会话最初几秒里整条消失。
  if (!view.model && !effortLabel && !contextText && !tokenText && !view.providerLabel) return null;

  const title = [
    `${view.providerLabel}${view.model ? ` · ${view.model}` : ''}`,
    effortLabel ? `思考强度：${effortLabel}` : '',
    percent != null
      ? `上下文 ${percent}%（${compact(view.context?.usedTokens)} / ${compact(view.context?.windowTokens)} token）`
      : view.context?.usedTokens ? `上下文已用 ${compact(view.context.usedTokens)} token` : '',
    tokenText ? `本会话累计 ${tokenText}` : '',
    '点击查看 Agent 详情',
  ].filter(Boolean).join('\n');

  return (
    <>
      <span className="app-statusbar-divider" aria-hidden="true" />
      <button
        ref={buttonRef}
        type="button"
        className={`app-statusbar-item app-statusbar-clickable app-statusbar-agent${open ? ' active' : ''}`}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={togglePopover}
      >
        <AgentIcon
          provider={view.provider}
          className={`app-statusbar-agent-logo provider-${view.provider}`}
        />
        {view.model ? (
          <span className="app-statusbar-label app-statusbar-agent-model">{view.model}</span>
        ) : (
          <span className="app-statusbar-label">{view.providerLabel}</span>
        )}
        {effortLabel && (
          <span className="app-statusbar-agent-effort">思考 {effortLabel}</span>
        )}
        {contextText && (
          <span className={`app-statusbar-agent-metric app-statusbar-optional${level ? ` ${level}` : ''}`}>
            <Gauge className="app-statusbar-icon" aria-hidden="true" />
            <span className="app-statusbar-label">上下文</span>
            <span className="app-statusbar-mono">{contextText}</span>
          </span>
        )}
        {tokenText && (
          <span className="app-statusbar-agent-metric app-statusbar-optional">
            <Coins className="app-statusbar-icon" aria-hidden="true" />
            <span className="app-statusbar-mono">{tokenText}</span>
            {cacheRate !== '—' && <span className="app-statusbar-muted">缓存 {cacheRate}</span>}
          </span>
        )}
      </button>
      {open && anchor && createPortal(
        <AgentStatsPopover
          view={view}
          anchor={anchor}
          anchorRef={buttonRef}
          onClose={closePopover}
        />,
        document.body,
      )}
    </>
  );
}
