import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../stores/appStore';
import { isBrowserClient } from '../services/platform';
import { refreshTaskSummaries, terminalDisplayTitle, useTaskSummaryStore } from '../stores/taskSummaryStore';

export function useTerminalTaskSummaries() {
  const ids = useAppStore(state => state.sessions.filter(session => session.sessionType !== 'editor' && !session.starting).map(session => session.id).sort().join(','));
  const activeSession = useAppStore(state => state.sessions.find(session => session.id === state.activeSessionId));
  const specialTab = useAppStore(state => state.activeSpecialTab);
  const enabled = useTaskSummaryStore(state => state.enabled);
  const task = useTaskSummaryStore(state => activeSession ? state.summaries[activeSession.id] : undefined);
  const baseTitle = useRef(document.title || 'TerminalBuddy');
  const titleChanged = useRef(false);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (disposed || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        await refreshTaskSummaries(ids ? ids.split(',') : []);
      } catch {
        // 暂时离线时保留已显示的摘要，下一次自动重试。
      } finally {
        busy = false;
        if (!disposed) timer = setTimeout(refresh, 4000);
      }
    };
    void refresh();
    window.addEventListener('terminal-task-summary-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('terminal-task-summary-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [ids]);

  const title = enabled && task && activeSession && !specialTab
    ? terminalDisplayTitle(activeSession.profileName, task)
    : null;
  useEffect(() => {
    // 浏览器标签页由主页标题设置管理，任务摘要只更新桌面窗口标题。
    if (isBrowserClient()) return;
    if (!title && !titleChanged.current) return;
    if (title && !titleChanged.current) baseTitle.current = document.title || 'TerminalBuddy';
    titleChanged.current = title !== null;
    void getCurrentWindow().setTitle(title ? `${title} — ${baseTitle.current}` : baseTitle.current).catch(() => {});
  }, [title]);
}
