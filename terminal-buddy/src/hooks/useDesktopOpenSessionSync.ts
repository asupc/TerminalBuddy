import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { setDesktopOpenSessions } from '../services/tauri/aiChat';
import { isBrowserClient } from '../services/platform';

/**
 * 把桌面端当前打开着的原生会话标签同步到服务端。
 *
 * 手机简版首页的「已打开」以服务端视角展示：电脑上打开着的聊天 + 手机自己
 * 正在查看的会话，而不是手机本地「曾经点开过」的记录。标签集合变化（打开、
 * 关闭、启动恢复）时整体上报一次，服务端只保存在内存里，进程退出即清空。
 *
 * 浏览器模式（dist-web）不是「电脑端」，不上报，避免网页标签页冒充桌面标签。
 */
export function useDesktopOpenSessionSync() {
  // 选择器返回稳定字符串：标签顺序、引用变化不触发多余上报。
  const openIds = useAppStore(state =>
    state.agentTabs
      .filter(tab => tab.shape === 'native')
      .map(tab => tab.sessionId)
      .sort()
      .join(','),
  );
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    if (isBrowserClient() || lastSent.current === openIds) return;
    lastSent.current = openIds;
    const ids = openIds ? openIds.split(',') : [];
    void setDesktopOpenSessions(ids).catch(error => {
      // 失败只影响手机端「已打开」的实时性；清空记录，下次标签变化时重试。
      console.error('同步桌面端已打开会话失败:', error);
      lastSent.current = null;
    });
  }, [openIds]);
}
