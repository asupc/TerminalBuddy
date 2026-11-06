import { useEffect } from 'react';
import { create } from 'zustand';
import { isBrowserClient } from '../services/platform';
import { watchMobileAi, type MobileAiSession } from '../services/mobileAi';
import { useAppStore } from './appStore';

interface MobileAiState {
  sessions: MobileAiSession[];
  selectedId: string | null;
  error: string;
}

export const useMobileAiStore = create<MobileAiState>(() => ({ sessions: [], selectedId: null, error: '' }));

export function openMobileAiSession(id: string): void {
  if (!useMobileAiStore.getState().sessions.some(session => session.id === id)) return;
  useMobileAiStore.setState({ selectedId: id });
  useAppStore.getState().setActiveSpecialTab('mobile-chat');
}

export function closeMobileAiSession(): void {
  useMobileAiStore.setState({ selectedId: null });
  if (useAppStore.getState().activeSpecialTab === 'mobile-chat') useAppStore.getState().setActiveSpecialTab(null);
}

/** App 级列表订阅，切换终端或进入聊天页不会停止发现手机新建的对话。 */
export function useMobileAiSessionsSync(): void {
  useEffect(() => {
    if (!isBrowserClient()) return;
    const receive = (sessions: MobileAiSession[]) => {
      if (!Array.isArray(sessions)) return;
      const unique = [...new Map(sessions.map(session => [session.id, session])).values()];
      const selectedId = useMobileAiStore.getState().selectedId;
      const removed = selectedId !== null && !unique.some(session => session.id === selectedId);
      useMobileAiStore.setState({
        sessions: unique.sort((a, b) => b.updatedAt - a.updatedAt),
        error: '',
        ...(removed ? { selectedId: null } : {}),
      });
      if (removed && useAppStore.getState().activeSpecialTab === 'mobile-chat') {
        useAppStore.getState().setActiveSpecialTab(null);
        useAppStore.getState().showToast('该移动端会话已删除', 'info');
      }
    };
    const stop = watchMobileAi<MobileAiSession[]>({
      path: '/api/ai/sessions', socketPath: '/ws/ai', onSnapshot: receive, expectHeartbeatFrames: true,
      onFrame: frame => { if (frame.type === 'sessions') receive(frame.sessions); },
      onError: error => useMobileAiStore.setState({ error }),
    });
    return () => {
      stop();
      useMobileAiStore.setState({ sessions: [], selectedId: null, error: '' });
      if (useAppStore.getState().activeSpecialTab === 'mobile-chat') useAppStore.getState().setActiveSpecialTab(null);
    };
  }, []);
}
