import { useEffect, useState } from 'react';
import {
  AI_SESSION_UPDATE_EVENT,
  aiCatalog,
  aiSessionGet,
  getTerminalAgentUsage,
  listenTauri,
  type AiSession,
  type AiSessionUpdateFrame,
  type AiUsage,
  type TerminalAgentUsage,
} from '../services/tauri';

/** 底部状态栏需要的 Agent 实时状态：只保留展示字段，不把消息列表写进状态。 */
export interface ActiveAgentStats {
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  status: string;
  usage: AiUsage | null;
}

function pickStats(session: AiSession): ActiveAgentStats {
  return {
    providerId: session.providerId ?? null,
    providerName: session.providerName ?? null,
    model: session.model ?? null,
    status: session.status,
    usage: session.usage ?? null,
  };
}

/** 只比较状态栏实际展示的用量字段：流式期间每帧都会换 usage 引用，
 * 但消息增长不应触发状态栏重渲染。 */
function sameUsage(a: AiUsage | null, b: AiUsage | null): boolean {
  if (!a || !b) return a === b;
  return a.context.usedTokens === b.context.usedTokens
    && a.context.windowTokens === b.context.windowTokens
    && a.context.updating === b.context.updating
    && a.context.basis === b.context.basis
    && a.sessionTotal.inputTokens === b.sessionTotal.inputTokens
    && a.sessionTotal.outputTokens === b.sessionTotal.outputTokens
    && a.sessionTotal.cacheReadInputTokens === b.sessionTotal.cacheReadInputTokens
    && a.sessionTotal.cacheCreationInputTokens === b.sessionTotal.cacheCreationInputTokens
    && a.lastTurn?.inputTokens === b.lastTurn?.inputTokens
    && a.lastTurn?.outputTokens === b.lastTurn?.outputTokens
    && a.lastTurn?.cacheReadInputTokens === b.lastTurn?.cacheReadInputTokens
    && a.lastTurn?.cacheCreationInputTokens === b.lastTurn?.cacheCreationInputTokens;
}

function sameStats(a: ActiveAgentStats, b: ActiveAgentStats): boolean {
  return a.providerId === b.providerId
    && a.providerName === b.providerName
    && a.model === b.model
    && a.status === b.status
    && sameUsage(a.usage, b.usage);
}

/**
 * 选中原生会话标签时订阅该会话的实时状态。会话页在后台标签里不会挂载，
 * 状态栏必须自己订阅 `ai-session-update`，并先取一次快照兜底。
 */
export function useActiveAgentStats(sessionId: string | null): ActiveAgentStats | null {
  const [stats, setStats] = useState<ActiveAgentStats | null>(null);

  useEffect(() => {
    setStats(null);
    if (!sessionId) return;
    let cancelled = false;
    const apply = (session: AiSession) => {
      if (cancelled || session.id !== sessionId) return;
      const next = pickStats(session);
      setStats(previous => (previous && sameStats(previous, next) ? previous : next));
    };
    aiSessionGet(sessionId).then(apply).catch(() => {});
    const unlisten = listenTauri<AiSessionUpdateFrame>(AI_SESSION_UPDATE_EVENT, frame => {
      if (frame?.session) apply(frame.session);
    });
    return () => {
      cancelled = true;
      void unlisten.then(off => off());
    };
  }, [sessionId]);

  return stats;
}

/** 思考强度：会话快照不含 effort，按供应商 + 模型到目录里匹配（与用量面板同源）。 */
export function useAgentEffort(
  providerId: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const [effort, setEffort] = useState<string | null>(null);

  useEffect(() => {
    setEffort(null);
    if (!providerId || !model) return;
    let cancelled = false;
    aiCatalog()
      .then(catalog => {
        if (cancelled) return;
        const value = catalog.providers
          .find(provider => provider.id === providerId)
          ?.models.find(item => item.id === model)
          ?.effort?.trim();
        setEffort(value || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId, model]);

  return effort;
}

/** 终端里启动的 Agent 没有推送通道，只能按终端轮询 transcript 快照。 */
const TERMINAL_USAGE_POLL_MS = 5_000;

function sameTerminalUsage(a: TerminalAgentUsage, b: TerminalAgentUsage): boolean {
  return a.provider === b.provider
    && a.model === b.model
    && a.effort === b.effort
    && a.contextUsedTokens === b.contextUsedTokens
    && a.contextWindowTokens === b.contextWindowTokens
    && a.total.inputTokens === b.total.inputTokens
    && a.total.outputTokens === b.total.outputTokens
    && a.total.cacheReadInputTokens === b.total.cacheReadInputTokens
    && a.total.cacheCreationInputTokens === b.total.cacheCreationInputTokens;
}

/**
 * 选中终端会话时轮询其背后 Agent 的用量。未绑定 Agent、或后端读不到 transcript
 * 时返回 null，状态栏不会为普通终端渲染额外的占位。
 */
export function useTerminalAgentUsage(terminalId: string | null): TerminalAgentUsage | null {
  const [usage, setUsage] = useState<TerminalAgentUsage | null>(null);

  useEffect(() => {
    setUsage(null);
    if (!terminalId) return;
    let cancelled = false;
    const load = () => {
      getTerminalAgentUsage(terminalId)
        .then(next => {
          if (cancelled) return;
          setUsage(previous => (previous && next && sameTerminalUsage(previous, next) ? previous : next));
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, TERMINAL_USAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminalId]);

  return usage;
}
