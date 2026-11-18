import { isBrowserClient } from '../platform';
import { isRemoteWorkspace } from './config';
import type { UnlistenFn } from '@tauri-apps/api/event';

export type { UnlistenFn } from '@tauri-apps/api/event';

/** 业务事件按当前工作区选择来源；桌面远程模式仍监听本机窗口事件。 */
export async function listen<T>(
  event: string,
  callback: (event: { event: string; id: number; payload: T }) => void,
): Promise<UnlistenFn> {
  if (isBrowserClient()) {
    const { listen: listenBrowser } = await import('../browser/connection');
    return listenBrowser(event, callback);
  }
  if (isRemoteWorkspace()) {
    const { listen: listenRemote } = await import('./event');
    return listenRemote(event, callback);
  }
  const { listenNative } = await import('./native');
  return listenNative(event, callback);
}
