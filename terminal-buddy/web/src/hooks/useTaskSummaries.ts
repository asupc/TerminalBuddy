import { useEffect } from 'react';
import { useStore } from '../store';

export function useTaskSummaries() {
  const token = useStore(state => state.token);
  const ids = useStore(state => state.sessions.map(session => session.id).sort().join(','));
  useEffect(() => {
    if (!token) return;
    let disposed = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (disposed || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        await useStore.getState().refreshTaskSummaries(ids ? ids.split(',') : []);
      } catch {
        // 连接恢复后重试，保留当前标题。
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
  }, [token, ids]);
}
