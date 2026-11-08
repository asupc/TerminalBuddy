import { dockerRuntime, serverPlatform } from './browser/connection';

export function isBrowserClient(): boolean {
  return import.meta.env.MODE === 'browser';
}
export function isDockerClient(): boolean {
  return isBrowserClient() && dockerRuntime;
}
export function clientTerminalOwner(): 'pc' | 'web' {
  return isBrowserClient() ? 'web' : 'pc';
}

export function serverUsesWindowsPaths(): boolean {
  return !isBrowserClient() || serverPlatform === 'windows';
}
/** 服务端文件系统是否大小写不敏感（用于路径去重键，不能一律小写化）。 */
export function serverPathsCaseInsensitive(): boolean {
  return !isBrowserClient() || serverPlatform === 'windows' || serverPlatform === 'darwin';
}
export function defaultShellType(): 'powershell' | 'bash' {
  return serverUsesWindowsPaths() ? 'powershell' : 'bash';
}
/** 是否支持打开本地系统资源管理器：浏览器模式（Docker/远程网页）无宿主资源管理器。 */
export function supportsSystemExplorerOpen(): boolean {
  return !isBrowserClient();
}
