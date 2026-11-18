import { invoke } from '@tauri-apps/api/core';
import { isRemoteWorkspace } from './config';

/** 所有业务模块仍导入同一入口；远程工作区仅切换这一个调用通道。 */
export async function routedInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isRemoteWorkspace()) {
    const { remoteInvoke } = await import('./proxy');
    return remoteInvoke<T>(command, args);
  }
  return invoke<T>(command, args);
}
