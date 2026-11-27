import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Coins, Gauge, Sparkles, User } from 'lucide-react';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { cacheHitRate, compact, contextPercent } from '../agent-chat/UsagePanel';
import { antigravityQuotaCacheKey, useAntigravityQuotaStore } from '../../stores/antigravityQuotaStore';
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
  const isAntigravity = view.provider === 'antigravity';
  const agyQuotaKey = antigravityQuotaCacheKey(view.accountId ?? null);
  const agyQuotaEntry = useAntigravityQuotaStore(s => (isAntigravity ? s.entries[agyQuotaKey] : undefined));
  const fetchQuota = useAntigravityQuotaStore(s => s.fetchQuota);
  const agyQuota = isAntigravity ? (agyQuotaEntry?.data ?? null) : null;
  const agyQuotaLoading = isAntigravity ? Boolean(agyQuotaEntry?.loading) : false;
  const agyQuotaError = isAntigravity ? (agyQuotaEntry?.error ?? null) : null;

  const loadAgyQuota = useCallback((forceRefresh = false) => {
    if (!isAntigravity) return;
    void fetchQuota(view.accountId ?? null, forceRefresh);
  }, [fetchQuota, isAntigravity, view.accountId]);

  useEffect(() => {
    if (!isAntigravity) return;
    loadAgyQuota(false);
  }, [isAntigravity, view.accountId, loadAgyQuota]);

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

  const formatResetShort = (raw?: string | null): string | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const ms = /^\d{10,13}$/.test(trimmed)
      ? (trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed))
      : Date.parse(trimmed);
    if (!Number.isNaN(ms)) {
      const diffSec = Math.floor((ms - Date.now()) / 1000);
      if (diffSec <= 0) return '已刷新';
      const days = Math.floor(diffSec / 86400);
      const hours = Math.floor((diffSec % 86400) / 3600);
      const mins = Math.floor((diffSec % 3600) / 60);
      if (days > 0) return `${days}d${hours}h`;
      if (hours > 0) return `${hours}h${mins}m`;
      return `${Math.max(1, mins)}m`;
    }
    return trimmed.replace(/^(?:resets?\s+(?:in|at)\s+|in\s+|刷新于\s*|重置于\s*)/i, '').trim() || trimmed;
  };
  const window5h = agyQuota?.geminiWindows.find(w => w.kind === 'session_5h') ?? null;
  const windowWeekly = agyQuota?.geminiWindows.find(w => w.kind === 'weekly') ?? null;
  const geminiLevel = agyQuota?.geminiPercent != null
    ? (agyQuota.geminiPercent <= 10 ? 'critical' : agyQuota.geminiPercent <= 30 ? 'warn' : null)
    : null;
  const gemini5hReset = formatResetShort(window5h?.resetText);
  const geminiWeeklyReset = formatResetShort(windowWeekly?.resetText);
  const geminiQuotaText = (() => {
    if (window5h || windowWeekly) {
      const parts: string[] = [];
      if (window5h && (window5h.remainingPercent != null || gemini5hReset)) {
        const pct = window5h.remainingPercent != null ? `${window5h.remainingPercent}%` : '—';
        parts.push(`5h ${pct}${gemini5hReset ? `(${gemini5hReset})` : ''}`);
      }
      if (windowWeekly && (windowWeekly.remainingPercent != null || geminiWeeklyReset)) {
        const pct = windowWeekly.remainingPercent != null ? `${windowWeekly.remainingPercent}%` : '—';
        parts.push(`周 ${pct}${geminiWeeklyReset ? `(${geminiWeeklyReset})` : ''}`);
      }
      if (parts.length > 0) return parts.join(' · ');
    }
    if (agyQuota?.geminiPercent != null) return `${agyQuota.geminiPercent}%`;
    return agyQuotaLoading ? '…' : null;
  })();

  const title = [
    `${view.providerLabel}${view.accountAlias ? ` · 账号：${view.accountAlias}` : ''}${view.model ? ` · ${view.model}` : ''}`,
    ...(agyQuota?.geminiWindows.map(w => {
      const r = formatResetShort(w.resetText);
      return `Gemini ${w.label}：${w.remainingPercent != null ? `剩余 ${w.remainingPercent}%` : '—'}${r ? `（刷新 ${r}）` : ''}`;
    }) ?? (agyQuota?.geminiPercent != null ? [`Gemini 剩余额度：${agyQuota.geminiPercent}%`] : [])),
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
        {isAntigravity && view.accountAlias && (
          <span className="app-statusbar-agent-metric">
            <User className="app-statusbar-icon" aria-hidden="true" />
            <span className="app-statusbar-label">{view.accountAlias}</span>
          </span>
        )}
        {view.model ? (
          <span className="app-statusbar-label app-statusbar-agent-model">{view.model}</span>
        ) : !isAntigravity ? (
          <span className="app-statusbar-label">{view.providerLabel}</span>
        ) : null}
        {isAntigravity && geminiQuotaText && (
          <span className={`app-statusbar-agent-metric${geminiLevel ? ` ${geminiLevel}` : ''}`}>
            <Sparkles className="app-statusbar-icon" aria-hidden="true" />
            <span className="app-statusbar-label">Gemini</span>
            <span className="app-statusbar-mono">{geminiQuotaText}</span>
          </span>
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
          agyQuota={agyQuota}
          agyQuotaLoading={agyQuotaLoading}
          agyQuotaError={agyQuotaError}
          onRefreshAgyQuota={() => loadAgyQuota(true)}
        />,
        document.body,
      )}
    </>
  );
}
