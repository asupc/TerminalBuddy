import type { FC } from 'react';
import type { AntigravityQuotaWindow } from '../../services/tauri';
import './QuotaRing.css';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatQuotaResetDetail(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const ms = /^\d{10,13}$/.test(trimmed)
    ? (trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed))
    : Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    const d = new Date(ms);
    const clock = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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

export function quotaWindowLabel(w: AntigravityQuotaWindow): string {
  if (w.kind === 'session_5h') return w.label || '5小时额度';
  if (w.kind === 'weekly') return w.label || '周额度';
  return w.label || 'Gemini 额度';
}

export function quotaTone(percent: number | null | undefined): 'ok' | 'warn' | 'low' | 'unknown' {
  if (percent == null) return 'unknown';
  if (percent < 20) return 'low';
  if (percent < 50) return 'warn';
  return 'ok';
}

interface QuotaRingItemProps {
  label: string;
  percent: number | null;
  resetText?: string | null;
  size?: number;
}

export const QuotaRingItem: FC<QuotaRingItemProps> = ({
  label,
  percent,
  resetText,
  size = 56,
}) => {
  const clamped = percent != null ? Math.max(0, Math.min(100, percent)) : 0;
  const tone = quotaTone(percent);
  const strokeWidth = 5.5;
  const radius = (64 - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const resetDetail = formatQuotaResetDetail(resetText);

  return (
    <div className={`quota-ring-card tone-${tone}`}>
      <div className="quota-ring-visual" style={{ width: size, height: size }}>
        <svg className="quota-ring-svg" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
          <circle
            className="quota-ring-track"
            cx="32"
            cy="32"
            r={radius}
            strokeWidth={strokeWidth}
          />
          {percent != null && (
            <circle
              className={`quota-ring-progress tone-${tone}`}
              cx="32"
              cy="32"
              r={radius}
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
            />
          )}
        </svg>
        <span className={`quota-ring-percent tone-${tone}`}>
          {percent != null ? `${percent}%` : '—'}
        </span>
      </div>
      <div className="quota-ring-info">
        <div className="quota-ring-label">{label}</div>
        {resetDetail && (
          <div className="quota-ring-reset" title={resetText ?? undefined}>
            {resetDetail}
          </div>
        )}
      </div>
    </div>
  );
};

interface AntigravityQuotaRingsProps {
  windows: AntigravityQuotaWindow[];
  compact?: boolean;
}

export const AntigravityQuotaRings: FC<AntigravityQuotaRingsProps> = ({ windows, compact = false }) => (
  <div className={`quota-ring-grid${compact ? ' is-compact' : ''}`}>
    {windows.map((w, idx) => (
      <QuotaRingItem
        key={`${w.kind}-${w.label}-${idx}`}
        label={quotaWindowLabel(w)}
        percent={w.remainingPercent}
        resetText={w.resetText}
        size={compact ? 52 : 58}
      />
    ))}
  </div>
);
