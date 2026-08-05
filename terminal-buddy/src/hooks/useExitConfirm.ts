import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';

/**
 * 退出确认：有会话时弹确认框，无会话时直接执行退出流程。
 * tray-exit-requested 与窗口 closeRequested 两处共用。
 */
export function useExitConfirm(onExit: () => Promise<void> | void) {
  const [closeConfirm, setCloseConfirm] = useState<{ sessionCount: number } | null>(null);
  const closeConfirmedRef = useRef(false);

  /** 触发退出流程；返回 false 表示已确认过（调用方不应再拦截关闭）。 */
  const requestExit = useCallback(() => {
    if (closeConfirmedRef.current) return false;
    const { sessions } = useAppStore.getState();
    if (sessions.length > 0) {
      setCloseConfirm({ sessionCount: sessions.length });
    } else {
      // 无终端时也需要保存 Claude 会话
      void onExit();
    }
    return true;
  }, [onExit]);

  const confirmExit = useCallback(async () => {
    closeConfirmedRef.current = true;
    setCloseConfirm(null);
    await onExit();
  }, [onExit]);

  const cancelExit = useCallback(() => {
    setCloseConfirm(null);
  }, []);

  return { closeConfirm, closeConfirmedRef, requestExit, confirmExit, cancelExit };
}
