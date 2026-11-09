import { useEffect } from 'react';
import { AI_SESSION_UPDATE_EVENT, listenTauri, type AiSessionUpdateFrame } from '../services/tauri';
import { useAppStore } from '../stores/appStore';

/**
 * 原生会话状态全局同步。
 *
 * 聊天页只在标签处于激活状态时挂载，切到别的标签后就收不到 `ai-session-update`，
 * 标签栏上的呼吸灯会停在上一次状态（执行中一直亮，或已结束仍在闪）。
 * 这里在应用根节点常驻订阅，只把状态回写到对应的原生会话标签；
 * 标题与模型仍由聊天页负责，避免流式期间重复写持久化。
 */
export function useAgentTabStatusSync() {
  useEffect(() => {
    let disposed = false;
    const unlisten = listenTauri<AiSessionUpdateFrame>(AI_SESSION_UPDATE_EVENT, frame => {
      if (disposed) return;
      const session = frame.session;
      if (!session?.id || !session.status) return;
      const store = useAppStore.getState();
      const tab = store.agentTabs.find(item => item.shape === 'native' && item.sessionId === session.id);
      // 值没变就不写 store：每帧都换数组引用会让标签栏整体重渲染。
      if (!tab || tab.shape !== 'native' || tab.status === session.status) return;
      store.updateAgentTab(tab.key, { status: session.status });
    });
    return () => {
      disposed = true;
      void unlisten.then(off => off());
    };
  }, []);
}
