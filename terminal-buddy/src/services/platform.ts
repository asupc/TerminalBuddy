import { dockerRuntime, serverPlatform } from './browser/connection';
import { isRemoteWorkspace } from './remoteWorkspace/config';

/** 当前页面是否运行在 Tauri 原生容器（含 browser-demo 的 mock 运行时）。 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 页面是否运行在浏览器；桌面远程工作区仍是原生窗口外壳。 */
export function isBrowserClient(): boolean {
  return import.meta.env.MODE === 'browser'
    || (import.meta.env.MODE !== 'browser-demo' && !isTauriRuntime());
}
/** 业务数据是否来自 Web API（普通浏览器或桌面远程工作区）。 */
export function isWebBackend(): boolean {
  return isBrowserClient() || isRemoteWorkspace();
}
export function isDockerClient(): boolean {
  return isWebBackend() && dockerRuntime;
}
export function clientTerminalOwner(): 'pc' | 'web' {
  return isWebBackend() ? 'web' : 'pc';
}

export function serverUsesWindowsPaths(): boolean {
  return !isWebBackend() || serverPlatform === 'windows';
}
/** 服务端文件系统是否大小写不敏感（用于路径去重键，不能一律小写化）。 */
export function serverPathsCaseInsensitive(): boolean {
  return !isWebBackend() || serverPlatform === 'windows' || serverPlatform === 'darwin';
}
export function defaultShellType(): 'powershell' | 'bash' {
  return serverUsesWindowsPaths() ? 'powershell' : 'bash';
}
export { isRemoteWorkspace } from './remoteWorkspace/config';

/** 本地资源管理器只对真正的本机工作区开放。 */
export function supportsSystemExplorerOpen(): boolean {
  return !isWebBackend();
}

