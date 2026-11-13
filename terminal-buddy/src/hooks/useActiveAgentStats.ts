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
    // 快照请求与事件订阅之间的空档里如果收到更新，快照可能是旧值，不能再覆盖它。
    let sawUpdate = false;
    let unlisten: (() => void) | null = null;
    const apply = (session: AiSession) => {
      if (cancelled || session.id !== sessionId) return;
      const next = pickStats(session);
      setStats(previous => (previous && sameStats(previous, next) ? previous : next));
    };
    void (async () => {
      // 必须先完成订阅再取快照：反过来会让两步之间的更新彻底丢失，
      // 状态栏在会话没有新消息时会一直空着。
      try {
        unlisten = await listenTauri<AiSessionUpdateFrame>(AI_SESSION_UPDATE_EVENT, frame => {
          if (frame?.session) {
            sawUpdate = true;
            apply(frame.session);
          }
        });
      } catch {
        // 订阅失败时仍尝试用快照兜底。
      }
      if (cancelled) {
        unlisten?.();
        return;
      }
      try {
        const snapshot = await aiSessionGet(sessionId);
        if (!sawUpdate) apply(snapshot);
      } catch {
        // 后端暂不可用时等下一次事件。
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
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
/** 刚启动 / 刚切换标签时先快速补几次，避免状态栏空等一整个轮询周期。 */
const TERMINAL_USAGE_RETRY_MS = 1_200;
/** 只有连续这么多次读不到快照才认为 Agent 已退出，单次读空不清空已有信息。 */
const TERMINAL_USAGE_MISS_LIMIT = 3;
/** 按终端缓存最近一次快照：切走再切回时立即恢复显示，不必等第一次请求。 */
const terminalUsageCache = new Map<string, TerminalAgentUsage>();

function rememberTerminalUsage(terminalId: string, usage: TerminalAgentUsage): void {
  // 终端数量有限，简单按插入顺序裁剪，避免长期运行无界增长。
  if (!terminalUsageCache.has(terminalId) && terminalUsageCache.size >= 32) {
    const oldest = terminalUsageCache.keys().next().value;
    if (oldest !== undefined) terminalUsageCache.delete(oldest);
  }
  terminalUsageCache.set(terminalId, usage);
}

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
  const [usage, setUsage] = useState<TerminalAgentUsage | null>(
    () => (terminalId ? terminalUsageCache.get(terminalId) ?? null : null),
  );

  useEffect(() => {
    setUsage(terminalId ? terminalUsageCache.get(terminalId) ?? null : null);
    if (!terminalId) return;
    let cancelled = false;
    let timer: number | undefined;
    let misses = 0;
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, delay);
    };
    const load = () => {
      getTerminalAgentUsage(terminalId)
        .then(next => {
          if (cancelled) return;
          if (next) {
            misses = 0;
            rememberTerminalUsage(terminalId, next);
            setUsage(previous => (previous && sameTerminalUsage(previous, next) ? previous : next));
            schedule(TERMINAL_USAGE_POLL_MS);
            return;
          }
          // transcript 可能刚好在切换会话 / Agent 重启，单次读空先保留旧快照，
          // 连续多次读空才清空，避免状态栏随机闪断。
          misses += 1;
          if (misses >= TERMINAL_USAGE_MISS_LIMIT) {
            terminalUsageCache.delete(terminalId);
            setUsage(null);
          }
          schedule(misses < TERMINAL_USAGE_MISS_LIMIT ? TERMINAL_USAGE_RETRY_MS : TERMINAL_USAGE_POLL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          // 请求失败不清空已展示的信息，按正常节奏重试。
          schedule(TERMINAL_USAGE_POLL_MS);
        });
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [terminalId]);

  return usage;
}
