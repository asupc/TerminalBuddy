import { useEffect, useRef, type RefObject } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { AiTokenUsage, AntigravityQuotaSummary } from '../../services/tauri';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { AntigravityQuotaRings } from '../shared/QuotaRing';
import { cacheHitRate, contextPercent, precise } from '../agent-chat/UsagePanel';
import { agentEffortLabel, contextLevel, type AgentStatusView } from './agentStatusView';
import './StatusBarAgent.css';

const STATUS_LABELS: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  approval: '等待确认',
  background: '后台运行',
  stopping: '正在停止',
  interrupted: '已中断',
  error: '出错',
};

const STATUS_TONES: Record<string, string> = {
  running: 'running',
  approval: 'warn',
  background: 'running',
  interrupted: 'warn',
  error: 'danger',
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatClock(millis: number): string {
  const date = new Date(millis);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatQuotaResetDetail(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const ms = /^\d{10,13}$/.test(trimmed)
    ? (trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed))
    : Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    const d = new Date(ms);
    const clock = `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const diffSec = Math.floor((ms - Date.now()) / 1000);
    if (diffSec <= 0) return `已刷新（${clock}）`;
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const rel = days > 0 ? `${days}天${hours}小时` : hours > 0 ? `${hours}小时${mins}分` : `${Math.max(1, mins)}分钟`;
    return `${rel}后刷新（${clock}）`;
  }
  const cleaned = trimmed.replace(/^(?:resets?\s+(?:in|at)\s+|in\s+|刷新于\s*|重置于\s*)/i, '').trim() || trimmed;
  return `刷新：${cleaned}`;
}

function hasTokens(tokens: AiTokenUsage | null): tokens is AiTokenUsage {
  if (!tokens) return false;
  return tokens.inputTokens != null
    || tokens.outputTokens != null
    || tokens.cacheReadInputTokens != null
    || tokens.cacheCreationInputTokens != null;
}

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="agent-stats-row">
      <span className="agent-stats-row-label">{label}</span>
      <span className="agent-stats-row-value">
        {value}
        {hint && <span className="agent-stats-row-hint">{hint}</span>}
      </span>
    </div>
  );
}

interface AgentStatsPopoverProps {
  view: AgentStatusView;
  /** 相对视口的定位：距左边缘、距底部（状态栏上沿之上）。 */
  anchor: { left: number; bottom: number };
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  agyQuota?: AntigravityQuotaSummary | null;
  agyQuotaLoading?: boolean;
  agyQuotaError?: string | null;
  onRefreshAgyQuota?: () => void;
}

/**
 * 状态栏 Agent 详情浮层：在用的模型 / 思考强度 / 上下文占用与累计 Token。
 * 数据与状态栏条目同源，只是把窄条里省略的明细完整展开。
 */
export function AgentStatsPopover({ view, anchor, anchorRef, onClose, agyQuota, agyQuotaLoading, agyQuotaError, onRefreshAgyQuota }: AgentStatsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc / 窗口真实尺寸变化时关闭；点击状态栏条目本身交给外层做开合切换。
  useEffect(() => {
    const initialW = window.innerWidth;
    const initialH = window.innerHeight;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleResize = () => {
      if (Math.abs(window.innerWidth - initialW) <= 1 && Math.abs(window.innerHeight - initialH) <= 1) {
        return;
      }
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [anchorRef, onClose]);

  const context = view.context;
  const percent = contextPercent(context);
  const level = contextLevel(percent);
  const effortLabel = agentEffortLabel(view.effort);
  const statusLabel = view.status ? (STATUS_LABELS[view.status] ?? view.status) : null;
  const statusTone = view.status ? (STATUS_TONES[view.status] ?? '') : '';
  const total = view.sessionTotal;
  const lastTurn = view.lastTurn;

  const contextValue = percent != null
    ? `${percent}%`
    : context?.usedTokens
      ? precise(context.usedTokens)
      : context?.updating ? '等待更新' : '—';

  return (
    <div
      ref={popoverRef}
      className="agent-stats-popover"
      style={{ left: anchor.left, bottom: anchor.bottom }}
      role="dialog"
      aria-label={`${view.providerLabel} Agent 详情`}
      onPointerDown={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <div className="agent-stats-header">
        <AgentIcon
          provider={view.provider}
          className={`agent-stats-logo provider-${view.provider}`}
        />
        <span className="agent-stats-title">{view.providerLabel}</span>
        {statusLabel && (
          <span className={`agent-stats-status${statusTone ? ` ${statusTone}` : ''}`}>{statusLabel}</span>
        )}
        <button
          type="button"
          className="agent-stats-close"
          title="关闭"
          aria-label="关闭 Agent 详情"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="agent-stats-body">
        <div className="agent-stats-grid">
          <StatRow label="模型" value={view.model ?? '未提供'} />
          <StatRow label="思考强度" value={effortLabel ?? '跟随服务端'} />
          <StatRow
            label={view.provider === 'antigravity' ? '使用账号' : '供应商'}
            value={view.provider === 'antigravity'
              ? (view.accountAlias || view.providerName || '系统默认')
              : (view.providerName ?? '默认供应商')}
          />
          <StatRow
            label="数据来源"
            value={view.source === 'native' ? '原生会话 · 实时同步' : '终端 Agent · 定时读取'}
          />
        </div>

        {view.provider === 'antigravity' && (
          <section className="agent-stats-section">
            <h4 className="agent-stats-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Gemini 模型用量</span>
              {onRefreshAgyQuota && (
                <button
                  type="button"
                  className={`agent-stats-close agent-stats-refresh${agyQuotaLoading ? ' is-spinning' : ''}`}
                  aria-disabled={agyQuotaLoading}
                  aria-busy={agyQuotaLoading}
                  onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                  onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!agyQuotaLoading) onRefreshAgyQuota();
                  }}
                  title={agyQuotaLoading ? '正在刷新…' : '刷新 Gemini 用量'}
                >
                  <RefreshCw size={12} />
                </button>
              )}
            </h4>
            {agyQuotaLoading && !agyQuota ? (
              <p className="agent-stats-empty">正在查询账号 Gemini 用量…</p>
            ) : agyQuota && agyQuota.geminiWindows.length > 0 ? (
              <AntigravityQuotaRings windows={agyQuota.geminiWindows} compact />
            ) : (
              <p className="agent-stats-empty">{agyQuotaError || agyQuota?.rawSummary || '暂未获取到 Gemini 额度信息'}</p>
            )}
          </section>
        )}

        <section className="agent-stats-section">
          <h4 className="agent-stats-section-title">上下文</h4>
          {percent != null ? (
            <>
              <div className="agent-stats-context-head">
                <strong className={`agent-stats-context-value${level ? ` ${level}` : ''}`}>{contextValue}</strong>
                <span className="agent-stats-context-capacity">
                  {precise(context?.usedTokens)} / {precise(context?.windowTokens)} token
                </span>
              </div>
              <div className="agent-stats-bar">
                <span
                  className={`agent-stats-bar-fill${level ? ` ${level}` : ''}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </>
          ) : (
            <p className="agent-stats-empty">
              {context?.updating
                ? '等待下一次模型调用更新上下文占用。'
                : context?.usedTokens
                  ? `已用 ${precise(context.usedTokens)} token，上下文容量未知。`
                  : '当前 Agent 暂未上报上下文用量。'}
            </p>
          )}
        </section>

        {hasTokens(lastTurn) && (
          <section className="agent-stats-section">
            <h4 className="agent-stats-section-title">本轮用量</h4>
            <StatRow label="输入" value={`${precise(lastTurn.inputTokens)} token`} />
            <StatRow label="输出" value={`${precise(lastTurn.outputTokens)} token`} />
            <StatRow label="缓存读取" value={`${precise(lastTurn.cacheReadInputTokens)} token`} />
            <StatRow label="缓存写入" value={`${precise(lastTurn.cacheCreationInputTokens)} token`} />
          </section>
        )}

        {hasTokens(total) && (
          <section className="agent-stats-section">
            <h4 className="agent-stats-section-title">本会话累计</h4>
            <StatRow label="输入" value={`${precise(total.inputTokens)} token`} />
            <StatRow label="输出" value={`${precise(total.outputTokens)} token`} />
            <StatRow label="缓存读取" value={`${precise(total.cacheReadInputTokens)} token`} />
            <StatRow label="缓存写入" value={`${precise(total.cacheCreationInputTokens)} token`} />
            <StatRow label="缓存命中率" value={cacheHitRate(total)} hint="缓存读取 ÷ 输入" />
          </section>
        )}
      </div>

      <div className="agent-stats-footer">
        {view.source === 'native'
          ? '会话状态实时推送 · 上下文超过 60% 转黄、80% 转红'
          : `每 5 秒读取终端 transcript${view.updatedAt ? ` · 更新于 ${formatClock(view.updatedAt)}` : ''}`}
      </div>
    </div>
  );
}
