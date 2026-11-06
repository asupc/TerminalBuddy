import { useEffect } from 'react';
import { create } from 'zustand';
import { isBrowserClient } from '../services/platform';
import { getToken } from '../services/browser/connection';
import { getMobileAiTerminalResume, watchMobileAi, type MobileAiSession } from '../services/mobileAi';
import { useAppStore } from './appStore';

interface MobileAiState {
  sessions: MobileAiSession[];
  openingIds: string[];
  terminalIds: Record<string, string>;
  error: string;
}

export const useMobileAiStore = create<MobileAiState>(() => ({ sessions: [], openingIds: [], terminalIds: {}, error: '' }));

/** 与历史列表共用 CLI 恢复流程，打开后就是网页原有的终端标签。 */
export function openMobileAiSession(id: string): void {
  const state = useMobileAiStore.getState();
  const token = getToken();
  const current = () => getToken() === token && useMobileAiStore.getState().sessions.some(session => session.id === id);
  if (!state.sessions.some(session => session.id === id) || state.openingIds.includes(id)) return;
  useMobileAiStore.setState({ openingIds: [...state.openingIds, id] });
  void (async () => {
    const { focusTerminalById, resumeClaudeSession } = await import('../components/claude-history/resumeClaudeSession');
    if (!current()) return;
    const existingId = state.terminalIds[id];
    if (existingId && useAppStore.getState().sessions.some(session => session.id === existingId)) {
      focusTerminalById(existingId);
      return;
    }
    const session = await getMobileAiTerminalResume(id);
    if (!current()) return;
    // 已在网页中恢复过同一 CLI 会话时直接聚焦，避免重复创建终端。
    const store = useAppStore.getState();
    const liveId = Object.entries(store.agentSessionBindings).find(([terminalId, binding]) =>
      binding.provider === session.provider && binding.sessionId === session.sessionId
      && store.sessions.some(terminal => terminal.id === terminalId))?.[0];
    if (liveId) {
      useMobileAiStore.setState(current => ({ terminalIds: { ...current.terminalIds, [id]: liveId } }));
      focusTerminalById(liveId);
      return;
    }
    const vendorRef = session.providerId && session.model ? { providerId: session.providerId, modelId: session.model } : undefined;
    if (session.provider === 'codex') {
      const { resumeCodexSession } = await import('../components/claude-history/resumeCodexSession');
      if (!current()) return;
      await resumeCodexSession(session, undefined, vendorRef);
    } else {
      await resumeClaudeSession(session, undefined, vendorRef);
    }
    if (!current()) return;
    const restored = useAppStore.getState();
    const terminalId = Object.entries(restored.agentSessionBindings).find(([terminalId, binding]) =>
      binding.provider === session.provider && binding.sessionId === session.sessionId
      && restored.sessions.some(terminal => terminal.id === terminalId))?.[0];
    if (terminalId) useMobileAiStore.setState(value => ({ terminalIds: { ...value.terminalIds, [id]: terminalId } }));
  })().catch(error => {
    if (current()) useAppStore.getState().showToast(`恢复手机会话失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  })
    .finally(() => useMobileAiStore.setState(current => ({ openingIds: current.openingIds.filter(value => value !== id) })));
}

/** App 级列表订阅，切换终端不会停止发现手机新建的对话。 */
export function useMobileAiSessionsSync(): void {
  useEffect(() => {
    if (!isBrowserClient()) return;
    const receive = (sessions: MobileAiSession[]) => {
      if (!Array.isArray(sessions)) return;
      const unique = [...new Map(sessions.map(session => [session.id, session])).values()];
      useMobileAiStore.setState({ sessions: unique.sort((a, b) => b.updatedAt - a.updatedAt), error: '' });
    };
    const stop = watchMobileAi<MobileAiSession[]>({
      path: '/api/ai/sessions', socketPath: '/ws/ai', onSnapshot: receive, expectHeartbeatFrames: true,
      onFrame: frame => { if (frame.type === 'sessions') receive(frame.sessions); },
      onError: error => useMobileAiStore.setState({ error }),
    });
    return () => {
      stop();
      useMobileAiStore.setState({ sessions: [], openingIds: [], terminalIds: {}, error: '' });
    };
  }, []);
}
