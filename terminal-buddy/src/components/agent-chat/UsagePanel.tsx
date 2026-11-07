import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { AiContextUsage, AiTokenUsage, AiUsage } from '../../services/tauri';
import './UsagePanel.css';

/** 精确到个位的 token 数：用量明细需要真实数字，不做 k/M 近似。 */
function precise(value: number | null | undefined): string {
  if (value == null || value < 0) return '—';
  return value.toLocaleString('zh-CN');
}

function compact(value: number | null | undefined): string {
  if (value == null || value < 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** 上下文占用率：与手机端同样按已用/容量计算；容量未知时不显示百分比。 */
export function contextPercent(context: AiContextUsage | null | undefined): number | null {
  if (!context?.usedTokens || !context.windowTokens) return null;
  return Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100));
}

/** 输入栏中显示的一句话摘要，跳变修复后这里不会在 0 与真实值之间闪烁。 */
export function contextSummary(context: AiContextUsage | null | undefined): string {
  if (context?.updating && context.usedTokens == null) return '上下文待更新';
  const percent = contextPercent(context);
  if (percent != null) return `上下文 ${percent}%（${compact(context!.usedTokens)} / ${compact(context!.windowTokens)}）`;
  if (context?.usedTokens != null) return `上下文 ${compact(context.usedTokens)}`;
  return '上下文 —';
}

/** 缓存命中率：命中 /（命中 + 写入 + 未命中输入）。 */
function cacheHitRate(tokens: AiTokenUsage | null | undefined): string {
  const read = tokens?.cacheReadInputTokens ?? null;
  const write = tokens?.cacheCreationInputTokens ?? null;
  const input = tokens?.inputTokens ?? null;
  if (read == null || input == null) return '—';
  const total = input + (write ?? 0);
  if (total <= 0) return '—';
  return `${Math.round((read / total) * 100)}%`;
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="usage-row">
      <span className="usage-row-label">{label}</span>
      <span className="usage-row-value">
        {value}
        {hint && <span className="usage-row-hint">{hint}</span>}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="usage-section">
      <h4 className="usage-section-title">{title}</h4>
      {children}
    </section>
  );
}

/** 单个 Token 明细块：输入 / 输出 / 缓存 / 推理 + 缓存命中率。 */
function TokenBlock({ tokens, coverage }: { tokens: AiTokenUsage | null | undefined; coverage?: string }) {
  return (
    <div className="usage-token-block">
      <Row label="输入" value={`${precise(tokens?.inputTokens)} token`} />
      <Row label="输出" value={`${precise(tokens?.outputTokens)} token`} />
      <Row label="其中缓存读取" value={`${precise(tokens?.cacheReadInputTokens)} token`} />
      <Row label="其中缓存写入" value={`${precise(tokens?.cacheCreationInputTokens)} token`} />
      {(tokens?.reasoningOutputTokens != null) && (
        <Row label="其中推理输出" value={`${precise(tokens?.reasoningOutputTokens)} token`} />
      )}
      <Row label="缓存命中率" value={cacheHitRate(tokens)} hint="缓存读取 ÷ 输入" />
      {coverage === 'partial' && (
        <p className="usage-note">包含未完整结算的回合，当前数值可能小于实际消耗。</p>
      )}
      {coverage === 'sinceUpgrade' && (
        <p className="usage-note">从功能升级后开始统计，之前的会话用量未包含在内。</p>
      )}
    </div>
  );
}

const TURN_STATE: Record<string, string> = {
  final: '统计已完成',
  partial: '部分统计',
  provisional: '统计中',
};

/**
 * 上下文与 Token 明细面板：与手机端 `AiUsageSheet` 展示同一份数据，
 * 桌面端此前只有输入栏的一行摘要。
 */
export function UsagePanel({ usage, modelLabel, effortLabel, running, onClose }: {
  usage: AiUsage | null | undefined;
  modelLabel: string;
  effortLabel: string;
  running: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const context = usage?.context;
  const lastTurn = usage?.lastTurn;

  return (
    <>
      <div className="usage-overlay" onClick={onClose} />
      <div className="usage-panel" ref={panelRef} role="dialog" aria-label="上下文与 Token">
        <header className="usage-panel-header">
          <h3>上下文与 Token</h3>
          <button type="button" className="usage-close" onClick={onClose} aria-label="关闭">
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="usage-panel-body">
          <Section title="模型与思考强度">
            <Row label="模型" value={modelLabel} />
            <Row label="思考强度" value={effortLabel} />
            <p className="usage-note">思考强度按当前供应商模型配置显示，未提供时跟随服务端。</p>
          </Section>

          {!usage ? (
            <p className="usage-empty">当前会话暂无用量统计。收到模型用量后会自动显示。</p>
          ) : (
            <>
              <Section title="当前上下文">
                <Row
                  label="占用"
                  value={context?.updating && context.usedTokens == null
                    ? '等待下一次模型调用更新'
                    : contextPercent(context) != null
                      ? `${contextPercent(context)}%（${compact(context?.usedTokens)} / ${compact(context?.windowTokens)}）`
                      : context?.usedTokens != null ? compact(context.usedTokens) : '占用率未知'}
                />
                <Row label="已用 / 容量" value={`${precise(context?.usedTokens)} / ${precise(context?.windowTokens)} token`} />
                <Row
                  label="容量来源"
                  value={context?.windowSource === 'cli' ? '模型报告'
                    : context?.windowSource === 'configuration' ? '会话配置' : '尚未提供'}
                />
                <p className="usage-note">
                  {context?.basis === 'inputAndOutput'
                    ? '根据最近一次调用的输入与输出估算，可能与模型自身的上下文显示有差异。'
                    : '采用最近一次模型调用的输入量，包含缓存读取和写入；草稿和此后新增内容尚未计入。'}
                </p>
              </Section>

              <Section title="本轮用量">
                <Row label="统计状态" value={TURN_STATE[lastTurn?.state ?? ''] ?? (running ? '统计中' : '尚未开始')} />
                <TokenBlock tokens={lastTurn} />
              </Section>

              <Section title="本会话累计">
                <TokenBlock tokens={usage.sessionTotal} coverage={usage.sessionTotal.coverage} />
                <p className="usage-note">
                  缓存与推理明细已包含在对应输入、输出中。多轮对话会重复发送上下文，因此累计消耗可以超过上下文容量。
                </p>
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
