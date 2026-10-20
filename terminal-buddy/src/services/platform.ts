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
export function defaultShellType(): 'powershell' | 'bash' {
  return serverUsesWindowsPaths() ? 'powershell' : 'bash';
}
/** 是否支持打开本地系统资源管理器：浏览器模式（Docker/远程网页）无宿主资源管理器。 */
export function supportsSystemExplorerOpen(): boolean {
  return !isBrowserClient();
}
