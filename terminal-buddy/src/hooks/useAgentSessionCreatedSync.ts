import { useEffect } from 'react';
import { AI_SESSION_CREATED_EVENT, listenTauri, type AiSessionCreatedFrame } from '../services/tauri';
import { nativeAgentTabKey, useAppStore } from '../stores/appStore';

/**
 * 其他客户端（手机 App / 浏览器）新建或恢复原生会话时，在电脑端标签栏补开标签。
 *
 * 服务端在会话创建成功后广播 `ai-session-created`；这里只追加标签、不切换焦点，
 * 与 Web 端创建终端会话时的处理一致——用户可能正在手机上看这个会话，
 * 电脑端不该被抢走当前操作。电脑端本地创建的会话由调用方自己激活，
 * `addAgentTab` 幂等，不会重复建标签，也不会覆盖本地刚写入的焦点标记。
 */
export function useAgentSessionCreatedSync() {
  useEffect(() => {
    let disposed = false;
    const unlisten = listenTauri<AiSessionCreatedFrame>(AI_SESSION_CREATED_EVENT, frame => {
      if (disposed) return;
      const session = frame?.session;
      if (!session?.id) return;
      const store = useAppStore.getState();
      const key = nativeAgentTabKey(session.id);
      if (store.agentTabs.some(tab => tab.key === key)) return;
      store.addAgentTab({
        key,
        shape: 'native',
        sessionId: session.id,
        title: session.title || '新对话',
        provider: session.provider === 'codex' ? 'codex' : session.provider === 'antigravity' ? 'antigravity' : 'claude',
        projectPath: session.projectPath,
        model: session.model ?? null,
        status: session.status,
        openedAt: Date.now(),
      });
    });
    return () => {
      disposed = true;
      void unlisten.then(off => off());
    };
  }, []);
}
