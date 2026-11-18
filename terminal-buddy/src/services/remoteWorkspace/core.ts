import { invoke as tauriInvoke, convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core';
import { isRemoteWorkspace, remoteProxyOrigin } from './config';
// 仅需拼 URL，不引入代理的 Tauri 依赖链。
function remoteFileUrl(path: string): string {
  return `${remoteProxyOrigin()}/__tb_remote/api/desktop/file?${new URLSearchParams({ path })}`;
}

/**
 * 统一业务调用入口：本机工作区直接走 Tauri 命令；桌面远程工作区改经本机回环代理。
 * 业务模块按原样 `import { invoke }`，不需要关心当前工作区。
 */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isRemoteWorkspace()) {
    const { remoteInvoke } = await import('./proxy');
    return remoteInvoke<T>(command, args);
  }
  return tauriInvoke<T>(command, args);
}

/** 兼容旧名：部分模块按 routedInvoke 引用。 */
export const routedInvoke = invoke;

/**
 * 文件路径转可访问地址：本机走 Tauri asset 协议；远程工作区由本机代理转发并注入令牌。
 * 调用点要求同步返回，因此代理尚未就绪时直接报错，而不是返回空地址。
 */
export function convertFileSrc(path: string): string {
  if (isRemoteWorkspace()) {
    if (!remoteProxyOrigin()) throw new Error('远程工作区尚未就绪，请稍后重试');
    return remoteFileUrl(path);
  }
  return tauriConvertFileSrc(path);
}
